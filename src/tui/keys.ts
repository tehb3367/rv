import type { KeyAction } from '../core/config.ts';

export type RawKey = { name: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string };

/** Normalise a key event to a binding string: "j", "G", "?", "ctrl+d", "space", "tab", "return", ... */
export function keyString(k: RawKey): string {
  if (k.ctrl && k.name && k.name.length === 1) return `ctrl+${k.name.toLowerCase()}`;
  if (k.name === 'space' || k.sequence === ' ') return 'space';
  const seq = k.sequence;
  if (!k.ctrl && !k.meta && seq && [...seq].length === 1 && seq >= ' ' && seq !== '\x7f') return seq;
  if (k.meta && k.name) return `meta+${k.name}`;
  return k.name;
}

/** Map binding strings to actions. Arrow keys always move the cursor. */
export function buildKeymap(keys: Record<KeyAction, string>): Map<string, KeyAction> {
  const m = new Map<string, KeyAction>();
  for (const [action, key] of Object.entries(keys) as [KeyAction, string][]) m.set(normaliseBinding(key), action);
  if (!m.has('down')) m.set('down', 'down');
  if (!m.has('up')) m.set('up', 'up');
  m.set('pagedown', 'halfDown');
  m.set('pageup', 'halfUp');
  m.set('home', 'top');
  m.set('end', 'bottom');
  return m;
}

export function normaliseBinding(b: string): string {
  const t = b.trim();
  if (t === ' ') return 'space';
  const lower = t.toLowerCase();
  if (lower.startsWith('ctrl-') || lower.startsWith('c-')) return 'ctrl+' + lower.split('-').pop();
  if (lower.startsWith('ctrl+')) return lower;
  if (['space', 'tab', 'return', 'enter', 'escape', 'esc', 'up', 'down', 'left', 'right'].includes(lower))
    return lower === 'enter' ? 'return' : lower === 'esc' ? 'escape' : lower;
  return t;
}
