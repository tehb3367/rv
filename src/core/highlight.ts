import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesInfo, type BundledLanguage } from 'shiki';
import { blobShas, readBlob } from './git.ts';
import { cacheDir, log } from './paths.ts';
import type { LoadedTheme } from './theme.ts';
import type { DiffLine, DiffSource, FileStatus } from './types.ts';

/** [content, colour, fontStyle]. Colour and style are omitted when default. */
export type Tok = [string, string?, number?];
export type LineTokens = Tok[];
export type SideTokens = LineTokens[] | null;
export type FileTokens = { old?: SideTokens; new?: SideTokens; skipped?: string };

export type HighlightConfig = { maxFileLines: number; maxFileBytes: number; skip: string[] };

export const DEFAULT_HIGHLIGHT: HighlightConfig = {
  maxFileLines: 5000,
  maxFileBytes: 500_000,
  skip: ['*.lock', 'package-lock.json', 'pnpm-lock.yaml', '*.min.js'],
};

const ALWAYS_SKIP = ['*.min.js', '*.min.css', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'];
export const MAX_LINE_CHARS = 2000;

// ---------- language detection ----------

const EXT_OVERRIDES: Record<string, string> = {
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml',
  htm: 'html',
  zsh: 'shellscript',
  bash: 'shellscript',
  sh: 'shellscript',
  kt: 'kotlin',
  kts: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  py: 'python',
  pyi: 'python',
  md: 'markdown',
  jsonc: 'jsonc',
  tf: 'hcl',
  txt: '',
};
const NAME_OVERRIDES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  gemfile: 'ruby',
  rakefile: 'ruby',
  justfile: 'just',
};

let aliasMap: Map<string, string> | null = null;
function aliases(): Map<string, string> {
  if (aliasMap) return aliasMap;
  aliasMap = new Map();
  for (const info of bundledLanguagesInfo) {
    aliasMap.set(info.id, info.id);
    for (const a of info.aliases ?? []) if (!aliasMap.has(a)) aliasMap.set(a, info.id);
  }
  return aliasMap;
}

/** Shiki language id for a path, or null for plain text. */
export function languageFor(path: string): string | null {
  const name = basename(path).toLowerCase();
  if (name in NAME_OVERRIDES) return NAME_OVERRIDES[name] || null;
  if (name.startsWith('dockerfile')) return 'docker';
  const ext = extname(name).slice(1);
  if (!ext) return null;
  if (ext in EXT_OVERRIDES) {
    const o = EXT_OVERRIDES[ext]!;
    return o ? (aliases().get(o) ?? null) : null;
  }
  return aliases().get(ext) ?? null;
}

// ---------- skip rules ----------

function globMatch(pattern: string, path: string): boolean {
  const target = pattern.includes('/') ? path : basename(path);
  return new Bun.Glob(pattern).match(target);
}

/** Reason to skip a file by name alone (lockfiles, minified files, configured globs). */
export function skipByName(path: string, cfg: HighlightConfig): string | null {
  for (const p of [...ALWAYS_SKIP, ...cfg.skip]) if (globMatch(p, path)) return `matches ${p}`;
  return null;
}

/** Reason to skip a file by its content, or null to highlight it. */
export function skipByContent(content: string, byteLength: number, cfg: HighlightConfig): string | null {
  if (byteLength > cfg.maxFileBytes) return `over ${cfg.maxFileBytes} bytes`;
  if (content.includes('\0')) return 'binary content';
  let lines = 1;
  let lineStart = 0;
  let longest = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++;
      longest = Math.max(longest, i - lineStart);
      lineStart = i + 1;
    }
  }
  longest = Math.max(longest, content.length - lineStart);
  if (lines > cfg.maxFileLines) return `over ${cfg.maxFileLines} lines`;
  if (longest > MAX_LINE_CHARS) return `a line over ${MAX_LINE_CHARS} characters`;
  if (content.length > 1000 && content.length / lines > 300) return 'looks minified';
  return null;
}

// ---------- tokenizer ----------

/**
 * Tokenizes with Shiki's JavaScript regex engine (no Oniguruma WASM in the binary).
 * The strict engine matches Oniguruma; a grammar whose patterns it cannot compile is
 * logged and retried with a forgiving engine, which skips the unsupported patterns.
 */
export class Tokenizer {
  private loaded = new Map<string, HighlighterCore>();
  private failed = new Set<string>();
  private forgiving: HighlighterCore | null = null;

  private constructor(
    private readonly strict: HighlighterCore,
    readonly theme: LoadedTheme,
  ) {}

  static async create(theme: LoadedTheme): Promise<Tokenizer> {
    const hl = await createHighlighterCore({ themes: [theme.theme], langs: [], engine: createJavaScriptRegexEngine() });
    return new Tokenizer(hl, theme);
  }

  private async forgivingHighlighter(): Promise<HighlighterCore> {
    this.forgiving ??= await createHighlighterCore({
      themes: [this.theme.theme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    return this.forgiving;
  }

  private get themeName(): string {
    return this.theme.theme.name ?? this.theme.id;
  }

  private async highlighterFor(lang: string): Promise<HighlighterCore | null> {
    const hit = this.loaded.get(lang);
    if (hit) return hit;
    if (this.failed.has(lang)) return null;
    const loader = bundledLanguages[lang as BundledLanguage];
    if (!loader) {
      this.failed.add(lang);
      return null;
    }
    try {
      await this.strict.loadLanguage(loader);
      // Compile the grammar now so unsupported patterns surface here rather than mid-file.
      this.strict.codeToTokens('x', { lang, theme: this.themeName });
      this.loaded.set(lang, this.strict);
      return this.strict;
    } catch (e) {
      log(`highlight: grammar ${lang} fails with the strict JavaScript engine (${(e as Error).message}); using forgiving mode`);
    }
    try {
      const f = await this.forgivingHighlighter();
      await f.loadLanguage(loader);
      this.loaded.set(lang, f);
      return f;
    } catch (e) {
      this.failed.add(lang);
      log(`highlight: grammar ${lang} failed to load: ${(e as Error).message}`);
      return null;
    }
  }

  /** Tokenize a whole file. Returns null if the grammar fails. */
  async tokenize(code: string, lang: string): Promise<LineTokens[] | null> {
    let hl = await this.highlighterFor(lang);
    if (!hl) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { tokens } = hl.codeToTokens(code, { lang, theme: this.themeName });
        return tokens.map((line) =>
          line.map((t): Tok => {
            const tok: Tok = [t.content];
            if (t.color) tok[1] = t.color;
            if (t.fontStyle) tok[2] = t.fontStyle;
            return tok;
          }),
        );
      } catch (e) {
        log(`highlight: grammar ${lang} failed while tokenizing: ${(e as Error).message}`);
        if (hl === this.forgiving) return null;
        hl = await this.forgivingHighlighter();
        try {
          await hl.loadLanguage(bundledLanguages[lang as BundledLanguage]);
          this.loaded.set(lang, hl);
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

// ---------- cache ----------

export class TokenCache {
  private mem = new Map<string, LineTokens[]>();

  constructor(
    private readonly dir: string | null = join(cacheDir(), 'tokens'),
    private readonly capacity = 200,
  ) {}

  static key(blobSha: string, theme: string, lang: string): string {
    return `${blobSha}:${theme}:${lang}`;
  }

  private file(key: string): string {
    return join(this.dir!, createHash('sha1').update(key).digest('hex') + '.json');
  }

  get(key: string): LineTokens[] | undefined {
    const hit = this.mem.get(key);
    if (hit) {
      this.mem.delete(key);
      this.mem.set(key, hit);
      return hit;
    }
    if (!this.dir) return undefined;
    try {
      const tokens = JSON.parse(readFileSync(this.file(key), 'utf8')) as LineTokens[];
      this.remember(key, tokens);
      return tokens;
    } catch {
      return undefined;
    }
  }

  set(key: string, tokens: LineTokens[]): void {
    this.remember(key, tokens);
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file(key), JSON.stringify(tokens));
    } catch {
      /* the disk cache is best-effort */
    }
  }

  private remember(key: string, tokens: LineTokens[]): void {
    this.mem.delete(key);
    this.mem.set(key, tokens);
    while (this.mem.size > this.capacity) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }

  get size(): number {
    return this.mem.size;
  }
}

// ---------- engine with priority queue ----------

export type HighlightFile = { path: string; oldPath?: string; status: FileStatus };

export type EngineOptions = { config?: HighlightConfig; cache?: TokenCache };

/** Highlights whole files for a diff source, most important files first. */
export class HighlightEngine {
  private files = new Map<string, HighlightFile>();
  private order: string[] = [];
  private done = new Set<string>();
  private shas: { old: Map<string, string>; new: Map<string, string> } | null = null;
  private running = false;
  private listeners: ((path: string, tokens: FileTokens) => void)[] = [];
  readonly config: HighlightConfig;
  readonly cache: TokenCache;

  constructor(
    private src: DiffSource,
    private readonly tokenizer: Tokenizer,
    opts: EngineOptions = {},
  ) {
    this.config = opts.config ?? DEFAULT_HIGHLIGHT;
    this.cache = opts.cache ?? new TokenCache();
  }

  onResult(cb: (path: string, tokens: FileTokens) => void): void {
    this.listeners.push(cb);
  }

  /** Replace the file set (after a reload). Already-highlighted files are re-done since blobs may differ. */
  setFiles(src: DiffSource, files: HighlightFile[]): void {
    this.src = src;
    this.files = new Map(files.map((f) => [f.path, f]));
    this.order = files.map((f) => f.path);
    this.done.clear();
    this.shas = null;
    this.kick();
  }

  /** Move these paths to the front of the queue, in order. */
  prioritize(paths: string[]): void {
    const front = paths.filter((p) => this.files.has(p));
    const set = new Set(front);
    this.order = [...front, ...this.order.filter((p) => !set.has(p))];
    this.kick();
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => void this.loop());
  }

  private async loop(): Promise<void> {
    try {
      while (true) {
        const next = this.order.find((p) => !this.done.has(p));
        if (!next) break;
        this.done.add(next);
        const file = this.files.get(next)!;
        const tokens = await this.highlightFile(file);
        for (const l of this.listeners) l(next, tokens);
        await new Promise((r) => setTimeout(r, 0)); // let priority updates arrive
      }
    } finally {
      this.running = false;
    }
  }

  private async loadShas(): Promise<NonNullable<typeof this.shas>> {
    if (this.shas) return this.shas;
    const files = [...this.files.values()];
    const oldPaths = files.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path);
    const newPaths = files.filter((f) => f.status !== 'deleted').map((f) => f.path);
    const [o, n] = await Promise.all([blobShas(this.src, 'old', oldPaths), blobShas(this.src, 'new', newPaths)]);
    this.shas = { old: o, new: n };
    return this.shas;
  }

  async highlightFile(file: HighlightFile): Promise<FileTokens> {
    if (file.status === 'binary') return { skipped: 'binary' };
    const nameSkip = skipByName(file.path, this.config);
    if (nameSkip) return { skipped: nameSkip };
    const lang = languageFor(file.path) ?? (file.oldPath ? languageFor(file.oldPath) : null);
    if (!lang) return { skipped: 'plain text' };
    const shas = await this.loadShas();
    const out: FileTokens = {};
    const sides: ('old' | 'new')[] = [];
    if (file.status !== 'added') sides.push('old');
    if (file.status !== 'deleted') sides.push('new');
    for (const side of sides) {
      const p = side === 'old' ? (file.oldPath ?? file.path) : file.path;
      const sha = shas[side].get(p);
      const key = sha ? TokenCache.key(sha, this.tokenizer.theme.id, lang) : null;
      const cached = key ? this.cache.get(key) : undefined;
      if (cached) {
        out[side] = cached;
        continue;
      }
      const blob = await readBlob(this.src, side, p);
      if (!blob) {
        out[side] = null;
        continue;
      }
      const text = new TextDecoder().decode(blob);
      const reason = skipByContent(text, blob.byteLength, this.config);
      if (reason) return { skipped: reason };
      const tokens = await this.tokenizer.tokenize(text, lang);
      out[side] = tokens;
      if (tokens && key) this.cache.set(key, tokens);
    }
    return out;
  }
}

/** Tokens for one diff line: deleted lines use old-file tokens, added and context lines use new-file tokens. */
export function tokensForLine(line: DiffLine, ft: FileTokens | undefined): LineTokens | undefined {
  if (!ft) return undefined;
  const side = line.kind === 'del' ? ft.old : ft.new;
  const no = line.kind === 'del' ? line.oldNo : line.newNo;
  if (!side || !no) return undefined;
  const toks = side[no - 1];
  if (!toks) return line.text === '' ? [] : undefined;
  // Guard against drift between the diff and the blob (e.g. CRLF): fall back to plain.
  let joined = '';
  for (const t of toks) joined += t[0];
  if (joined !== line.text && joined.replace(/\r$/, '') !== line.text) return undefined;
  return toks;
}
