/// <reference lib="webworker" />
import { HighlightEngine, Tokenizer, TokenCache } from './highlight.ts';
import type { HighlightConfig, HighlightFile } from './highlight.ts';
import { loadTheme } from './theme.ts';
import type { DiffSource } from './types.ts';

export type WorkerIn =
  | { type: 'init'; src: DiffSource; theme: string; config: HighlightConfig; files: HighlightFile[]; cacheDir?: string | null }
  | { type: 'files'; src: DiffSource; files: HighlightFile[] }
  | { type: 'prioritize'; paths: string[] };

declare const self: Worker;

let engine: HighlightEngine | null = null;
const pending: WorkerIn[] = [];

async function handle(msg: WorkerIn): Promise<void> {
  if (msg.type === 'init') {
    try {
      const theme = await loadTheme(msg.theme);
      const tokenizer = await Tokenizer.create(theme);
      const cache = msg.cacheDir === undefined ? new TokenCache() : new TokenCache(msg.cacheDir);
      engine = new HighlightEngine(msg.src, tokenizer, { config: msg.config, cache });
      engine.onResult((path, tokens) => self.postMessage({ type: 'tokens', path, tokens }));
      engine.setFiles(msg.src, msg.files);
      for (const p of pending.splice(0)) await handle(p);
      self.postMessage({ type: 'ready' });
    } catch (e) {
      self.postMessage({ type: 'error', message: (e as Error).message });
    }
    return;
  }
  if (!engine) {
    pending.push(msg);
    return;
  }
  if (msg.type === 'files') engine.setFiles(msg.src, msg.files);
  else if (msg.type === 'prioritize') engine.prioritize(msg.paths);
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => void handle(ev.data);
