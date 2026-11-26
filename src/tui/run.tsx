import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { StartContext } from '../cli/start.ts';
import { HighlightClient } from '../core/highlight-client.ts';
import { log } from '../core/paths.ts';
import { derivePalette, loadTheme } from '../core/theme.ts';
import { App } from './app.tsx';
import { osc52 } from './clipboard.ts';
import { Controller } from './controller.ts';

export async function runTui(ctx: StartContext): Promise<void> {
  const { session, config } = ctx;
  const theme = await loadTheme(config.theme);
  const palette = derivePalette(theme.theme, { transparent: config.transparent });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    ...(palette.bg ? { backgroundColor: palette.bg } : {}),
  });

  const highlight = new HighlightClient(config.theme, config.highlight);
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));

  const ctl = new Controller({
    session,
    config,
    palette,
    submit: ctx.submit,
    copy: (text) => {
      try {
        if (!renderer.copyToClipboardOSC52(text)) process.stdout.write(osc52(text));
      } catch {
        process.stdout.write(osc52(text));
      }
    },
    runEditor: async (initial) => {
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      const dir = mkdtempSync(join(tmpdir(), 'rv-edit-'));
      const file = join(dir, 'COMMENT.md');
      writeFileSync(file, initial);
      await renderer.suspend();
      try {
        const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
        return r.status === 0 ? readFileSync(file, 'utf8') : null;
      } catch (e) {
        log(`editor failed: ${(e as Error).message}`);
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await renderer.resume();
      }
    },
    prioritize: (paths) => highlight.prioritize(paths),
    quit: () => finish(),
  });

  highlight.onResult((path, tokens) => ctl.setTokens(path, tokens));
  session.bus.on((e) => {
    if (e.type === 'reload') highlight.setFiles(session.src, ctl.highlightFiles());
  });

  const root = createRoot(renderer);
  root.render(<App ctl={ctl} />);
  // Start highlighting after the first paint so it never delays it.
  setTimeout(() => {
    void highlight.start(session.src, ctl.highlightFiles()).then(() => ctl.prioritizeHighlight());
  }, 0);

  await done;
  highlight.stop();
  ctl.dispose();
  root.unmount();
  renderer.destroy();
}
