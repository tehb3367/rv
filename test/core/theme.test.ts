import { describe, expect, test } from 'bun:test';
import { composite, derivePalette, loadTheme, parseHex, quantize256, stripJsonc } from '../../src/core/theme.ts';
import { tempDir, write } from '../helpers.ts';
import { join } from 'node:path';

describe('theme palette', () => {
  test('synthwave-84 drives the UI chrome', async () => {
    const { theme, id } = await loadTheme('synthwave-84');
    expect(id).toBe('synthwave-84');
    const p = derivePalette(theme, { truecolor: true });
    expect(p.bg).toBe('#262335');
    expect(p.sidebarBg).toBe('#241b2f');
    expect(p.riskLow).toBe('#72f1b8');
    expect(p.riskHigh).toBe('#fe4450');
    expect(p.askBorder).toBe('#03edf9');
    expect(p.noteBorder).toBe('#ff7edb');
    // focusBorder (#1f212b) is invisible on the background, so tab.activeBorder is used.
    expect(p.focus).toBe('#880088');
    // editorLineNumber.foreground #ffffff73 composited over the background
    expect(p.gutter).toBe(composite('#ffffff73', parseHex('#262335')!)!);
    // insertedTextBackground #0beb9935 is composited, never passed through with alpha
    expect(p.addWord).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('alpha is composited over the background', () => {
    expect(composite('#ffffff80', { r: 0, g: 0, b: 0 })).toBe('#808080');
    expect(composite('#123', { r: 0, g: 0, b: 0 })).toBe('#112233');
  });

  test('quantizes to the 256-colour palette without truecolor', async () => {
    const { theme } = await loadTheme('synthwave-84');
    const p = derivePalette(theme, { truecolor: false });
    expect(quantize256('#262335')).toBe(p.bg!);
    expect(p.color('#FF8B39')).toBe(quantize256('#ff8b39'));
  });

  test('transparent leaves the background unpainted but keeps line tints', async () => {
    const { theme } = await loadTheme('synthwave-84');
    const p = derivePalette(theme, { truecolor: true, transparent: true });
    expect(p.bg).toBeUndefined();
    expect(p.addLine).toMatch(/^#/);
  });

  test('VS Code theme JSON by path', async () => {
    const dir = tempDir();
    write(dir, 't.json', `{
      // comment
      "name": "Mine", "type": "dark",
      "colors": { "editor.background": "#101010", "focusBorder": "#ff00ff", },
      "tokenColors": []
    }`);
    const { theme, id } = await loadTheme(join(dir, 't.json'));
    expect(id).toMatch(/^custom-/);
    const p = derivePalette(theme, { truecolor: true });
    expect(p.bg).toBe('#101010');
    expect(p.focus).toBe('#ff00ff');
    expect(stripJsonc('{"a": "//x", /* c */ "b": 1,}')).toBe('{"a": "//x",  "b": 1}');
  });
});
