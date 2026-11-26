import { beforeEach, describe, expect, test } from 'bun:test';
import { defaultConfig } from '../../src/core/config.ts';
import { resolveLocalSource } from '../../src/core/git.ts';
import { derivePalette, loadTheme } from '../../src/core/theme.ts';
import { Session } from '../../src/server/session.ts';
import { Controller } from '../../src/tui/controller.ts';
import type { RawKey } from '../../src/tui/keys.ts';
import { commitAll, initRepo, sh, write } from '../helpers.ts';

function key(s: string): RawKey {
  if (s === 'space') return { name: 'space', ctrl: false, meta: false, shift: false, sequence: ' ' };
  if (s === 'return') return { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' };
  if (s === 'escape') return { name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b' };
  if (s === 'tab') return { name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' };
  if (s.startsWith('ctrl+')) return { name: s.slice(5), ctrl: true, meta: false, shift: false, sequence: '' };
  return { name: s.toLowerCase(), ctrl: false, meta: false, shift: s !== s.toLowerCase(), sequence: s };
}

let session: Session;
let ctl: Controller;
let quit = 0;
let copied = '';

async function setup() {
  const dir = initRepo();
  for (let i = 0; i < 4; i++) write(dir, `f${i}.ts`, Array.from({ length: 30 }, (_, k) => `const v${k} = ${k};`).join('\n') + '\n');
  commitAll(dir, 'base');
  sh(['git', 'checkout', '-q', '-b', 'feat'], dir);
  for (let i = 0; i < 4; i++)
    write(dir, `f${i}.ts`, Array.from({ length: 30 }, (_, k) => (k === 3 || k === 20 ? `const v${k} = ${k * 10};` : `const v${k} = ${k};`)).join('\n') + '\n');
  commitAll(dir, 'change');
  const src = await resolveLocalSource(dir, { range: 'main..feat' });
  session = await Session.open(src, () => resolveLocalSource(dir, { range: 'main..feat' }), { debounceMs: 5 });
  const { theme } = await loadTheme('synthwave-84');
  quit = 0;
  ctl = new Controller({
    session,
    config: defaultConfig(),
    palette: derivePalette(theme, { truecolor: true }),
    copy: (t) => (copied = t),
    runEditor: async (t) => t + ' (edited)',
    prioritize: () => {},
    quit: () => quit++,
  });
  ctl.resize(160, 48);
}

const press = (...keys: string[]) => keys.forEach((k) => ctl.handleKey(key(k)));
const type = (s: string) => [...s].forEach((ch) => ctl.handleKey(key(ch === ' ' ? 'space' : ch)));

describe('controller', () => {
  beforeEach(setup);

  test('starts unstacked; n moves to the first hunk; space marks it reviewed and moves on', () => {
    expect(ctl.layer.id).toBe('Unstacked');
    const ids = session.hunks.map((h) => h.id);
    expect(ids).toHaveLength(8);
    press('n');
    expect(ctl.currentHunkId()).toBe(ids[0]);
    press('space');
    expect(session.state.reviewed[ids[0]!]).toBeDefined();
    expect(ctl.currentHunkId()).toBe(ids[1]);
    press('space', 'space');
    expect(session.status().layers[0]!.reviewed).toBe(3);
    // press again on a reviewed hunk to unmark
    press('p');
    press('space');
    expect(session.status().layers[0]!.reviewed).toBe(2);
  });

  test('plan from the agent switches to layer view; ] and [ move layers; N finds unreviewed', () => {
    const ids = session.hunks.map((h) => h.id);
    const r = session.setStack({
      version: 1,
      title: 'Plan',
      layers: [
        { id: 'L1', title: 'First', why: 'w', risk: 'low', hunks: ids.slice(0, 4) },
        { id: 'L2', title: 'Second', why: 'w', risk: 'high', hunks: ids.slice(4) },
      ],
    });
    expect(r.ok).toBe(true);
    expect(ctl.layer.id).toBe('L1');
    press(']');
    expect(ctl.layer.id).toBe('L2');
    press('[');
    expect(ctl.layer.id).toBe('L1');
    press('V');
    expect(ctl.layerProgress(ctl.layer)).toEqual({ done: 4, total: 4 });
    press('N');
    expect(ctl.layer.id).toBe('L2');
    expect(ctl.currentHunkId()).toBe(ids[4]);
  });

  test('? opens the editor; Enter saves a draft ask; S sends it; ctrl+e uses $EDITOR', async () => {
    press('n', 'j', 'j');
    const row = ctl.currentRow()!;
    expect(row.kind).toBe('line');
    press('?');
    expect(ctl.editor?.mode).toBe('ask');
    type('Why x10?');
    ctl.handleKey({ name: 'linefeed', ctrl: false, meta: false, shift: false, sequence: '\n' });
    type('ok');
    press('return');
    const asks = session.comments({ kind: 'ask' });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toBe('Why x10?\nok');
    expect(asks[0]!.status).toBe('draft');
    expect(asks[0]!.line).toBeDefined();
    press('S');
    expect(session.comments({ kind: 'ask' })[0]!.status).toBe('pending');
    press('c');
    type('draft');
    press('ctrl+e');
    await Bun.sleep(10);
    expect(ctl.editor!.text).toBe('draft (edited)');
    press('escape');
    expect(ctl.editor).toBeNull();
    expect(session.comments({ kind: 'review' })).toHaveLength(0);
  });

  test('e edits, d deletes drafts, r resolves', () => {
    press('n', 'j');
    press('c');
    type('nit');
    press('return');
    const c = session.comments({ kind: 'review' })[0]!;
    ctl.navigate({ comment: c.id });
    expect(ctl.commentHere()?.id).toBe(c.id);
    press('e');
    type('!');
    press('return');
    expect(session.comments({ kind: 'review' })[0]!.body).toBe('nit!');
    press('r');
    expect(session.comments({ kind: 'review' })[0]!.status).toBe('resolved');
    press('n', 'j', 'c');
    type('gone');
    press('return');
    const d = session.comments({ kind: 'review' }).find((x) => x.body === 'gone')!;
    ctl.navigate({ comment: d.id });
    press('d');
    expect(session.comments({ kind: 'review' }).some((x) => x.id === d.id)).toBe(false);
  });

  test('o toggles collapse; w toggles wrap; b toggles the layers pane; narrow hides it', () => {
    press('n');
    const id = ctl.currentHunkId()!;
    press('o');
    expect(ctl.rows.rows.some((r) => r.kind === 'collapsed' && r.hunkId === id)).toBe(true);
    press('o');
    expect(ctl.rows.rows.some((r) => r.kind === 'collapsed')).toBe(false);
    press('w');
    expect(ctl.wrap).toBe(true);
    expect(ctl.sidebarDocked).toBe(true);
    press('b');
    expect(ctl.sidebarDocked).toBe(false);
    press('b');
    ctl.resize(90, 30);
    expect(ctl.sidebarDocked).toBe(false);
    press('b');
    expect(ctl.sideOverlay).toBe(true);
    expect(ctl.focus).toBe('layers');
  });

  test('E exports to the clipboard and the git dir; P on a local range says so', () => {
    press('E');
    expect(copied).toContain('# Review:');
    press('P');
    expect(ctl.flash!.text).toContain("can't be submitted");
    expect(ctl.overlay).toBeNull();
  });

  test('q confirms with unsent asks', () => {
    press('n', 'j', '?');
    type('q?');
    press('return');
    press('q');
    expect(ctl.overlay?.type).toBe('confirm');
    press('n');
    expect(quit).toBe(0);
    press('q', 'y');
    expect(quit).toBe(1);
  });

  test('navigate from the agent moves the view', () => {
    const h = session.hunks[5]!;
    session.navigate({ hunk: h.id });
    expect(ctl.currentHunkId()).toBe(h.id);
  });

  test('half-page and top/bottom movement stay in range', () => {
    press('ctrl+d');
    expect(ctl.cursor).toBeGreaterThan(0);
    press('G');
    expect(ctl.cursor).toBe(ctl.rows.rows.length - 1);
    press('g');
    expect(ctl.cursor).toBe(0);
    expect(ctl.scroll).toBe(0);
  });
});
