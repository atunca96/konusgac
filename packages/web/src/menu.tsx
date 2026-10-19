import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

// Right-click menus, one look everywhere: a dark panel with rows, sub-menus,
// check boxes and custom rows (a volume slider, a row of quick reactions). Menus are built by
// plain functions (menus.tsx) and opened with openMenu(event, items).

export type MenuItem =
  | { kind?: 'item'; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { kind: 'check'; label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }
  | { kind: 'sub'; label: string; items: Entry[]; disabled?: boolean }
  | { kind: 'custom'; render: () => ReactNode }
  | { kind: 'sep' };

// false/null/undefined entries are skipped, so menus can be written with conditions inline.
export type Entry = MenuItem | false | null | undefined | '' | 0;

interface Open {
  x: number;
  y: number;
  items: MenuItem[];
}

let open: Open | null = null;
const listeners = new Set<() => void>();
const set = (next: Open | null) => {
  open = next;
  listeners.forEach((l) => l());
};

// Drops skipped entries and separators at the edges or next to each other.
export function clean(entries: Entry[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === 'sep' && (out.length === 0 || out[out.length - 1]!.kind === 'sep')) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1]!.kind === 'sep') out.pop();
  return out;
}

// Opens a menu at the pointer. Right-clicks in text fields keep the field's own menu
// (cut, copy, paste, spelling), so those are left alone.
export function openMenu(e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number; target: EventTarget | null }, entries: Entry[]) {
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) return;
  const items = clean(entries);
  e.preventDefault();
  e.stopPropagation();
  if (items.length) set({ x: e.clientX, y: e.clientY, items });
}

export function openMenuAt(x: number, y: number, entries: Entry[]) {
  const items = clean(entries);
  if (items.length) set({ x, y, items });
}

export function closeMenu() {
  if (open) set(null);
}

export const copyText = (text: string) => void navigator.clipboard?.writeText(text);

// Rendered once, at the top of the app.
export function MenuHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );

  useEffect(() => {
    if (!current) return;
    const onDown = (e: MouseEvent) => !(e.target as HTMLElement).closest('.ctx-menu') && closeMenu();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    const onScroll = (e: Event) => !(e.target as HTMLElement).closest?.('.ctx-menu') && closeMenu();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [current]);

  if (!current) return null;
  return <Panel key={`${current.x},${current.y},${current.items.length}`} items={current.items} x={current.x} y={current.y} root />;
}

// One menu panel; placed so it stays on screen (flips left or up when needed).
function Panel(props: { items: MenuItem[]; x: number; y: number; root?: boolean; anchorLeft?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y, ready: false });
  const [active, setActive] = useState(-1);
  const [subOpen, setSubOpen] = useState<number | null>(null);
  const [flipped, setFlipped] = useState<Record<number, boolean>>({}); // check boxes ticked while open
  const rows = useRef<(HTMLDivElement | null)[]>([]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = props.x;
    let top = props.y;
    if (left + width > window.innerWidth - pad) left = props.anchorLeft !== undefined ? props.anchorLeft - width : window.innerWidth - width - pad;
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    setPos({ left: Math.max(pad, left), top, ready: true });
    if (props.root) el.focus();
  }, [props.x, props.y, props.anchorLeft, props.root]);

  const selectable = (i: number) => {
    const it = props.items[i]!;
    return it.kind !== 'sep' && it.kind !== 'custom' && !('disabled' in it && it.disabled);
  };
  const move = (dir: 1 | -1) => {
    for (let n = 1; n <= props.items.length; n++) {
      const i = (active + dir * n + props.items.length * 2) % props.items.length;
      if (selectable(i)) return setActive(i);
    }
  };
  const run = (i: number) => {
    const it = props.items[i];
    if (!it || !selectable(i)) return;
    if (it.kind === 'sub') return setSubOpen(i);
    if (it.kind === 'check') {
      const next = !(flipped[i] ?? it.checked);
      setFlipped({ ...flipped, [i]: next });
      return it.onChange(next);
    }
    if (it.kind === 'item' || it.kind === undefined) {
      closeMenu();
      it.onClick();
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
        else if (e.key === 'Enter' || e.key === ' ') run(active);
        else if (e.key === 'ArrowRight' && props.items[active]?.kind === 'sub') setSubOpen(active);
        else if (e.key === 'ArrowLeft' && !props.root) closeMenu();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {props.items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="ctx-sep" />;
        if (it.kind === 'custom') return <div key={i} className="ctx-custom">{it.render()}</div>;
        const disabled = 'disabled' in it && it.disabled;
        const cls = `ctx-item ${active === i ? 'active' : ''} ${'danger' in it && it.danger ? 'danger' : ''} ${disabled ? 'disabled' : ''}`;
        return (
          <div
            key={i}
            ref={(el) => {
              rows.current[i] = el;
            }}
            className={cls}
            role={it.kind === 'check' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={it.kind === 'check' ? (flipped[i] ?? it.checked) : undefined}
            aria-disabled={disabled || undefined}
            onMouseEnter={() => {
              setActive(i);
              setSubOpen(it.kind === 'sub' && !disabled ? i : null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              run(i);
            }}
          >
            <span className="ctx-label">{it.label}</span>
            {it.kind === 'check' && <span className={`ctx-check ${(flipped[i] ?? it.checked) ? 'on' : ''}`}>{(flipped[i] ?? it.checked) ? '✓' : ''}</span>}
            {it.kind === 'sub' && <span className="ctx-arrow">›</span>}
            {(it.kind === 'item' || it.kind === undefined) && it.hint && <span className="ctx-hint">{it.hint}</span>}
            {it.kind === 'sub' && subOpen === i && <SubPanel items={clean(it.items)} row={rows.current[i] ?? null} />}
          </div>
        );
      })}
    </div>
  );
}

function SubPanel({ items, row }: { items: MenuItem[]; row: HTMLDivElement | null }) {
  if (!row || items.length === 0) return null;
  const r = row.getBoundingClientRect();
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Panel items={items} x={r.right + 4} y={r.top - 6} anchorLeft={r.left - 4} />
    </div>
  );
}
