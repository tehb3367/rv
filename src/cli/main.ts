import { RvError } from '../core/git.ts';
import { VERSION } from '../version.ts';
import type { UiRunner, SubmitterFactory } from './start.ts';

export const HELP = `rv ${VERSION} — review large PRs as agent-planned layers

Open a review (human):
  rv diff [range] [-- paths]   --staged --worktree --watch --theme <name> --transparent
  rv pr <number or url>        same flags as rv diff
  rv reload [-- <diff args>]   reload the open session, optionally with a new range

Agent commands (all take --json and --session <id>):
  rv session list
  rv review [--patch] [--layer <id>] [--unreviewed]
  rv stack get
  rv stack set --stdin | --file plan.json
  rv note add --hunk <id> --body <md> [--line new:42] [--stdin]
  rv comments [--kind ask] [--pending]
  rv reply --to <commentId> --body <md> [--stdin]
  rv wait [--timeout 600]
  rv navigate --layer <id> | --hunk <id> | --comment <id>
  rv status
  rv export --md [--out file]
  rv submit [--event comment|approve|request-changes|draft] [--include-asks]
  rv skill path

Exit codes: 0 ok, 1 error, 2 plan validation failed, 3 no live session, 4 bad token or version mismatch.
`;

export type Hooks = { ui: UiRunner | null; submitter?: SubmitterFactory };

export async function main(argv: string[], hooks: Hooks): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case '--version':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'diff':
      return (await import('./start.ts')).runDiff(rest, hooks.ui);
    case 'pr':
      return (await import('./start.ts')).runPr(rest, hooks.ui, hooks.submitter);
    case 'reload':
      return (await import('./reload.ts')).run(rest);
    case 'session':
      return (await import('./session-list.ts')).run(rest);
    case 'review':
      return (await import('./review.ts')).run(rest);
    case 'stack':
      return (await import('./stack.ts')).run(rest);
    case 'note':
      return (await import('./note.ts')).run(rest);
    case 'comments':
      return (await import('./comments.ts')).run(rest);
    case 'reply':
      return (await import('./reply.ts')).run(rest);
    case 'wait':
      return (await import('./wait.ts')).run(rest);
    case 'navigate':
      return (await import('./navigate.ts')).run(rest);
    case 'status':
      return (await import('./status.ts')).run(rest);
    case 'export':
      return (await import('./export.ts')).run(rest);
    case 'submit':
      return (await import('./submit.ts')).run(rest);
    case 'skill':
      return (await import('./skill.ts')).run(rest);
    default:
      throw new RvError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}
