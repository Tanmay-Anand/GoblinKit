import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Glyph } from '../describe.js';
import { Icon, type UiIcon } from './icons.js';

export type MenuEntry =
  | {
      label: string;
      icon?: Glyph | UiIcon;
      /** Shown on the right, e.g. "R" — the key that does the same thing. */
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | 'separator';

/**
 * A right-click menu, built to the WAI-ARIA menu pattern: focus moves into
 * it on open, arrow keys walk the items, Enter or Space picks one, Escape or
 * a click anywhere else closes it. It never spills off the canvas: it opens
 * where the pointer was, then shifts back inside if it would overflow.
 */
export function ContextMenu({
  x,
  y,
  label,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = ref.current;
    const bounds = menu?.parentElement?.getBoundingClientRect();
    if (!menu || !bounds) return;
    const { width, height } = menu.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(x, bounds.width - width - 8)),
      top: Math.max(8, Math.min(y, bounds.height - height - 8)),
    });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture, so a click that starts a pan or a drag still closes the menu first.
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const walk = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      className="gk-menu nodrag nopan"
      role="menu"
      aria-label={label}
      style={{ left: place.left, top: place.top }}
      onKeyDown={walk}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep-${i}`} className="gk-menu-sep" role="separator" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={`gk-menu-item${entry.danger ? ' is-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="gk-menu-icon">{entry.icon ? <Icon name={entry.icon} size={15} /> : null}</span>
            <span className="gk-menu-label">{entry.label}</span>
            {entry.shortcut ? <kbd className="gk-menu-key">{entry.shortcut}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}
