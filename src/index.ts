#!/usr/bin/env bun
import { RvError } from './core/git.ts';
import { main } from './cli/main.ts';

const argv = process.argv.slice(2);
const needsUi = argv[0] === 'diff' || argv[0] === 'pr';

try {
  const ui = needsUi && !argv.includes('--headless') ? (await import('./tui/run.tsx')).runTui : null;
  const submitter = argv[0] === 'pr' ? (await import('./server/submit.ts')).makeSubmitter : undefined;
  const code = await main(argv, { ui, submitter });
  process.exitCode = code;
} catch (e) {
  if (e instanceof RvError) {
    process.stderr.write(`rv: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`rv: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  }
}
