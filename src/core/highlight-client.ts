import { HighlightEngine, Tokenizer, TokenCache } from './highlight.ts';
import type { FileTokens, HighlightConfig, HighlightFile } from './highlight.ts';
import type { WorkerIn } from './highlight-worker.ts';
import { log } from './paths.ts';
import { loadTheme } from './theme.ts';
import type { DiffSource } from './types.ts';

type Listener = (path: string, tokens: FileTokens) => void;

/** Runs highlighting in a Bun Worker, falling back to the main thread if a worker cannot start. */
export class HighlightClient {
  private worker: Worker | null = null;
  private engine: HighlightEngine | null = null;
  private listeners: Listener[] = [];
  private fallback = false;

  constructor(
    private readonly theme: string,
    private readonly config: HighlightConfig,
    private readonly opts: { useWorker?: boolean; cacheDir?: string | null } = {},
  ) {}

  onResult(cb: Listener): void {
    this.listeners.push(cb);
  }

  private emit(path: string, tokens: FileTokens): void {
    for (const l of this.listeners) l(path, tokens);
  }

  async start(src: DiffSource, files: HighlightFile[]): Promise<void> {
    if (this.opts.useWorker !== false) {
      try {
        const w = new Worker(new URL('./highlight-worker.ts', import.meta.url).href);
        w.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { type: string; path?: string; tokens?: FileTokens; message?: string };
          if (m.type === 'tokens' && m.path && m.tokens) this.emit(m.path, m.tokens);
          else if (m.type === 'error') {
            log(`highlight worker error: ${m.message}`);
            w.terminate();
            this.worker = null;
            void this.startInProcess(src, files);
          }
        };
        w.onerror = (ev) => {
          log(`highlight worker failed: ${(ev as ErrorEvent).message ?? 'unknown'}`);
          if (this.worker) {
            this.worker = null;
            void this.startInProcess(src, files);
          }
        };
        this.worker = w;
        this.post({ type: 'init', src, theme: this.theme, config: this.config, files, cacheDir: this.opts.cacheDir });
        (w as Worker & { unref?: () => void }).unref?.();
        return;
      } catch (e) {
        log(`highlight worker unavailable, using main thread: ${(e as Error).message}`);
      }
    }
    await this.startInProcess(src, files);
  }

  private async startInProcess(src: DiffSource, files: HighlightFile[]): Promise<void> {
    if (this.fallback) return;
    this.fallback = true;
    const tokenizer = await Tokenizer.create(await loadTheme(this.theme));
    const cache = this.opts.cacheDir === undefined ? new TokenCache() : new TokenCache(this.opts.cacheDir);
    this.engine = new HighlightEngine(src, tokenizer, { config: this.config, cache });
    this.engine.onResult((p, t) => this.emit(p, t));
    this.engine.setFiles(src, files);
  }

  private post(msg: WorkerIn): void {
    this.worker?.postMessage(msg);
  }

  setFiles(src: DiffSource, files: HighlightFile[]): void {
    if (this.worker) this.post({ type: 'files', src, files });
    else this.engine?.setFiles(src, files);
  }

  prioritize(paths: string[]): void {
    if (this.worker) this.post({ type: 'prioritize', paths });
    else this.engine?.prioritize(paths);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
