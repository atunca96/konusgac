import { getSettings, type SoundName } from './settings';

// Short interface sounds, synthesized with Web Audio so no audio files are shipped.
// Each cue is a few notes: [frequency in Hz, start in s, length in s].
type Note = [number, number, number];

const CUES: Record<SoundName, { notes: Note[]; wave: OscillatorType }> = {
  message: { notes: [[880, 0, 0.09], [1320, 0.07, 0.12]], wave: 'sine' },
  mention: { notes: [[988, 0, 0.08], [1319, 0.08, 0.08], [1760, 0.16, 0.14]], wave: 'sine' },
  mute: { notes: [[660, 0, 0.07], [440, 0.06, 0.1]], wave: 'triangle' },
  unmute: { notes: [[440, 0, 0.07], [660, 0.06, 0.1]], wave: 'triangle' },
  deafen: { notes: [[523, 0, 0.08], [392, 0.07, 0.08], [262, 0.14, 0.12]], wave: 'triangle' },
  undeafen: { notes: [[262, 0, 0.08], [392, 0.07, 0.08], [523, 0.14, 0.12]], wave: 'triangle' },
  join: { notes: [[392, 0, 0.1], [523, 0.08, 0.1], [784, 0.16, 0.16]], wave: 'sine' },
  leave: { notes: [[784, 0, 0.1], [523, 0.08, 0.1], [392, 0.16, 0.16]], wave: 'sine' },
  userJoin: { notes: [[587, 0, 0.08], [880, 0.07, 0.12]], wave: 'sine' },
  userLeave: { notes: [[880, 0, 0.08], [587, 0.07, 0.12]], wave: 'sine' },
  pttStart: { notes: [[1200, 0, 0.04]], wave: 'square' },
  pttStop: { notes: [[900, 0, 0.04]], wave: 'square' },
  streamStart: { notes: [[523, 0, 0.08], [659, 0.07, 0.08], [784, 0.14, 0.08], [1047, 0.21, 0.16]], wave: 'sine' },
  streamStop: { notes: [[1047, 0, 0.08], [784, 0.07, 0.08], [523, 0.14, 0.16]], wave: 'sine' },
};

let ctx: AudioContext | null = null;

export function playSound(name: SoundName, force = false) {
  const s = getSettings();
  if (!force && (!s.sounds[name] || s.streamerMode)) return;
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const out = ctx.createGain();
    out.gain.value = (s.soundVolume / 100) * 0.25;
    out.connect(ctx.destination);
    const now = ctx.currentTime + 0.01;
    for (const [freq, start, len] of CUES[name].notes) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = CUES[name].wave;
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, now + start);
      env.gain.linearRampToValueAtTime(1, now + start + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, now + start + len);
      osc.connect(env).connect(out);
      osc.start(now + start);
      osc.stop(now + start + len + 0.02);
    }
  } catch {
    // audio unavailable (no output device): stay silent
  }
}

export const SOUND_LABELS: Record<SoundName, string> = {
  message: 'Yeni mesaj',
  mention: 'Bahsedilme ve özel mesaj',
  mute: 'Mikrofonu kapatma',
  unmute: 'Mikrofonu açma',
  deafen: 'Sesi kapatma',
  undeafen: 'Sesi açma',
  join: 'Sesli kanala katılma',
  leave: 'Sesli kanaldan ayrılma',
  userJoin: 'Biri kanala katıldı',
  userLeave: 'Biri kanaldan ayrıldı',
  pttStart: 'Bas-konuş başladı',
  pttStop: 'Bas-konuş bitti',
  streamStart: 'Yayın başladı',
  streamStop: 'Yayın bitti',
};
