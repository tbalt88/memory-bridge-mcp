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
CAPTURE_MODEL="${MEMORY_BRIDGE_CAPTURE_MODEL:-claude-haiku-4-5-20251001}"
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
CAPTURE_PROMPT="You are an automated memory-capture agent for Memory Bridge. A Claude Code session just ended. Your job is to persist durable knowledge from it into Memory Bridge via MCP tools.

STEP 0 — CONFIRM THE CONNECTION IS LIVE BEFORE DOING ANYTHING ELSE.
Call memory_ping. The remote MCP server can take a few seconds to establish its connection, so if memory_ping errors or the memory tools are not available yet, WAIT briefly and call memory_ping again — retry up to 6 times. Do NOT attempt any memory_write until a memory_ping call has returned ok. If after 6 attempts it still is not connected, stop and report that the connection never came up (write nothing).

STEP 1 — READ THE TRANSCRIPT.
Read the Claude Code JSONL transcript at:

  $TRANSCRIPT

Extract ONLY durable, reusable knowledge worth recalling in a future, unrelated session — decisions made and why, stable user preferences, project facts, gotchas/troubleshooting resolutions, useful references. Do NOT capture ephemeral or task-local chatter, step-by-step narration, or anything that won't matter next week.

STEP 2 — WRITE. For each candidate:
  a. Call memory_search first to avoid a near-duplicate of something already stored. If a close match exists, skip it.
  b. If genuinely new, call memory_write with: surface \"code\"; session_id \"$SESSION_ID\"; an appropriate category (decision | preference | project-fact | troubleshooting | reference) OR omit category to stage it if unsure; a few flat tags.

Be conservative: a handful of high-value entries is a success; writing nothing is a perfectly valid outcome. Do not summarize the whole session. When done, briefly state what you captured (and confirm memory_ping succeeded)."

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
