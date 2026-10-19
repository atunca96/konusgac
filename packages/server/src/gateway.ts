import {
  CloseCode,
  GATEWAY_PATH,
  HEARTBEAT_INTERVAL_MS,
  Op,
  Perm,
  type Channel,
  type ClientFrame,
  type DispatchEvents,
  type DispatchName,
  type GuildCreatePayload,
  type PresenceStatus,
  type ReadyPayload,
  type ServerFrame,
  type VoiceState,
} from '@konusgac/shared';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Access } from './access';
import { hashToken } from './auth';
import type { ServerConfig } from './config';
import { id } from './http';
import type { RateLimiter } from './ratelimit';
import { RtcError, Sfu } from './sfu';
import type { Store } from './store';

const IDENTIFY_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS_PER_USER = 10;

const voiceStateFrame = z.object({
  channelId: id.nullable(),
  selfMute: z.boolean().default(false),
  selfDeaf: z.boolean().default(false),
  selfVideo: z.boolean().default(false),
  selfStream: z.boolean().default(false),
});

const rtcFrame = z.object({
  id: z.number().int(),
  method: z.string().max(32),
  data: z.unknown().optional(),
});

interface Conn {
  id: string; // gateway session ID, also the voice sessionId
  ws: WebSocket;
  userId: string | null;
  lastBeat: number;
}

// A user's live voice connection; channelId is never null while stored.
interface VoiceSession {
  state: VoiceState;
  conn: Conn;
}

export class Gateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private byUser = new Map<string, Set<Conn>>();
  private voice = new Map<string, VoiceSession>(); // by userId
  private reaper: NodeJS.Timeout;
  private closing = false; // shutting down: skip presence fan-out, the store may already be closed
  readonly sfu: Sfu; // voice and video media

  constructor(
    private store: Store,
    private access: Access,
    private limits: RateLimiter,
    private config: ServerConfig,
    private heartbeatInterval = HEARTBEAT_INTERVAL_MS,
  ) {
    this.reaper = setInterval(() => this.reap(), this.heartbeatInterval);
    this.reaper.unref();
    this.sfu = new Sfu(config, (userId, event) => {
      const session = this.voice.get(userId);
      if (session) this.send(session.conn, { op: Op.Dispatch, t: 'RTC_EVENT', d: event });
    });
  }

  attach(server: Server, trustProxy = false) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== GATEWAY_PATH) {
        socket.destroy();
        return;
      }
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
      const ip = forwarded || req.socket.remoteAddress || '?';
      if (this.limits.take('gatewayConnections', ip) > 0) {
        socket.end(['HTTP/1.1 429 Too Many Requests', 'Connection: close', '', ''].join(String.fromCharCode(13, 10)));
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  close() {
    this.closing = true;
    clearInterval(this.reaper);
    this.sfu.close();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  // ---------- connection lifecycle ----------

  private onConnection(ws: WebSocket) {
    const conn: Conn = { id: randomUUID(), ws, userId: null, lastBeat: Date.now() };
    this.send(conn, { op: Op.Hello, d: { heartbeatInterval: this.heartbeatInterval } });

    const identifyTimer = setTimeout(() => {
      if (!conn.userId) ws.close(CloseCode.NotAuthenticated, 'Kimlik doğrulama zaman aşımı');
    }, IDENTIFY_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame;
      } catch {
        return;
      }
      // A flooding client is cut off; the app reconnects after a backoff. Joining a busy call takes
      // many voice-server requests at once, so those have their own, larger allowance.
      if (this.limits.take(frame?.op === Op.Rtc ? 'rtcRequests' : 'gatewayFrames', conn.id) > 0) {
        ws.close(CloseCode.RateLimited, 'Çok fazla istek');
        return;
      }
      if (frame.op === Op.Heartbeat) {
        conn.lastBeat = Date.now();
        this.send(conn, { op: Op.HeartbeatAck });
      } else if (frame.op === Op.Identify && !conn.userId) {
        clearTimeout(identifyTimer);
        this.identify(conn, typeof frame.d?.token === 'string' ? frame.d.token : '');
      } else if (frame.op === Op.VoiceStateUpdate && conn.userId) {
        this.onVoiceStateUpdate(conn, frame.d);
      } else if (frame.op === Op.Rtc && conn.userId) {
        this.onRtc(conn, frame.d);
      }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimer);
      if (conn.userId && !this.closing) this.unregister(conn);
    });
  }

  private identify(conn: Conn, token: string) {
    const userId = this.store.sessionUserId(hashToken(token));
    if (!userId) {
      this.send(conn, { op: Op.InvalidSession });
      conn.ws.close(CloseCode.AuthFailed, 'Geçersiz oturum');
      return;
    }
    const existing = this.byUser.get(userId);
    if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
      conn.ws.close(CloseCode.RateLimited, 'Bu hesapla çok fazla açık bağlantı var');
      return;
    }
    conn.userId = userId;
    const wasOnline = this.isOnline(userId);
    const set = existing ?? new Set();
    set.add(conn);
    this.byUser.set(userId, set);

    this.send(conn, { op: Op.Dispatch, t: 'READY', d: this.buildReady(userId, conn.id) });
    if (!wasOnline) this.broadcastPresence(userId, 'online');
  }

  private unregister(conn: Conn) {
    const userId = conn.userId!;
    if (this.voice.get(userId)?.conn === conn) this.leaveVoice(userId);
    const set = this.byUser.get(userId);
    set?.delete(conn);
    if (set && set.size === 0) {
      this.byUser.delete(userId);
      this.broadcastPresence(userId, 'offline');
    }
  }

  private reap() {
    const deadline = Date.now() - this.heartbeatInterval * 2;
    for (const set of this.byUser.values()) {
      for (const conn of set) {
        if (conn.lastBeat < deadline) conn.ws.close(CloseCode.HeartbeatTimeout, 'Kalp atışı alınamadı');
      }
    }
  }

  // Closes every connection of a user, e.g. after the account was deleted.
  disconnectUser(userId: string) {
    this.leaveVoice(userId);
    for (const conn of this.byUser.get(userId) ?? []) conn.ws.close(CloseCode.AuthFailed, 'Oturum sonlandı');
  }

  // ---------- state snapshots ----------

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  presences(userIds: Iterable<string>): Record<string, PresenceStatus> {
    const out: Record<string, PresenceStatus> = {};
    for (const id of userIds) out[id] = this.isOnline(id) ? 'online' : 'offline';
    return out;
  }

  buildReady(userId: string, sessionId: string): ReadyPayload {
    const related = this.store.relatedUserIds(userId);
    const guildIds = this.store.guildIdsForUser(userId);
    return {
      sessionId,
      user: this.store.user(userId)!,
      guilds: guildIds.map((id) => this.access.filterGuildState(this.store.guildState(id)!, userId)),
      voiceStates: guildIds.flatMap((id) => this.visibleVoiceStates(id, userId)),
      dmChannels: this.store.dmChannels(userId),
      relationships: this.store.relationships(userId),
      users: this.store.users(related),
      presences: this.presences(related),
      readStates: this.store.readStates(userId),
    };
  }

  guildSnapshotFor(guildId: string, userId: string): GuildCreatePayload | undefined {
    const state = this.store.guildState(guildId);
    if (!state) return undefined;
    const userIds = state.members.map((m) => m.userId);
    return {
      ...this.access.filterGuildState(state, userId),
      users: this.store.users(userIds),
      presences: this.presences(userIds),
      voiceStates: this.visibleVoiceStates(guildId, userId),
    };
  }

  // ---------- dispatch ----------

  private send(conn: Conn, frame: ServerFrame) {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  dispatch<K extends DispatchName>(userIds: Iterable<string>, t: K, d: DispatchEvents[K]) {
    const frame = JSON.stringify({ op: Op.Dispatch, t, d });
    for (const id of new Set(userIds)) {
      for (const conn of this.byUser.get(id) ?? []) {
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(frame);
      }
    }
  }

  toGuild<K extends DispatchName>(guildId: string, t: K, d: DispatchEvents[K]) {
    this.dispatch(this.store.memberUserIds(guildId), t, d);
  }

  toViewers<K extends DispatchName>(channel: Channel, t: K, d: DispatchEvents[K], except?: string) {
    this.dispatch(
      this.access.viewers(channel).filter((id) => id !== except),
      t,
      d,
    );
  }

  // Resend each connected member their own filtered view of a guild, e.g. after
  // a role or overwrite change that can alter channel visibility.
  resyncGuild(guildId: string) {
    this.syncVoice(guildId);
    for (const userId of this.store.memberUserIds(guildId)) {
      if (!this.isOnline(userId)) continue;
      const snapshot = this.guildSnapshotFor(guildId, userId);
      if (snapshot) this.dispatch([userId], 'GUILD_CREATE', snapshot);
    }
  }

  private broadcastPresence(userId: string, status: PresenceStatus) {
    this.dispatch(this.store.relatedUserIds(userId), 'PRESENCE_UPDATE', { userId, status });
  }

  // ---------- voice ----------

  // Voice states of a guild whose channel the user can see.
  visibleVoiceStates(guildId: string, userId: string): VoiceState[] {
    const out: VoiceState[] = [];
    for (const { state } of this.voice.values()) {
      if (state.guildId !== guildId) continue;
      const channel = this.store.channel(state.channelId!);
      if (channel && this.access.can(channel, userId, Perm.ViewChannel)) out.push(state);
    }
    return out;
  }

  private onVoiceStateUpdate(conn: Conn, raw: unknown) {
    const parsed = voiceStateFrame.safeParse(raw);
    if (!parsed.success) return;
    const { channelId, selfMute, selfDeaf, selfVideo, selfStream } = parsed.data;
    const userId = conn.userId!;
    // Leaving works from any of the user's connections, e.g. another tab.
    if (channelId === null) return this.leaveVoice(userId);

    const channel = this.store.channel(channelId);
    if (!channel || channel.type !== 'voice' || !this.access.can(channel, userId, Perm.ViewChannel)) {
      return this.voiceError(conn, channelId, 'Sesli kanal bulunamadı');
    }
    if (!this.access.can(channel, userId, Perm.Connect)) {
      return this.voiceError(conn, channelId, 'Bu sesli kanala bağlanma iznin yok');
    }
    const prev = this.voice.get(userId)?.state;
    const state: VoiceState = {
      userId,
      guildId: channel.guildId!,
      channelId,
      sessionId: conn.id,
      selfMute,
      selfDeaf,
      // Camera and screen need the Stream permission; without it the flags stay off for everyone.
      selfVideo: selfVideo && this.access.can(channel, userId, Perm.Stream),
      selfStream: selfStream && this.access.can(channel, userId, Perm.Stream),
      suppress: !this.access.can(channel, userId, Perm.Speak),
    };
    // Moving to another channel, or another tab taking over, starts the media from scratch;
    // turning the camera or screen off stops sending it even if the client forgets to.
    const prevConn = this.voice.get(userId)?.conn;
    if (prev && (prev.channelId !== channelId || prevConn !== conn)) this.sfu.leave(userId);
    else if (prev) this.sfu.stopSources(userId, [...(state.selfVideo ? [] : ['camera' as const]), ...(state.selfStream ? [] : ['screen' as const, 'screenAudio' as const])]);
    this.voice.set(userId, { state, conn });
    this.announceVoice(state, prev);
  }

  // A request to the voice server, from the connection that holds the user's voice session.
  private onRtc(conn: Conn, raw: unknown) {
    const parsed = rtcFrame.safeParse(raw);
    const requestId = parsed.data?.id ?? (raw as { id?: unknown })?.id;
    if (typeof requestId !== 'number') return;
    const reply = (d: { data?: unknown; error?: string }) => this.send(conn, { op: Op.Dispatch, t: 'RTC_RESPONSE', d: { id: requestId, ...d } });
    if (!parsed.success) return reply({ error: 'Geçersiz istek' }); // answered, so the client never waits forever
    const { method, data } = parsed.data;
    const session = this.voice.get(conn.userId!);
    const channel = session && this.store.channel(session.state.channelId!);
    if (!session || session.conn !== conn || !channel) return reply({ error: 'Sesli kanalda değilsin' });
    const allowed = { speak: !session.state.suppress, stream: this.access.can(channel, conn.userId!, Perm.Stream) };
    this.sfu.request(conn.userId!, channel.id, allowed, method, data).then(
      (result) => reply({ data: result }),
      (err: unknown) => {
        if (!(err instanceof RtcError)) console.error('Ses sunucusu isteği başarısız', method, err);
        reply({ error: err instanceof RtcError ? err.message : 'Ses sunucusunda bir hata oluştu' });
      },
    );
  }

  private voiceError(conn: Conn, channelId: string | null, message: string) {
    this.send(conn, { op: Op.Dispatch, t: 'VOICE_ERROR', d: { channelId, message } });
  }

  leaveVoice(userId: string) {
    const session = this.voice.get(userId);
    if (!session) return;
    this.voice.delete(userId);
    this.sfu.leave(userId);
    this.announceVoice({ ...session.state, channelId: null }, session.state);
  }

  // Sends a voice state to everyone who can see its channel (and the user's own
  // connections). Viewers of the previous channel who cannot see the new one are
  // told the user left instead, so a hidden channel's ID never leaks.
  private announceVoice(state: VoiceState, prev?: VoiceState) {
    const next = state.channelId ? this.store.channel(state.channelId) : undefined;
    const recipients = new Set(next ? this.access.viewers(next) : []);
    recipients.add(state.userId);
    this.dispatch(recipients, 'VOICE_STATE_UPDATE', state);
    if (prev?.channelId && prev.channelId !== state.channelId) {
      const old = this.store.channel(prev.channelId);
      const oldViewers = old ? this.access.viewers(old) : this.store.memberUserIds(prev.guildId);
      this.dispatch(
        oldViewers.filter((id) => !recipients.has(id)),
        'VOICE_STATE_UPDATE',
        { ...prev, channelId: null },
      );
    }
  }

  // Re-checks every voice session in a guild after channels, roles, overwrites or
  // membership changed: disconnects users who may no longer connect and updates
  // the Speak-based suppress flag and the Stream-based camera and screen flags.
  syncVoice(guildId: string) {
    for (const [userId, session] of this.voice) {
      if (session.state.guildId !== guildId) continue;
      const channel = this.store.channel(session.state.channelId!);
      if (!channel || !this.access.can(channel, userId, Perm.ViewChannel | Perm.Connect)) {
        this.leaveVoice(userId);
        continue;
      }
      const suppress = !this.access.can(channel, userId, Perm.Speak);
      const stream = this.access.can(channel, userId, Perm.Stream);
      const selfVideo = session.state.selfVideo && stream;
      const selfStream = session.state.selfStream && stream;
      const st = session.state;
      this.sfu.enforce(userId, { speak: !suppress, stream });
      if (suppress !== st.suppress || selfVideo !== st.selfVideo || selfStream !== st.selfStream) {
        session.state = { ...st, suppress, selfVideo, selfStream };
        this.announceVoice(session.state);
      }
    }
  }
}
