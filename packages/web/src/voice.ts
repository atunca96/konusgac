import { Op, type MediaSource, type ServerFrame, type VoiceState } from '@konusgac/shared';
import { sendFrame } from './connection';
import { onRtcResponse, RtcSession, type RemoteTrack } from './rtc';
import { getSettings, subscribeSettings, updateSettings, type Settings } from './settings';
import { playSound } from './sounds';
import { getState, myVoiceHere, setState, subscribe, type VoiceSelf } from './state';

// Voice and video go through the server's voice router (see rtc.ts and server/src/sfu.ts): we
// send each stream once and receive everyone else's from the server.
//
// Our microphone goes through a small Web Audio graph before it is sent:
//   mic (chosen device, chosen filters) → input volume → [level meter] → gate → sent track
// The gate opens on voice activity (above the sensitivity threshold) or while push-to-talk is
// held. Swapping the microphone only changes the graph's source, so the sent track stays the same.
//
// Incoming audio plays through Web Audio too, so each person has their own volume (up to 200%),
// can be muted locally, and everything goes to the chosen output device. A screen's sound goes
// through the same per-person volume.

const SPEAKING_RMS = 0.015;
const SPEAKING_HOLD_MS = 300;
const VAD_HOLD_MS = 400; // the gate stays open this long after the voice drops below the threshold
const SILENCE_DB = -95; // below this the microphone is considered silent
const SILENCE_WARN_MS = 5000;

// What we receive from one person in the channel.
interface Remote {
  userId: string;
  gain: GainNode | null; // this person's volume
  voice: { el: HTMLAudioElement; source: MediaStreamAudioSourceNode | null; stopMeter: () => void } | null;
  screenSound: { el: HTMLAudioElement; source: MediaStreamAudioSourceNode | null } | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
}

interface Input {
  raw: MediaStream; // straight from getUserMedia
  source: MediaStreamAudioSourceNode;
  key: string; // device + filters it was opened with
}

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null; // output volume and deafen
let outAnalyser: AnalyserNode | null = null; // what actually goes to the speakers
let heardEnergy = 0; // running sum of output power × seconds, for diagnostics and the voice test
let inputGain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let gate: GainNode | null = null;
let local: MediaStream | null = null; // the processed stream we send
let input: Input | null = null;
let vadTimer: number | undefined;
let stopLocalMeter: (() => void) | undefined;
let rtc: RtcSession | null = null;
const remotes = new Map<string, Remote>();
let camera: MediaStream | null = null; // our camera, while it is on
let screen: MediaStream | null = null; // our screen share, while it is on
let screenQuality: { height: 720 | 1080 | 0; fps: 15 | 30 | 60 } | null = null;
let joinedSession: string | null = null; // gateway session our join request was sent on
let others = new Set<string>(); // who else is in our channel, for the join and leave sounds

let pttHeld = false;
let pttReleasedAt = 0;
let gateOpen = false;
let lastVoiceAt = 0;
let noiseFloor = -70; // estimated background level for automatic sensitivity
let inputDb = -100;
let silentSince = 0;

function setSelf(patch: Partial<VoiceSelf>) {
  setState((s) => ({ voiceSelf: { ...s.voiceSelf, ...patch } }));
}

function sendVoiceState() {
  const v = getState().voiceSelf;
  sendFrame({
    op: Op.VoiceStateUpdate,
    d: { channelId: v.channelId, selfMute: v.selfMute || v.noMic, selfDeaf: v.selfDeaf, selfVideo: v.selfVideo, selfStream: v.selfStream },
  });
}

// ---------- public controls ----------

export async function joinVoice(channelId: string) {
  const s = getState();
  if (s.voiceSelf.channelId === channelId && (s.voiceSelf.connecting || myVoiceHere(s)?.channelId === channelId)) return;
  const switching = !!s.voiceSelf.channelId;
  if (switching) {
    // Camera and screen stay in the channel they were shared in.
    stopCamera(false);
    stopScreenShare(false);
  }
  setSelf({ channelId, connecting: true, error: null });
  // Created inside the click handler so the browser lets it play.
  ensureAudioGraph();
  void audioCtx!.resume();
  if (!input) await openMicrophone();
  if (getState().voiceSelf.channelId !== channelId) return; // left or switched while waiting for the mic
  applyLocalTrack();
  joinedSession = getState().sessionId;
  sendVoiceState();
  if (!switching) playSound('join');
}

export function leaveVoice() {
  if (!getState().voiceSelf.channelId) return;
  stopCamera(false);
  stopScreenShare(false);
  setSelf({ channelId: null, connecting: false, silent: false });
  sendVoiceState();
  teardown();
  playSound('leave');
}

export function toggleMute() {
  const v = getState().voiceSelf;
  // Unmuting while deafened undeafens too, as one would expect.
  if (v.selfDeaf && v.selfMute) setSelf({ selfMute: false, selfDeaf: false });
  else setSelf({ selfMute: !v.selfMute });
  playSound(getState().voiceSelf.selfMute ? 'mute' : 'unmute');
  applyLocalTrack();
  applyOutput();
  if (getState().voiceSelf.channelId) sendVoiceState();
}

export function toggleDeaf() {
  const v = getState().voiceSelf;
  setSelf({ selfDeaf: !v.selfDeaf });
  playSound(getState().voiceSelf.selfDeaf ? 'deafen' : 'undeafen');
  applyLocalTrack();
  applyOutput();
  if (getState().voiceSelf.channelId) sendVoiceState();
}

// Push-to-talk key held or released (from the keybind handler).
export function setPushToTalk(held: boolean) {
  if (held === pttHeld || getSettings().inputMode !== 'ptt') return;
  pttHeld = held;
  if (!held) pttReleasedAt = Date.now();
  if (getState().voiceSelf.channelId && localTrackEnabled()) playSound(held ? 'pttStart' : 'pttStop');
}

export function dismissVoiceError() {
  setSelf({ error: null });
}

// Local cleanup when the session ends (logout).
export function resetVoice() {
  teardown();
  joinedSession = null;
}

// ---------- gateway events ----------

export function onVoiceDispatch(frame: ServerFrame) {
  if (!('t' in frame)) return;
  if (frame.t === 'RTC_RESPONSE') onRtcResponse(frame.d);
  else if (frame.t === 'RTC_EVENT') rtc?.onEvent(frame.d);
  else if (frame.t === 'VOICE_ERROR') {
    // A refused move keeps us in the channel we were already in, if any.
    const here = myVoiceHere(getState());
    setSelf({ channelId: here?.channelId ?? null, connecting: false, error: frame.d.message });
    if (!here) teardown();
  }
}

// ---------- following the voice state ----------

let reconciling = false;
let dirty = false;

subscribe(() => {
  if (reconciling) {
    dirty = true;
    return;
  }
  reconciling = true;
  try {
    do {
      dirty = false;
      reconcile();
    } while (dirty);
  } finally {
    reconciling = false;
  }
});

let lastVoice: unknown;
let lastSession: unknown;
let lastSelf: unknown;

function reconcile() {
  const s = getState();
  if (s.voice === lastVoice && s.sessionId === lastSession && s.voiceSelf === lastSelf) return;
  lastVoice = s.voice;
  lastSession = s.sessionId;
  lastSelf = s.voiceSelf;

  const want = s.voiceSelf.channelId;
  const here = myVoiceHere(s);

  if (want && s.connection === 'ready' && joinedSession && s.sessionId !== joinedSession) {
    // The gateway reconnected and the server forgot us: rejoin on the new session.
    closeRtc();
    joinedSession = s.sessionId;
    setSelf({ connecting: true });
    sendVoiceState();
    return;
  }
  if (want && s.voiceSelf.connecting && here?.channelId === want) {
    setSelf({ connecting: false });
    return;
  }
  if (want && !s.voiceSelf.connecting && !here) {
    // Disconnected by the server (permission change, channel deleted) or taken over by another tab.
    setSelf({ channelId: null, selfVideo: false, selfStream: false });
    teardown();
    return;
  }
  if (!here || !local) {
    closeRtc();
    return;
  }

  // One media session per (gateway session, channel); moving channels starts a new one.
  if (rtc && (rtc.sessionId !== here.sessionId || rtc.channelId !== here.channelId)) closeRtc();
  if (!rtc) openRtc(here);
  applyLocalTrack(here);

  const now = new Set(Object.values(s.voice).filter((v) => v.channelId === here.channelId && v.userId !== here.userId).map((v) => v.userId));
  if (!s.voiceSelf.connecting) {
    for (const id of now) if (!others.has(id)) playSound('userJoin');
    for (const id of others) if (!now.has(id)) playSound('userLeave');
  }
  others = now;
}

function openRtc(here: VoiceState) {
  const session = new RtcSession(here.sessionId, here.channelId!, {
    added: onRemoteTrack,
    removed: onRemoteGone,
    screens: mediaChanged,
    state: (state) => setState(() => ({ rtcState: state })),
  });
  rtc = session;
  setState(() => ({ rtcState: 'connecting' }));
  session.ready.then(
    () => {
      // What we were already sending before this session (e.g. after a reconnect) goes out again.
      if (rtc !== session) return;
      applyLocalTrack();
      void sendCamera();
      void sendScreen();
    },
    (err: Error) => {
      if (rtc !== session) return;
      console.warn('Ses sunucusuna bağlanılamadı', err);
      setSelf({ error: `Ses sunucusuna bağlanılamadı: ${err.message}` });
      setState(() => ({ rtcState: 'failed' }));
    },
  );
}

function closeRtc() {
  rtc?.close();
  rtc = null;
  for (const id of [...remotes.keys()]) dropRemote(id);
  others = new Set();
  setState(() => ({ rtcState: null }));
}

// ---------- what we receive ----------

function remote(userId: string): Remote {
  let r = remotes.get(userId);
  if (!r) {
    r = { userId, gain: null, voice: null, screenSound: null, camera: null, screen: null };
    remotes.set(userId, r);
  }
  return r;
}

function onRemoteTrack({ userId, source, track }: RemoteTrack) {
  const r = remote(userId);
  if (source === 'camera' || source === 'screen') {
    r[source] = new MediaStream([track]);
    mediaChanged();
    return;
  }
  // Remote audio has to be attached to an element for Chrome to deliver it into Web Audio; the
  // element itself stays muted, the sound comes out of the graph with this person's volume.
  const stream = new MediaStream([track]);
  const el = new Audio();
  el.muted = true;
  el.srcObject = stream;
  void el.play().catch(() => {});
  const gain = peerGain(r);
  const node = audioCtx && gain ? audioCtx.createMediaStreamSource(stream) : null;
  if (node && gain) node.connect(gain);
  if (source === 'mic') {
    stopVoice(r);
    r.voice = { el, source: node, stopMeter: meter(stream, () => userId, () => !getSettings().userMutes[userId]) };
  } else {
    stopScreenSound(r);
    r.screenSound = { el, source: node };
  }
}

function onRemoteGone(userId: string, source: MediaSource) {
  const r = remotes.get(userId);
  if (!r) return;
  if (source === 'mic') stopVoice(r);
  else if (source === 'screenAudio') stopScreenSound(r);
  else {
    r[source] = null;
    mediaChanged();
  }
}

function stopVoice(r: Remote) {
  if (!r.voice) return;
  r.voice.stopMeter();
  r.voice.source?.disconnect();
  r.voice.el.srcObject = null;
  r.voice = null;
}

function stopScreenSound(r: Remote) {
  if (!r.screenSound) return;
  r.screenSound.source?.disconnect();
  r.screenSound.el.srcObject = null;
  r.screenSound = null;
}

function dropRemote(userId: string) {
  const r = remotes.get(userId);
  if (!r) return;
  remotes.delete(userId);
  stopVoice(r);
  stopScreenSound(r);
  r.gain?.disconnect();
  mediaChanged();
}

// This person's volume node, made on first use and wired to the master output.
function peerGain(r: Remote): GainNode | null {
  if (!audioCtx || !master) return null;
  if (!r.gain) {
    r.gain = audioCtx.createGain();
    r.gain.connect(master);
    applyPeerVolume(r);
  }
  return r.gain;
}

function teardown() {
  closeRtc();
  camera?.getTracks().forEach((t) => t.stop());
  screen?.getTracks().forEach((t) => t.stop());
  camera = screen = null;
  clearInterval(vadTimer);
  vadTimer = undefined;
  stopLocalMeter?.();
  stopLocalMeter = undefined;
  input?.raw.getTracks().forEach((t) => t.stop());
  input = null;
  local?.getTracks().forEach((t) => t.stop());
  local = null;
  void audioCtx?.close();
  audioCtx = null;
  master = inputGain = gate = null;
  outAnalyser = null;
  analyser = null;
  gateOpen = false;
}

// ---------- audio graph ----------

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  master = audioCtx.createGain();
  master.connect(audioCtx.destination);
  outAnalyser = audioCtx.createAnalyser();
  outAnalyser.fftSize = 1024;
  master.connect(outAnalyser);
  inputGain = audioCtx.createGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  gate = audioCtx.createGain();
  gate.gain.value = 0;
  const dest = audioCtx.createMediaStreamDestination();
  inputGain.connect(analyser);
  inputGain.connect(gate).connect(dest);
  local = dest.stream;
  applyOutput();
  applyInputVolume();
  stopLocalMeter = meter(local, () => getState().me?.id, () => localTrackEnabled());
  vadTimer = window.setInterval(tickGate, 20);
}

function micConstraints(s: Settings): MediaTrackConstraints {
  return {
    deviceId: s.inputDeviceId === 'default' ? undefined : { exact: s.inputDeviceId },
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.automaticGainControl,
  };
}

const micKey = (s: Settings) => JSON.stringify([s.inputDeviceId, s.echoCancellation, s.noiseSuppression, s.automaticGainControl]);

// Opens (or reopens) the microphone with the current device and filters and plugs it into the graph.
async function openMicrophone() {
  const s = getSettings();
  let raw: MediaStream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia yok');
    raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(s), video: false }).catch(async (err) => {
      // The chosen device was unplugged: fall back to the default one.
      if (s.inputDeviceId === 'default') throw err;
      return navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(s), deviceId: undefined }, video: false });
    });
    setSelf({ noMic: false });
  } catch {
    // No microphone or permission denied: stay listen-only; the gate keeps the sent track silent.
    setSelf({ noMic: true });
    return;
  }
  if (!audioCtx || !inputGain) {
    raw.getTracks().forEach((t) => t.stop());
    return;
  }
  const old = input;
  input = { raw, source: audioCtx.createMediaStreamSource(raw), key: micKey(s) };
  input.source.connect(inputGain);
  if (old) {
    old.source.disconnect();
    old.raw.getTracks().forEach((t) => t.stop());
  }
}

// Called every 20 ms: measures the input and opens or closes the gate.
function tickGate() {
  if (!analyser || !gate || !audioCtx) return;
  const s = getSettings();
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  inputDb = Math.max(-100, 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-10));
  if (outAnalyser) {
    outAnalyser.getFloatTimeDomainData(buf);
    let out = 0;
    for (const x of buf) out += x * x;
    heardEnergy += (out / buf.length) * 0.02;
  }

  // Background estimate: falls quickly to quiet moments, rises slowly with steady noise.
  noiseFloor = inputDb < noiseFloor ? noiseFloor + (inputDb - noiseFloor) * 0.2 : noiseFloor + (inputDb - noiseFloor) * 0.002;
  const now = Date.now();
  let open: boolean;
  if (s.inputMode === 'ptt') open = pttHeld || now - pttReleasedAt < s.pttReleaseDelay;
  else {
    if (inputDb > currentThreshold()) lastVoiceAt = now;
    open = now - lastVoiceAt < VAD_HOLD_MS;
  }
  open = open && localTrackEnabled();
  if (open !== gateOpen) {
    gateOpen = open;
    gate.gain.setTargetAtTime(open ? 1 : 0, audioCtx.currentTime, 0.01);
  }

  // "Your microphone is silent" warning while connected and unmuted.
  const v = getState().voiceSelf;
  const watching = s.silenceWarning && v.channelId && !v.connecting && localTrackEnabled() && input;
  if (watching && inputDb < SILENCE_DB) {
    silentSince ||= now;
    if (now - silentSince > SILENCE_WARN_MS && !v.silent) setSelf({ silent: true });
  } else {
    silentSince = 0;
    if (v.silent) setSelf({ silent: false });
  }
}

// The sensitivity in dB: manual, or a margin above the measured background.
export function currentThreshold(): number {
  const s = getSettings();
  return s.autoThreshold ? Math.min(-30, Math.max(-75, noiseFloor + 14)) : s.threshold;
}

// Live input level for the settings page (dB, -100–0) while in a voice channel.
export function voiceInputLevel(): number | null {
  return analyser ? inputDb : null;
}

function localTrackEnabled(here = myVoiceHere(getState())): boolean {
  const v = getState().voiceSelf;
  return !(v.selfMute || v.selfDeaf || v.noMic || here?.suppress);
}

// The microphone is sent while we may speak (not suppressed, a microphone exists); muting pauses it.
function applyLocalTrack(here?: VoiceState) {
  const enabled = localTrackEnabled(here);
  local?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  if (!rtc) return;
  const v = getState().voiceSelf;
  const may = !(v.noMic || (here ?? myVoiceHere(getState()))?.suppress);
  const track = local?.getAudioTracks()[0] ?? null;
  if (may && track && !rtc.sends('mic')) void rtc.setSource('mic', track).then(() => rtc?.pauseMic(!localTrackEnabled()));
  else if (!may && rtc.sends('mic')) void rtc.setSource('mic', null);
  else void rtc.pauseMic(!enabled);
}

function applyInputVolume() {
  if (inputGain) inputGain.gain.value = getSettings().inputVolume / 100;
}

function applyOutput() {
  const s = getSettings();
  if (master) master.gain.value = getState().voiceSelf.selfDeaf ? 0 : s.outputVolume / 100;
  setOutputDevice(audioCtx, s.outputDeviceId);
}

// ---------- camera and screen sharing ----------

export interface ScreenShareOptions {
  sourceId?: string; // desktop app: the screen or window picked in our own picker
  resolution: 720 | 1080 | 0; // 0 = as the source is
  fps: 15 | 30 | 60;
  audio: boolean;
}

export async function toggleCamera() {
  if (camera) return stopCamera();
  if (!getState().voiceSelf.channelId) return;
  const s = getSettings();
  const constraints = (deviceId?: string): MediaStreamConstraints => ({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices
      .getUserMedia(constraints(s.videoDeviceId === 'default' ? undefined : s.videoDeviceId))
      .catch(() => navigator.mediaDevices.getUserMedia(constraints())); // the chosen camera was unplugged
  } catch (err) {
    const name = (err as DOMException).name;
    setSelf({
      error:
        name === 'NotAllowedError'
          ? 'Kamera izni verilmedi. Tarayıcının adres çubuğundaki kamera simgesinden izin verebilirsin.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'Kamera bulunamadı.'
            : name === 'NotReadableError'
              ? 'Kamera açılamadı: başka bir uygulama kullanıyor olabilir.'
              : `Kamera açılamadı (${name}).`,
    });
    return;
  }
  if (!getState().voiceSelf.channelId) return stream.getTracks().forEach((t) => t.stop());
  camera = stream;
  stream.getVideoTracks()[0]!.onended = () => stopCamera();
  setSelf({ selfVideo: true, error: null });
  sendVoiceState();
  void sendCamera();
  mediaChanged();
}

function sendCamera() {
  return rtc?.setSource('camera', camera?.getVideoTracks()[0] ?? null);
}

function sendScreen() {
  if (!rtc) return;
  const q = screenQuality ?? undefined;
  void rtc.setSource('screen', screen?.getVideoTracks()[0] ?? null, screen ? q : undefined);
  void rtc.setSource('screenAudio', screen?.getAudioTracks()[0] ?? null);
}

export function stopCamera(announce = true) {
  if (!camera) return;
  camera.getTracks().forEach((t) => t.stop());
  camera = null;
  setSelf({ selfVideo: false });
  if (announce && getState().voiceSelf.channelId) sendVoiceState();
  void sendCamera();
  mediaChanged();
}

export async function startScreenShare(o: ScreenShareOptions) {
  if (!getState().voiceSelf.channelId) return;
  const shell = (window as { konusgac?: { pickScreenSource?(id: string, audio: boolean): Promise<boolean> } }).konusgac;
  if (o.sourceId && shell?.pickScreenSource) await shell.pickScreenSource(o.sourceId, o.audio);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: o.fps, max: o.fps },
        ...(o.resolution ? { height: { ideal: o.resolution, max: o.resolution } } : {}),
      },
      // Our own voice chat stays out of the shared sound where the browser supports it.
      audio: o.audio ? ({ restrictOwnAudio: true, suppressLocalAudioPlayback: false } as MediaTrackConstraints) : false,
    });
  } catch (err) {
    // NotAllowedError: the picker was cancelled, which is not an error to show.
    if ((err as DOMException).name !== 'NotAllowedError') setSelf({ error: 'Ekran paylaşımı başlatılamadı.' });
    return;
  }
  if (!getState().voiceSelf.channelId) return stream.getTracks().forEach((t) => t.stop());
  screen?.getTracks().forEach((t) => t.stop());
  screen = stream;
  screenQuality = { height: o.resolution, fps: o.fps };
  const video = stream.getVideoTracks()[0]!;
  video.contentHint = o.fps >= 30 ? 'motion' : 'detail'; // smooth for games and video, sharp for text
  video.onended = () => stopScreenShare(); // "Paylaşımı durdur" in the browser's own bar
  setSelf({ selfStream: true, error: null });
  sendVoiceState();
  sendScreen();
  mediaChanged();
  playSound('streamStart');
}

export function stopScreenShare(announce = true) {
  if (!screen) return;
  screen.getTracks().forEach((t) => t.stop());
  screen = null;
  setSelf({ selfStream: false });
  if (announce && getState().voiceSelf.channelId) {
    sendVoiceState();
    playSound('streamStop');
  }
  sendScreen();
  mediaChanged();
}

export function screenShareSupported(): boolean {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

// What to show for someone's camera or screen; for ourselves, our own local preview.
export function mediaStream(userId: string, kind: 'camera' | 'screen'): MediaStream | null {
  if (userId === getState().me?.id) return kind === 'camera' ? camera : screen;
  return remotes.get(userId)?.[kind] ?? null;
}

// Screens are received only while watched ("Yayını izle").
export function isWatching(userId: string): boolean {
  return userId === getState().me?.id || !!rtc?.isWatching(userId);
}

export function watchStream(userId: string, on: boolean) {
  rtc?.watch(userId, on);
  mediaChanged();
}

// A tile shown big asks for the sharp layer, a small one for a lighter layer.
export function setStreamQuality(userId: string, kind: 'camera' | 'screen', high: boolean) {
  if (userId !== getState().me?.id) rtc?.setQuality(userId, kind, high);
}

// Video tiles re-read mediaStream() when peers or our own tracks change.
let mediaVersion = 0;
const mediaListeners = new Set<() => void>();
function mediaChanged() {
  mediaVersion++;
  mediaListeners.forEach((l) => l());
}
export function subscribeMedia(l: () => void): () => void {
  mediaListeners.add(l);
  return () => mediaListeners.delete(l);
}
export const getMediaVersion = () => mediaVersion;

function applyPeerVolume(r: Remote) {
  const s = getSettings();
  if (r.gain) r.gain.gain.value = s.userMutes[r.userId] ? 0 : (s.userVolumes[r.userId] ?? 100) / 100;
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

function setOutputDevice(ctx: AudioContext | null, deviceId: string) {
  const c = ctx as SinkContext | null;
  if (!c?.setSinkId) return;
  void c.setSinkId(deviceId === 'default' ? '' : deviceId).catch(() => c.setSinkId!('').catch(() => {}));
}

// Settings changed: apply volumes and devices to a running call; reopen the microphone only when
// its device or filters changed.
let lastSettings = getSettings();
subscribeSettings(() => {
  const s = getSettings();
  const prev = lastSettings;
  lastSettings = s;
  if (!audioCtx) return;
  if (s.inputVolume !== prev.inputVolume) applyInputVolume();
  if (s.outputVolume !== prev.outputVolume || s.outputDeviceId !== prev.outputDeviceId) applyOutput();
  if (s.userVolumes !== prev.userVolumes || s.userMutes !== prev.userMutes) remotes.forEach(applyPeerVolume);
  if (input && micKey(s) !== input.key) void openMicrophone();
});

// Marks a user as speaking while the stream's loudness stays above a threshold.
function meter(stream: MediaStream, userId: () => string | undefined, active: () => boolean): () => void {
  const ctx = audioCtx;
  if (!ctx) return () => {};
  const source = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  source.connect(an);
  const buf = new Float32Array(an.fftSize);
  let lastLoud = 0;
  let speaking = false;

  const set = (on: boolean) => {
    const id = userId();
    if (!id || on === speaking) return;
    speaking = on;
    setState((s) => {
      const { [id]: _was, ...rest } = s.speaking;
      return { speaking: on ? { ...rest, [id]: true } : rest };
    });
  };

  const timer = window.setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const now = Date.now();
    if (active() && Math.sqrt(sum / buf.length) > SPEAKING_RMS) lastLoud = now;
    set(now - lastLoud < SPEAKING_HOLD_MS);
  }, 60);

  return () => {
    clearInterval(timer);
    source.disconnect();
    set(false);
  };
}

// ---------- devices and tests (settings page) ----------

export interface Devices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  outputSelectable: boolean; // the browser can route audio to a chosen device
}

export async function listDevices(): Promise<Devices> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const real = (kind: MediaDeviceKind) => all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return {
    inputs: real('audioinput'),
    outputs: real('audiooutput'),
    cameras: real('videoinput'),
    outputSelectable: 'setSinkId' in AudioContext.prototype,
  };
}

// "Haydi kontrol edelim": opens the microphone with the current settings, reports its level and,
// with loopback, plays it back so you hear yourself. Returns a stop function.
export async function startMicTest(onLevel: (db: number) => void, loopback: boolean): Promise<() => void> {
  const s = getSettings();
  const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(s), video: false });
  const ctx = new AudioContext();
  setOutputDevice(ctx, s.outputDeviceId);
  const source = ctx.createMediaStreamSource(raw);
  const gain = ctx.createGain();
  gain.gain.value = s.inputVolume / 100;
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  source.connect(gain).connect(an);
  if (loopback) {
    const out = ctx.createGain();
    out.gain.value = s.outputVolume / 100;
    gain.connect(out).connect(ctx.destination);
  }
  const buf = new Float32Array(an.fftSize);
  let raf = 0;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    onLevel(Math.max(-100, 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-10)));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    raw.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}

export async function startCameraPreview(video: HTMLVideoElement, deviceId: string): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId === 'default' ? undefined : { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  return () => {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

// ---------- diagnostics ----------

// Link quality per person, for the voice end-to-end test and for troubleshooting from the console:
// await konusgacVoiceStats()
async function voiceStats() {
  return (await rtc?.stats())?.peers ?? {};
}

// Our own side: input level, sensitivity and whether the gate lets audio through.
function localVoiceStats() {
  return { inputDb, threshold: currentThreshold(), gateOpen, context: audioCtx?.state ?? null, mic: !!input, noiseFloor, heardEnergy };
}
(window as unknown as { konusgacLocalVoice: typeof localVoiceStats }).konusgacLocalVoice = localVoiceStats;
// Same as the per-user volume slider; used by the voice test.
(window as unknown as { konusgacSetUserVolume: (id: string, v: number) => void }).konusgacSetUserVolume = (id, v) =>
  updateSettings({ userVolumes: { ...getSettings().userVolumes, [id]: v } });
(window as unknown as { konusgacVoiceStats: typeof voiceStats }).konusgacVoiceStats = voiceStats;
// What we send and receive, for the end-to-end test and troubleshooting.
(window as unknown as { konusgacMediaStats: () => unknown }).konusgacMediaStats = async () => ({
  camera: !!camera,
  screen: !!screen,
  error: getState().voiceSelf.error,
  rtc: await rtc?.stats(),
  remotes: [...remotes.values()].map((r) => ({ userId: r.userId, voice: !!r.voice, camera: !!r.camera, screen: !!r.screen, screenSound: !!r.screenSound })),
});
