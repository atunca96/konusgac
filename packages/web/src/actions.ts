import { api, setToken } from './api';
import { connect, disconnect } from './connection';
import { getSettings } from './settings';
import { channelById, getState, isUnread, mentionCount, resetState, setState } from './state';
import { resetVoice } from './voice';

export function startSession(token: string) {
  setToken(token);
  connect(() => endSession());
}

export async function logout() {
  try {
    await api.logout();
  } catch {
    // token may already be invalid; clear locally regardless
  }
  endSession();
}

function endSession() {
  resetVoice();
  disconnect();
  setToken(null);
  resetState();
}

// ---------- navigation (mirrored in the URL hash: #/<guildId|@me>/<channelId>) ----------

export function navigate(guildId: string, channelId: string | null = null) {
  if (guildId !== '@me' && !channelId) channelId = defaultChannel(guildId);
  setState(() => ({ view: { guildId, channelId } }));
  const hash = `#/${guildId}${channelId ? `/${channelId}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  // A voice channel opens the call view, which has no messages.
  if (channelId && channelById(getState(), channelId)?.type !== 'voice') {
    void ensureMessages(channelId);
    markRead(channelId);
  }
}

// ---------- read state ----------

const pendingAcks = new Map<string, number>();

// Marks a channel read up to its newest message: at once locally, on the server shortly after
// (several quick calls become one request).
export function markRead(channelId: string) {
  const s = getState();
  const channel = channelById(s, channelId);
  if (!channel?.lastMessageId || (!isUnread(s, channel) && mentionCount(s, channelId) === 0)) return;
  const lastReadId = channel.lastMessageId;
  setState((st) => ({ readStates: { ...st.readStates, [channelId]: { channelId, lastReadId, mentionCount: 0 } } }));
  clearTimeout(pendingAcks.get(channelId));
  pendingAcks.set(
    channelId,
    window.setTimeout(() => {
      pendingAcks.delete(channelId);
      void api.ack(channelId, lastReadId).catch(() => {});
    }, 400),
  );
}

// The open channel counts as read only while the window has focus.
export function markViewRead() {
  const id = getState().view.channelId;
  if (id && document.hasFocus()) markRead(id);
}

// ---------- emoticons ----------

const EMOTICONS: [RegExp, string][] = [
  [/(^|\s):-?\)(?=\s|$)/g, '$1🙂'],
  [/(^|\s):-?\((?=\s|$)/g, '$1🙁'],
  [/(^|\s):-?D(?=\s|$)/g, '$1😃'],
  [/(^|\s);-?\)(?=\s|$)/g, '$1😉'],
  [/(^|\s):-?[pP](?=\s|$)/g, '$1😛'],
  [/(^|\s):-?[oO](?=\s|$)/g, '$1😮'],
  [/(^|\s)<3(?=\s|$)/g, '$1❤️'],
  [/(^|\s):'\((?=\s|$)/g, '$1😢'],
];

// ":)" → "🙂" outside code, when the setting is on.
export function convertEmoticons(text: string): string {
  if (!getSettings().convertEmoticons) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : EMOTICONS.reduce((t, [re, to]) => t.replace(re, to), part)))
    .join('');
}

// ---------- mentions ----------

// Members who can be mentioned in a channel: the guild's members, or the DM's two people.
export function mentionCandidates(channelId: string): { id: string; username: string; displayName: string }[] {
  const s = getState();
  const channel = channelById(s, channelId);
  if (!channel) return [];
  const ids = channel.guildId ? (s.guilds[channel.guildId]?.members.map((m) => m.userId) ?? []) : channel.recipientIds;
  return ids.map((id) => s.users[id]).filter((u) => !!u).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }));
}

// "@ayse" → "<@123>" for people who can be mentioned here; anything else stays as typed.
export function encodeMentions(channelId: string, text: string): string {
  const byName = new Map(mentionCandidates(channelId).map((u) => [u.username.toLowerCase(), u.id]));
  return text.replace(/(^|[^\w@<])@([a-zA-Z0-9_.]{2,32})/g, (all, pre: string, name: string) => {
    const id = byName.get(name.toLowerCase());
    return id ? `${pre}<@${id}>` : all;
  });
}

// "<@123>" → "@ayse" for editing.
export function decodeMentions(text: string): string {
  const users = getState().users;
  return text.replace(/<@(\d{1,20})>/g, (all, id: string) => (users[id] ? `@${users[id].username}` : all));
}

// #/<guild>/<channel>[/<message>]: a message link also scrolls to the message once it is loaded.
let pendingJump: { channelId: string; messageId: string } | null = null;

export function navigateFromHash() {
  const [, guildId = '@me', channelId = null, messageId] = location.hash.split('/');
  setState(() => ({ view: { guildId, channelId } }));
  if (channelId && messageId && /^\d{1,20}$/.test(messageId)) pendingJump = { channelId, messageId };
}

// The message to jump to in this channel, if it is among the loaded ones (used once).
export function takePendingJump(channelId: string, loaded: string[]): string | null {
  if (!pendingJump || pendingJump.channelId !== channelId) return null;
  if (!loaded.includes(pendingJump.messageId)) {
    // Older than what is loaded: load more, a few pages at most.
    const oldest = loaded[0];
    if (oldest && BigInt(pendingJump.messageId) < BigInt(oldest) && (jumpTries += 1) <= 5) void loadOlder(channelId);
    return null;
  }
  const id = pendingJump.messageId;
  pendingJump = null;
  jumpTries = 0;
  return id;
}
let jumpTries = 0;

// Following a Konuşgaç link inside the app (#/… in the address) opens it in place.
window.addEventListener('hashchange', () => {
  const before = getState().view;
  navigateFromHash();
  const v = getState().view;
  if (v.guildId !== before.guildId || v.channelId !== before.channelId) navigate(v.guildId, v.channelId);
});

function defaultChannel(guildId: string): string | null {
  const g = getState().guilds[guildId];
  return g?.channels.find((c) => c.type === 'text')?.id ?? null;
}

// ---------- messages ----------

export async function ensureMessages(channelId: string) {
  const s = getState();
  if (s.messages[channelId]) return;
  await loadOlder(channelId);
}

export async function loadOlder(channelId: string) {
  const log = getState().messages[channelId];
  if (log?.loading || (log && !log.hasMore)) return;
  setState((s) => ({
    messages: { ...s.messages, [channelId]: { items: log?.items ?? [], hasMore: true, loading: true } },
  }));
  try {
    const page = await api.messages(channelId, log?.items[0]?.id);
    setState((s) => {
      const cur = s.messages[channelId]?.items ?? [];
      const known = new Set(cur.map((m) => m.id));
      return {
        messages: {
          ...s.messages,
          [channelId]: { items: [...page.filter((m) => !known.has(m.id)), ...cur], hasMore: page.length >= 50, loading: false },
        },
      };
    });
  } catch {
    setState((s) => ({ messages: { ...s.messages, [channelId]: { items: log?.items ?? [], hasMore: true, loading: false } } }));
  }
}

export async function openDmWith(userId: string) {
  const channel = await api.openDm(userId);
  setState((s) => ({ dms: { ...s.dms, [channel.id]: channel } }));
  navigate('@me', channel.id);
}

const lastTyping = new Map<string, number>();

export function signalTyping(channelId: string) {
  const now = Date.now();
  if (now - (lastTyping.get(channelId) ?? 0) < 8000) return;
  lastTyping.set(channelId, now);
  void api.typing(channelId).catch(() => {});
}
