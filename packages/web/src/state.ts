import {
  computeChannelPermissions,
  computeGuildPermissions,
  type Channel,
  type DispatchEvents,
  type DispatchName,
  type GuildState,
  type Message,
  type PresenceStatus,
  type ReadState,
  type RelationshipType,
  type User,
  type VoiceState,
} from '@konusgac/shared';
import { useSyncExternalStore } from 'react';

export interface MessageLog {
  items: Message[];
  hasMore: boolean;
  loading: boolean;
}

export interface State {
  connection: 'offline' | 'connecting' | 'ready';
  me: User | null;
  users: Record<string, User>;
  presences: Record<string, PresenceStatus>;
  guilds: Record<string, GuildState>;
  guildOrder: string[];
  dms: Record<string, Channel>;
  relationships: Record<string, RelationshipType>;
  messages: Record<string, MessageLog>;
  typing: Record<string, Record<string, number>>; // channelId -> userId -> expiresAt
  readStates: Record<string, ReadState>; // by channelId
  // '@me' is the home view (friends + DMs)
  view: { guildId: string; channelId: string | null };
  sessionId: string | null; // this tab's gateway session
  voice: Record<string, VoiceState>; // userId -> state, only users currently in a voice channel
  voiceSelf: VoiceSelf;
  speaking: Record<string, true>;
  rtcState: RTCPeerConnectionState | null; // this tab's media link to the voice server, while in a channel
}

// This tab's own voice controls. channelId is the channel we are in or joining.
export interface VoiceSelf {
  channelId: string | null;
  connecting: boolean;
  error: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  noMic: boolean; // no microphone available: listen-only
  silent: boolean; // connected and unmuted, but the microphone has sent only silence for a while
  selfVideo: boolean; // our camera is on
  selfStream: boolean; // we are sharing our screen
}

const initial: State = {
  sessionId: null,
  voice: {},
  voiceSelf: { channelId: null, connecting: false, error: null, selfMute: false, selfDeaf: false, noMic: false, silent: false, selfVideo: false, selfStream: false },
  speaking: {},
  rtcState: null,
  connection: 'offline',
  me: null,
  users: {},
  presences: {},
  guilds: {},
  guildOrder: [],
  dms: {},
  relationships: {},
  messages: {},
  typing: {},
  readStates: {},
  view: { guildId: '@me', channelId: null },
};

let state = initial;
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(update: (s: State) => Partial<State>) {
  state = { ...state, ...update(state) };
  listeners.forEach((l) => l());
}

export function resetState() {
  state = initial;
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---------- derived helpers ----------

export function channelById(s: State, id: string | null): Channel | undefined {
  if (!id) return undefined;
  if (s.dms[id]) return s.dms[id];
  for (const g of Object.values(s.guilds)) {
    const c = g.channels.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

export function guildPerms(s: State, guildId: string): number {
  const g = s.guilds[guildId];
  const m = g?.members.find((x) => x.userId === s.me?.id);
  return g && m ? computeGuildPermissions(g.guild, m, g.roles) : 0;
}

export function channelPerms(s: State, channel: Channel): number {
  if (channel.type === 'dm') return ~0;
  const g = s.guilds[channel.guildId!];
  const m = g?.members.find((x) => x.userId === s.me?.id);
  return g && m ? computeChannelPermissions(g.guild, m, g.roles, channel) : 0;
}

export function displayName(s: State, userId: string, guildId?: string): string {
  const nick = guildId ? s.guilds[guildId]?.members.find((m) => m.userId === userId)?.nick : null;
  return nick || s.users[userId]?.displayName || 'Bilinmeyen kullanıcı';
}

// Color of the member's highest colored role, if any.
export function roleColor(s: State, guildId: string, userId: string): string | undefined {
  const g = s.guilds[guildId];
  const m = g?.members.find((x) => x.userId === userId);
  if (!g || !m) return undefined;
  const roles = g.roles.filter((r) => m.roleIds.includes(r.id) && r.color !== '#99aab5').sort((a, b) => b.position - a.position);
  return roles[0]?.color;
}

// ---------- unread & mentions ----------

export function isUnread(s: State, channel: Channel): boolean {
  if (!channel.lastMessageId || channel.type === 'category' || channel.type === 'voice') return false;
  const read = s.readStates[channel.id]?.lastReadId;
  return !read || BigInt(channel.lastMessageId) > BigInt(read);
}

export function mentionCount(s: State, channelId: string): number {
  return s.readStates[channelId]?.mentionCount ?? 0;
}

// Whether a message pings this user: a DM, a <@me> mention, @everyone, or a reply to one of my messages.
export function pingsMe(s: State, m: Message): boolean {
  const me = s.me?.id;
  if (!me || m.authorId === me) return false;
  return !!s.dms[m.channelId] || m.mentionIds.includes(me) || m.mentionEveryone || m.replyTo?.authorId === me;
}

export function dmPartner(s: State, channel: Channel): string | undefined {
  return channel.recipientIds.find((id) => id !== s.me?.id);
}

// Our voice state, if this tab owns the voice session.
export function myVoiceHere(s: State): VoiceState | undefined {
  const v = s.me ? s.voice[s.me.id] : undefined;
  return v && v.sessionId === s.sessionId ? v : undefined;
}

export function voiceMembers(s: State, channelId: string): VoiceState[] {
  return Object.values(s.voice).filter((v) => v.channelId === channelId);
}

function withGuildVoice(voice: Record<string, VoiceState>, guildId: string, states: VoiceState[]) {
  const next: Record<string, VoiceState> = {};
  for (const [userId, v] of Object.entries(voice)) if (v.guildId !== guildId) next[userId] = v;
  for (const v of states) next[v.userId] = v;
  return next;
}

// ---------- gateway event reducer ----------

function patchGuild(s: State, guildId: string, fn: (g: GuildState) => GuildState): Partial<State> {
  const g = s.guilds[guildId];
  return g ? { guilds: { ...s.guilds, [guildId]: fn(g) } } : {};
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function editLog(s: State, channelId: string, fn: (items: Message[]) => Message[]): Partial<State> {
  const log = s.messages[channelId];
  return log ? { messages: { ...s.messages, [channelId]: { ...log, items: fn(log.items) } } } : {};
}

export function applyEvent<K extends DispatchName>(t: K, data: DispatchEvents[K]) {
  setState((s) => reduce(s, t, data));
}

function reduce<K extends DispatchName>(s: State, t: K, raw: DispatchEvents[K]): Partial<State> {
  switch (t) {
    case 'READY': {
      const d = raw as DispatchEvents['READY'];
      const users: Record<string, User> = {};
      for (const u of d.users) users[u.id] = u;
      const guilds: Record<string, GuildState> = {};
      for (const g of d.guilds) guilds[g.guild.id] = g;
      const dms: Record<string, Channel> = {};
      for (const c of d.dmChannels) dms[c.id] = c;
      const relationships: Record<string, RelationshipType> = {};
      for (const r of d.relationships) relationships[r.userId] = r.type;
      const view = s.view.guildId === '@me' || guilds[s.view.guildId] ? s.view : { guildId: '@me', channelId: null };
      const voice: Record<string, VoiceState> = {};
      for (const v of d.voiceStates) voice[v.userId] = v;
      const readStates: Record<string, ReadState> = {};
      for (const r of d.readStates) readStates[r.channelId] = r;
      return {
        readStates,
        connection: 'ready',
        sessionId: d.sessionId,
        voice,
        me: d.user,
        users,
        presences: d.presences,
        guilds,
        guildOrder: d.guilds.map((g) => g.guild.id),
        dms,
        relationships,
        messages: {}, // refetched on demand after (re)connect
        typing: {},
        view,
      };
    }
    case 'GUILD_CREATE': {
      const d = raw as DispatchEvents['GUILD_CREATE'];
      const users = { ...s.users };
      for (const u of d.users) users[u.id] = u;
      const { users: _u, presences, voiceStates, ...guildState } = d;
      const order = s.guildOrder.includes(d.guild.id) ? s.guildOrder : [...s.guildOrder, d.guild.id];
      return {
        guilds: { ...s.guilds, [d.guild.id]: guildState },
        guildOrder: order,
        users,
        presences: { ...s.presences, ...presences },
        voice: withGuildVoice(s.voice, d.guild.id, voiceStates),
      };
    }
    case 'GUILD_UPDATE': {
      const d = raw as DispatchEvents['GUILD_UPDATE'];
      return patchGuild(s, d.id, (g) => ({ ...g, guild: d }));
    }
    case 'GUILD_DELETE': {
      const d = raw as DispatchEvents['GUILD_DELETE'];
      const { [d.id]: _gone, ...guilds } = s.guilds;
      return {
        guilds,
        guildOrder: s.guildOrder.filter((id) => id !== d.id),
        view: s.view.guildId === d.id ? { guildId: '@me', channelId: null } : s.view,
        voice: withGuildVoice(s.voice, d.id, []),
      };
    }
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE': {
      const c = raw as Channel;
      if (c.type === 'dm') return { dms: { ...s.dms, [c.id]: c } };
      return patchGuild(s, c.guildId!, (g) => ({ ...g, channels: upsert(g.channels, c).sort((a, b) => a.position - b.position) }));
    }
    case 'CHANNEL_DELETE': {
      const d = raw as DispatchEvents['CHANNEL_DELETE'];
      const view = s.view.channelId === d.id ? { ...s.view, channelId: null } : s.view;
      if (!d.guildId) {
        const { [d.id]: _gone, ...dms } = s.dms;
        return { dms, view };
      }
      return { ...patchGuild(s, d.guildId, (g) => ({ ...g, channels: g.channels.filter((c) => c.id !== d.id) })), view };
    }
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE': {
      const r = raw as DispatchEvents['GUILD_ROLE_CREATE'];
      return patchGuild(s, r.guildId, (g) => ({ ...g, roles: upsert(g.roles, r).sort((a, b) => a.position - b.position) }));
    }
    case 'GUILD_ROLE_DELETE': {
      const d = raw as DispatchEvents['GUILD_ROLE_DELETE'];
      return patchGuild(s, d.guildId, (g) => ({ ...g, roles: g.roles.filter((r) => r.id !== d.id) }));
    }
    case 'GUILD_MEMBER_ADD': {
      const d = raw as DispatchEvents['GUILD_MEMBER_ADD'];
      return {
        users: { ...s.users, [d.user.id]: d.user },
        ...patchGuild(s, d.member.guildId, (g) => ({
          ...g,
          members: [...g.members.filter((m) => m.userId !== d.member.userId), d.member],
        })),
      };
    }
    case 'GUILD_MEMBER_UPDATE': {
      const m = raw as DispatchEvents['GUILD_MEMBER_UPDATE'];
      return patchGuild(s, m.guildId, (g) => ({ ...g, members: g.members.map((x) => (x.userId === m.userId ? m : x)) }));
    }
    case 'GUILD_MEMBER_REMOVE': {
      const d = raw as DispatchEvents['GUILD_MEMBER_REMOVE'];
      return patchGuild(s, d.guildId, (g) => ({ ...g, members: g.members.filter((m) => m.userId !== d.userId) }));
    }
    case 'MESSAGE_CREATE': {
      const m = raw as Message;
      const typing = s.typing[m.channelId];
      const next: Partial<State> = editLog(s, m.channelId, (items) => (items.some((x) => x.id === m.id) ? items : [...items, m]));
      if (typing?.[m.authorId]) {
        const { [m.authorId]: _t, ...rest } = typing;
        next.typing = { ...s.typing, [m.channelId]: rest };
      }
      // Mirror the server's read state: our own messages are read, pings raise the badge.
      const rs = s.readStates[m.channelId] ?? { channelId: m.channelId, lastReadId: null, mentionCount: 0 };
      if (m.authorId === s.me?.id) next.readStates = { ...s.readStates, [m.channelId]: { ...rs, lastReadId: m.id, mentionCount: 0 } };
      else if (pingsMe(s, m)) next.readStates = { ...s.readStates, [m.channelId]: { ...rs, mentionCount: rs.mentionCount + 1 } };
      // keep lastMessageId (unread marker, DM ordering) fresh
      const dm = s.dms[m.channelId];
      if (dm) next.dms = { ...s.dms, [dm.id]: { ...dm, lastMessageId: m.id } };
      else {
        for (const g of Object.values(s.guilds)) {
          if (g.channels.some((c) => c.id === m.channelId)) {
            Object.assign(
              next,
              patchGuild(s, g.guild.id, (x) => ({ ...x, channels: x.channels.map((c) => (c.id === m.channelId ? { ...c, lastMessageId: m.id } : c)) })),
            );
            break;
          }
        }
      }
      return next;
    }
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const d = raw as DispatchEvents['MESSAGE_REACTION_ADD'];
      const add = t === 'MESSAGE_REACTION_ADD';
      return editLog(s, d.channelId, (items) =>
        items.map((m) => {
          if (m.id !== d.messageId) return m;
          let reactions = m.reactions.map((r) =>
            r.emoji !== d.emoji
              ? r
              : { ...r, userIds: add ? (r.userIds.includes(d.userId) ? r.userIds : [...r.userIds, d.userId]) : r.userIds.filter((u) => u !== d.userId) },
          );
          if (add && !reactions.some((r) => r.emoji === d.emoji)) reactions = [...reactions, { emoji: d.emoji, userIds: [d.userId] }];
          return { ...m, reactions: reactions.filter((r) => r.userIds.length > 0) };
        }),
      );
    }
    case 'MESSAGE_ACK': {
      const r = raw as ReadState;
      return { readStates: { ...s.readStates, [r.channelId]: r } };
    }
    case 'MESSAGE_UPDATE': {
      const m = raw as Message;
      return editLog(s, m.channelId, (items) => items.map((x) => (x.id === m.id ? m : x)));
    }
    case 'MESSAGE_DELETE': {
      const d = raw as DispatchEvents['MESSAGE_DELETE'];
      return editLog(s, d.channelId, (items) => items.filter((x) => x.id !== d.id));
    }
    case 'TYPING_START': {
      const d = raw as DispatchEvents['TYPING_START'];
      return { typing: { ...s.typing, [d.channelId]: { ...s.typing[d.channelId], [d.userId]: Date.now() + 10_000 } } };
    }
    case 'PRESENCE_UPDATE': {
      const d = raw as DispatchEvents['PRESENCE_UPDATE'];
      return { presences: { ...s.presences, [d.userId]: d.status } };
    }
    case 'USER_UPDATE': {
      const u = raw as User;
      return { users: { ...s.users, [u.id]: u }, me: s.me?.id === u.id ? u : s.me };
    }
    case 'RELATIONSHIP_ADD': {
      const d = raw as DispatchEvents['RELATIONSHIP_ADD'];
      return {
        users: { ...s.users, [d.user.id]: d.user },
        relationships: { ...s.relationships, [d.relationship.userId]: d.relationship.type },
      };
    }
    case 'RELATIONSHIP_REMOVE': {
      const d = raw as DispatchEvents['RELATIONSHIP_REMOVE'];
      const { [d.userId]: _gone, ...relationships } = s.relationships;
      return { relationships };
    }
    case 'VOICE_STATE_UPDATE': {
      const v = raw as VoiceState;
      const { [v.userId]: _old, ...voice } = s.voice;
      return { voice: v.channelId ? { ...voice, [v.userId]: v } : voice };
    }
    default:
      return {};
  }
}
