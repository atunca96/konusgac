import { Op, type DispatchEvents, type DispatchName } from '@konusgac/shared';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp, type AppOptions } from '../src/app';

export interface Res<T = any> {
  status: number;
  data: T;
  headers: Headers;
}

// Starts a server on a random port and returns small HTTP and gateway helpers bound to it.
export async function startServer(opts: Partial<AppOptions> = {}) {
  const ctx = await createApp({ dbPath: ':memory:', heartbeatInterval: 60_000, rateLimits: false, ...opts, config: { rtcPort: 0, rtcAddress: '127.0.0.1', ...opts.config } });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;

  async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`http://${base}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  async function upload<T = any>(path: string, token: string, payload: unknown, files: { name: string; data: Buffer }[]): Promise<Res<T>> {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.data)]), f.name);
    const res = await fetch(`http://${base}/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  const raw = (path: string, init?: RequestInit) => fetch(`http://${base}${path}`, init);

  async function user(username: string, password = 'gizli-sifre-1') {
    const r = await api('POST', '/auth/register', undefined, { acceptTerms: true, username, password });
    if (r.status !== 201) throw new Error(`kayıt başarısız: ${JSON.stringify(r.data)}`);
    return { token: r.data.token as string, id: r.data.user.id as string, password };
  }

  return { ...ctx, base, api, upload, raw, user, gateway: (token: string) => Client.connect(base, token), close: () => ctx.app.close() };
}

export class Client {
  events: { t: DispatchName; d: any }[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  ws!: WebSocket;
  ready!: DispatchEvents['READY'];

  static async connect(base: string, token: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://${base}/gateway`);
    c.ws.on('close', (code) => {
      c.closeCode = code;
      c.waiters.splice(0).forEach((w) => w());
    });
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

  async closed(ms = 3000): Promise<number> {
    const deadline = Date.now() + ms;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('bağlantı kapanmadı');
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closeCode;
  }

  has(t: DispatchName, pred: (d: any) => boolean) {
    return this.events.some((e) => e.t === t && pred(e.d));
  }

  close() {
    this.ws.close();
  }
}

export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// A 1x1 PNG.
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2dd9b0b0000000049454e44ae426082',
  'hex',
);
