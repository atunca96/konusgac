// Voice end-to-end test with real browsers: two headless Chrome instances, each with Chrome's
// built-in fake microphone (a steady beep), join the same voice channel through the real web
// client; all media goes through the server's voice router (SFU). Passes when both peers connect, audio bytes flow both ways, the other side hears
// sound, muting silences it, per-user volume works, both cameras reach the other side, and a
// screen share arrives with its picture and its sound.
//
// Usage: npm run build && npm run test:voice -w @konusgac/server
// Chrome is taken from CHROME_PATH, or the usual install location.
import type { GuildState } from '@konusgac/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createApp } from '../src/app';

const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!CHROME) throw new Error('Chrome bulunamadı; CHROME_PATH ile yolunu ver.');

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (!existsSync(webRoot)) throw new Error('Önce web istemcisini derle: npm run build');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Minimal Chrome DevTools Protocol client for one page.
class Page {
  private seq = 0;
  private pending = new Map<number, (v: any) => void>();
  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id) this.pending.get(msg.id)?.(msg);
    });
  }
  static async open(port: number): Promise<Page> {
    for (let i = 0; i < 50; i++) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((t) => t.type === 'page');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r) => ws.once('open', r));
          return new Page(ws);
        }
      } catch {
        // Chrome still starting
      }
      await sleep(200);
    }
    throw new Error('Chrome hata ayıklama bağlantısı açılmadı');
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'sayfa hatası');
    return res.result?.result?.value as T;
  }
  async waitFor(expression: string, what: string, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(`!!(${expression})`).catch(() => false)) return;
      await sleep(200);
    }
    throw new Error(`zaman aşımı: ${what}`);
  }
  close() {
    this.ws.close();
  }
}

function launchChrome(port: number, profile: string): ChildProcess {
  return spawn(
    CHROME!,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--use-fake-ui-for-media-stream', // grant the microphone without a prompt
      '--use-fake-device-for-media-stream', // a fake mic playing a beep, and a fake camera
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio', // the beeps stay inside the test; nothing comes out of the speakers
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

type Stats = Record<string, { state: string; bytesReceived: number; bytesSent: number; audioLevel: number; audioEnergy: number }>;

const ctx = await createApp({ dbPath: ':memory:', webRoot, rateLimits: false, config: { rtcPort: 0 } });
await ctx.app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
const api = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
};

const profiles: string[] = [];
const browsers: ChildProcess[] = [];
const pages: Page[] = [];
let failed = false;
try {
  const a = await api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ses_a', password: 'ses-sifre-1' });
  const b = await api('POST', '/auth/register', undefined, { acceptTerms: true, username: 'ses_b', password: 'ses-sifre-2' });
  const g = (await api('POST', '/guilds', a.token, { name: 'Ses Testi' })) as GuildState;
  const voice = g.channels.find((c) => c.type === 'voice')!;
  const text = g.channels.find((c) => c.type === 'text')!;
  const inv = await api('POST', `/channels/${text.id}/invites`, a.token, {});
  await api('POST', `/invites/${inv.code}`, b.token);

  const users = [
    { name: 'A', token: a.token as string, id: a.user.id as string },
    { name: 'B', token: b.token as string, id: b.user.id as string },
  ];
  for (const [i, u] of users.entries()) {
    const port = 9400 + Math.floor(Math.random() * 400) + i;
    const profile = mkdtempSync(join(tmpdir(), `konusgac-chrome-${u.name}-`));
    profiles.push(profile);
    browsers.push(launchChrome(port, profile));
    const page = await Page.open(port);
    pages.push(page);
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: base });
    await page.waitFor('document.readyState === "complete"', 'sayfa yüklenmesi');
    await page.eval(`localStorage.setItem('konusgac.token', ${JSON.stringify(u.token)})`);
    await page.send("Page.navigate", { url: `${base}/?oturum=1#/${g.guild.id}/${text.id}` });
    await page.waitFor(`document.querySelector('.voice-channel button')`, `${u.name}: arayüz`);
    await page.eval(`[...document.querySelectorAll('.voice-channel button')].find(b => b.textContent.includes(${JSON.stringify(voice.name)})).click()`);
    console.log(`${u.name} sesli kanala katıldı`);
  }

  const [pa, pb] = pages as [Page, Page];
  const stats = (p: Page) => p.eval<Stats>('window.konusgacVoiceStats()');
  await pa.waitFor(`window.konusgacVoiceStats().then(s => s[${JSON.stringify(users[1]!.id)}]?.state === 'connected')`, 'A→B bağlantısı');
  await pb.waitFor(`window.konusgacVoiceStats().then(s => s[${JSON.stringify(users[0]!.id)}]?.state === 'connected')`, 'B→A bağlantısı');
  console.log('WebRTC bağlantısı kuruldu (iki yönde de "connected")');

  // Measure over 3 seconds: bytes must flow both ways, and each side must actually hear the
  // other at its speaker output (after per-user volume, output volume and deafen).
  await sleep(2000);
  const peer = async (p: Page, other: number) => {
    const all = await stats(p);
    const row = all[users[other]!.id];
    if (!row) throw new Error(`istatistik yok: ${JSON.stringify(all)}`);
    return row;
  };
  const heard = (p: Page) => p.eval<number>('window.konusgacLocalVoice().heardEnergy');
  const [a1, b1, ha1, hb1] = [await peer(pa, 1), await peer(pb, 0), await heard(pa), await heard(pb)];
  await sleep(3000);
  const [a2, b2, ha2, hb2] = [await peer(pa, 1), await peer(pb, 0), await heard(pa), await heard(pb)];
  const heardByA = ha2 - ha1;
  const heardByB = hb2 - hb1;
  console.log(`A aldı: ${a2.bytesReceived - a1.bytesReceived} bayt, duyduğu ses enerjisi ${heardByA.toExponential(2)}`);
  console.log(`B aldı: ${b2.bytesReceived - b1.bytesReceived} bayt, duyduğu ses enerjisi ${heardByB.toExponential(2)}`);
  if (!(a2.bytesReceived > a1.bytesReceived && b2.bytesReceived > b1.bytesReceived)) throw new Error('ses verisi akmıyor');
  if (!(heardByA > 0 && heardByB > 0)) {
    console.log('A yerel:', JSON.stringify(await pa.eval('window.konusgacLocalVoice()')));
    console.log('B yerel:', JSON.stringify(await pb.eval('window.konusgacLocalVoice()')));
    throw new Error('karşı taraf duyulmuyor');
  }

  // A mutes: what B hears over the next 3 seconds must drop to (near) silence.
  await pa.eval(`[...document.querySelectorAll('button')].find(b => b.title === 'Mikrofonu kapat').click()`);
  await sleep(1000);
  const m1 = await heard(pb);
  await sleep(3000);
  const mutedEnergy = (await heard(pb)) - m1;
  console.log(`A susturulunca B'nin duyduğu enerji: ${mutedEnergy.toExponential(2)} (öncesi ${heardByB.toExponential(2)})`);
  if (mutedEnergy > heardByB / 20) throw new Error('susturma çalışmıyor');

  const states = ctx.gateway.visibleVoiceStates(g.guild.id, users[1]!.id);
  if (!states.find((v) => v.userId === users[0]!.id)?.selfMute) throw new Error('sunucu susturma durumunu görmedi');

  // B turns A down to 0% locally: B hears nothing from A even after A unmutes.
  await pa.eval(`[...document.querySelectorAll('button')].find(b => b.title === 'Mikrofonu aç').click()`);
  await pb.eval(`window.konusgacSetUserVolume(${JSON.stringify(users[0]!.id)}, 0)`);
  await sleep(1000);
  const v1 = await heard(pb);
  await sleep(2500);
  const quiet = (await heard(pb)) - v1;
  console.log(`B, A'yı %0'a indirince duyduğu enerji: ${quiet.toExponential(2)}`);
  if (quiet > heardByB / 20) throw new Error('kişi başına ses düzeyi çalışmıyor');
  await pb.eval(`window.konusgacSetUserVolume(${JSON.stringify(users[0]!.id)}, 100)`);
  await sleep(1000);
  const r1 = await heard(pb);
  await sleep(2500);
  const back = (await heard(pb)) - r1;
  console.log(`Ses düzeyi %100'e dönünce: ${back.toExponential(2)}`);
  if (!(back > heardByB / 10)) throw new Error('ses düzeyi geri açılınca ses gelmedi');

  // ---- camera and screen sharing ----
  // Frames decoded per video tile on a page; a tile is live when its count keeps growing.
  const frames = (p: Page) =>
    p.eval<number[]>(`[...document.querySelectorAll('.call-tile video')].map(v => v.getVideoPlaybackQuality().totalVideoFrames)`);
  const liveVideos = async (p: Page) => {
    const f1 = await frames(p);
    await sleep(1500);
    const f2 = await frames(p);
    return f2.filter((n, i) => n > (f1[i] ?? 0)).length;
  };
  // A tile's first frames can take a moment (the server picks a quality layer first): ask again a few times.
  const waitLive = async (p: Page, n: number) => {
    let live = 0;
    for (let i = 0; i < 5 && live < n; i++) live = await liveVideos(p);
    return live;
  };
  const click = (p: Page, label: string) =>
    p.eval(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.title === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('düğme yok: ' + ${JSON.stringify(label)}); b.click(); })()`,
    );
  const flags = (i: number) => ctx.gateway.visibleVoiceStates(g.guild.id, users[1 - i]!.id).find((v) => v.userId === users[i]!.id);

  // Both sides turn their camera on, so sending works from the offering and the answering side.
  await click(pa, 'Kamerayı aç');
  await pb.waitFor(`document.querySelectorAll('.call-tile video').length === 1`, "B'de A'nın kamerası");
  await sleep(1500);
  if ((await waitLive(pb, 1)) !== 1) throw new Error("B, A'nın kamerasını görmüyor (kare gelmiyor)");
  if (!flags(0)?.selfVideo) throw new Error('sunucu kamera durumunu görmedi');
  console.log("B, A'nın kamerasını görüyor");
  await click(pb, 'Kamerayı aç');
  await pa.waitFor(`document.querySelectorAll('.call-tile video').length === 2`, "A'da iki kamera");
  await sleep(1500);
  if ((await waitLive(pa, 2)) !== 2) throw new Error("A, B'nin kamerasını görmüyor");
  console.log("A, B'nin kamerasını görüyor (iki yön de çalışıyor)");

  // A shares a "screen". Headless Chrome has no screen to pick, so the capture is the fake camera
  // plus the fake microphone's beep; the slots and the interface are the real ones.
  await pa.eval(`navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true })`);
  await click(pa, 'Ekranını paylaş');
  await pa.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Yayına başla')`, 'yayın penceresi');
  await click(pa, 'Yayına başla');
  await pb.waitFor(`document.querySelector('.call-tile .live-pill')`, "B'de CANLI karosu");
  // A screen is downloaded only once someone chooses to watch it.
  await sleep(1000);
  if ((await pb.eval<number>(`document.querySelectorAll('.call-tile video').length`)) !== 2) throw new Error('yayın izlenmeden indirilmemeli');
  await pb.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Yayını izle')`, '"Yayını izle" düğmesi');
  await click(pb, 'Yayını izle');
  await pb.waitFor(`document.querySelectorAll('.call-tile video').length === 3`, "B'de yayın görüntüsü");
  await sleep(1500);
  if ((await waitLive(pb, 3)) !== 3) throw new Error("B, A'nın ekranını görmüyor");
  if (!flags(0)?.selfStream) throw new Error('sunucu yayın durumunu görmedi');
  // Everything goes through the server: A sends each stream once.
  const room = ctx.gateway.sfu.stats().find((r) => r.channelId === voice.id);
  const aSends = room?.peers.find((p) => p.userId === users[0]!.id)?.producers.sort().join(',');
  if (aSends !== 'camera,mic,screen,screenAudio') throw new Error(`sunucu A'dan beklenen akışları almıyor: ${aSends}`);
  console.log(`Sunucu A'dan alıp dağıtıyor: ${aSends}`);
  console.log("B, A'nın ekran paylaşımını görüyor");

  // With A's microphone muted, B still hears the stream's own sound.
  await click(pa, 'Mikrofonu kapat');
  await sleep(1000);
  const s1 = await heard(pb);
  await sleep(2500);
  const streamSound = (await heard(pb)) - s1;
  console.log(`A'nın mikrofonu kapalıyken B'nin duyduğu yayın sesi: ${streamSound.toExponential(2)}`);
  if (!(streamSound > heardByB / 10)) throw new Error('yayının sesi gelmiyor');
  await click(pa, 'Mikrofonu aç');

  await click(pa, 'Yayını durdur');
  await pb.waitFor(`!document.querySelector('.call-tile .live-pill') && document.querySelectorAll('.call-tile video').length === 2`, 'yayının bitmesi');
  await click(pa, 'Kamerayı kapat');
  await click(pb, 'Kamerayı kapat');
  await pb.waitFor(`document.querySelectorAll('.call-tile video').length === 0`, 'kameraların kapanması');
  if (flags(0)?.selfVideo || flags(0)?.selfStream) throw new Error('sunucu kapanmayı görmedi');
  console.log('Yayın ve kameralar kapandı; herkes avatar karosuna döndü');

  console.log('\nSES VE GÖRÜNTÜ TESTİ GEÇTİ');
} catch (err) {
  failed = true;
  for (const [i, p] of pages.entries()) {
    const info = await p
      .eval(`JSON.stringify({ media: window.konusgacMediaStats?.(), tiles: [...document.querySelectorAll('.call-tile')].map(t => t.innerText) })`)
      .catch((e: Error) => `okunamadı: ${e.message}`);
    console.log(`sayfa ${i ? 'B' : 'A'}:`, info);
  }
  console.error('\nSES VE GÖRÜNTÜ TESTİ BAŞARISIZ:', (err as Error).message);
} finally {
  for (const p of pages) p.close();
  for (const b of browsers) b.kill();
  await ctx.app.close();
  await sleep(500);
  for (const p of profiles) rmSync(p, { recursive: true, force: true, maxRetries: 5 });
  process.exit(failed ? 1 : 0);
}
