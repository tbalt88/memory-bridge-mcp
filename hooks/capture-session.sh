#!/usr/bin/env bash
#
# Memory Bridge — automatic session capture (Claude Code SessionEnd hook)
#
# On session end, spawns a detached, headless `claude` agent that reads the
# just-ended session's transcript, extracts only durable facts/decisions/
# preferences, and writes them to Memory Bridge via memory_write. Truly
# hands-off: you never call anything.
#
# Design notes:
#   - A shell hook can't run an LLM, so extraction is delegated to a headless
#     `claude -p` (defaults to Haiku — extraction is cheap work).
#   - RECURSION GUARD: the headless capture agent is itself a Claude Code
#     session, so when it ends it also fires SessionEnd. MEMORY_BRIDGE_CAPTURE=1
#     is exported onto the spawned agent; this script no-ops immediately if it
#     ever sees that flag.
#   - The capture agent runs with cwd = the Memory Bridge repo, where the
#     `memory-bridge` MCP server is registered and authenticated. The transcript
#     path is absolute, so it is readable from there regardless of where the
#     captured session actually ran.
#
# Portability: set MEMORY_BRIDGE_DIR to your clone's path (default below).

set -euo pipefail

# --- Recursion guard: never capture a capture session ------------------------
if [ "${MEMORY_BRIDGE_CAPTURE:-}" = "1" ]; then
  exit 0
fi

# --- Config ------------------------------------------------------------------
MEMORY_BRIDGE_DIR="${MEMORY_BRIDGE_DIR:-$HOME/Documents/Projects/memory-bridge-mcp}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo /opt/homebrew/bin/claude)}"
CAPTURE_MODEL="${MEMORY_BRIDGE_CAPTURE_MODEL:-claude-haiku-5-5}"
LOG="$HOME/.claude/memory-bridge-capture.log"
mkdir -p "$(dirname "$LOG")"

# --- Parse the SessionEnd payload (line-per-field preserves spaces in paths) --
PAYLOAD="$(cat)"
{
  IFS= read -r SESSION_ID
  IFS= read -r TRANSCRIPT
  IFS= read -r REASON
  IFS= read -r CWD
} < <(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(); print(); print(); print(); sys.exit(0)
for k in ("session_id", "transcript_path", "reason", "cwd"):
    print(d.get(k, ""))
')

# --- Skip conditions ---------------------------------------------------------
[ "$REASON" = "resume" ] && exit 0          # session continuing, not ending
[ -z "$TRANSCRIPT" ] && exit 0              # nothing to read
[ -f "$TRANSCRIPT" ] || exit 0             # transcript gone

# --- Extraction instruction for the headless capture agent -------------------
# The hook cannot query Memory Bridge itself (the MCP server is OAuth-gated and
# only the spawned agent holds a session), so the dedupe check is part of the
# prompt: the agent runs memory_search before every write.
CAPTURE_PROMPT="A Claude Code session just ended. Read its transcript and save to Memory Bridge only what a future, unrelated session would want to recall.

The transcript is a JSONL file at:

  $TRANSCRIPT

Connection first. The remote memory server can take a few seconds to come up, so call memory_ping before anything else. If it errors or the memory tools are not available yet, wait briefly and retry, up to 6 attempts. Do not call memory_write until a ping has returned ok. If it never connects, write nothing and say so.

What belongs in memory: atomic facts, decisions (with the reason), stable preferences, and pointers (where something lives, which ticket or doc to open). One entry per fact, a sentence or two each. Longer material such as documents, plans, write-ups, logs and handoffs belongs in the vault, so leave it out. Also leave out task-local narration, anything that will not matter next week, and standing rules or instructions that were loaded into the session (CLAUDE.md, handoff files, earlier memory results) rather than decided in it. Those are already recorded where they came from, and restating them is how near-identical entries pile up.

Check before you write. For each candidate, call memory_search on its two or three key terms, and once more with a synonym if the first search finds nothing. Then:
- If an existing entry already says the same thing, write nothing for it.
- If the session established something new, write it.
- If the session changed or reversed what an existing entry says, write the correction and cite the superseded entry's id in the content (for example \"Supersedes <id>: ...\"), so the older entry can be triaged.

Write with memory_write using surface \"code\", session_id \"$SESSION_ID\", a category (decision, preference, project-fact, troubleshooting or reference) or no category to stage the entry if you are unsure, and a few flat tags.

Writing nothing is a normal outcome. Finish with one line per entry written (or \"nothing new\") and whether memory_ping succeeded."

# --- Spawn the detached capture agent ----------------------------------------
# Export everything the backgrounded subshell needs (references, not embeds —
# avoids quoting issues and handles spaces). MEMORY_BRIDGE_CAPTURE=1 arms the
# recursion guard for the agent's own eventual SessionEnd.
export MEMORY_BRIDGE_CAPTURE=1
export CAPTURE_PROMPT CAPTURE_MODEL MEMORY_BRIDGE_DIR CLAUDE_BIN

echo "=== capture $(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID reason=$REASON origin_cwd=$CWD ===" >> "$LOG"

# Warm the Worker/Durable Object so the capture agent's MCP connection
# establishes faster (a 401 is fine — it just wakes the isolate).
curl -s -o /dev/null --max-time 5 "https://memory-bridge-mcp.dexevo.workers.dev/mcp" >> "$LOG" 2>&1 || true

nohup bash -c '
  cd "$MEMORY_BRIDGE_DIR" || exit 0
  "$CLAUDE_BIN" -p "$CAPTURE_PROMPT" \
    --model "$CAPTURE_MODEL" \
    --allowedTools Read mcp__memory-bridge__memory_ping mcp__memory-bridge__memory_search mcp__memory-bridge__memory_write
' >> "$LOG" 2>&1 &

disown 2>/dev/null || true
exit 0
