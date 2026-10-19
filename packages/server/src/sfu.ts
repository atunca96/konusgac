import { MEDIA_SOURCES, type MediaSource, type RtcEvent, type RtcProducer } from '@konusgac/shared';
import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import type { ServerConfig } from './config';

// Voice and video go through the server: each participant sends every stream
// (microphone, camera, screen, screen sound) once, and the server forwards it to everyone else
// in the channel. Nobody's upload grows with the size of the room, and the server can enforce
// who may speak or share.
//
// One mediasoup worker runs all rooms; one router per voice channel, made when the first person
// asks and closed when the last one leaves. All media uses one port (UDP, and TCP for networks
// that block UDP), so a server needs one extra port open.
//
// The gateway owns who is in which channel (VoiceState); this class only holds the media of
// people the gateway says are there.

const CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
];

const MAX_INCOMING_BITRATE = 12_000_000; // per sending connection: a 1080p60 screen plus a camera
const KIND: Record<MediaSource, 'audio' | 'video'> = { mic: 'audio', camera: 'video', screen: 'video', screenAudio: 'audio' };

const json = z.record(z.string(), z.unknown());
const schemas = {
  createTransport: z.object({ direction: z.enum(['send', 'recv']) }),
  connectTransport: z.object({ transportId: z.string().max(64), dtlsParameters: json }),
  produce: z.object({ transportId: z.string().max(64), source: z.enum(MEDIA_SOURCES as [MediaSource, ...MediaSource[]]), rtpParameters: json }),
  source: z.object({ source: z.enum(MEDIA_SOURCES as [MediaSource, ...MediaSource[]]) }),
  consume: z.object({ producerId: z.string().max(64), rtpCapabilities: json }),
  consumer: z.object({ consumerId: z.string().max(64) }),
  layers: z.object({ consumerId: z.string().max(64), spatialLayer: z.number().int().min(0).max(4) }),
};

export class RtcError extends Error {}

interface Peer {
  userId: string;
  send: ms.WebRtcTransport | null;
  recv: ms.WebRtcTransport | null;
  producers: Map<MediaSource, ms.Producer>;
  consumers: Map<string, ms.Consumer>;
}

interface Room {
  router: ms.Router;
  peers: Map<string, Peer>;
}

// What a participant may send, from the channel's permissions.
export interface Allowed {
  speak: boolean;
  stream: boolean;
}

export class Sfu {
  private worker: ms.Worker | null = null;
  private server: ms.WebRtcServer | null = null;
  private starting: Promise<void> | null = null;
  private rooms = new Map<string, Room>(); // by voice channel
  private where = new Map<string, string>(); // userId -> channelId
  private closed = false;

  // emit: deliver an event to a participant's voice connection.
  constructor(
    private config: ServerConfig,
    private emit: (userId: string, event: RtcEvent) => void,
  ) {}

  // Starts the media worker. The server calls it at startup (so the voice port is open and a
  // problem shows in the log right away); otherwise the first voice request does, as in tests.
  start(): Promise<void> {
    this.starting ??= (async () => {
      const announced = await announcedAddress(this.config.rtcAddress);
      const worker = await mediasoup.createWorker({ logLevel: 'warn' });
      worker.on('died', () => {
        // A crashed worker takes every call with it; the next request starts a new one.
        console.error('Ses sunucusu (mediasoup) beklenmedik şekilde kapandı; yeniden başlatılacak.');
        this.rooms.clear();
        this.where.clear();
        this.worker = this.server = null;
        this.starting = null;
      });
      const port = this.config.rtcPort || undefined; // 0: any free port (tests)
      this.server = await worker.createWebRtcServer({
        listenInfos: [
          { protocol: 'udp', ip: '0.0.0.0', announcedAddress: announced, port },
          { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: announced, port },
        ],
      });
      this.worker = worker;
    })().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  close() {
    this.closed = true;
    this.worker?.close();
  }

  // One request from a participant. channelId is where the gateway says they are.
  async request(userId: string, channelId: string, allowed: Allowed, method: string, data: unknown): Promise<unknown> {
    if (this.closed) throw new RtcError('Sunucu kapanıyor');
    await this.start();
    if (this.where.get(userId) !== channelId) await this.join(userId, channelId);
    const room = this.rooms.get(channelId)!;
    const peer = room.peers.get(userId)!;

    switch (method) {
      case 'join':
        return {
          rtpCapabilities: room.router.rtpCapabilities,
          producers: this.producersFor(room, userId),
        };

      case 'createTransport': {
        const { direction } = parse(schemas.createTransport, data);
        const old = peer[direction];
        old?.close();
        const t = await room.router.createWebRtcTransport({
          webRtcServer: this.server!,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 1_500_000,
        });
        if (direction === 'send') await t.setMaxIncomingBitrate(MAX_INCOMING_BITRATE);
        peer[direction] = t;
        return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
      }

      case 'connectTransport': {
        const { transportId, dtlsParameters } = parse(schemas.connectTransport, data);
        const t = [peer.send, peer.recv].find((x) => x?.id === transportId);
        if (!t) throw new RtcError('Bağlantı bulunamadı');
        await t.connect({ dtlsParameters: dtlsParameters as unknown as ms.DtlsParameters });
        return {};
      }

      case 'produce': {
        const { transportId, source, rtpParameters } = parse(schemas.produce, data);
        if (peer.send?.id !== transportId) throw new RtcError('Gönderme bağlantısı yok');
        if (!mayProduce(source, allowed)) throw new RtcError(source === 'mic' ? 'Bu kanalda konuşma iznin yok' : 'Bu kanalda görüntü paylaşma iznin yok');
        this.closeProducer(room, peer, source);
        const producer = await peer.send.produce({
          kind: KIND[source],
          rtpParameters: rtpParameters as unknown as ms.RtpParameters,
          appData: { source },
        });
        peer.producers.set(source, producer);
        producer.on('transportclose', () => this.closeProducer(room, peer, source));
        this.toOthers(room, userId, { type: 'producerAdded', producerId: producer.id, userId, source });
        return { id: producer.id };
      }

      case 'closeProducer':
        this.closeProducer(room, peer, parse(schemas.source, data).source);
        return {};

      case 'pauseProducer':
        await peer.producers.get(parse(schemas.source, data).source)?.pause();
        return {};

      case 'resumeProducer': {
        const { source } = parse(schemas.source, data);
        if (!mayProduce(source, allowed)) throw new RtcError('İzin yok');
        await peer.producers.get(source)?.resume();
        return {};
      }

      case 'consume': {
        const { producerId, rtpCapabilities } = parse(schemas.consume, data);
        if (!peer.recv) throw new RtcError('Alma bağlantısı yok');
        const owner = [...room.peers.values()].find((p) => [...p.producers.values()].some((x) => x.id === producerId));
        if (!owner || owner === peer) throw new RtcError('Yayın bulunamadı');
        const caps = rtpCapabilities as unknown as ms.RtpCapabilities;
        if (!room.router.canConsume({ producerId, rtpCapabilities: caps })) throw new RtcError('Bu yayın alınamıyor');
        const consumer = await peer.recv.consume({ producerId, rtpCapabilities: caps, paused: true });
        peer.consumers.set(consumer.id, consumer);
        const forget = () => peer.consumers.delete(consumer.id);
        consumer.on('transportclose', forget);
        consumer.on('producerclose', forget);
        const source = (consumer.appData.source ?? [...owner.producers].find(([, p]) => p.id === producerId)![0]) as MediaSource;
        return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, userId: owner.userId, source };
      }

      case 'resumeConsumer':
        await peer.consumers.get(parse(schemas.consumer, data).consumerId)?.resume();
        return {};

      case 'closeConsumer': {
        const { consumerId } = parse(schemas.consumer, data);
        peer.consumers.get(consumerId)?.close();
        peer.consumers.delete(consumerId);
        return {};
      }

      // Big tile: the sharp layer; small tile: a lighter one, so nobody downloads more than they show.
      case 'setLayers': {
        const { consumerId, spatialLayer } = parse(schemas.layers, data);
        await peer.consumers.get(consumerId)?.setPreferredLayers({ spatialLayer });
        return {};
      }
    }
    throw new RtcError('Bilinmeyen istek');
  }

  // Leaving the channel (or moving): everything the participant sent or received is closed.
  leave(userId: string) {
    const channelId = this.where.get(userId);
    if (!channelId) return;
    this.where.delete(userId);
    const room = this.rooms.get(channelId);
    const peer = room?.peers.get(userId);
    if (!room || !peer) return;
    for (const source of [...peer.producers.keys()]) this.closeProducer(room, peer, source);
    peer.send?.close();
    peer.recv?.close();
    room.peers.delete(userId);
    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(channelId);
    }
  }

  // Permissions changed while connected: stop what may no longer be sent.
  enforce(userId: string, allowed: Allowed) {
    const room = this.rooms.get(this.where.get(userId) ?? '');
    const peer = room?.peers.get(userId);
    if (!room || !peer) return;
    for (const source of [...peer.producers.keys()]) if (!mayProduce(source, allowed)) this.closeProducer(room, peer, source);
  }

  // The participant turned their camera or screen off in their voice state.
  stopSources(userId: string, sources: MediaSource[]) {
    const room = this.rooms.get(this.where.get(userId) ?? '');
    const peer = room?.peers.get(userId);
    if (room && peer) for (const s of sources) this.closeProducer(room, peer, s);
  }

  private async join(userId: string, channelId: string) {
    this.leave(userId);
    let room = this.rooms.get(channelId);
    if (!room) {
      const router = await this.worker!.createRouter({ mediaCodecs: CODECS });
      // Another request may have made the room while this one waited.
      room = this.rooms.get(channelId);
      if (room) router.close();
      else {
        room = { router, peers: new Map() };
        this.rooms.set(channelId, room);
      }
    }
    room.peers.set(userId, { userId, send: null, recv: null, producers: new Map(), consumers: new Map() });
    this.where.set(userId, channelId);
  }

  private producersFor(room: Room, userId: string): RtcProducer[] {
    const out: RtcProducer[] = [];
    for (const p of room.peers.values()) {
      if (p.userId === userId) continue;
      for (const [source, producer] of p.producers) out.push({ producerId: producer.id, userId: p.userId, source });
    }
    return out;
  }

  private closeProducer(room: Room, peer: Peer, source: MediaSource) {
    const producer = peer.producers.get(source);
    if (!producer) return;
    peer.producers.delete(source);
    producer.close();
    this.toOthers(room, peer.userId, { type: 'producerRemoved', producerId: producer.id });
  }

  private toOthers(room: Room, userId: string, event: RtcEvent) {
    for (const p of room.peers.values()) if (p.userId !== userId) this.emit(p.userId, event);
  }

  // Diagnostics for tests: rooms and what each participant sends and receives.
  stats() {
    return [...this.rooms].map(([channelId, room]) => ({
      channelId,
      peers: [...room.peers.values()].map((p) => ({ userId: p.userId, producers: [...p.producers.keys()], consumers: p.consumers.size })),
    }));
  }
}

function mayProduce(source: MediaSource, allowed: Allowed): boolean {
  return source === 'mic' ? allowed.speak : allowed.stream;
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new RtcError('Geçersiz istek');
  return r.data;
}

// The address put in the media candidates: the configured one (a host name is looked up once),
// otherwise this machine's first network address, which works on a LAN and for local testing.
async function announcedAddress(configured: string | null): Promise<string> {
  if (configured) return isIP(configured) ? configured : (await lookup(configured, { family: 4 })).address;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}
