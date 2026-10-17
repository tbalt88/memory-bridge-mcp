# Auto-capture hook

`capture-session.sh` is a Claude Code **SessionEnd** hook that automatically
persists durable knowledge from each session into Memory Bridge — hands-off, you
never call anything.

## How it works

```
Claude Code session ends
        │  SessionEnd hook fires with { session_id, transcript_path, reason, cwd }
        ▼
capture-session.sh
        │  - recursion guard (skip if MEMORY_BRIDGE_CAPTURE=1)
        │  - skip reason=resume / missing transcript
        │  - warm the Worker (curl)
        ▼
spawn detached:  claude -p  (Haiku 5.5, MEMORY_BRIDGE_CAPTURE=1)
        │  runs in the Memory Bridge repo dir (authenticated memory-bridge MCP)
        │  1. memory_ping (retry until connected — beats the connection race)
        │  2. read the transcript
        │  3. extract only durable atomic facts/decisions/preferences/pointers;
        │     documents go to the vault, not here
        │  4. memory_search each candidate first: skip restatements, write only
        │     new facts or corrections that cite the superseded entry id
        ▼
entries land in Memory Bridge, surface="code", session_id set for provenance
```

A shell hook can't run an LLM, so the extraction is delegated to a headless
`claude -p`. It defaults to **Haiku 5.5** (`claude-haiku-5-5`) — extraction is cheap work and this keeps the
per-session cost low.

### Why `memory_ping` first

A freshly-spawned headless session races the remote MCP server's OAuth/Durable-Object
connection setup. Early testing wrote nothing because the agent tried `memory_write`
before the connection was live ("memory-bridge is still connecting"). The fix: the
agent calls `memory_ping` first and retries until it returns ok, only then writing.
The connection warms during those retries.

### Dedupe

The hook itself cannot query Memory Bridge (the server is OAuth-gated and only the
spawned agent holds a session), so deduplication lives in the prompt: the agent
runs `memory_search` on each candidate's key terms before any write, writes nothing
that restates an existing entry, and writes a correction that cites the superseded
entry's id when a ruling changed. It also skips standing rules that were loaded into
the session (CLAUDE.md, handoffs, earlier memory results). **Limit:** this is
enforced by the model following instructions, not by code, so an occasional
near-duplicate is still possible. A hard guarantee would need a server-side
content-similarity check in `memory_write`.

### Recursion guard

The capture agent is itself a Claude Code session, so *its* end also fires SessionEnd.
`MEMORY_BRIDGE_CAPTURE=1` is exported onto the agent; the hook no-ops immediately when
it sees that flag. Verified: exactly one capture per real session, no runaway.

## Install

1. Copy the script somewhere stable and make it executable:
   ```bash
   mkdir -p ~/.claude/hooks
   cp hooks/capture-session.sh ~/.claude/hooks/
   chmod +x ~/.claude/hooks/capture-session.sh
   ```
2. Register it as a SessionEnd hook in `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "SessionEnd": [
         { "hooks": [ { "type": "command", "command": "/absolute/path/to/.claude/hooks/capture-session.sh" } ] }
       ]
     }
   }
   ```
3. Point the script at your clone (if not the default) and confirm the
   `memory-bridge` MCP server is registered + authenticated there:
   ```bash
   export MEMORY_BRIDGE_DIR="/path/to/memory-bridge-mcp"   # default: ~/Documents/Projects/memory-bridge-mcp
   ```

## Config (env vars)

| Var | Default | Purpose |
|---|---|---|
| `MEMORY_BRIDGE_DIR` | `~/Documents/Projects/memory-bridge-mcp` | Dir the capture agent runs in (must have `memory-bridge` MCP authenticated). |
| `MEMORY_BRIDGE_CAPTURE_MODEL` | `claude-haiku-5-5` | Model for the capture agent. |
| `CLAUDE_BIN` | auto (`command -v claude`) | Path to the claude CLI. |
| `MEMORY_BRIDGE_CAPTURE` | (unset) | Internal recursion-guard flag — do not set manually. |

## Disable

Remove the `SessionEnd` block from `~/.claude/settings.json` (or delete the whole
`hooks` key if it's the only one). No other cleanup needed.

## Logs

Every run appends to `~/.claude/memory-bridge-capture.log` — start marker per session
plus the capture agent's own summary of what it stored. First place to look if a
capture seems to have not happened.

## Known limits / notes

- Fires on **every** Claude Code session end (except `resume`). That's the point, but
  it does mean quota is spent per session and trivial sessions may still cost one Haiku
  call that writes nothing.
- Capture is best-effort: if the connection never comes up within the ping retries,
  the agent writes nothing rather than erroring loudly.
- All entries are `surface="code"` (they originate from Claude Code). Provenance is
  the `session_id`.
