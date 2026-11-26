#!/usr/bin/env bash
# End-to-end suite: drives the real TUI in tmux, with a scripted agent and a stub gh.
# Usage: bash test/e2e.sh            (UPDATE_SNAPSHOTS=1 to rewrite snapshots, RV_BIN=dist/rv-linux-x64 to test a binary)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAP="$ROOT/test/e2e/snapshots"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rv-e2e.XXXXXX")"
TMUX_A="rv-e2e-a-$$"
TMUX_B="rv-e2e-b-$$"
PASS=0

cleanup() {
  tmux kill-session -t "$TMUX_A" 2>/dev/null || true
  tmux kill-session -t "$TMUX_B" 2>/dev/null || true
  [[ -n "${KEEP:-}" ]] || rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() {
  printf '  \033[31m✗ %s\033[0m\n' "$*" >&2
  for s in "$TMUX_A" "$TMUX_B"; do
    tmux has-session -t "$s" 2>/dev/null && { echo "--- $s ---" >&2; tmux capture-pane -p -t "$s" >&2 || true; }
  done
  [[ -f "$WORK/rv-a.err" ]] && { echo "--- rv-a stderr ---" >&2; cat "$WORK/rv-a.err" >&2; }
  exit 1
}

# ---- environment: isolated homes, an `rv` on PATH, the stub gh ----
export RV_HOME="$WORK/rv-home"
export XDG_CACHE_HOME="$WORK/cache"
export XDG_CONFIG_HOME="$WORK/config"
export COLORTERM=truecolor
mkdir -p "$WORK/bin" "$WORK/ghbin" "$RV_HOME"
if [[ -n "${RV_BIN:-}" ]]; then
  ln -s "$(cd "$(dirname "$RV_BIN")" && pwd)/$(basename "$RV_BIN")" "$WORK/bin/rv"
else
  printf '#!/bin/sh\nexec bun "%s/src/index.ts" "$@"\n' "$ROOT" > "$WORK/bin/rv"
  chmod +x "$WORK/bin/rv"
fi
cp "$ROOT/test/fixtures/stub-gh" "$WORK/ghbin/gh"
export PATH="$WORK/bin:$PATH"
export RV_CMD="$WORK/bin/rv"
export RV_STUB_GH_LOG="$WORK/gh.log"

capture() { tmux capture-pane -p -t "$1"; }
capture_e() { tmux capture-pane -p -e -t "$1"; }
wait_for() { # session pattern [timeout-seconds]
  local deadline=$((SECONDS + ${3:-10}))
  while ((SECONDS < deadline)); do
    capture "$1" | grep -qF -- "$2" && return 0
    sleep 0.1
  done
  die "timed out waiting for \"$2\" in $1"
}
keys() { local s="$1"; shift; for k in "$@"; do tmux send-keys -t "$s" "$k"; sleep 0.08; done; }
type_text() { tmux send-keys -t "$1" -l "$2"; sleep 0.1; }
wait_live() { # dir
  local deadline=$((SECONDS + 15))
  while ((SECONDS < deadline)); do
    [[ "$(cd "$1" && rv session list --json)" != "[]" ]] && return 0
    sleep 0.1
  done
  die "no live session in $1"
}
snapshot() { # name file
  if [[ -n "${UPDATE_SNAPSHOTS:-}" || ! -f "$SNAP/$1" ]]; then
    cp "$2" "$SNAP/$1"
    ok "snapshot $1 written"
  else
    diff -u "$SNAP/$1" "$2" || die "$1 does not match the snapshot (UPDATE_SNAPSHOTS=1 to accept)"
    ok "$1 matches the snapshot"
  fi
}

# ---- 1. fixture repo ----
say "1. build the fixture repo"
FIX="$(bun "$ROOT/test/e2e/fixture.ts" "$WORK/fixture")"
REPO_A="$(echo "$FIX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["a"])')"
REPO_B="$(echo "$FIX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["b"])')"
export RV_STUB_GH_PR_JSON="$(echo "$FIX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["prJson"])')"
ok "TS, TSX, Python and Go edits, a rename, a binary file and a lockfile change"

# ---- 2. start rv diff ----
say "2. start rv diff in tmux (160x48)"
tmux new-session -d -s "$TMUX_A" -x 160 -y 48 -c "$REPO_A" \
  "env PATH='$PATH' RV_HOME='$RV_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' COLORTERM=truecolor rv diff main..feature 2>'$WORK/rv-a.err'; sleep 600"
wait_live "$REPO_A"
wait_for "$TMUX_A" "Unstacked"
ok "session is live"

# ---- 3. fake agent plans ----
say "3. the fake agent submits a bad plan, then the corrected one"
(cd "$REPO_A" && bun "$ROOT/test/e2e/fake-agent.ts" plan) || die "fake agent plan failed"
ok "plan missing one hunk was rejected with exit 2 and that ID; the corrected plan was accepted"

# ---- 4. layer titles and truecolor ----
say "4. capture shows the layers and Synthwave '84 colours"
wait_for "$TMUX_A" "Cached API and active rows"
for t in "L1 Cached API" "L2 Report format" "L3 Rename, logo" "Core" "Tools" "Mechanical"; do
  capture "$TMUX_A" | grep -qF "$t" || die "layer pane is missing \"$t\""
done
ok "layer titles and groups are shown"
deadline=$((SECONDS + 10))
ESC=$'\e'
until capture_e "$TMUX_A" | grep -qE "${ESC}\[38;2;254;222;93m(${ESC}\[48;2;[0-9;]*m)?(import|export|const|function)"; do
  ((SECONDS < deadline)) || die "no Synthwave '84 keyword colour (#FEDE5D) in the capture"
  sleep 0.2
done
ok "keywords use Synthwave '84 #FEDE5D as a truecolor escape"

# ---- 5. ask and reply ----
say "5. ask the agent, the agent replies"
(cd "$REPO_A" && bun "$ROOT/test/e2e/fake-agent.ts" wait-reply > "$WORK/agent.out") &
AGENT=$!
wait_for "$TMUX_A" "agent waiting"
keys "$TMUX_A" n j '?'
wait_for "$TMUX_A" "ask agent"
type_text "$TMUX_A" "Why cache handler3?"
keys "$TMUX_A" Enter S
wait "$AGENT" || die "fake agent wait-reply failed"
grep -qF "ask: Why cache handler3?" "$WORK/agent.out" || die "rv wait did not return the ask"
wait_for "$TMUX_A" "Because handler3 is the hot path."
wait_for "$TMUX_A" "reply · agent"
ok "rv wait returned the ask, and the reply renders inline"

# ---- 6. reviewed marks ----
say "6. space three times"
keys "$TMUX_A" space space space
sleep 0.3
REVIEWED="$(cd "$REPO_A" && rv status --json | python3 -c 'import json,sys;print(sum(l["reviewed"] for l in json.load(sys.stdin)["layers"]))')"
[[ "$REVIEWED" == 3 ]] || die "rv status reports $REVIEWED reviewed, expected 3"
ok "rv status reports 3 reviewed"

# ---- 7. export ----
say "7. export markdown"
keys "$TMUX_A" E
wait_for "$TMUX_A" "exported to clipboard"
snapshot export.md "$REPO_A/.git/rv/export.md"

# ---- 8. rv pr + submit ----
say "8. rv pr with a stub gh, then submit as Comment"
tmux new-session -d -s "$TMUX_B" -x 160 -y 48 -c "$REPO_B" \
  "env PATH='$WORK/ghbin:$PATH' RV_HOME='$RV_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' RV_STUB_GH_LOG='$RV_STUB_GH_LOG' RV_STUB_GH_PR_JSON='$RV_STUB_GH_PR_JSON' COLORTERM=truecolor rv pr 7 2>'$WORK/rv-b.err'; sleep 600"
wait_live "$REPO_B"
wait_for "$TMUX_B" "PR #7"
keys "$TMUX_B" n n j c   # past the binary pseudo-hunk to the first line of cmd/main.go
wait_for "$TMUX_B" "review comment"
type_text "$TMUX_B" "Consider a cache key per handler."
keys "$TMUX_B" Enter
wait_for "$TMUX_B" "Consider a cache key per handler."
keys "$TMUX_B" P
wait_for "$TMUX_B" "Submit review"
keys "$TMUX_B" Enter
wait_for "$TMUX_B" "(y/n)"
keys "$TMUX_B" y
wait_for "$TMUX_B" "submitted: https://github.com/acme/widgets/pull/7"
python3 - "$RV_STUB_GH_LOG" "$WORK/payload.json" <<'PY'
import json, sys
calls = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
api = [c for c in calls if c["args"][0] == "api"]
assert len(api) == 1, f"expected one gh api call, got {len(api)}"
json.dump({"args": api[0]["args"], "payload": api[0]["stdin"]}, open(sys.argv[2], "w"), indent=2, sort_keys=True)
open(sys.argv[2], "a").write("\n")
PY
snapshot submit-payload.json "$WORK/payload.json"

# ---- 9. quit ----
say "9. quit"
STATE_A="$REPO_A/.git/rv/main..feature.json"
keys "$TMUX_A" q
keys "$TMUX_B" q
deadline=$((SECONDS + 10))
until [[ -z "$(ls -A "$RV_HOME/sessions" 2>/dev/null)" ]]; do
  ((SECONDS < deadline)) || die "registry files left behind: $(ls "$RV_HOME/sessions")"
  sleep 0.1
done
ok "registry files are gone"
python3 - "$STATE_A" <<'PY' || die "state file is missing comments or reviewed marks"
import json, sys
s = json.load(open(sys.argv[1]))
kinds = sorted(c["kind"] for c in s["comments"])
assert kinds == ["ask", "reply"], kinds
assert len(s["reviewed"]) == 3, s["reviewed"]
assert s["plan"]["title"] == "Cache lookups and polish the UI"
PY
ok "state file has the plan, comments and reviewed marks"

# ---- restore: restarting on the same range brings everything back ----
say "10. restart restores the plan, marks and comments"
tmux kill-session -t "$TMUX_A" 2>/dev/null || true
tmux new-session -d -s "$TMUX_A" -x 160 -y 48 -c "$REPO_A" \
  "env PATH='$PATH' RV_HOME='$RV_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' COLORTERM=truecolor rv diff main..feature 2>'$WORK/rv-a.err'; sleep 600"
wait_live "$REPO_A"
wait_for "$TMUX_A" "Cached API and active rows"
wait_for "$TMUX_A" "3/9 hunks"
keys "$TMUX_A" q
ok "plan, reviewed marks and comments restored"

printf '\n\033[32mall %d e2e checks passed\033[0m\n' "$PASS"
