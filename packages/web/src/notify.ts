import type { Message } from '@konusgac/shared';
import { getSettings } from './settings';
import { playSound } from './sounds';
import { channelById, displayName, getState, pingsMe } from './state';

// Bridge exposed by the desktop shell's preload script (absent in the browser).
interface DesktopBridge {
  notify(title: string, body: string): void;
  setBadge(count: number, flash?: boolean): void;
  info?(): Promise<{ version: string; canChangeServer: boolean; server: string | null } | null>;
  changeServer?(): void;
  setZoom?(factor: number): void;
  setShortcuts?(keys: { toggleMute: string | null; toggleDeaf: string | null }): void;
  onShortcut?(cb: (name: string) => void): void;
  getWindowSettings?(): Promise<WindowSettings>;
  setWindowSettings?(patch: Partial<WindowSettings>): void;
  screenSources?(): Promise<ScreenSource[]>;
  openGoogleSignIn?(): void; // Google sign-in in the system browser; the result comes back via konusgac://
  onNativeMenu?(cb: (p: import('./nativeMenu').NativeMenuParams) => void): void; // right-clicks no Konuşgaç menu took
  nativeMenuAction?(action: import('./nativeMenu').NativeAction, arg?: string): void;
  setTrayState?(state: { muted: boolean; deafened: boolean }): void;
  pickScreenSource?(id: string, audio: boolean): Promise<boolean>;
}

// A screen or window the desktop app can share.
export interface ScreenSource {
  id: string;
  name: string;
  screen: boolean; // a whole screen rather than one window
  thumbnail: string; // data: URL
}

export interface WindowSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean; // the close button hides the window to the system tray
  hardwareAcceleration: boolean; // applies after a restart
}

declare global {
  interface Window {
    konusgac?: DesktopBridge;
  }
}

export const desktop = window.konusgac;

// Notify for DMs, mentions and replies to me that arrive while the window is not focused.
export function notifyForMessage(m: Message) {
  const s = getState();
  if (!pingsMe(s, m)) return;
  const settings = getSettings();
  const looking = document.hasFocus() && s.view.channelId === m.channelId;
  if (!looking) playSound('mention');
  if (document.hasFocus() || !settings.desktopNotifications || settings.streamerMode) return;
  const channel = channelById(s, m.channelId);
  const guildId = channel?.guildId ?? undefined;
  const who = displayName(s, m.authorId, guildId);
  const title = channel && channel.type !== 'dm' ? `${who} · #${channel.name}` : who;
  const text = m.content.replace(/<@(\d{1,20})>/g, (_all, id: string) => `@${displayName(s, id, guildId)}`) || '📎 Dosya gönderdi';
  const body = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  if (desktop) desktop.notify(title, body);
  else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/logo.svg' });
}

export function requestNotificationPermission() {
  if (!desktop && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}
