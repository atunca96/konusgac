import { Op, Perm, type DispatchEvents, type DispatchName, type GuildState } from '@konusgac/shared';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import type { Gateway } from '../src/gateway';

let base = '';
let close: () => Promise<void>;
let ctxStats: () => ReturnType<Gateway['sfu']['stats']>;

before(async () => {
  const { app, gateway } = await createApp({ dbPath: ':memory:', heartbeatInterval: 60_000, rateLimits: false, config: { rtcPort: 0, rtcAddress: '127.0.0.1' } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
  ctxStats = () => gateway.sfu.stats();
});

after(() => close());

async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

class Client {
  events: { t: DispatchName; d: any }[] = [];
  private waiters: (() => void)[] = [];
  ws!: WebSocket;
  ready!: DispatchEvents['READY'];

  static async connect(token: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://${base}/gateway`);
    c.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === Op.Hello) c.ws.send(JSON.stringify({ op: Op.Identify, d: { token } }));
      if (frame.op === Op.Dispatch) {
        c.events.push({ t: frame.t, d: frame.d });
        c.waiters.splice(0).forEach((w) => w());
      }
    });
    c.ready = await c.next('READY');
    return c;
  }

  // Resolves with the first not-yet-consumed event of type t matching pred.
  async next<K extends DispatchName>(t: K, pred: (d: DispatchEvents[K]) => boolean = () => true, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.t === t && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0]!.d as DispatchEvents[K];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${t} olayı gelmedi`);
      await new Promise<void>((r) => {
        const timer = setTimeout(r, left);
        this.waiters.push(() => (clearTimeout(timer), r()));
      });
    }
  }

  has(t: DispatchName, pred: (d: any) => boolean) {
    return this.events.some((e) => e.t === t && pred(e.d));
  }

  send(op: number, d: unknown) {
    this.ws.send(JSON.stringify({ op, d }));
  }

  voice(channelId: string | null, selfMute = false, selfDeaf = false) {
    this.send(Op.VoiceStateUpdate, { channelId, selfMute, selfDeaf });
  }

  // A voice-server request; resolves with its RTC_RESPONSE.
  private rtcSeq = 0;
  async rtc(method: string, data?: unknown) {
    const id = ++this.rtcSeq;
    this.send(Op.Rtc, { id, method, data });
    return this.next('RTC_RESPONSE', (d) => d.id === id, 15_000);
  }

  close() {
    this.ws.close();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test('Konuşgaç uçtan uca akış', async () => {
  // --- accounts ---
  const a = await api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ayse', password: 'gizli-sifre-1', displayName: 'Ayşe' });
  assert.equal(a.status, 201);
  const b = await api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'baris', password: 'gizli-sifre-2' });
  assert.equal(b.status, 201);
  assert.equal((await api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'AYSE', password: 'baska-sifre-9' })).status, 409);
  assert.equal((await api('POST', '/auth/login', undefined, { username: 'ayse', password: 'yanlis-sifre' })).status, 401);
  const login = await api('POST', '/auth/login', undefined, { username: 'ayse', password: 'gizli-sifre-1' });
  assert.equal(login.status, 200);

  const ayse = { token: a.data.token as string, id: a.data.user.id as string };
  const baris = { token: b.data.token as string, id: b.data.user.id as string };

  const wsA = await Client.connect(ayse.token);
  const wsB = await Client.connect(baris.token);

  // --- guild + invite ---
  const g = await api<GuildState>('POST', '/guilds', ayse.token, { name: 'Kod Kulübü' });
  assert.equal(g.status, 201);
  const guildId = g.data.guild.id;
  const genel = g.data.channels.find((c) => c.name === 'genel')!;
  assert.ok(genel, '#genel kanalı oluşturulmalı');
  await wsA.next('GUILD_CREATE', (d) => d.guild.id === guildId);

  const inv = await api('POST', `/channels/${genel.id}/invites`, ayse.token, {});
  assert.equal(inv.status, 201);
  const preview = await api('GET', `/invites/${inv.data.code}`);
  assert.equal(preview.data.guild.name, 'Kod Kulübü');
  assert.equal((await api('POST', `/invites/${inv.data.code}`, baris.token)).status, 200);
  await wsB.next('GUILD_CREATE', (d) => d.guild.id === guildId);
  await wsA.next('GUILD_MEMBER_ADD', (d) => d.user.id === baris.id);

  // --- messaging ---
  const msg = await api('POST', `/channels/${genel.id}/messages`, baris.token, { content: 'Merhaba herkese!' });
  assert.equal(msg.status, 201);
  await wsA.next('MESSAGE_CREATE', (d) => d.content === 'Merhaba herkese!');
  assert.equal((await api('PATCH', `/channels/${genel.id}/messages/${msg.data.id}`, ayse.token, { content: 'x' })).status, 403);
  assert.equal((await api('POST', `/channels/${genel.id}/messages`, baris.token, { content: '   ' })).status, 400);
  const hist = await api('GET', `/channels/${genel.id}/messages`, ayse.token);
  assert.deepEqual(hist.data.map((m: any) => m.content), ['Merhaba herkese!']);

  // --- private channel via @everyone deny overwrite ---
  const gizli = await api('POST', `/guilds/${guildId}/channels`, ayse.token, { name: 'Yönetim Odası' });
  assert.equal(gizli.data.name, 'yönetim-odası');
  await api('PATCH', `/channels/${gizli.data.id}`, ayse.token, {
    overwrites: [{ roleId: guildId, allow: 0, deny: Perm.ViewChannel }],
  });
  const resync = await wsB.next('GUILD_CREATE', (d) => d.guild.id === guildId && !d.channels.some((c) => c.id === gizli.data.id));
  assert.ok(resync);
  assert.equal((await api('GET', `/channels/${gizli.data.id}/messages`, baris.token)).status, 404);
  await api('POST', `/channels/${gizli.data.id}/messages`, ayse.token, { content: 'gizli not' });
  await settle();
  assert.ok(!wsB.has('MESSAGE_CREATE', (d) => d.content === 'gizli not'), 'Barış gizli mesajı görmemeli');

  // grant access with a role overwrite
  const role = await api('POST', `/guilds/${guildId}/roles`, ayse.token, { name: 'Moderatör', color: '#e8590c', permissions: 0 });
  assert.equal(role.status, 201);
  await api('PATCH', `/channels/${gizli.data.id}`, ayse.token, {
    overwrites: [
      { roleId: guildId, allow: 0, deny: Perm.ViewChannel },
      { roleId: role.data.id, allow: Perm.ViewChannel, deny: 0 },
    ],
  });
  assert.equal((await api('PATCH', `/guilds/${guildId}/members/${baris.id}`, ayse.token, { roleIds: [role.data.id] })).status, 200);
  await wsB.next('GUILD_CREATE', (d) => d.channels.some((c) => c.id === gizli.data.id));
  assert.equal((await api('GET', `/channels/${gizli.data.id}/messages`, baris.token)).status, 200);

  // --- authorization ---
  assert.equal((await api('DELETE', `/guilds/${guildId}/members/${ayse.id}`, baris.token)).status, 403);
  assert.equal((await api('POST', `/guilds/${guildId}/roles`, baris.token, { name: 'hile' })).status, 403);
  assert.equal((await api('DELETE', `/guilds/${guildId}`, baris.token)).status, 403);
  assert.equal((await api('GET', '/users/@me')).status, 401);

  // --- friends & DM ---
  assert.equal((await api('POST', '/users/@me/relationships', baris.token, { username: 'ayse' })).status, 204);
  await wsA.next('RELATIONSHIP_ADD', (d) => d.relationship.type === 'incoming');
  assert.equal((await api('POST', '/users/@me/relationships', ayse.token, { userId: baris.id })).status, 204);
  await wsB.next('RELATIONSHIP_ADD', (d) => d.relationship.type === 'friend');
  const dm = await api('POST', '/users/@me/channels', ayse.token, { recipientId: baris.id });
  assert.equal(dm.data.type, 'dm');
  await wsB.next('CHANNEL_CREATE', (d) => d.id === dm.data.id);
  await api('POST', `/channels/${dm.data.id}/messages`, ayse.token, { content: 'Selam Barış' });
  await wsB.next('MESSAGE_CREATE', (d) => d.channelId === dm.data.id);
  assert.equal((await api('POST', '/users/@me/channels', ayse.token, { recipientId: baris.id })).data.id, dm.data.id);

  // --- presence ---
  wsB.close();
  await wsA.next('PRESENCE_UPDATE', (d) => d.userId === baris.id && d.status === 'offline');

  // --- leave ---
  assert.equal((await api('DELETE', `/guilds/${guildId}/members/@me`, ayse.token)).status, 400);
  assert.equal((await api('DELETE', `/guilds/${guildId}/members/@me`, baris.token)).status, 204);
  await wsA.next('GUILD_MEMBER_REMOVE', (d) => d.userId === baris.id);

  wsA.close();
});

test('sesli kanallar: durum, izinler ve sinyal iletimi', async () => {
  const reg = async (username: string) => {
    const r = await api('POST', '/auth/register', undefined, { acceptTerms: true, username, password: 'ses-sifresi-1' });
    assert.equal(r.status, 201);
    return { token: r.data.token as string, id: r.data.user.id as string };
  };
  const cem = await reg('cem');
  const deniz = await reg('deniz');
  const wsC = await Client.connect(cem.token);
  const wsD = await Client.connect(deniz.token);

  const g = await api<GuildState>('POST', '/guilds', cem.token, { name: 'Ses Odası' });
  const guildId = g.data.guild.id;
  const genel = g.data.channels.find((c) => c.type === 'text')!;
  const lobi = g.data.channels.find((c) => c.type === 'voice')!;
  assert.ok(lobi, 'varsayılan sesli kanal oluşturulmalı');
  assert.equal(lobi.name, 'Genel');
  const inv = await api('POST', `/channels/${lobi.id}/invites`, cem.token, {});
  assert.equal(inv.status, 201, 'sesli kanaldan davet oluşturulabilmeli');
  await api('POST', `/invites/${inv.data.code}`, deniz.token);
  await wsD.next('GUILD_CREATE', (d) => d.guild.id === guildId);

  // voice channels take no messages
  assert.equal((await api('POST', `/channels/${lobi.id}/messages`, cem.token, { content: 'selam' })).status, 400);
  const yeni = await api('POST', `/guilds/${guildId}/channels`, cem.token, { name: 'Oyun Odası', type: 'voice', parentId: lobi.parentId });
  assert.equal(yeni.status, 201);
  assert.equal(yeni.data.name, 'Oyun Odası');
  assert.equal(yeni.data.parentId, lobi.parentId);

  // --- join: everyone who can see the channel learns about it ---
  wsC.voice(lobi.id);
  const cJoined = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === cem.id && d.channelId === lobi.id);
  assert.equal(cJoined.suppress, false);
  await wsD.next('VOICE_STATE_UPDATE', (d) => d.userId === cem.id && d.channelId === lobi.id);

  // a fresh connection sees current voice states in READY
  const wsD2 = await Client.connect(deniz.token);
  assert.ok(wsD2.ready.voiceStates.some((v) => v.userId === cem.id && v.channelId === lobi.id));
  assert.notEqual(wsD2.ready.sessionId, wsD.ready.sessionId);
  wsD2.close();
  // ...and so does a guild snapshot
  const snap = await api('POST', `/invites/${inv.data.code}`, deniz.token);
  assert.ok(snap.data.voiceStates.some((v: any) => v.userId === cem.id && v.channelId === lobi.id));

  wsD.voice(lobi.id, true, false);
  const dJoined = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === lobi.id);
  assert.equal(dJoined.selfMute, true);
  await wsD.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === lobi.id);

  // --- voice server: the room's codecs, a media connection on the one RTC port ---
  const joined = (await wsC.rtc('join')) as { data: any };
  assert.ok(joined.data.rtpCapabilities.codecs.some((c: any) => c.mimeType === 'audio/opus'));
  assert.deepEqual(joined.data.producers, []);
  const transport = (await wsC.rtc('createTransport', { direction: 'send' })).data as any;
  assert.ok(transport.iceCandidates.some((c: any) => c.protocol === 'udp' && c.address === '127.0.0.1'));
  assert.ok(transport.iceCandidates.some((c: any) => c.protocol === 'tcp'), 'UDP kapalı ağlar için TCP de olmalı');
  assert.match((await wsC.rtc('produce', { transportId: 'yok', source: 'mic', rtpParameters: {} })).error ?? '', /Gönderme/);
  assert.match((await wsC.rtc('uydurma')).error ?? '', /Bilinmeyen/);
  assert.match((await wsC.rtc('createTransport', { direction: 'yan' })).error ?? '', /Geçersiz/);
  assert.equal(ctxStats().find((r) => r.channelId === lobi.id)?.peers.length, 1);

  // --- camera and screen: on with the Stream permission, forced off when it is denied ---
  const media = (on: boolean, selfMute: boolean) =>
    wsD.send(Op.VoiceStateUpdate, { channelId: lobi.id, selfMute, selfDeaf: false, selfVideo: on, selfStream: on });
  media(true, true);
  const live = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.selfStream);
  assert.equal(live.selfVideo, true);
  await api('PATCH', `/channels/${lobi.id}`, cem.token, { overwrites: [{ roleId: guildId, allow: 0, deny: Perm.Stream }] });
  const cut = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && !d.selfStream);
  assert.equal(cut.selfVideo, false);
  assert.equal(cut.channelId, lobi.id, 'yayın izni gidince kanaldan atılmamalı');
  media(true, false); // asking again without the permission
  const asked = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && !d.selfMute);
  assert.equal(asked.selfVideo || asked.selfStream, false);
  await api('PATCH', `/channels/${lobi.id}`, cem.token, { overwrites: [] });
  media(false, true);
  await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.selfMute);

  // --- Speak denied: still connected, but suppressed, and the voice server refuses the microphone ---
  await api('PATCH', `/channels/${lobi.id}`, cem.token, { overwrites: [{ roleId: guildId, allow: 0, deny: Perm.Speak }] });
  const muted = await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.suppress === true);
  assert.equal(muted.channelId, lobi.id);
  const dSend = (await wsD.rtc('createTransport', { direction: 'send' })).data as any;
  assert.match((await wsD.rtc('produce', { transportId: dSend.id, source: 'mic', rtpParameters: {} })).error ?? '', /konuşma iznin yok/);
  assert.ok(!wsC.has('VOICE_STATE_UPDATE', (d) => d.userId === cem.id && d.suppress), 'sahip susturulmamalı');

  // --- Connect denied: kicked out, and new joins are refused ---
  await api('PATCH', `/channels/${lobi.id}`, cem.token, { overwrites: [{ roleId: guildId, allow: 0, deny: Perm.Connect }] });
  await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === null);
  await wsD.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === null);
  wsD.voice(lobi.id);
  assert.match((await wsD.next('VOICE_ERROR')).message, /bağlanma iznin yok/);

  // out of the channel: no voice-server access, and nothing of theirs is left there
  assert.match((await wsD.rtc('join')).error ?? '', /Sesli kanalda değilsin/);
  assert.ok(!ctxStats().some((r) => r.peers.some((p) => p.userId === deniz.id)));

  // a text channel cannot be joined
  wsD.voice(genel.id);
  assert.match((await wsD.next('VOICE_ERROR')).message, /bulunamadı/);

  // --- move between channels, then disconnect ---
  wsD.voice(yeni.data.id);
  await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === yeni.data.id);
  wsC.voice(yeni.data.id);
  await wsD.next('VOICE_STATE_UPDATE', (d) => d.userId === cem.id && d.channelId === yeni.data.id);
  wsD.close();
  await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === deniz.id && d.channelId === null);

  // deleting the channel disconnects whoever is in it
  assert.equal((await api('DELETE', `/channels/${yeni.data.id}`, cem.token)).status, 204);
  await wsC.next('VOICE_STATE_UPDATE', (d) => d.userId === cem.id && d.channelId === null);
  assert.deepEqual(ctxStats(), [], 'boşalan odalar kapanmalı');

  wsC.close();
});
