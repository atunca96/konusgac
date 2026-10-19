import { Op, type MediaSource, type RtcEvent, type RtcProducer } from '@konusgac/shared';
import { Device, type types } from 'mediasoup-client';
import { sendFrame } from './connection';

// The media side of a voice session: one connection to the server's voice router (an SFU) for
// sending, one for receiving. We send each of our streams once, whatever the room size; the
// server forwards everyone else's. Camera and screen are sent in several qualities (simulcast)
// and the server forwards each viewer the one that fits how big they show it.
//
// voice.ts owns the audio graph and decides what to send; this module only moves tracks.

export interface RemoteTrack {
  userId: string;
  source: MediaSource;
  track: MediaStreamTrack;
}

export interface RtcHooks {
  added(t: RemoteTrack): void; // a stream of someone in the channel started arriving
  removed(userId: string, source: MediaSource): void;
  screens(): void; // the set of screens one could watch changed
  state(state: RTCPeerConnectionState): void; // of the receiving connection
}

// How a screen share is encoded, from the picker's choices.
export interface ScreenQuality {
  height: 720 | 1080 | 0; // 0 = the source's own
  fps: 15 | 30 | 60;
}

interface Received {
  consumer: types.Consumer;
  userId: string;
  source: MediaSource;
}

let nextRequest = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Gateway frames for the voice server, handed over by voice.ts.
export function onRtcResponse(d: { id: number; data?: unknown; error?: string }) {
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error !== undefined) p.reject(new Error(d.error));
  else p.resolve(d.data);
}

function request<T = Record<string, never>>(method: string, data?: unknown): Promise<T> {
  const id = ++nextRequest;
  sendFrame({ op: Op.Rtc, d: { id, method, data } });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Ses sunucusu yanıt vermedi'));
    }, 15_000);
  });
}

// Bitrate for a screen share: enough for sharp text and smooth motion at the chosen quality.
function screenBitrate(q: ScreenQuality): number {
  const base = q.height === 720 ? 2_500_000 : q.height === 1080 ? 4_500_000 : 6_000_000;
  return Math.round(base * (q.fps >= 60 ? 1.5 : q.fps <= 15 ? 0.6 : 1));
}

export class RtcSession {
  private device = new Device();
  private send: types.Transport | null = null;
  private recv: types.Transport | null = null;
  private producers = new Map<MediaSource, types.Producer>();
  private received = new Map<string, Received>(); // by producerId
  private available = new Map<string, RtcProducer>(); // every stream in the room, by producerId
  private watching = new Set<string>(); // userIds whose screen we receive
  private sending = new Map<MediaSource, Promise<void>>(); // one change per source at a time
  private closed = false;
  readonly ready: Promise<void>;

  constructor(
    readonly sessionId: string,
    readonly channelId: string,
    private hooks: RtcHooks,
  ) {
    this.ready = this.start();
    this.ready.catch(() => {}); // the caller looks at it; this only keeps it from being "unhandled"
  }

  private async start() {
    const joined = await request<{ rtpCapabilities: types.RtpCapabilities; producers: RtcProducer[] }>('join');
    if (this.closed) return;
    await this.device.load({ routerRtpCapabilities: joined.rtpCapabilities });
    const [sendInfo, recvInfo] = await Promise.all([
      request<types.TransportOptions>('createTransport', { direction: 'send' }),
      request<types.TransportOptions>('createTransport', { direction: 'recv' }),
    ]);
    if (this.closed) return;
    this.send = this.device.createSendTransport(sendInfo);
    this.recv = this.device.createRecvTransport(recvInfo);
    for (const t of [this.send, this.recv]) {
      t.on('connect', ({ dtlsParameters }, done, fail) => {
        request('connectTransport', { transportId: t.id, dtlsParameters }).then(() => done(), fail);
      });
    }
    this.send.on('produce', ({ rtpParameters, appData }, done, fail) => {
      request<{ id: string }>('produce', { transportId: this.send!.id, source: appData.source, rtpParameters }).then(done, fail);
    });
    this.recv.on('connectionstatechange', (state) => this.hooks.state(state));
    for (const p of joined.producers) this.onProducer(p);
  }

  close() {
    this.closed = true;
    this.send?.close();
    this.recv?.close();
    for (const r of this.received.values()) this.hooks.removed(r.userId, r.source);
    this.received.clear();
    this.available.clear();
  }

  // ---------- sending ----------

  // Sends a track for a source, swaps it, or (null) stops sending it.
  setSource(source: MediaSource, track: MediaStreamTrack | null, quality?: ScreenQuality): Promise<void> {
    const prev = this.sending.get(source) ?? Promise.resolve();
    const next = prev.then(() => this.applySource(source, track, quality)).catch((err) => console.warn('Yayın gönderilemedi', source, err));
    this.sending.set(source, next);
    return next;
  }

  private async applySource(source: MediaSource, track: MediaStreamTrack | null, quality?: ScreenQuality) {
    await this.ready;
    if (this.closed || !this.send) return;
    const current = this.producers.get(source);
    if (!track) {
      if (!current) return;
      this.producers.delete(source);
      current.close();
      await request('closeProducer', { source }).catch(() => {});
      return;
    }
    // A new screen quality needs new encodings, so the screen is produced again; otherwise
    // swapping the track keeps everyone's stream running.
    if (current && !(source === 'screen' && quality)) {
      await current.replaceTrack({ track });
      return;
    }
    if (current) {
      this.producers.delete(source);
      current.close();
    }
    const producer = await this.send.produce({ track, stopTracks: false, appData: { source }, ...encodingFor(source, quality) });
    if (this.closed) return producer.close();
    this.producers.set(source, producer);
  }

  // Muted: the microphone sends nothing at all (not even silence) until unmuted.
  async pauseMic(paused: boolean) {
    await this.ready.catch(() => {});
    const p = this.producers.get('mic');
    if (!p || p.paused === paused) return;
    if (paused) p.pause();
    else p.resume();
    await request(paused ? 'pauseProducer' : 'resumeProducer', { source: 'mic' }).catch(() => {});
  }

  sends(source: MediaSource): boolean {
    return this.producers.has(source);
  }

  // ---------- receiving ----------

  onEvent(ev: RtcEvent) {
    void this.ready.then(() => {
      if (this.closed) return;
      if (ev.type === 'producerAdded') this.onProducer(ev);
      else this.onProducerGone(ev.producerId);
    });
  }

  // Voices and cameras are received right away; a screen only once the person chooses to watch it,
  // so nobody downloads streams they are not looking at.
  private onProducer(p: RtcProducer) {
    this.available.set(p.producerId, p);
    if (p.source === 'mic' || p.source === 'camera') void this.consume(p);
    else if (this.watching.has(p.userId)) void this.consume(p);
    if (p.source === 'screen') this.hooks.screens();
  }

  private onProducerGone(producerId: string) {
    const p = this.available.get(producerId);
    this.available.delete(producerId);
    this.drop(producerId);
    if (p?.source === 'screen') this.hooks.screens();
  }

  private drop(producerId: string) {
    const r = this.received.get(producerId);
    if (!r) return;
    this.received.delete(producerId);
    r.consumer.close();
    this.hooks.removed(r.userId, r.source);
  }

  private async consume(p: RtcProducer) {
    if (!this.recv || this.received.has(p.producerId)) return;
    try {
      const info = await request<{ id: string; producerId: string; kind: 'audio' | 'video'; rtpParameters: types.RtpParameters }>('consume', {
        producerId: p.producerId,
        rtpCapabilities: this.device.recvRtpCapabilities,
      });
      if (this.closed || !this.available.has(p.producerId)) return void request('closeConsumer', { consumerId: info.id }).catch(() => {});
      const consumer = await this.recv.consume({ id: info.id, producerId: info.producerId, kind: info.kind, rtpParameters: info.rtpParameters });
      this.received.set(p.producerId, { consumer, userId: p.userId, source: p.source });
      await request('resumeConsumer', { consumerId: consumer.id });
      this.hooks.added({ userId: p.userId, source: p.source, track: consumer.track });
    } catch (err) {
      console.warn('Yayın alınamadı', p.source, err);
    }
  }

  // Screens one could watch, by userId.
  screens(): Set<string> {
    return new Set([...this.available.values()].filter((p) => p.source === 'screen').map((p) => p.userId));
  }

  isWatching(userId: string): boolean {
    return this.watching.has(userId);
  }

  watch(userId: string, on: boolean) {
    if (on) this.watching.add(userId);
    else this.watching.delete(userId);
    for (const p of this.available.values()) {
      if (p.userId !== userId || (p.source !== 'screen' && p.source !== 'screenAudio')) continue;
      if (on) void this.consume(p);
      else {
        const r = this.received.get(p.producerId);
        this.drop(p.producerId);
        if (r) void request('closeConsumer', { consumerId: r.consumer.id }).catch(() => {});
      }
    }
  }

  // Shown big: the sharpest layer; small: a lighter one.
  setQuality(userId: string, source: 'camera' | 'screen', high: boolean) {
    for (const r of this.received.values()) {
      if (r.userId === userId && r.source === source) {
        void request('setLayers', { consumerId: r.consumer.id, spatialLayer: high ? (source === 'camera' ? 2 : 1) : 0 }).catch(() => {});
      }
    }
  }

  // ---------- diagnostics ----------

  async stats() {
    const out: Record<string, { state: string; bytesReceived: number; bytesSent: number; sources: string[] }> = {};
    const state = this.recv?.connectionState ?? 'new';
    for (const r of this.received.values()) {
      const row = (out[r.userId] ??= { state, bytesReceived: 0, bytesSent: 0, sources: [] });
      row.sources.push(r.source);
      (await r.consumer.getStats()).forEach((s: { type: string; bytesReceived?: number }) => {
        if (s.type === 'inbound-rtp') row.bytesReceived += s.bytesReceived ?? 0;
      });
    }
    return { sending: [...this.producers.keys()], sendState: this.send?.connectionState ?? 'new', recvState: state, peers: out };
  }
}

function encodingFor(source: MediaSource, quality?: ScreenQuality): Partial<types.ProducerOptions> {
  switch (source) {
    case 'mic':
      // Voice: forward error correction for lossy links, nothing sent during silence.
      return { codecOptions: { opusStereo: false, opusDtx: true, opusFec: true }, zeroRtpOnPause: true, disableTrackOnPause: false };
    case 'screenAudio':
      // Game and video sound: stereo at music quality.
      return { codecOptions: { opusStereo: true, opusFec: true, opusMaxAverageBitrate: 128_000 } };
    case 'camera':
      return {
        encodings: [
          { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
          { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
          { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
        ],
        codecOptions: { videoGoogleStartBitrate: 1000 },
      };
    case 'screen': {
      const q = quality ?? { height: 1080, fps: 30 };
      const max = screenBitrate(q);
      // Two layers: the full stream, and a light one for small tiles and slow connections.
      return {
        encodings: [
          { scaleResolutionDownBy: 2, maxBitrate: Math.round(max / 4), maxFramerate: Math.min(q.fps, 30) },
          { scaleResolutionDownBy: 1, maxBitrate: max, maxFramerate: q.fps },
        ],
        codecOptions: { videoGoogleStartBitrate: 1000 },
      };
    }
  }
}
