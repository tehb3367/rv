# rv

Terminal tool for reviewing large PRs as agent-planned layers. Bring your own agent via the bundled skill.

Your coding agent breaks a PR (or local branch) into ordered **layers**, each with a title, a "why" and a
risk level, and guarantees every hunk is in exactly one layer so nothing gets skipped. You review layer by
layer in the terminal, ask the agent questions inline, and submit the review to GitHub or export it as
markdown.

See [SPEC.md](SPEC.md) for the full build spec.

## Install

Download the binary for your platform from the releases page (`rv-darwin-arm64`, `rv-darwin-x64`,
`rv-linux-x64`), put it on your `PATH` as `rv`, and make it executable. Or run from source with
[Bun](https://bun.sh):

```sh
bun install
bun run src/index.ts diff          # or: bun link, then rv diff
bun run build                      # single binaries in dist/
```

`rv pr` and `rv submit` need the GitHub CLI (`gh`), logged in with `gh auth login`.

## Quick start

```sh
rv diff                 # review merge-base(origin/HEAD, HEAD)..HEAD
rv diff main..feature   # or a..b, a...b, a single ref; -- paths to limit
rv diff --worktree      # include uncommitted changes; --staged for the index
rv pr 482               # review a GitHub PR (number or URL)
```

Then, in your agent (in the same repo): *"plan this review in rv"*. With the skill loaded, the agent reads
the diff with `rv review`, posts a plan with `rv stack set`, and answers your questions with `rv wait` and
`rv reply`. Without an agent, rv still works: everything sits in one `Unstacked` layer in file order.

## Keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move cursor |
| `Ctrl-d` / `Ctrl-u` | Half page down / up |
| `g` / `G` | Top / bottom of layer |
| `n` / `p` | Next / previous hunk |
| `]` / `[` | Next / previous layer |
| `N` | Next unreviewed hunk in any layer |
| `Tab` | Switch pane focus; `Enter` opens a layer |
| `space` | Mark hunk reviewed and move on (again to unmark) |
| `V` | Mark the whole layer reviewed |
| `o` | Expand or collapse the hunk |
| `c` | Review comment on the cursor line |
| `?` | Ask the agent about the cursor line |
| `e` / `d` / `r` | Edit own comment / delete a draft / resolve thread |
| `S` | Send all draft asks to the agent |
| `E` | Export markdown (clipboard via OSC 52, and `<git dir>/rv/export.md`) |
| `P` | Submit to GitHub (Comment, Approve, Request changes, Draft) |
| `R` | Reload the diff |
| `w` | Toggle line wrap (on by default in compact layouts) |
| `b` | Toggle layers pane |
| `L` | Learning mode on/off |
| `x` | Ask the agent to explain the cursor line for a beginner |
| `H` | Help |
| `q` | Quit (confirms if asks are unsent or review comments unsubmitted) |

In the comment editor: `Enter` saves, `Ctrl-j` adds a newline, `Ctrl-e` opens `$EDITOR`, `Esc` cancels.
Mouse: the wheel scrolls the pane under the pointer, and clicking a layer opens it.

## Small screens and phones

rv adapts to the terminal size, so it works over SSH from a phone (Termius, Blink, a mobile terminal app):

- **Under 100 columns** the layers pane hides; `b` (or `Tab`) opens it as an overlay, `Enter` picks a layer.
- **Under 60 columns or 24 rows** rv switches to a compact layout: no pane border (the layer title is a
  single row), one line-number column instead of two, line wrap on by default (breaking at word
  boundaries; `w` toggles it), shortened paths, and a short header and key hint line. Help (`H`) scrolls
  with `j`/`k`, and dialogs wrap to the screen.
- **Under 24×8** rv shows a "terminal too small" notice until you resize.

Touch scrolling arrives as mouse-wheel events and scrolls the pane under your finger. Without an `Esc` key,
saving an empty comment also closes the editor.

## Learning mode

For people who don't read code yet but want to learn from reviewing it. Turn it on with
`rv diff --learn` (or `rv pr <n> --learn`), `learn = true` in the config, or `L` at any time.

- **Learn panel:** a panel under the diff explains whatever the cursor is on, with no agent needed:
  what green `+` and red `-` lines mean, what a hunk's `@@ -40,6 +40,9 @@` address says, what kind of
  file this is (TypeScript, Python, Go, a lockfile, an image…), what each risk level means, and the code
  words on the current line (`import`, `async`, `await`, `=>`, `def`, `func`, JSX tags, comments, strings
  and more).
- **`x` explains a line:** sends the agent "Explain this line to me like I'm new to code" for the cursor
  line in one press (no need to type a question or press `S`).
- **Beginner plans and answers:** rv tells the agent learning mode is on. Following the skill, it adds a
  plain-language `explain` to each layer (shown on the layer card as "In plain words") and answers
  questions from the basics.

Learning mode works in compact layouts too; on a phone the panel takes three or four rows.

## Install the agent skill

The skill ships inside the binary. `rv skill path` extracts it to `~/.rv/skill/SKILL.md` (refreshed when
rv is upgraded) and prints the path. Link it into your agent's skills folder:

**Claude Code**

```sh
mkdir -p ~/.claude/skills/rv-review
ln -sf "$(rv skill path)" ~/.claude/skills/rv-review/SKILL.md
```

**Codex**

```sh
mkdir -p ~/.codex/skills/rv-review
ln -sf "$(rv skill path)" ~/.codex/skills/rv-review/SKILL.md
```

**opencode**

```sh
mkdir -p ~/.config/opencode/skills/rv-review
ln -sf "$(rv skill path)" ~/.config/opencode/skills/rv-review/SKILL.md
```

(opencode also picks up skills from `~/.claude/skills`, so the Claude Code link works for both.)

**Any other agent**: paste the contents of `cat "$(rv skill path)"` into its instructions. It only needs
to be able to run shell commands.

## Agent CLI

Every agent command takes `--json` and `--session <id>`, and talks to the live session for the current
repo.

| Command | Does |
| --- | --- |
| `rv session list` | Live sessions |
| `rv review [--patch] [--layer <id>] [--unreviewed]` | Files and hunks, with stable hunk ids |
| `rv stack get` | The current plan, `stale` and `newHunks` |
| `rv stack set --stdin \| --file p.json` | Validate and install a plan (exit 2 with the problems) |
| `rv note add --hunk <id> --body <md> [--line new:42]` | Agent note |
| `rv comments [--kind ask] [--pending]` | Comments |
| `rv reply --to <id> --body <md>` | Answer an ask |
| `rv wait [--timeout 600]` | Block until asks arrive or the review ends |
| `rv navigate --layer\|--hunk\|--comment <id>` | Move the TUI |
| `rv status` | Progress per layer |
| `rv export --md [--out f]` | Markdown review |
| `rv submit [--event comment\|approve\|request-changes\|draft] [--include-asks]` | Post the GitHub review |
| `rv reload [-- <diff args>]` | Reload, optionally with a new range |
| `rv skill path` | Path of the bundled SKILL.md |

Exit codes: `0` ok, `1` error, `2` plan validation failed, `3` no live session, `4` bad token or version
mismatch.

## Config

`~/.config/rv/config.toml`, overridden by `<repo>/.rv.toml`, overridden by flags:

```toml
theme = "synthwave-84"   # any bundled Shiki theme, or a path to a VS Code theme JSON
transparent = false      # true: leave the terminal background unpainted
learn = false            # true: start in learning mode (plain-language explanations)

[asks]
autoSend = false         # true: asks go to the agent as soon as you save them

[highlight]
maxFileLines = 5000
maxFileBytes = 500000
skip = ["*.lock", "package-lock.json", "pnpm-lock.yaml", "*.min.js"]

[layout]
sidebarWidth = 34
wrap = false

[keys]                   # override any binding, e.g.
ask = "?"
send = "S"
```

Colours come from the theme's `colors` map (editor background, sidebar, line numbers, focus border, diff
tints, ANSI colours). rv targets truecolor; if `COLORTERM` isn't `truecolor` or `24bit`, colours are
quantized to the 256-colour palette.

## Files

- `~/.rv/sessions/<id>.json`: registry of live sessions (port and token, mode 0600, removed on exit).
- `<git dir>/rv/<key>.json`: saved plan, reviewed marks and comments, restored when you reopen the same
  range or PR.
- `~/.cache/rv/tokens/`: highlighting cache.
- `~/.rv/rv.log`: diagnostics (grammar failures, worker errors).

## Development

```sh
bun test                # unit and integration tests
bun run typecheck
bash test/e2e.sh        # end-to-end suite in tmux
bun run build           # binaries for macOS arm64, macOS x64 and Linux x64
```
