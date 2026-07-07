# Technical Design Document: Memory Bridge MCP

A cross-surface personal memory system reachable from Claude chat (web/mobile), Claude
Code, and Cowork, via a single hosted remote MCP server.

Status: v1 built and deployed to `https://memory-bridge-mcp.dexevo.workers.dev`.
Live-verified cross-surface on 2026-07-07: a `memory_write` from Claude Code was
read back via `memory_search` from claude.ai chat, with content, id, and `surface`
provenance all intact. Cowork reach is still unconfirmed (see §10). Project name is
provisional.

## 1. Problem

Context does not survive moving between Claude surfaces. Today this is solved by hand —
writing a manifest file at the end of a session and re-reading it at the start of the
next one (see `gemini-learning-ai-nb`'s `NEXT_SESSION_MANIFEST.md`). This project
automates that: one memory store, reachable from every surface that can reach it,
carrying enough provenance to know where an entry came from.

## 2. Goals

- A single remote MCP server, reachable over HTTPS, usable from:
  - claude.ai (custom remote MCP connector)
  - Claude Code (`claude mcp add --transport http`)
  - Cowork, if its settings expose the same custom-connector mechanism (unconfirmed —
    verify during setup, see Open Risks)
- Every entry carries provenance: surface, session id, timestamps.
- A minimal, honest answer to "this looks like a tangent, what do I do with it": a
  staged/untriaged bucket, resolved on demand — not lost, not force-categorized.
- Fast reads/writes with no LLM in the hot path.

## 3. Non-goals (v1) — explicit, to hold the scope line

These were considered and deliberately cut. Re-adding any of them is a new design
discussion, not a v1 detail:

- **No autonomous self-reflection / auto-built hierarchy.** Categorization is a flat
  `category` + `tags` field, set by the caller or resolved manually via triage. Building
  an engine that invents its own hierarchy is the over-engineering trap this project
  explicitly avoided (see: `ruflo` in the competitive landscape research).
- **No vector/semantic search.** `memory_search` is SQL `LIKE` + filters. Cloudflare
  Vectorize is a clean phase-2 add if keyword search actually proves insufficient —
  not before.
- **No scheduled/cron auto-triage.** Staged entries are reviewed on demand
  (`memory_list_staged` + `memory_triage`), not by a background job.
- **No FlatBuffers or other custom serialization.** D1 (SQLite) is fast enough at this
  scale. Revisit only with a measured bottleneck, not a hypothetical one.
- **No live/interactive tangent detection.** Detection is post-hoc: the caller either
  supplies a category at write time or leaves the entry staged for later review.
- **No Jarvis-Desktop-Voice-Assistant integration.** That is a separate follow-on
  project ("Level 2"), and doesn't start until the Jarvis fork is rewritten into
  something actually owned (it currently has zero original commits from `tbalt88` — see
  project history). Out of scope here entirely.

## 4. Architecture

```
claude.ai (custom remote MCP connector, HTTPS)   ─┐
Claude Code (claude mcp add --transport http)     ─┼──►  Cloudflare Worker (MCP server)
Cowork (verify custom-connector support first)    ─┘             │
                                                                   ▼
                                                          Cloudflare D1 (SQLite)
                                                          table: memories
```

One Worker, one D1 database, one route on the existing Cloudflare-managed domain
(e.g. `memory.<domain>`). No separate server, no new hosting account.

## 5. Auth

**Decision: Worker-embedded OAuth via `@cloudflare/workers-oauth-provider`, using
GitHub as the identity provider. Not a Cloudflare Access gate in front of the route.**

Verified before committing to this: Cloudflare Access as an outer SSO gate has an open,
reproduced bug against claude.ai's web/mobile MCP connector
([anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410))
— Access completes its own OAuth handshake before the request reaches the Worker, and
claude.ai's connector cannot complete that browser redirect or send Access's custom
headers. Claude Code hits the same URL fine, but the whole point is chat parity too.

The supported alternative is Cloudflare's own official template
(`cloudflare/ai/demos/remote-mcp-github-oauth`), where the Worker itself is the OAuth
2.1 provider that Claude's client is designed to drive, gated by GitHub login
(`tbalt88`, already the authenticated `gh` identity). This is a library integration, not
custom-built auth.

## 6. Data model (v1 — one table)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT,              -- null = staged/untriaged
  tags TEXT,                  -- comma-separated, deliberately flat, no nesting
  status TEXT NOT NULL,        -- 'active' | 'staged' | 'archived'
  surface TEXT NOT NULL,       -- 'chat' | 'cowork' | 'code'
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 7. Tool surface (v1 — five tools, nothing else)

1. `memory_write(content, category?, tags?, surface, session_id)` — `category` omitted
   → `status = 'staged'`.
2. `memory_search(query, tags?, surface?, status?)` — SQL filter, no embeddings.
3. `memory_get(id)`
4. `memory_list_staged()` — the FIFO queue for manual review.
5. `memory_triage(id, category | discard)` — resolves a staged entry.

## 8. Tech stack

- **Compute:** Cloudflare Workers, Cloudflare Agents SDK `McpAgent` pattern (TypeScript).
- **Storage:** Cloudflare D1.
- **Auth:** `@cloudflare/workers-oauth-provider` + GitHub OAuth (see §5).
- **DNS/hosting:** existing Cloudflare-managed domain, one new route. No new
  registrations beyond enabling Workers + D1 (both free-tier eligible at this scale).
- **Deploy:** `wrangler` CLI.
- **CI:** minimal GitHub Action — type-check / `wrangler deploy --dry-run` on every
  push. From commit one, not bolted on later.

## 9. Build steps

1. Scaffold from `npm create cloudflare@latest -- --template=cloudflare/ai/demos/remote-mcp-github-oauth`.
2. Replace demo tools with the five in §7; add the D1 migration from §6.
3. `wrangler d1 create memory-db`; bind it in `wrangler.toml`.
4. Deploy; register as a custom connector in claude.ai; `claude mcp add --transport http`
   in Claude Code.
5. Live-verify: write from Claude Code, read the same entry from claude.ai chat, confirm
   provenance round-trips. This step is the actual proof of the project's premise —
   reading the code is not a substitute for running it.
6. Attempt the same from Cowork; resolves the one remaining open risk below.

## 10. Open risks

- **Chat + Claude Code cross-surface: confirmed working (2026-07-07).** Both connect
  via the Worker's own OAuth provider (GitHub login, dynamic client registration) —
  no Client ID/Secret needed on the claude.ai side, it self-registers.
- **Cowork custom-connector support: still unconfirmed, leaning negative.** Cowork has
  its own Connectors directory (Skills / Connectors / Plugins), but it's a curated
  per-conversation picker with no "custom connector by URL" option found via search.
  Account-level Cowork settings (as opposed to the in-conversation directory) haven't
  been exhaustively checked yet. Until resolved, treat cross-surface reach as
  "chat + Claude Code" only.
- **GitHub OAuth template assumes a GitHub-based identity check.** Fine for a
  single-user personal tool; would need rework for multi-user.

## 11. Phase 2 (explicitly deferred, not designed yet)

- Cloudflare Vectorize for semantic search, gated behind a real measured shortfall in
  keyword search quality.
- Scheduled (Cron Trigger) batch triage pass, once manual triage proves the staged
  queue actually needs automating.
- Hierarchical/nested categories, if flat tags prove insufficient in practice.
- Jarvis-Desktop-Voice-Assistant integration ("Level 2"), after Jarvis is rewritten into
  original work.
