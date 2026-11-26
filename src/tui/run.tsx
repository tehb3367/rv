import type { StartContext } from '../cli/start.ts';

/** Placeholder until the TUI lands: keep the session alive headless. */
export async function runTui(ctx: StartContext): Promise<void> {
  process.stderr.write(`rv session ${ctx.server.entry.id} on ${ctx.server.url} (TUI not built yet)\n`);
  await new Promise(() => {});
}
