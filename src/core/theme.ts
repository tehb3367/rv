import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bundledThemes, type BundledTheme, type ThemeRegistration } from 'shiki';

export const DEFAULT_THEME = 'synthwave-84';

export type LoadedTheme = { id: string; theme: ThemeRegistration };

/** Strip // and /* *\/ comments and trailing commas from JSONC. */
export function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function isBundledTheme(name: string): name is BundledTheme {
  return Object.prototype.hasOwnProperty.call(bundledThemes, name);
}

/** Load a bundled Shiki theme by name, or a VS Code theme JSON by path. */
export async function loadTheme(nameOrPath: string): Promise<LoadedTheme> {
  if (isBundledTheme(nameOrPath)) {
    const mod = await bundledThemes[nameOrPath]();
    return { id: nameOrPath, theme: mod.default as ThemeRegistration };
  }
  let text: string;
  try {
    text = readFileSync(nameOrPath, 'utf8');
  } catch {
    throw new Error(`unknown theme "${nameOrPath}": not a bundled Shiki theme or a readable file`);
  }
  const theme = JSON.parse(stripJsonc(text)) as ThemeRegistration;
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 8);
  const id = `custom-${hash}`;
  theme.name = id;
  if (!theme.type) theme.type = 'dark';
  return { id, theme };
}

// ---------- colour maths ----------

export type RGB = { r: number; g: number; b: number };
type RGBA = RGB & { a: number };

export function parseHex(hex: string | undefined): RGBA | null {
  if (!hex) return null;
  let h = hex.trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (s: string) => parseInt(s, 16);
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  return { r: n(h.slice(0, 2)), g: n(h.slice(2, 4)), b: n(h.slice(4, 6)), a: h.length === 8 ? n(h.slice(6, 8)) / 255 : 1 };
}

export function toHex(c: RGB): string {
  const p = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

export function mix(fg: RGB, bg: RGB, alpha: number): RGB {
  return { r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha) };
}

/** Composite a possibly-translucent colour over a background, since terminals have no alpha. */
export function composite(hex: string | undefined, bg: RGB): string | undefined {
  const c = parseHex(hex);
  if (!c) return undefined;
  return toHex(c.a >= 1 ? c : mix(c, bg, c.a));
}

function luminance(c: RGB): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// xterm 256-colour palette (indices 16-255; 0-15 vary by terminal so they are avoided)
const CUBE = [0, 95, 135, 175, 215, 255];
const PALETTE_256: RGB[] = (() => {
  const out: RGB[] = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push({ r: CUBE[r]!, g: CUBE[g]!, b: CUBE[b]! });
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push({ r: v, g: v, b: v });
  }
  return out;
})();

export function quantize256(hex: string): string {
  const c = parseHex(hex);
  if (!c) return hex;
  let best = PALETTE_256[0]!;
  let bestD = Infinity;
  for (const p of PALETTE_256) {
    const d = (p.r - c.r) ** 2 * 0.3 + (p.g - c.g) ** 2 * 0.59 + (p.b - c.b) ** 2 * 0.11;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return toHex(best);
}

export function supportsTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  const ct = (env.COLORTERM ?? '').toLowerCase();
  return ct === 'truecolor' || ct === '24bit';
}

// ---------- palette ----------

export type Palette = {
  /** undefined means "leave the terminal default". */
  bg?: string;
  fg?: string;
  sidebarBg?: string;
  gutter: string;
  focus: string;
  addLine: string;
  delLine: string;
  addWord: string;
  delWord: string;
  riskLow: string;
  riskMed: string;
  riskHigh: string;
  askBorder: string;
  noteBorder: string;
  reviewBorder: string;
  muted: string;
  /** Map any token colour into the terminal's colour space (composite + optional quantize). */
  color: (hex: string | undefined) => string | undefined;
  truecolor: boolean;
  transparent: boolean;
};

const ANSI = {
  green: '#00cd00',
  red: '#cd0000',
  yellow: '#cdcd00',
  cyan: '#00cdcd',
  magenta: '#cd00cd',
  white: '#e5e5e5',
  black: '#000000',
};

export type PaletteOptions = { truecolor?: boolean; transparent?: boolean };

/** Derive every interface colour from the theme's `colors` map (no hardcoded UI hex beyond named ANSI fallbacks). */
export function derivePalette(theme: ThemeRegistration, opts: PaletteOptions = {}): Palette {
  const truecolor = opts.truecolor ?? supportsTruecolor();
  const transparent = opts.transparent ?? false;
  const colors = (theme.colors ?? {}) as Record<string, string>;
  const isLight = theme.type === 'light';
  const themeBg = colors['editor.background'] ?? (theme as { bg?: string }).bg;
  const bgRgb = parseHex(themeBg) ?? parseHex(isLight ? '#ffffff' : ANSI.black)!;
  const bgSolid = toHex(bgRgb);
  const fgRaw = colors['editor.foreground'] ?? (theme as { fg?: string }).fg;
  const fgSolid = composite(fgRaw, bgRgb);
  const fgRgb = parseHex(fgSolid) ?? parseHex(isLight ? ANSI.black : ANSI.white)!;
  const q = (hex: string | undefined) => (hex === undefined ? undefined : truecolor ? hex : quantize256(hex));
  const c = (key: string, fallback: string) => q(composite(colors[key], bgRgb) ?? fallback)!;
  const tint = (key: string, baseKey: string, ansi: string, alpha: number) => {
    const own = composite(colors[key], bgRgb);
    if (own) return q(own)!;
    const base = parseHex(composite(colors[baseKey], bgRgb) ?? ansi)!;
    return q(toHex(mix(base, bgRgb, alpha)))!;
  };

  // focusBorder first, then tab.activeBorder, then magenta; skip a candidate that is invisible on the background.
  let focus = q(composite('#000000', bgRgb))!;
  for (const cand of [colors.focusBorder, colors['tab.activeBorder'], colors['terminal.ansiMagenta'], ANSI.magenta]) {
    const solid = composite(cand, bgRgb);
    const rgb = parseHex(solid);
    if (solid && rgb && contrast(rgb, bgRgb) >= 1.5) {
      focus = q(solid)!;
      break;
    }
  }
  const gutterRaw = composite(colors['editorLineNumber.foreground'], bgRgb) ?? toHex(mix(fgRgb, bgRgb, 0.5));
  return {
    bg: transparent ? undefined : q(themeBg ? bgSolid : undefined),
    fg: q(fgRaw ? fgSolid : undefined),
    sidebarBg: transparent ? undefined : q(composite(colors['sideBar.background'], bgRgb) ?? (themeBg ? bgSolid : undefined)),
    gutter: q(gutterRaw)!,
    focus,
    addLine: tint('diffEditor.insertedLineBackground', 'terminal.ansiGreen', ANSI.green, 0.15),
    delLine: tint('diffEditor.removedLineBackground', 'terminal.ansiRed', ANSI.red, 0.15),
    addWord: tint('diffEditor.insertedTextBackground', 'terminal.ansiGreen', ANSI.green, 0.35),
    delWord: tint('diffEditor.removedTextBackground', 'terminal.ansiRed', ANSI.red, 0.35),
    riskLow: c('terminal.ansiGreen', ANSI.green),
    riskMed: c('terminal.ansiYellow', ANSI.yellow),
    riskHigh: c('terminal.ansiRed', ANSI.red),
    askBorder: c('terminal.ansiCyan', ANSI.cyan),
    noteBorder: c('terminal.ansiMagenta', ANSI.magenta),
    reviewBorder: q(fgSolid ?? (isLight ? ANSI.black : ANSI.white))!,
    muted: q(toHex(mix(fgRgb, bgRgb, 0.55)))!,
    color: (hex) => q(composite(hex, bgRgb)),
    truecolor,
    transparent,
  };
}
