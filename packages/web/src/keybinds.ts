import { getSettings, keybindMatches, subscribeSettings, type Keybind } from './settings';
import { getState, subscribe } from './state';
import { setPushToTalk, toggleDeaf, toggleMute } from './voice';

// Keybinds work while the window has focus. In the desktop app, the mute and deafen toggles are
// also registered system-wide; push-to-talk needs to see the key being released, which global
// shortcuts cannot report, so it works while the app window is focused.

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

// A plain letter key would fire while writing a message; such keys only act outside text fields.
const needsFreeFocus = (k: Keybind) => !k.ctrl && !k.alt && /^(Key|Digit|Space|Backquote|Minus|Equal|Bracket|Semicolon|Quote|Comma|Period|Slash)/.test(k.code);

let capturing = false; // the settings page is recording a new key

export function setCapturing(on: boolean) {
  capturing = on;
}

window.addEventListener('keydown', (e) => {
  if (capturing || e.repeat) return;
  const s = getSettings();
  for (const [key, action] of [
    [s.pttKey, () => setPushToTalk(true)],
    [s.toggleMuteKey, toggleMute],
    [s.toggleDeafKey, toggleDeaf],
  ] as const) {
    if (keybindMatches(key, e) && !(needsFreeFocus(key!) && typing(e.target))) {
      if (key !== s.pttKey) e.preventDefault();
      action();
    }
  }
});

window.addEventListener('keyup', (e) => {
  const k = getSettings().pttKey;
  if (k && e.code === k.code) setPushToTalk(false);
});

// Releasing the key while another window has focus never reaches us; let go when focus leaves.
window.addEventListener('blur', () => setPushToTalk(false));

// ---------- desktop app: system-wide toggles ----------

function accelerator(k: Keybind | null): string | null {
  if (!k) return null;
  const key = k.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad(\d)$/, 'num$1')
    .replace(/^Arrow/, '');
  return [k.ctrl && 'CommandOrControl', k.alt && 'Alt', k.shift && 'Shift', key].filter(Boolean).join('+');
}

function registerGlobal() {
  const s = getSettings();
  window.konusgac?.setShortcuts?.({ toggleMute: accelerator(s.toggleMuteKey), toggleDeaf: accelerator(s.toggleDeafKey) });
}

window.konusgac?.onShortcut?.((name) => {
  if (name === 'toggleMute') toggleMute();
  if (name === 'toggleDeaf') toggleDeaf();
});
registerGlobal();
subscribeSettings(registerGlobal);

// The tray menu's "Mikrofonu kapat" and "Sesi kapat" boxes follow the app.
let lastTray = '';
subscribe(() => {
  const v = getState().voiceSelf;
  const key = `${v.selfMute}|${v.selfDeaf}`;
  if (key === lastTray) return;
  lastTray = key;
  window.konusgac?.setTrayState?.({ muted: v.selfMute, deafened: v.selfDeaf });
});
