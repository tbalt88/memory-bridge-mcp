# Architecture — Memory Bridge MCP

A living, high-level reference for how this system actually works. For design
rationale, the full decision history, pitfalls hit, and incident details, see
[TDD.md](./TDD.md) — this file is deliberately just the current shape of the thing.

## What this is

A personal, cross-surface memory store exposed as a remote MCP server: write/read/
classify memories from claude.ai chat, Claude Code, or (pending, see below) Cowork,
all hitting the same backend, so context survives moving between them.

## System diagram

```
claude.ai (custom remote MCP connector)   ─┐
Claude Code (claude mcp add --transport http) ─┼──►  Cloudflare Worker
Cowork (blocked — see Surface support)     ─┘         (memory-bridge-mcp)
                                                            │
                                    ┌───────────────────────┼───────────────────────┐
                                    ▼                       ▼                       ▼
                             Cloudflare D1            Cloudflare KV          GitHub OAuth
                             (memories table)          (OAUTH_KV —          (identity check,
                                                        OAuth session          via workers-
                                                          state)             oauth-provider)
```

Deployed at `https://memory-bridge-mcp.dexevo.workers.dev`. One Worker, one D1
database (`memory-bridge-db`), one KV namespace (`OAUTH_KV`).

## Components

- **`src/index.ts`** — the MCP server (`McpAgent`) and the seven tool definitions.
  Gated by `ALLOWED_USERNAMES` — a GitHub login allowlist checked against
  `this.props.login` (populated by the OAuth flow). Wrapped in an `OAuthProvider`
  that handles the OAuth 2.1 surface (`/authorize`, `/callback`, `/register`,
  `/token`) before any MCP request reaches the tools.
- **`src/memory.ts`** — the actual D1 operations (write/search/get/update/delete/
  triage/list_staged) as plain functions taking a `D1Database`. `index.ts`'s tools are
  thin wrappers that validate input (zod) and shape these functions' output into MCP's
  response format. Split out specifically so this logic is unit-testable without the
  OAuth/Durable Object/MCP-protocol stack around it.
- **`src/github-handler.ts`** / **`src/utils.ts`** / **`src/workers-oauth-utils.ts`**
  — the OAuth handshake: redirect to GitHub, exchange code for token, CSRF-protected
  approval dialog, session-state binding. From Cloudflare's official
  `remote-mcp-github-oauth` template, lightly modified.
- **Cloudflare D1** — the actual data store. One table, `memories` (see schema below).
- **Cloudflare KV (`OAUTH_KV`)** — OAuth state/session binding, not memory data.
- **GitHub OAuth** — the identity provider. Proves *who* is connecting; the
  `ALLOWED_USERNAMES` allowlist decides *whether that identity gets any tools at all*.

## Data model

One table, deliberately flat — no hierarchy, no separate tags table:

```sql
memories (
  id, content, category, tags, status, surface, session_id, created_at, updated_at
)
```

- `status`: `active` | `staged` | `archived`. New entries without a `category` land as
  `staged` (a FIFO triage queue) rather than forcing a guess.
- `surface`: `chat` | `cowork` | `code` | `gemini` — provenance, since this is the one property a
  single-surface memory tool would never need.
- `tags`: comma-separated string, no nesting.

## Tool surface (7 tools — CRUD + Classify)

| Op | Tool(s) |
|---|---|
| Create | `memory_write` |
| Read | `memory_search`, `memory_get`, `memory_list_staged` |
| Update | `memory_update` (content/tags/surface only) |
| Delete | `memory_delete` (hard delete) |
| Classify | `memory_triage` (category/status only — assign or discard/archive) |

`memory_update` and `memory_triage` are intentionally non-overlapping: one never
touches category/status, the other never touches content. Full parameter tables and
exact response shapes are in TDD.md §7, not duplicated here.

## Auth flow, in short

1. MCP client hits `/authorize` → redirected to GitHub.
2. GitHub redirects back to `/callback` with a code → exchanged for a token, GitHub
   user info fetched.
3. `OAUTH_PROVIDER.completeAuthorization` issues the client a token; `login` becomes
   available as `this.props.login` inside the Worker.
4. On every tool call, `MyMCP.init()` checks `this.props.login` against
   `ALLOWED_USERNAMES` before registering any tools — an unauthorized login gets no
   tools, not an error.

Chosen over a Cloudflare Access front-gate specifically because Access breaks
claude.ai's web/mobile MCP connector (see TDD.md §5, §12.1).

## Consumption layer (how Claude actually uses this day to day)

Two pieces, living outside this repo, on the machine running Claude Code:

- **`~/.claude/CLAUDE.md`** — global standing instructions: when to write, when to
  search first, suggested category taxonomy, the "never `memory_delete` without
  asking" rule.
- **`~/.claude/skills/consolidate-memory-bridge/SKILL.md`** — a personal Claude Code
  skill that triages the staged queue, merges near-duplicate active entries, and flags
  likely-stale ones. Never deletes on its own — surfaces candidates and waits for
  confirmation.

claude.ai and Cowork don't read `~/.claude/CLAUDE.md`; the same instruction text needs
manually pasting into each product's own custom-instructions setting if you want the
behavior there too.

## Surface support (current state)

| Surface | Status |
|---|---|
| claude.ai (chat) | **Working**, live-verified — custom remote MCP connector, dynamic client registration, no manual OAuth Client ID/Secret needed. |
| Claude Code | **Working**, live-verified — `claude mcp add --transport http`. |
| Cowork | **Blocked on Cowork's own product bug** — the connector registers account-wide (confirmed via a duplicate-URL rejection) but Cowork's UI doesn't surface or let you authenticate it for that client. Not fixable from this side. Re-check periodically. |

## Hosting / ops

- Cloudflare account, `dexevo.workers.dev` subdomain, no custom domain wired yet
  (`dexevo.io` is available for this later, not yet used).
- CI: `.github/workflows/ci.yml` — type-check + Vitest test suite (17 tests, running
  against a real Miniflare D1 binding) on every push.
- Repo: `github.com/tbalt88/memory-bridge-mcp`, currently **private**. Being built to
  public-repo quality (generalizable config, tests, docs) without being public yet —
  flip to public is a deliberate future step, not automatic.

## Explicit non-goals (still true as of this writing)

No semantic/vector search, no scheduled auto-triage job, no autonomous
self-organizing hierarchy, no custom serialization format. Full reasoning in
TDD.md §3 and §11 — not repeated here since the reasoning doesn't change even as the
implementation does.
