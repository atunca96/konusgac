import { useEffect, useState, type ReactNode } from 'react';
import { setCapturing } from '../../keybinds';
import { keybindLabel, type Keybind } from '../../settings';

// Building blocks of the settings pages.

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-section">
      <h3>{title}</h3>
      {children}
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

export function Toggle(props: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`set-toggle ${props.disabled ? 'disabled' : ''}`}>
      <span className="set-toggle-text">
        <span className="set-label">{props.label}</span>
        {props.hint && <span className="set-hint">{props.hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const fmt = props.format ?? ((v: number) => `${v}%`);
  return (
    <label className="set-slider">
      <span className="set-label">{props.label}</span>
      <span className="set-slider-row">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
        <span className="set-slider-value">{fmt(props.value)}</span>
      </span>
    </label>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label className="set-select">
      <span className="set-label">{props.label}</span>
      <select value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Radio<T extends string>(props: { name: string; value: T; options: [T, string, string?][]; onChange: (v: T) => void }) {
  return (
    <div className="set-radio" role="radiogroup">
      {props.options.map(([v, label, hint]) => (
        <label key={v} className={props.value === v ? 'active' : ''}>
          <input type="radio" name={props.name} checked={props.value === v} onChange={() => props.onChange(v)} />
          <span>
            <span className="set-label">{label}</span>
            {hint && <span className="set-hint">{hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

// Records the next key combination pressed; Escape cancels, Backspace clears.
export function KeyRecorder({ value, onChange }: { value: Keybind | null; onChange: (k: Keybind | null) => void }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    setCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return setRecording(false);
      if (e.code === 'Backspace') {
        onChange(null);
        return setRecording(false);
      }
      const modifierOnly = /^(Shift|Control|Alt|Meta)/.test(e.code);
      onChange({
        code: e.code,
        ctrl: !modifierOnly && e.ctrlKey,
        alt: !modifierOnly && e.altKey,
        shift: !modifierOnly && e.shiftKey,
      });
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setCapturing(false);
    };
  }, [recording, onChange]);

  return (
    <button type="button" className={`key-recorder ${recording ? 'recording' : ''}`} onClick={() => setRecording(!recording)}>
      {recording ? 'Bir tuşa bas… (Esc: iptal, ⌫: temizle)' : keybindLabel(value)}
    </button>
  );
}

// A level bar in dB (-100–0), with an optional threshold marker.
export function LevelMeter({ db, threshold }: { db: number; threshold?: number }) {
  const pct = (v: number) => Math.min(100, Math.max(0, v + 100));
  const above = threshold === undefined || db > threshold;
  return (
    <div className="level-meter">
      <div className={`level-fill ${above ? 'on' : ''}`} style={{ width: `${pct(db)}%` }} />
      {threshold !== undefined && <div className="level-threshold" style={{ left: `${pct(threshold)}%` }} />}
    </div>
  );
}
