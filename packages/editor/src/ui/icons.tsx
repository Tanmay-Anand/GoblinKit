import type { Glyph } from '../describe.js';

/** Line icons on a 24-unit grid, drawn in the current text colour. */
const PATHS: Record<Glyph | UiIcon, string> = {
  // box glyphs
  play: 'M8 5.5v13l10-6.5z',
  branch: 'M7 4v16 M7 12h6a4 4 0 0 0 4-4V4',
  switch: 'M4 12h6 M10 12l4-6h6 M10 12l4 6h6 M14 12h6',
  merge: 'M6 4v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4 M18 4v4a4 4 0 0 1-4 4',
  set: 'M4 7h16 M4 12h10 M4 17h7',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3.2 3 3.2 15 0 18 M12 3c-3.2 3-3.2 15 0 18',
  note: 'M6 3h9l3 3v15H6z M9 10h6 M9 14h6 M9 18h4',
  loop: 'M4 12a8 8 0 0 1 14-5.3 M18 3v4h-4 M20 12a8 8 0 0 1-14 5.3 M6 21v-4h4',
  repeat: 'M17 2l3 3-3 3 M4 11V9a4 4 0 0 1 4-4h12 M7 22l-3-3 3-3 M20 13v2a4 4 0 0 1-4 4H4',
  stop: 'M6 6h12v12H6z',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 2',
  box: 'M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10',
  // interface
  back: 'M15 18l-6-6 6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  x: 'M6 6l12 12 M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  layout: 'M4 4h7v5H4z M13 15h7v5h-7z M7.5 9v4a2 2 0 0 0 2 2H13',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  check: 'M5 12l5 5 9-10',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  spinner: 'M12 3a9 9 0 1 1-9 9',
  dash: 'M5 12h14',
  keyboard: 'M3 6h18v12H3z M7 10h.5 M11 10h.5 M15 10h.5 M8 14h8',
  rotateRight: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  rotateLeft: 'M4 11a8 8 0 1 1 2.3 5.7 M4 4v7h7',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  settings: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M14 5v4 M8 15v4',
};

export type UiIcon =
  | 'back' | 'chevronDown' | 'chevronUp' | 'plus' | 'undo' | 'redo' | 'x' | 'search' | 'grid' | 'layout'
  | 'alert' | 'check' | 'trash' | 'spinner' | 'dash' | 'keyboard' | 'rotateRight' | 'rotateLeft' | 'fit' | 'settings';

export function Icon({ name, size = 16, className }: { name: Glyph | UiIcon; size?: number; className?: string }) {
  const filled = name === 'play';
  return (
    <svg
      className={className ? `gk-icon ${className}` : 'gk-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
