import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HIGHLIGHT, type HighlightConfig } from './highlight.ts';
import { configDir, log } from './paths.ts';
import { DEFAULT_THEME } from './theme.ts';

export type KeyAction =
  | 'down' | 'up' | 'halfDown' | 'halfUp' | 'top' | 'bottom' | 'nextHunk' | 'prevHunk' | 'nextLayer' | 'prevLayer'
  | 'nextUnreviewed' | 'focus' | 'reviewed' | 'layerReviewed' | 'expand' | 'comment' | 'ask' | 'edit' | 'delete'
  | 'resolve' | 'send' | 'export' | 'submit' | 'reload' | 'wrap' | 'sidebar' | 'help' | 'quit' | 'learn' | 'explain';

export const DEFAULT_KEYS: Record<KeyAction, string> = {
  down: 'j',
  up: 'k',
  halfDown: 'ctrl+d',
  halfUp: 'ctrl+u',
  top: 'g',
  bottom: 'G',
  nextHunk: 'n',
  prevHunk: 'p',
  nextLayer: ']',
  prevLayer: '[',
  nextUnreviewed: 'N',
  focus: 'tab',
  reviewed: 'space',
  layerReviewed: 'V',
  expand: 'o',
  comment: 'c',
  ask: '?',
  edit: 'e',
  delete: 'd',
  resolve: 'r',
  send: 'S',
  export: 'E',
  submit: 'P',
  reload: 'R',
  wrap: 'w',
  sidebar: 'b',
  help: 'H',
  quit: 'q',
  learn: 'L',
  explain: 'x',
};

export type Config = {
  theme: string;
  transparent: boolean;
  /** Learning mode: plain-language explanations for people new to code. */
  learn: boolean;
  asks: { autoSend: boolean };
  highlight: HighlightConfig;
  layout: { sidebarWidth: number; wrap: boolean };
  keys: Record<KeyAction, string>;
};

export function defaultConfig(): Config {
  return {
    theme: DEFAULT_THEME,
    transparent: false,
    learn: false,
    asks: { autoSend: false },
    highlight: { ...DEFAULT_HIGHLIGHT, skip: [...DEFAULT_HIGHLIGHT.skip] },
    layout: { sidebarWidth: 34, wrap: false },
    keys: { ...DEFAULT_KEYS },
  };
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function apply(cfg: Config, raw: Raw, source: string): void {
  if (typeof raw.theme === 'string') cfg.theme = raw.theme;
  if (typeof raw.transparent === 'boolean') cfg.transparent = raw.transparent;
  if (typeof raw.learn === 'boolean') cfg.learn = raw.learn;
  if (isObj(raw.asks) && typeof raw.asks.autoSend === 'boolean') cfg.asks.autoSend = raw.asks.autoSend;
  if (isObj(raw.highlight)) {
    const h = raw.highlight;
    if (typeof h.maxFileLines === 'number') cfg.highlight.maxFileLines = h.maxFileLines;
    if (typeof h.maxFileBytes === 'number') cfg.highlight.maxFileBytes = h.maxFileBytes;
    if (Array.isArray(h.skip)) cfg.highlight.skip = h.skip.filter((s): s is string => typeof s === 'string');
  }
  if (isObj(raw.layout)) {
    if (typeof raw.layout.sidebarWidth === 'number') cfg.layout.sidebarWidth = Math.max(16, Math.floor(raw.layout.sidebarWidth));
    if (typeof raw.layout.wrap === 'boolean') cfg.layout.wrap = raw.layout.wrap;
  }
  if (isObj(raw.keys)) {
    for (const [k, v] of Object.entries(raw.keys)) {
      if (k in cfg.keys && typeof v === 'string' && v) cfg.keys[k as KeyAction] = v;
      else log(`config ${source}: ignoring unknown key binding ${k}`);
    }
  }
}

function readToml(path: string): Raw | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8'));
    return isObj(parsed) ? parsed : null;
  } catch (e) {
    throw new Error(`invalid config ${path}: ${(e as Error).message}`);
  }
}

export type ConfigFlags = { theme?: string; transparent?: boolean; learn?: boolean };

/** ~/.config/rv/config.toml, overridden by <repo>/.rv.toml, overridden by flags. */
export function loadConfig(repoRoot: string | null, flags: ConfigFlags = {}): Config {
  const cfg = defaultConfig();
  const user = readToml(join(configDir(), 'config.toml'));
  if (user) apply(cfg, user, 'user');
  if (repoRoot) {
    const repo = readToml(join(repoRoot, '.rv.toml'));
    if (repo) apply(cfg, repo, 'repo');
  }
  if (flags.theme) cfg.theme = flags.theme;
  if (flags.transparent !== undefined) cfg.transparent = flags.transparent;
  if (flags.learn !== undefined) cfg.learn = flags.learn;
  return cfg;
}
