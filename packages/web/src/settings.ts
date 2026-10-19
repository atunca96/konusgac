import { useSyncExternalStore } from 'react';

// Settings kept on this device (like a desktop app's preferences): audio devices, input mode,
// appearance, notifications and keybinds. Account-wide settings (privacy) live on the server.

export type InputMode = 'voice' | 'ptt';
export type InputProfile = 'isolation' | 'studio' | 'custom';
export type Theme = 'dark' | 'darker' | 'light' | 'system';
export type SoundName =
  | 'message'
  | 'mention'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'join'
  | 'leave'
  | 'userJoin'
  | 'userLeave'
  | 'pttStart'
  | 'pttStop'
  | 'streamStart'
  | 'streamStop';

export interface Keybind {
  code: string; // KeyboardEvent.code, e.g. "KeyV", "Backquote", "F8"
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Settings {
  // ---- voice ----
  inputDeviceId: string; // 'default' = the system's default device
  outputDeviceId: string;
  videoDeviceId: string;
  inputVolume: number; // percent, 0–200
  outputVolume: number; // percent, 0–200
  inputMode: InputMode;
  pttKey: Keybind | null;
  pttReleaseDelay: number; // ms, 0–2000
  autoThreshold: boolean; // let the app find the sensitivity
  threshold: number; // dB, -100–0: input below this is not sent
  inputProfile: InputProfile;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  automaticGainControl: boolean;
  silenceWarning: boolean; // warn when the microphone sends nothing
  userVolumes: Record<string, number>; // per user, percent 0–200
  userMutes: Record<string, boolean>; // users muted locally
  streamResolution: 720 | 1080 | 0; // screen share height; 0 = the source's own
  streamFps: 15 | 30 | 60;
  streamAudio: boolean; // share the computer's sound with the screen

  // ---- notifications ----
  desktopNotifications: boolean;
  unreadBadge: boolean; // count on the taskbar / tab title
  flashFrame: boolean; // flash the taskbar button on a new ping
  sounds: Record<SoundName, boolean>;
  soundVolume: number; // percent, 0–100

  // ---- keybinds ----
  toggleMuteKey: Keybind | null;
  toggleDeafKey: Keybind | null;

  // ---- appearance & accessibility ----
  theme: Theme;
  compact: boolean; // compact message layout
  fontSize: number; // px, 12–24
  zoom: number; // percent, 50–200 (desktop app only)
  reducedMotion: 'system' | 'on' | 'off';
  saturation: number; // percent, 0–100
  roleColors: boolean; // show role colors on names
  underlineLinks: boolean;

  // ---- text & images ----
  inlineMedia: boolean; // show images and videos in the chat
  showReactions: boolean;
  convertEmoticons: boolean; // :) → 🙂
  spellcheck: boolean;
  sendOnEnter: boolean;

  // ---- streamer mode & advanced ----
  streamerMode: boolean; // hide personal info, invite links and notifications
  developerMode: boolean; // "ID'yi kopyala" in menus
}

export const DEFAULT_SETTINGS: Settings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: 'default',
  streamResolution: 1080,
  streamFps: 30,
  streamAudio: true,
  inputVolume: 100,
  outputVolume: 100,
  inputMode: 'voice',
  pttKey: null,
  pttReleaseDelay: 20,
  autoThreshold: true,
  threshold: -60,
  inputProfile: 'isolation',
  echoCancellation: true,
  noiseSuppression: true,
  automaticGainControl: true,
  silenceWarning: true,
  userVolumes: {},
  userMutes: {},

  desktopNotifications: true,
  unreadBadge: true,
  flashFrame: true,
  sounds: {
    message: true,
    mention: true,
    mute: true,
    unmute: true,
    deafen: true,
    undeafen: true,
    join: true,
    leave: true,
    userJoin: true,
    userLeave: true,
    pttStart: false,
    pttStop: false,
    streamStart: true,
    streamStop: true,
  },
  soundVolume: 60,

  toggleMuteKey: null,
  toggleDeafKey: null,

  theme: 'dark',
  compact: false,
  fontSize: 15,
  zoom: 100,
  reducedMotion: 'system',
  saturation: 100,
  roleColors: true,
  underlineLinks: false,

  inlineMedia: true,
  showReactions: true,
  convertEmoticons: true,
  spellcheck: true,
  sendOnEnter: true,

  streamerMode: false,
  developerMode: false,
};

// Input profiles set the voice processing in one click, like the presets of a desktop voice app.
export const PROFILES: Record<Exclude<InputProfile, 'custom'>, Partial<Settings>> = {
  // Clear speech in a noisy room: every filter on, sensitivity found automatically.
  isolation: { echoCancellation: true, noiseSuppression: true, automaticGainControl: true, autoThreshold: true },
  // Music and a good microphone: the raw signal, a low fixed threshold.
  studio: { echoCancellation: false, noiseSuppression: false, automaticGainControl: false, autoThreshold: false, threshold: -84 },
};

const KEY = 'konusgac.ayarlar';

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw, sounds: { ...DEFAULT_SETTINGS.sounds, ...raw.sounds } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or disabled: keep the settings for this session
  }
  listeners.forEach((l) => l());
}

export function resetSettings(keys: (keyof Settings)[]) {
  const patch: Partial<Settings> = {};
  for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
  updateSettings(patch);
}

export function subscribeSettings(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSettings<T>(select: (s: Settings) => T): T {
  return useSyncExternalStore(subscribeSettings, () => select(settings));
}

export function keybindLabel(k: Keybind | null): string {
  if (!k) return 'Atanmadı';
  const key = k.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace('Backquote', '"')
    .replace('Space', 'Boşluk')
    .replace('ShiftLeft', 'Sol Shift')
    .replace('ShiftRight', 'Sağ Shift')
    .replace('ControlLeft', 'Sol Ctrl')
    .replace('ControlRight', 'Sağ Ctrl')
    .replace('AltLeft', 'Sol Alt')
    .replace('AltRight', 'Sağ Alt')
    .replace('CapsLock', 'Caps Lock');
  return [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', key].filter(Boolean).join(' + ');
}

export function keybindMatches(k: Keybind | null, e: KeyboardEvent): boolean {
  if (!k || e.code !== k.code) return false;
  const modifier = /^(Shift|Control|Alt)/.test(k.code);
  return modifier || (e.ctrlKey === k.ctrl && e.altKey === k.alt && e.shiftKey === k.shift);
}

// ---------- applying appearance to the page ----------

function applyAppearance() {
  const s = settings;
  const root = document.documentElement;
  const theme = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme;
  root.dataset.theme = theme;
  root.dataset.compact = s.compact ? '1' : '0';
  root.dataset.underlineLinks = s.underlineLinks ? '1' : '0';
  const reduce = s.reducedMotion === 'system' ? matchMedia('(prefers-reduced-motion: reduce)').matches : s.reducedMotion === 'on';
  root.dataset.reducedMotion = reduce ? '1' : '0';
  root.style.setProperty('--chat-font-size', `${s.fontSize}px`);
  root.style.filter = s.saturation < 100 ? `saturate(${s.saturation}%)` : '';
  window.konusgac?.setZoom?.(s.zoom / 100);
}

applyAppearance();
subscribeSettings(applyAppearance);
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyAppearance);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyAppearance);
