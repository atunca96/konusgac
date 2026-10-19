import { Perm, type GuildState, type Message } from '@konusgac/shared';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db';
import { PNG, settle, startServer } from './helpers';

// A server with two members in one guild; the first one owns it.
async function setup(opts: Parameters<typeof startServer>[0] = {}) {
  const srv = await startServer(opts);
  const ayse = await srv.user('ayse');
  const baris = await srv.user('baris');
  const g = await srv.api<GuildState>('POST', '/guilds', ayse.token, { name: 'Kulüp' });
  const guildId = g.data.guild.id;
  const genel = g.data.channels.find((c) => c.name === 'genel')!;
  const inv = await srv.api('POST', `/channels/${genel.id}/invites`, ayse.token, {});
  await srv.api('POST', `/invites/${inv.data.code}`, baris.token);
  return { srv, ayse, baris, guildId, genel };
}

test('dosya ekleri: yükleme, tür tespiti, güvenli sunum, silinince dosya da gider', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'konusgac-test-'));
  const { srv, ayse, baris, genel } = await setup({ dataDir });
  const wsB = await srv.gateway(baris.token);

  const res = await srv.upload<Message>(`/channels/${genel.id}/messages`, ayse.token, { content: 'resim ve not' }, [
    { name: 'kedi.png', data: PNG },
    { name: '../../not.html', data: Buffer.from('<script>alert(1)</script>') },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const [img, html] = res.data.attachments;
  assert.equal(img!.contentType, 'image/png');
  assert.equal(img!.filename, 'kedi.png');
  assert.equal(html!.filename, 'not.html', 'yol parçaları atılmalı');
  assert.equal(html!.contentType, 'application/octet-stream', 'HTML asla sayfa olarak sunulmamalı');
  await wsB.next('MESSAGE_CREATE', (m) => m.attachments.length === 2);

  const imgRes = await srv.raw(img!.url);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('content-type'), 'image/png');
  assert.match(imgRes.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), PNG);
  const htmlRes = await srv.raw(html!.url);
  assert.match(htmlRes.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await srv.raw('/attachments/AAAAAAAAAAAAAAAAAAAAAA/x.png')).status, 404);

  // Attachment-only message, and the AttachFiles permission.
  assert.equal((await srv.upload(`/channels/${genel.id}/messages`, baris.token, {}, [{ name: 'a.png', data: PNG }])).status, 201);
  await srv.api('PATCH', `/channels/${genel.id}`, ayse.token, { overwrites: [{ roleId: genel.guildId!, allow: 0, deny: Perm.AttachFiles }] });
  assert.equal((await srv.upload(`/channels/${genel.id}/messages`, baris.token, {}, [{ name: 'b.png', data: PNG }])).status, 403);

  // Size limit.
  const big = await srv.upload(`/channels/${genel.id}/messages`, ayse.token, {}, [{ name: 'big.bin', data: Buffer.alloc(11 * 1024 * 1024, 1) }]);
  assert.equal(big.status, 413);

  const dir = join(dataDir, 'attachments');
  const before = readdirSync(dir).length;
  assert.equal((await srv.api('DELETE', `/channels/${genel.id}/messages/${res.data.id}`, ayse.token)).status, 204);
  assert.equal(readdirSync(dir).length, before - 2, 'mesajla birlikte dosyaları da silinmeli');
  assert.equal((await srv.raw(img!.url)).status, 404);

  wsB.close();
  await srv.close();
});

test('yanıtlar, bahsetmeler ve okunmamış sayaçları', async () => {
  const { srv, ayse, baris, genel } = await setup();
  const wsA = await srv.gateway(ayse.token);

  const first = await srv.api<Message>('POST', `/channels/${genel.id}/messages`, ayse.token, { content: 'ilk mesaj' });
  const reply = await srv.api<Message>('POST', `/channels/${genel.id}/messages`, baris.token, {
    content: `<@${ayse.id}> katılıyorum <@99999>`,
    replyToId: first.data.id,
  });
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.data.replyTo, { id: first.data.id, authorId: ayse.id, content: 'ilk mesaj' });
  assert.deepEqual(reply.data.mentionIds, [ayse.id], 'yalnızca kanalı görebilen gerçek kullanıcılar sayılır');

  // Reply to a message in another channel is refused.
  const other = await srv.api('POST', `/guilds/${genel.guildId}/channels`, ayse.token, { name: 'diğer' });
  assert.equal(
    (await srv.api('POST', `/channels/${other.data.id}/messages`, ayse.token, { content: 'x', replyToId: first.data.id })).status,
    400,
  );

  // @everyone needs MentionEveryone: Barış cannot, the owner can.
  const e1 = await srv.api<Message>('POST', `/channels/${genel.id}/messages`, baris.token, { content: '@everyone selam' });
  assert.equal(e1.data.mentionEveryone, false);
  const e2 = await srv.api<Message>('POST', `/channels/${genel.id}/messages`, ayse.token, { content: '@everyone toplantı!' });
  assert.equal(e2.data.mentionEveryone, true);

  // Read states: Ayşe was mentioned once (+ reply), Barış once by @everyone.
  const wsB = await srv.gateway(baris.token);
  const rsB = wsB.ready.readStates.find((r) => r.channelId === genel.id)!;
  assert.equal(rsB.mentionCount, 1);
  const wsA2 = await srv.gateway(ayse.token);
  const rsA = wsA2.ready.readStates.find((r) => r.channelId === genel.id)!;
  assert.equal(rsA.lastReadId, e2.data.id, 'kendi mesajın okundu sayılır');
  assert.equal(rsA.mentionCount, 0);

  assert.equal((await srv.api('POST', `/channels/${genel.id}/ack`, baris.token, { messageId: e2.data.id })).status, 204);
  const ack = await wsB.next('MESSAGE_ACK');
  assert.deepEqual(ack, { channelId: genel.id, lastReadId: e2.data.id, mentionCount: 0 });
  assert.equal((await srv.api('POST', `/channels/${genel.id}/ack`, baris.token, { messageId: '999999999999999999' })).status, 400);
  // a normal ack never moves back; "Okunmadı olarak işaretle" (manual) does
  const older = (BigInt(e2.data.id) - 1n).toString();
  await srv.api('POST', `/channels/${genel.id}/ack`, baris.token, { messageId: older });
  assert.equal((await wsB.next('MESSAGE_ACK')).lastReadId, e2.data.id);
  await srv.api('POST', `/channels/${genel.id}/ack`, baris.token, { messageId: older, manual: true });
  assert.equal((await wsB.next('MESSAGE_ACK')).lastReadId, older);

  // Deleted reply target keeps the reference with empty fields.
  await srv.api('DELETE', `/channels/${genel.id}/messages/${first.data.id}`, ayse.token);
  const hist = await srv.api<Message[]>('GET', `/channels/${genel.id}/messages`, ayse.token);
  assert.deepEqual(hist.data.find((m) => m.id === reply.data.id)!.replyTo, { id: first.data.id, authorId: null, content: null });

  // DM: every message counts for the recipient.
  const dm = await srv.api('POST', '/users/@me/channels', ayse.token, { recipientId: baris.id });
  await srv.api('POST', `/channels/${dm.data.id}/messages`, ayse.token, { content: 'özel' });
  const wsB2 = await srv.gateway(baris.token);
  assert.equal(wsB2.ready.readStates.find((r) => r.channelId === dm.data.id)?.mentionCount, 1);

  for (const c of [wsA, wsA2, wsB, wsB2]) c.close();
  await srv.close();
});

test('tepkiler', async () => {
  const { srv, ayse, baris, genel } = await setup();
  const wsA = await srv.gateway(ayse.token);
  const m = await srv.api<Message>('POST', `/channels/${genel.id}/messages`, ayse.token, { content: 'beğenin' });
  const path = (e: string) => `/channels/${genel.id}/messages/${m.data.id}/reactions/${encodeURIComponent(e)}/@me`;

  assert.equal((await srv.api('PUT', path('👍'), baris.token)).status, 204);
  await wsA.next('MESSAGE_REACTION_ADD', (d) => d.emoji === '👍' && d.userId === baris.id);
  assert.equal((await srv.api('PUT', path('👍'), baris.token)).status, 204, 'tekrar eklemek sorun değil');
  assert.equal((await srv.api('PUT', path('👍🏽'), ayse.token)).status, 204, 'ten rengi');
  assert.equal((await srv.api('PUT', path('🇹🇷'), ayse.token)).status, 204, 'bayrak');
  assert.equal((await srv.api('PUT', path('abc'), ayse.token)).status, 400);
  assert.equal((await srv.api('PUT', path('1'), ayse.token)).status, 400);

  const msg = (await srv.api<Message[]>('GET', `/channels/${genel.id}/messages`, ayse.token)).data[0]!;
  assert.deepEqual(msg.reactions.map((r) => [r.emoji, r.userIds.length]), [['👍', 1], ['👍🏽', 1], ['🇹🇷', 1]]);

  // Without AddReactions Barış may join an existing reaction but not start a new one.
  await srv.api('PATCH', `/channels/${genel.id}`, ayse.token, { overwrites: [{ roleId: genel.guildId!, allow: 0, deny: Perm.AddReactions }] });
  assert.equal((await srv.api('PUT', path('🇹🇷'), baris.token)).status, 204);
  assert.equal((await srv.api('PUT', path('🎉'), baris.token)).status, 403);

  assert.equal((await srv.api('DELETE', path('👍'), baris.token)).status, 204);
  await wsA.next('MESSAGE_REACTION_REMOVE', (d) => d.emoji === '👍');
  wsA.close();
  await srv.close();
});

test('arama: Türkçe büyük/küçük harf, izinler, sayfalama', async () => {
  const { srv, ayse, baris, guildId, genel } = await setup();
  await srv.api('POST', `/channels/${genel.id}/messages`, ayse.token, { content: 'İstanbul toplantısı ISPARTA' });
  await srv.api('POST', `/channels/${genel.id}/messages`, ayse.token, { content: 'istanbul ve ılık hava' });
  await srv.api('POST', `/channels/${genel.id}/messages`, ayse.token, { content: '100% indirim_kodu' });
  const gizli = await srv.api('POST', `/guilds/${guildId}/channels`, ayse.token, { name: 'gizli' });
  await srv.api('PATCH', `/channels/${gizli.data.id}`, ayse.token, { overwrites: [{ roleId: guildId, allow: 0, deny: Perm.ViewChannel }] });
  await srv.api('POST', `/channels/${gizli.data.id}/messages`, ayse.token, { content: 'istanbul gizli plan' });

  const q = (who: string, query: string, extra = '') =>
    srv.api('GET', `/search?q=${encodeURIComponent(query)}&guildId=${guildId}${extra}`, who);
  assert.equal((await q(ayse.token, 'İSTANBUL')).data.messages.length, 3);
  assert.equal((await q(baris.token, 'istanbul')).data.messages.length, 2, 'gizli kanal aramada görünmez');
  assert.equal((await q(baris.token, 'ısparta')).data.messages.length, 1, 'I → ı');
  assert.equal((await q(baris.token, 'istanbul hava')).data.messages.length, 1, 'tüm kelimeler');
  assert.equal((await q(baris.token, '%')).data.messages.length, 1, '% joker değil');
  assert.equal((await q(baris.token, '_')).data.messages.length, 1, '_ joker değil');
  assert.equal((await srv.api('GET', `/search?q=x&guildId=1234`, baris.token)).status, 404);

  for (let i = 0; i < 30; i++) await srv.api('POST', `/channels/${genel.id}/messages`, ayse.token, { content: `sayfa ${i}` });
  const p1 = await q(baris.token, 'sayfa');
  assert.equal(p1.data.messages.length, 25);
  assert.equal(p1.data.hasMore, true);
  const p2 = await q(baris.token, 'sayfa', `&before=${p1.data.messages.at(-1).id}`);
  assert.equal(p2.data.messages.length, 5);
  assert.equal(p2.data.hasMore, false);
  await srv.close();
});

test('hız sınırları: giriş denemeleri, mesaj seli, gateway', async () => {
  const srv = await startServer({ rateLimits: { login: { limit: 3, windowMs: 60_000 }, message: { limit: 3, windowMs: 60_000 } } });
  const u = await srv.user('deneme');
  for (let i = 0; i < 3; i++) assert.equal((await srv.api('POST', '/auth/login', undefined, { username: 'deneme', password: 'yanlis-1234' })).status, 401);
  const blocked = await srv.api('POST', '/auth/login', undefined, { username: 'deneme', password: u.password });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  const g = await srv.api<GuildState>('POST', '/guilds', u.token, { name: 'X' });
  const ch = g.data.channels.find((c) => c.type === 'text')!;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await srv.api('POST', `/channels/${ch.id}/messages`, u.token, { content: `m${i}` })).status);
  assert.deepEqual(codes, [201, 201, 201, 429]);

  // A client that floods the gateway is disconnected.
  const flood = await startServer({ rateLimits: { gatewayFrames: { limit: 5, windowMs: 60_000 } } });
  const fu = await flood.user('sel');
  const c = await flood.gateway(fu.token);
  for (let i = 0; i < 10; i++) c.ws.send(JSON.stringify({ op: 1 }));
  assert.equal(await c.closed(), 4008);
  await flood.close();
  await srv.close();
});

test('hesap: kayıt kapatma, şifre değiştirme, hesap silme, sunucu devri', async () => {
  const closed = await startServer({ config: { registration: 'closed' } });
  assert.equal((await closed.api('GET', '/config')).data.registration, 'closed');
  assert.equal((await closed.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'yeni', password: 'gizli-sifre-1' })).status, 403);
  await closed.close();

  const { srv, ayse, baris, guildId } = await setup();
  const other = await srv.api('POST', '/auth/login', undefined, { username: 'baris', password: baris.password });
  assert.equal((await srv.api('PUT', '/users/@me/password', baris.token, { currentPassword: 'yanlis', newPassword: 'yeni-sifre-12' })).status, 403);
  assert.equal((await srv.api('PUT', '/users/@me/password', baris.token, { currentPassword: baris.password, newPassword: 'yeni-sifre-12' })).status, 204);
  assert.equal((await srv.api('GET', '/users/@me', other.data.token)).status, 401, 'diğer oturumlar kapanır');
  assert.equal((await srv.api('GET', '/users/@me', baris.token)).status, 200, 'bu oturum açık kalır');
  assert.equal((await srv.api('POST', '/auth/login', undefined, { username: 'baris', password: 'yeni-sifre-12' })).status, 200);

  // The owner must hand the server over before deleting the account.
  assert.equal((await srv.api('DELETE', '/users/@me', ayse.token, { password: ayse.password })).status, 400);
  assert.equal((await srv.api('PATCH', `/guilds/${guildId}`, baris.token, { ownerId: baris.id })).status, 403);
  assert.equal((await srv.api('PATCH', `/guilds/${guildId}`, ayse.token, { ownerId: baris.id })).status, 200);
  assert.equal(srv.store.guild(guildId)!.ownerId, baris.id);

  const wsB = await srv.gateway(baris.token);
  const wsA = await srv.gateway(ayse.token);
  const genel = srv.store.guildChannels(guildId).find((c) => c.name === 'genel')!;
  await srv.api('POST', `/channels/${genel.id}/messages`, ayse.token, { content: 'hoşça kalın' });
  assert.equal((await srv.api('DELETE', '/users/@me', ayse.token, { password: ayse.password })).status, 204);
  assert.equal(await wsA.closed(), 4004);
  await wsB.next('GUILD_MEMBER_REMOVE', (d) => d.userId === ayse.id);
  const renamed = await wsB.next('USER_UPDATE', (u) => u.id === ayse.id);
  assert.equal(renamed.displayName, 'Silinmiş kullanıcı');
  assert.equal((await srv.api('POST', '/auth/login', undefined, { username: 'ayse', password: ayse.password })).status, 401);
  const hist = await srv.api<Message[]>('GET', `/channels/${genel.id}/messages`, baris.token);
  assert.ok(hist.data.some((m) => m.authorId === ayse.id && m.content === 'hoşça kalın'), 'mesajlar kalır, adı anonimleşir');
  assert.equal((await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ayse', password: 'gizli-sifre-1' })).status, 201, 'ad yeniden alınabilir');
  wsB.close();
  await srv.close();
});

test('güvenlik başlıkları', async () => {
  const srv = await startServer();
  const u = await srv.user('kisi');
  const res = await srv.api('GET', '/users/@me', u.token);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  // the web client may use the microphone, camera and screen capture, nothing else
  assert.equal(res.headers.get('permissions-policy'), 'camera=(self), display-capture=(self), geolocation=(), microphone=(self)');
  await srv.close();
});

test('v0.2 veritabanı güncel şemaya taşınır', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konusgac-mig-'));
  const path = join(dir, 'eski.db');
  // A database as v0.2 left it: user_version 1, messages without the new columns.
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('abc', '1', 5);
    CREATE TABLE guilds (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, icon_color TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE roles (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, permissions INTEGER NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY, guild_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL,
      topic TEXT NOT NULL DEFAULT '', overwrites TEXT NOT NULL DEFAULT '[]', last_message_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL, edited_at INTEGER);
    INSERT INTO users VALUES ('1', 'eski', 'Eski', 'x', '#000000', 0);
    INSERT INTO guilds VALUES ('10', 'G', '1', '#000000', 0);
    INSERT INTO roles VALUES ('10', '10', '@everyone', '#99aab5', 3086, 0);
    INSERT INTO channels (id, guild_id, type, name, position) VALUES ('11', '10', 'text', 'genel', 0);
    INSERT INTO messages VALUES ('12', '11', '1', 'Eski İSTANBUL mesajı', 0, NULL);
    PRAGMA user_version = 1;
  `);
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  const row = db.prepare('SELECT search_text, mention_ids FROM messages').get() as { search_text: string; mention_ids: string };
  assert.equal(row.search_text, 'eski istanbul mesajı');
  assert.equal(row.mention_ids, '[]');
  const sess = db.prepare('SELECT last_used, user_agent FROM sessions').get() as { last_used: number; user_agent: string };
  assert.deepEqual({ ...sess }, { last_used: 5, user_agent: '' });
  const user = db.prepare('SELECT dm_from_members FROM users').get() as { dm_from_members: number };
  assert.equal(user.dm_from_members, 1);
  const perms = (db.prepare("SELECT permissions FROM roles WHERE id = '10'").get() as { permissions: number }).permissions;
  assert.ok(perms & Perm.AttachFiles && perms & Perm.AddReactions);
  db.close();
  assert.ok(existsSync(path));
  await settle(10);
});

test('gizlilik: özel mesaj ve arkadaşlık isteği izinleri', async () => {
  const { srv, ayse, baris } = await setup();
  const cem = await srv.user('cem');
  // Defaults: everyone may send requests, server members may DM.
  assert.deepEqual((await srv.api('GET', '/users/@me/settings', baris.token)).data, {
    dmFromServerMembers: true,
    friendRequests: { everyone: true, friendsOfFriends: true, serverMembers: true },
  });

  // Barış accepts requests only from server members: Cem (no shared server) is refused, Ayşe is not.
  await srv.api('PATCH', '/users/@me/settings', baris.token, {
    dmFromServerMembers: false,
    friendRequests: { everyone: false, friendsOfFriends: false, serverMembers: true },
  });
  assert.equal((await srv.api('POST', '/users/@me/relationships', cem.token, { username: 'baris' })).status, 403);

  // DMs from a server member are closed now; existing DM channels are closed too.
  assert.equal((await srv.api('POST', '/users/@me/channels', ayse.token, { recipientId: baris.id })).status, 403);
  // Friends may always message each other.
  assert.equal((await srv.api('POST', '/users/@me/relationships', ayse.token, { username: 'baris' })).status, 204);
  assert.equal((await srv.api('POST', '/users/@me/relationships', baris.token, { username: 'ayse' })).status, 204);
  const dm = await srv.api('POST', '/users/@me/channels', ayse.token, { recipientId: baris.id });
  assert.equal(dm.status, 200);
  assert.equal((await srv.api('POST', `/channels/${dm.data.id}/messages`, ayse.token, { content: 'selam' })).status, 201);
  await srv.api('DELETE', `/users/@me/relationships/${baris.id}`, ayse.token);
  assert.equal((await srv.api('POST', `/channels/${dm.data.id}/messages`, ayse.token, { content: 'hâlâ?' })).status, 403);
  await srv.close();
});

test('cihazlar: oturumları listeleme ve kapatma', async () => {
  const srv = await startServer();
  const u = await srv.user('kisi');
  const other = await srv.api('POST', '/auth/login', undefined, { username: 'kisi', password: u.password });
  const list = await srv.api('GET', '/users/@me/sessions', u.token);
  assert.equal(list.data.length, 2);
  assert.equal(list.data.filter((x: any) => x.current).length, 1);
  assert.match(list.data[0].userAgent, /node|undici/i);
  const otherId = list.data.find((x: any) => !x.current).id;
  assert.equal((await srv.api('DELETE', `/users/@me/sessions/${otherId}`, u.token)).status, 204);
  assert.equal((await srv.api('GET', '/users/@me', other.data.token)).status, 401);
  assert.equal((await srv.api('DELETE', '/users/@me/sessions/0000000000000000', u.token)).status, 404);
  const third = await srv.api('POST', '/auth/login', undefined, { username: 'kisi', password: u.password });
  assert.equal((await srv.api('DELETE', '/users/@me/sessions', u.token)).status, 204);
  assert.equal((await srv.api('GET', '/users/@me', third.data.token)).status, 401);
  assert.equal((await srv.api('GET', '/users/@me', u.token)).status, 200);
  await srv.close();
});

test('Windows uygulaması sunucunun kendisinden indirilir', async () => {
  const srv = await startServer();
  assert.equal((await srv.api('GET', '/config')).data.desktopApp, false, 'dosya yokken önerilmemeli');
  assert.equal((await srv.raw('/indir/Konusgac-Kurulum.exe')).status, 404);

  writeFileSync(join(srv.downloads, 'Konusgac-Kurulum.exe'), 'MZ kurulum');
  writeFileSync(join(srv.downloads, 'latest.yml'), 'version: 9.9.9');
  assert.equal((await srv.api('GET', '/config')).data.desktopApp, true);
  // konusgac.com/indir is the link people share: it goes straight to the installer
  const short = await srv.raw('/indir', { redirect: 'manual' });
  assert.equal(short.status, 302);
  assert.equal(short.headers.get('location'), '/indir/Konusgac-Kurulum.exe');
  const exe = await srv.raw('/indir/Konusgac-Kurulum.exe');
  assert.equal(exe.status, 200);
  assert.equal(await exe.text(), 'MZ kurulum');
  // the updater must always see the newest version
  const yml = await srv.raw('/indir/latest.yml');
  assert.equal(yml.headers.get('cache-control'), 'no-cache');
  assert.equal(await yml.text(), 'version: 9.9.9');
  // nothing outside the folder
  assert.notEqual((await srv.raw('/indir/..%2Fkonusgac.db')).status, 200);
  await srv.close();
});

test('e-posta: doğrulama, şifre sıfırlama, e-postayla giriş', async () => {
  const outbox: { to: string; subject: string; text: string }[] = [];
  const srv = await startServer({ mailer: async (m) => void outbox.push(m), config: { publicUrl: 'https://konusgac.test' } });
  const linkIn = (text: string, key: string) => text.match(new RegExp(`\\?${key}=([A-Za-z0-9_-]+)`))?.[1] ?? '';
  assert.equal((await srv.api('GET', '/config')).data.mail, true);

  // with e-mail on, sign-up needs an address; one address, one account
  assert.equal((await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'epostasiz', password: 'gizli-sifre-1' })).status, 400);
  const reg = await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ayse', password: 'gizli-sifre-1', email: 'Ayse@Ornek.org' });
  assert.equal(reg.status, 201);
  assert.equal((await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ayse2', password: 'gizli-sifre-1', email: 'ayse@ornek.org' })).status, 409);
  const token = reg.data.token;
  assert.deepEqual((await srv.api('GET', '/users/@me/account', token)).data, { email: 'ayse@ornek.org', emailVerified: false, hasPassword: true, google: false, siteAdmin: false });

  // the verification mail goes to the address, with a link to the site
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.to, 'ayse@ornek.org');
  assert.ok(outbox[0]!.text.includes('https://konusgac.test/?dogrula='));
  const verify = linkIn(outbox[0]!.text, 'dogrula');
  assert.equal((await srv.api('POST', '/auth/email/verify', undefined, { token: verify })).status, 200);
  assert.equal((await srv.api('GET', '/users/@me/account', token)).data.emailVerified, true);
  assert.equal((await srv.api('POST', '/auth/email/verify', undefined, { token: verify })).status, 400, 'bağlantı bir kez çalışır');

  // the e-mail address works as the login name
  assert.equal((await srv.api('POST', '/auth/login', undefined, { username: 'AYSE@ornek.org', password: 'gizli-sifre-1' })).status, 200);

  // "Şifremi unuttum": same answer for unknown addresses; the link sets a new password once
  assert.equal((await srv.api('POST', '/auth/password/forgot', undefined, { email: 'kimse@ornek.org' })).status, 204);
  assert.equal(outbox.length, 1, 'olmayan adrese e-posta gitmemeli');
  assert.equal((await srv.api('POST', '/auth/password/forgot', undefined, { email: 'ayse@ornek.org' })).status, 204);
  await settle();
  const reset = linkIn(outbox.at(-1)!.text, 'sifirla');
  assert.ok(outbox.at(-1)!.text.includes('@ayse'), 'e-posta hangi hesap olduğunu söylemeli');
  assert.equal((await srv.api('POST', '/auth/password/reset', undefined, { token: reset, password: 'yeni-sifre-22' })).status, 204);
  assert.equal((await srv.api('GET', '/users/@me', token)).status, 401, 'sıfırlama tüm oturumları kapatır');
  assert.equal((await srv.api('POST', '/auth/password/reset', undefined, { token: reset, password: 'baska-sifre-33' })).status, 400);
  const again = await srv.api('POST', '/auth/login', undefined, { username: 'ayse', password: 'yeni-sifre-22' });
  assert.equal(again.status, 200);

  // changing the address needs the password and a new confirmation
  assert.equal((await srv.api('PUT', '/users/@me/email', again.data.token, { email: 'yeni@ornek.org', password: 'yanlis' })).status, 403);
  const changed = await srv.api('PUT', '/users/@me/email', again.data.token, { email: 'yeni@ornek.org', password: 'yeni-sifre-22' });
  assert.deepEqual([changed.data.email, changed.data.emailVerified], ['yeni@ornek.org', false]);
  // an old verification link cannot confirm the new address
  assert.equal((await srv.api('POST', '/auth/email/verify', undefined, { token: verify })).status, 400);
  await srv.close();
});

test('Google ile giriş: yeni hesap, aynı e-postalı hesaba bağlanma, masaüstü dönüşü', async () => {
  const identities: Record<string, { sub: string; email: string | null; emailVerified: boolean; name: string | null }> = {
    'kod-yeni': { sub: 'g-1', email: 'cem.yilmaz@gmail.com', emailVerified: true, name: 'Cem Yılmaz' },
    'kod-ayni': { sub: 'g-2', email: 'deniz@ornek.org', emailVerified: true, name: 'Deniz' },
    'kod-dogrulanmamis': { sub: 'g-3', email: 'eda@ornek.org', emailVerified: true, name: 'Eda' },
  };
  const google = {
    authorizeUrl: (state: string, redirect: string) => `https://accounts.google.test/auth?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    exchange: async (code: string) => {
      const id = identities[code];
      if (!id) throw new Error('bilinmeyen kod');
      return id;
    },
  };
  const srv = await startServer({ google, mailer: async () => {}, config: { publicUrl: 'https://konusgac.test' } });
  assert.equal((await srv.api('GET', '/config')).data.google, true);

  async function signIn(code: string, desktop = false) {
    const start = await srv.raw(`/api/auth/google${desktop ? '?app=1' : ''}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location')!);
    assert.equal(to.searchParams.get('redirect_uri'), 'https://konusgac.test/api/auth/google/callback');
    return srv.raw(`/api/auth/google/callback?code=${code}&state=${to.searchParams.get('state')}`, { redirect: 'manual' });
  }
  const codeOf = (res: Response) => new URL(res.headers.get('location')!, 'https://x').searchParams.get('giris');

  // a new Google user gets an account with a free user name and a confirmed address
  const giris = codeOf(await signIn('kod-yeni'));
  const ex = await srv.api('POST', '/auth/google/exchange', undefined, { code: giris });
  assert.equal(ex.status, 200);
  assert.equal(ex.data.user.username, 'cem.yilmaz');
  assert.equal(ex.data.user.displayName, 'Cem Yılmaz');
  assert.deepEqual((await srv.api('GET', '/users/@me/account', ex.data.token)).data, { email: 'cem.yilmaz@gmail.com', emailVerified: true, hasPassword: false, google: true, siteAdmin: false });
  assert.equal((await srv.api('POST', '/auth/google/exchange', undefined, { code: giris })).status, 400, 'kod bir kez çalışır');
  // the same Google account signs in to the same user next time
  const ex2 = await srv.api('POST', '/auth/google/exchange', undefined, { code: codeOf(await signIn('kod-yeni')) });
  assert.equal(ex2.data.user.id, ex.data.user.id);
  // without a password: the first one is set without a current one, and other devices sign out
  assert.equal((await srv.api('PUT', '/users/@me/password', ex.data.token, { newPassword: 'ilk-sifre-123' })).status, 204);
  assert.equal((await srv.api('GET', '/users/@me/account', ex2.data.token)).status, 401);

  // an account whose address is confirmed is linked; an unconfirmed one is not taken over
  const deniz = await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'deniz', password: 'gizli-sifre-1', email: 'deniz@ornek.org' });
  srv.store.setEmail(deniz.data.user.id, 'deniz@ornek.org', true);
  const ex3 = await srv.api('POST', '/auth/google/exchange', undefined, { code: codeOf(await signIn('kod-ayni')) });
  assert.equal(ex3.data.user.id, deniz.data.user.id);
  await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'eda', password: 'gizli-sifre-1', email: 'eda@ornek.org' });
  const refused = await signIn('kod-dogrulanmamis');
  assert.match(decodeURIComponent(refused.headers.get('location')!), /giris_hata=.*doğrulanmamış/);

  // the desktop app gets a page that hands the code back through konusgac://
  const desk = await signIn('kod-ayni', true);
  assert.equal(desk.status, 200);
  assert.match(await desk.text(), /konusgac:\/\/giris\?kod=[A-Za-z0-9_-]{20,}/);

  // a callback without a started sign-in is refused
  const forged = await srv.raw('/api/auth/google/callback?code=kod-yeni&state=uydurma', { redirect: 'manual' });
  assert.match(decodeURIComponent(forged.headers.get('location')!), /giris_hata=/);
  await srv.close();
});

test('e-postasız sunucu: e-posta istenmez, Google yok', async () => {
  const srv = await startServer();
  const c = (await srv.api('GET', '/config')).data;
  assert.deepEqual([c.mail, c.google], [false, false]);
  assert.equal((await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'sade', password: 'gizli-sifre-1' })).status, 201);
  assert.equal((await srv.api('POST', '/auth/password/forgot', undefined, { email: 'a@b.org' })).status, 400);
  assert.equal((await srv.raw('/api/auth/google', { redirect: 'manual' })).status, 404);
  await srv.close();
});

test('kullanım koşulları: kayıtta kabul zorunlu, belgeler sunucunun bilgileriyle', async () => {
  const webRoot = mkdtempSync(join(tmpdir(), 'konusgac-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
  writeFileSync(join(webRoot, 'kosullar.html'), '<p>{{SITE}} · {{ISLETEN}} · {{ILETISIM}}</p>');
  writeFileSync(join(webRoot, 'gizlilik.html'), '<p>{{ISLETEN}}</p>');
  const srv = await startServer({ webRoot, config: { publicUrl: 'https://konusgac.test', operatorName: 'Ayşe <Yılmaz>', contactEmail: 'iletisim@konusgac.test' } });
  const without = await srv.api('POST', '/auth/register', undefined, { username: 'kabulsuz', password: 'gizli-sifre-1' });
  assert.equal(without.status, 400);
  assert.match(without.data.error, /Kullanım Koşulları/);
  assert.equal((await srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'kabullu', password: 'gizli-sifre-1' })).status, 201);
  const accepted = srv.store.db.prepare("SELECT terms_accepted_at FROM users WHERE username = 'kabullu'").get() as { terms_accepted_at: number };
  assert.ok(accepted.terms_accepted_at > 0, 'kabul zamanı kaydedilmeli');
  assert.equal(await (await srv.raw('/kosullar')).text(), '<p>konusgac.test · Ayşe &#60;Yılmaz&#62; · iletisim@konusgac.test</p>');
  assert.equal(await (await srv.raw('/gizlilik')).text(), '<p>Ayşe &#60;Yılmaz&#62;</p>');
  await srv.close();
});

test('moderasyon: şikâyet, platform yönetimi, platform ve sunucu yasakları', async () => {
  const outbox: { to: string; subject: string; text: string }[] = [];
  const srv = await startServer({
    mailer: async (m) => void outbox.push(m),
    config: { siteAdmins: ['yonetici'], contactEmail: 'bildirim@konusgac.test', publicUrl: 'https://konusgac.test' },
  });
  const reg = (username: string) =>
    srv.api('POST', '/auth/register', undefined, { acceptTerms: true, username, password: 'gizli-sifre-1', email: `${username}@ornek.org` }).then((r) => ({ token: r.data.token as string, id: r.data.user.id as string }));
  const admin = await reg('yonetici');
  const sahip = await reg('sahip');
  const kotu = await reg('kotu');
  const tanik = await reg('tanik');

  const g = (await srv.api<GuildState>('POST', '/guilds', sahip.token, { name: 'Topluluk' })).data;
  const genel = g.channels.find((c) => c.type === 'text')!;
  const inv = (await srv.api('POST', `/channels/${genel.id}/invites`, sahip.token, {})).data;
  await srv.api('POST', `/invites/${inv.code}`, kotu.token);
  await srv.api('POST', `/invites/${inv.code}`, tanik.token);
  const bad = (await srv.api<Message>('POST', `/channels/${genel.id}/messages`, kotu.token, { content: 'kötü içerik' })).data;

  // reporting: only what you can see, not your own, with a copy kept as evidence
  assert.equal((await srv.api('POST', '/reports', admin.token, { messageId: bad.id, reason: 'harassment' })).status, 404, 'göremediğin mesaj şikâyet edilemez');
  assert.equal((await srv.api('POST', '/reports', kotu.token, { messageId: bad.id, reason: 'spam' })).status, 400);
  assert.equal((await srv.api('POST', '/reports', tanik.token, { messageId: bad.id, reason: 'uydurma' })).status, 400);
  assert.equal((await srv.api('POST', '/reports', tanik.token, { messageId: bad.id, reason: 'harassment', note: 'tehdit ediyor' })).status, 204);
  await settle();
  assert.equal(outbox.at(-1)!.to, 'bildirim@konusgac.test');
  assert.match(outbox.at(-1)!.text, /kötü içerik/);

  // only operators see reports and use the admin routes
  assert.equal((await srv.api('GET', '/admin/reports', sahip.token)).status, 403);
  assert.equal((await srv.api('GET', '/users/@me/account', admin.token)).data.siteAdmin, true);
  assert.equal((await srv.api('GET', '/users/@me/account', sahip.token)).data.siteAdmin, false);
  const reports = (await srv.api('GET', '/admin/reports', admin.token)).data;
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].reason, reports[0].content, reports[0].author.username, reports[0].reporter.username, reports[0].guildName], ['harassment', 'kötü içerik', 'kotu', 'tanik', 'Topluluk']);

  // an operator removes the message anywhere; the report keeps its copy
  const wsT = await srv.gateway(tanik.token);
  assert.equal((await srv.api('DELETE', `/admin/messages/${bad.id}`, admin.token)).status, 204);
  await wsT.next('MESSAGE_DELETE', (d) => d.id === bad.id);
  const after = (await srv.api('GET', '/admin/reports', admin.token)).data[0];
  assert.deepEqual([after.messageExists, after.content], [false, 'kötü içerik']);
  assert.equal((await srv.api('POST', `/admin/reports/${after.id}/resolve`, admin.token)).status, 204);
  assert.equal((await srv.api('GET', '/admin/reports', admin.token)).data.length, 0);
  assert.equal((await srv.api('GET', '/admin/reports?status=resolved', admin.token)).data.length, 1);

  // platform ban: signed out everywhere, cannot sign in; recent messages can go too
  await srv.api('POST', `/channels/${genel.id}/messages`, kotu.token, { content: 'spam 1' });
  const wsK = await srv.gateway(kotu.token);
  assert.equal((await srv.api('PUT', `/admin/users/${admin.id}/ban`, admin.token, {})).status, 400, 'yönetici yasaklanamaz');
  assert.equal((await srv.api('PUT', `/admin/users/${kotu.id}/ban`, admin.token, { reason: 'spam', deleteRecentMessages: true })).status, 204);
  await new Promise<void>((r) => (wsK.ws.readyState === wsK.ws.CLOSED ? r() : wsK.ws.once('close', () => r())));
  assert.equal((await srv.api('GET', '/users/@me', kotu.token)).status, 401);
  const login = await srv.api('POST', '/auth/login', undefined, { username: 'kotu', password: 'gizli-sifre-1' });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /kapatıldı/);
  const left = (await srv.api<Message[]>('GET', `/channels/${genel.id}/messages`, tanik.token)).data;
  assert.ok(!left.some((m) => m.authorId === kotu.id), 'son mesajları silinmeli');
  assert.equal((await srv.api('GET', '/admin/bans', admin.token)).data[0].user.username, 'kotu');
  assert.equal((await srv.api('DELETE', `/admin/users/${kotu.id}/ban`, admin.token)).status, 204);
  assert.equal((await srv.api('POST', '/auth/login', undefined, { username: 'kotu', password: 'gizli-sifre-1' })).status, 200);

  // server ban: needs the permission, removes the member, keeps them from rejoining
  assert.equal((await srv.api('PUT', `/guilds/${g.guild.id}/bans/${kotu.id}`, tanik.token, {})).status, 403);
  assert.equal((await srv.api('PUT', `/guilds/${g.guild.id}/bans/${kotu.id}`, sahip.token, { reason: 'kurallar' })).status, 204);
  assert.ok(!srv.store.member(g.guild.id, kotu.id));
  const rejoin = await srv.api('POST', `/invites/${inv.code}`, (await srv.api('POST', '/auth/login', undefined, { username: 'kotu', password: 'gizli-sifre-1' })).data.token);
  assert.equal(rejoin.status, 403);
  assert.deepEqual((await srv.api('GET', `/guilds/${g.guild.id}/bans`, sahip.token)).data.map((b: any) => [b.user.username, b.reason]), [['kotu', 'kurallar']]);
  assert.equal((await srv.api('DELETE', `/guilds/${g.guild.id}/bans/${kotu.id}`, sahip.token)).status, 204);

  // an operator can remove any server
  assert.equal((await srv.api('DELETE', `/admin/guilds/${g.guild.id}`, admin.token)).status, 204);
  assert.ok(!srv.store.guild(g.guild.id));
  wsT.close();
  await srv.close();
});
