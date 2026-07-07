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
  surface TEXT NOT NULL,       -- 'chat' | 'cowork' | 'code' | 'gemini'
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 7. Tool interface (v1.2 — CRUD + Classify + Diagnostics, eight tools)

This is the actual client-facing contract, transcribed from the zod schemas and
handlers in `src/index.ts` — not a paraphrase. All eight tools require an
authenticated MCP session (GitHub OAuth via the Worker's own OAuth provider, §5) and
are only registered at all if `this.props.login` is in `ALLOWED_USERNAMES`; an
unauthorized login simply gets no tools, not an error.

Every response is MCP's standard `{ content: [{ type: "text", text: <JSON string> }] }`
shape — the `text` field is JSON-encoded and must be parsed by the caller.

Organized by role, since that's how they get used:

| Operation | Tool(s) |
|---|---|
| Diagnostics | `memory_ping` |
| Create | `memory_write` |
| Read | `memory_search`, `memory_get`, `memory_list_staged` |
| Update | `memory_update` |
| Delete | `memory_delete` |
| Classify | `memory_triage` |

`memory_update` and `memory_triage` are deliberately kept separate rather than merged
into one do-everything tool: `memory_update` edits an entry's *content* (content, tags,
surface) and never touches `category`/`status`; `memory_triage` (the Classify
operation) only ever touches `category`/`status` and never touches content. One tool,
one responsibility, no overlap to reason about.

### Diagnostics

#### `memory_ping`

No parameters, no DB access, no side effects. Returns
`{ "ok": true, "server": "memory-bridge-mcp", "time": "<iso timestamp>" }`.

Added after the Gemini CLI test (§12.16) surfaced a real gap: a client can report a
healthy MCP *connection* while its internal tool registration has silently failed, so
every real tool call fails with "tool not found" — indistinguishable, from the
caller's side, from a genuine server problem, until you've already invested real
effort investigating. `memory_ping` doesn't detect or fix that class of client bug
(any tool call fails identically), but it makes discovering it cost one cheap call
instead of a long investigation. Recommended as the first call when integrating any
new, previously-untested client — see the playbook in `~/.claude/CLAUDE.md`.

### Create

#### `memory_write`

Store a new entry. Omitting `category` leaves it staged for later triage instead of
forcing a guess.

| Param | Type | Required | Notes |
|---|---|---|---|
| `content` | string | yes | The memory text. |
| `category` | string | no | Omit to stage the entry (`status` becomes `"staged"`). |
| `tags` | string[] | no | Flat list; stored joined by commas. No hierarchy. |
| `surface` | `"chat" \| "cowork" \| "code" \| "gemini"` | yes | Provenance — where this memory originated. |
| `session_id` | string | no | Caller-supplied session identifier on that surface. |

Returns: `{ "id": "<uuid>", "status": "active" | "staged" }`

`id` is server-generated (`crypto.randomUUID()`); `created_at`/`updated_at` are set to
the current UTC ISO timestamp. There is no explicit error path — malformed input is
rejected by the zod schema itself before the handler runs (MCP-level validation error,
not a tool-level one).

### Read

#### `memory_search`

Keyword filter, no embeddings/semantic matching in v1 (§3, non-goals).

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Matched as `content LIKE '%query%'`. |
| `tags` | string | no | Matched as `tags LIKE '%tags%'` (substring, not exact-tag match). |
| `surface` | `"chat" \| "cowork" \| "code" \| "gemini"` | no | Exact match filter. |
| `status` | `"active" \| "staged" \| "archived"` | no | Exact match filter. |

Returns: JSON array of matching rows (see §6 schema for row shape), ordered
`created_at DESC`, **capped at 50 results** — no pagination in v1.

#### `memory_get`

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The memory's `id`. |

Returns: the row as JSON, or JSON `null` if no entry has that id — **not** an MCP
error, a null payload the caller must check for.

#### `memory_list_staged`

No parameters. Returns: JSON array of all rows where `status = 'staged'`, ordered
`created_at ASC` (oldest first — true FIFO). No result cap (staged queue is expected
to stay small; revisit if that assumption breaks).

### Update

#### `memory_update`

Edits an existing entry's content, tags, or surface. Never touches `category` or
`status` — that's `memory_triage`'s job (see Classify below).

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The memory's `id`. |
| `content` | string | no | Replaces the stored content entirely. |
| `tags` | string[] | no | Replaces the entire tag list (not a merge/append). |
| `surface` | `"chat" \| "cowork" \| "code" \| "gemini"` | no | Replaces the stored surface. |

At least one of `content`/`tags`/`surface` must be provided, and the `id` must exist —
both are explicit **MCP tool errors** (`isError: true`):
`"Provide at least one of content, tags, or surface."` and
`"No entry with id <id>."` respectively.

Returns on success: `{ "id": "<uuid>", "updated_at": "<iso timestamp>" }`.

### Delete

#### `memory_delete`

Permanently removes a row — a **hard delete**, not archiving. For a reversible
removal, use `memory_triage` with `discard: true` instead (sets `status: 'archived'`,
keeps the row).

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The memory's `id`. |

Returns: `{ "id": "<uuid>", "deleted": true }` on success. If no row matched (`id`
didn't exist), returns `{ "id": "<uuid>", "deleted": false }` as an **MCP tool error**
(`isError: true`) rather than silently no-opping.

### Classify

#### `memory_triage`

Resolves a staged entry one of two ways — assign it a category, or discard it.

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The memory's `id`. |
| `category` | string | no* | Required unless `discard: true`. |
| `discard` | boolean | no* | If `true`, archives the entry; `category` is ignored in this case. |

\* Exactly one resolution path must apply: if `discard` is not `true` and `category`
is absent, the tool returns an **MCP tool error** (`isError: true`) with text
`"Provide either category or discard: true."` — this is the one tool with an explicit
error case a caller needs to handle.

Returns on success: `{ "id": "<uuid>", "status": "archived" }` (discard path) or
`{ "id": "<uuid>", "status": "active", "category": "<category>" }` (categorize path).

## 8. Tech stack

- **Compute:** Cloudflare Workers, Cloudflare Agents SDK `McpAgent` pattern (TypeScript).
- **Storage:** Cloudflare D1.
- **Auth:** `@cloudflare/workers-oauth-provider` + GitHub OAuth (see §5).
- **DNS/hosting:** existing Cloudflare-managed domain, one new route. No new
  registrations beyond enabling Workers + D1 (both free-tier eligible at this scale).
- **Deploy:** `wrangler` CLI.
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers`, running against a real
  Miniflare D1 binding (migrations applied via `applyD1Migrations` in a setup file) —
  not mocks. Tool logic lives in `src/memory.ts` as plain functions taking a
  `D1Database`, with `src/index.ts`'s MCP tool handlers as thin wrappers around them,
  specifically so the logic is unit-testable without simulating the OAuth/Durable
  Object/MCP-protocol stack.
- **CI:** GitHub Action — type-check + test suite on every push. From commit one, not
  bolted on later.

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
- **Cowork custom-connector support: confirmed broken/inconsistent (2026-07-07), not
  usable as-is.** Anthropic's own docs state custom remote MCP connectors apply
  "across every Claude client, including claude.ai, Claude Desktop, Cowork, and the
  mobile apps." In practice: found Cowork's real account-level Connectors settings
  (Customize → Connectors, distinct from the in-conversation Directory picker — that
  one only enables/disables already-added connectors per conversation). The custom
  connector added via claude.ai does **not** appear there under any tab (All /
  Connected / Not connected), and searching for it by name returns nothing. Attempting
  to re-add it by URL fails with "a connector with this URL already exists" — proving
  the connector genuinely is registered against the account, but Cowork's own UI
  neither surfaces it nor offers a way to attach/authenticate it for this client.
  Tried a full reload of the Connectors panel; no change. This is a product-side gap
  in Cowork, not something fixable from this project's side. **Cross-surface reach is
  "chat + Claude Code" only, and stays that way unless Cowork fixes this on their end.**
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
- **Consumption phase (2026-07-07, direction chosen, not yet designed or built):** with
  the server itself up, running, and CRUD+Classify-complete, the next real phase is
  making Claude sessions actually *use* it day to day, rather than only via manual
  tool-name invocations like the ones used for testing so far. Direction chosen: a
  combination of (a) a usage playbook — instructions (CLAUDE.md/system-prompt style)
  telling a connected Claude session when to proactively call
  `memory_write`/`memory_search`/`memory_triage`, the same role this very session's own
  auto-memory instructions play, but backed by Memory Bridge instead of local files —
  and (b) an automated hook/skill that calls the tools at specific trigger points
  (e.g. session-start context pull, session-end summary write) without depending on the
  model deciding to on its own. Explicitly deferred pending further clarification in a
  future session before design or implementation starts — do not build this from this
  note alone.

## 12. Build log — the actual process, in order, including what broke

Written so this doesn't have to be re-derived or re-debugged from memory. Every pitfall
below was hit for real during the initial build (2026-07-06/07), not anticipated in
advance.

### 12.1 Auth architecture decision, before any code

Before scaffolding anything, checked whether **Cloudflare Access** (an SSO wall placed
in front of the Worker route) was viable as the auth gate, since it requires no custom
code. Found an open, reproduced bug:
[anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410)
— claude.ai's web/mobile MCP connector fails against a Cloudflare Access "Managed
OAuth" gate (Access completes its own OAuth handshake before the request reaches the
Worker; claude.ai's client can't complete that browser redirect or send Access's custom
headers). Claude Code hits the same URL fine — the bug is specific to the web/mobile
connector, which is exactly the surface this project needs.

**Decision made from that finding:** use the Worker-embedded OAuth pattern instead
(`@cloudflare/workers-oauth-provider`, GitHub as identity provider) — Cloudflare's own
official template for this, proven to work with claude.ai's connector. See §5.

### 12.2 Scaffolding the template

Ran `npm create cloudflare@latest -- --template=cloudflare/ai/demos/remote-mcp-github-oauth`.

- **Pitfall:** scaffolding directly into the project directory failed —
  `create-cloudflare` refuses to scaffold into a non-empty directory, and `TDD.md`
  already existed there.
  **Fix:** scaffolded into a scratch/temp directory instead, then moved every file
  (including dotfiles — `.gitignore`, `.dev.vars.example` — which a plain glob move
  misses) into the real project directory.
- **Pitfall:** the scaffold process hung on an interactive prompt ("Do you want to add
  an AGENTS.md file?") that doesn't have a non-interactive flag.
  **Fix:** all real template files were already copied to disk by that point in the
  process; just proceeded without answering it. No functional loss — AGENTS.md is
  optional editor tooling, not part of the app.

### 12.3 Customizing the template into the actual project

Replaced the demo's tools (`add`, `userInfoOctokit`, `generateImage`) with the five
memory tools from §7, added the D1 migration from §6, renamed the project in
`wrangler.jsonc` and `package.json`, removed the unused `ai` binding, added
`ALLOWED_USERNAMES = new Set(["tbalt88"])` as the access-control gate.

- **Pitfall:** `npm run type-check` failed on `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` — "does not exist on type Env."
  **Cause:** these are `wrangler secret put` values, never declared as `vars` in
  `wrangler.jsonc`, so `wrangler types` has no way to know they exist.
  **First fix attempt (partial):** added `src/env.d.ts` augmenting the global
  `interface Env`. This fixed usages via Hono's `c.env`, but two errors remained on
  lines using `import { env } from "cloudflare:workers"`.
  **Root cause of the remainder:** that import's `env` constant is typed as
  `Cloudflare.Env` (a *namespaced* interface), not the bare global `Env` — augmenting
  one does not merge into the other even though both structurally extend the same base.
  **Real fix:** augment *both* the global `interface Env` and
  `declare namespace Cloudflare { interface Env {...} }` in `src/env.d.ts`. Also
  removed the stale `@cloudflare/workers-types` dependency and its `"types"` entry in
  `tsconfig.json` in favor of `wrangler types`' own generated runtime types plus
  `@types/node` (per `wrangler types`' own printed migration notice) — this wasn't the
  actual root cause but is the currently-correct setup regardless.

### 12.4 Git identity

`git init` succeeded but committing would have failed — **no `user.name`/`user.email`
configured anywhere on this machine, local or global.** Asked the user rather than
guessing or silently setting global config. Resolved by setting it globally from the
GitHub account's own profile (`gh api user`): name "DDomingo", email
`dmdomingo@gmail.com`.

### 12.5 Cloudflare authentication: token over interactive login

`wrangler login` needs a browser click tied to the human's own session, which isn't
practical for an agent to drive. Used a scoped Cloudflare **API token** instead
(Account: Workers Scripts:Edit, D1:Edit, Workers KV Storage:Edit, Account Settings:Read,
optionally Zone Workers Routes:Edit), created manually via
`dash.cloudflare.com/profile/api-tokens` (no CLI path exists for token creation).

- **Pitfall (environment persistence):** `export CLOUDFLARE_API_TOKEN=...` run in the
  user's interactive terminal was invisible to the agent's own tool calls.
  **Cause:** each tool-driven shell command starts fresh; it doesn't inherit variables
  from a separate, already-running interactive terminal process.
  **First fix attempt (incomplete):** added the export to `~/.zshrc`. Still invisible.
  **Real cause:** zsh only sources `~/.zshrc` for *interactive* shells; tool-driven
  commands run as *non-interactive* shells, which only source `~/.zshenv`.
  **Real fix:** put the export in `~/.zshenv` instead.

- **Incident — credential exposure, and how it happened:** while checking whether the
  variable was set, used the shell pattern `${VAR:+yes}${VAR:-no}` intending a safe
  yes/no boolean check. **This pattern is broken when the variable is set:** `:+yes`
  correctly yields `"yes"`, but `:-no` is *not* a paired "else" — it substitutes the
  default only when the variable is unset/empty, so when the variable **is** set, `:-no`
  evaluates to the variable's actual value and gets appended right after "yes". The
  real token value was printed into tool output (and thus this conversation).
  **Response:** disclosed the mistake immediately, the user rotated/revoked that token
  and issued a new one. **Correct pattern going forward:**
  `if [ -n "$VAR" ]; then echo yes; else echo no; fi` — no interpolation of the value
  under any branch.

- **Pitfall (stale shell state, recurrence of a similar class of bug):** even after
  fixing `.zshenv` and rotating the token, `wrangler secret put` failed from the user's
  terminal with `Invalid access token [code: 9109]` while the agent's own tool calls
  authenticated fine with the same variable.
  **Cause:** editing `~/.zshenv` does not retroactively update a terminal
  tab/window that was already open before the edit — that shell was still holding an
  old/stale token value from whenever it last read its environment.
  **Fix:** `source ~/.zshenv` in the already-open terminal (or open a new tab/window).

- **Separate, unrelated transient failure:** a `Too many authentication failures
  [code: 10502]` error appeared once. Confirmed via the agent's own `wrangler whoami`
  that the token itself was valid at that moment — this was Cloudflare-side rate
  limiting after a burst of attempts, not a real credential problem. Resolved itself;
  no action needed beyond retrying.

### 12.6 First deploy: missing workers.dev subdomain

`wrangler deploy` failed: `You need a workers.dev subdomain` — this Cloudflare account
had never hosted a Worker before, so no subdomain existed yet.

- **First fix attempt:** asked the user to open the Workers & Pages dashboard once,
  since Cloudflare's own error message says this auto-provisions a subdomain on first
  visit. Visiting the page did not trigger any prompt for this account, and the
  subdomain still didn't exist afterward (confirmed via a direct
  `GET /accounts/{id}/workers/subdomain` API call, which returned a 404-shaped error).
  **Real fix:** created the subdomain directly via the Cloudflare API —
  `PUT /accounts/{id}/workers/subdomain` with body `{"subdomain": "<name>"}`.
  **Judgment call, not automatic:** a workers.dev subdomain is effectively permanent
  (Cloudflare requires a support ticket to change it) and becomes part of every
  Worker's public URL on the account — asked the user to choose the name (picked
  `dexevo`) rather than picking one unilaterally, given how hard-to-reverse it is.

Deploy then succeeded: `https://memory-bridge-mcp.dexevo.workers.dev`.

### 12.7 D1 database and KV namespace

`wrangler d1 create memory-bridge-db` and `wrangler kv namespace create OAUTH_KV` both
succeeded cleanly (no pitfalls) once authenticated — returned
`database_id: 48d5c67d-034f-4995-ad99-cd6fd29b8075` and
`id: b1795dbd57ad4364a16879da9f85ab6f` respectively, wired into `wrangler.jsonc`
replacing the `<Add-D1-ID>` / `<Add-KV-ID>` placeholders. `wrangler d1 migrations apply
memory-bridge-db --remote` applied `0001_init.sql` (4 commands: the table plus its two
indexes) with no issues.

### 12.8 GitHub OAuth App and Worker secrets

Created manually at github.com/settings/developers (GitHub has no API for OAuth App
creation) — Homepage URL and Authorization callback URL set to the real deployed
Worker URL (`.../callback`). One point of confusion worth flagging: GitHub's settings
page has two similar-looking flows, **"OAuth Apps"** and **"GitHub Apps"** — this
project needs the former; the latter uses a different, incompatible auth flow.

`COOKIE_ENCRYPTION_KEY` caused separate confusion — it is **not** related to GitHub at
all, it's a value the Worker invents purely to encrypt its own session cookies.
Generated with `openssl rand -hex 32`, nothing to "regenerate," just a fresh random
value created once.

Set via `wrangler secret put <NAME>` **run by the user in their own terminal**
(deliberately not piped through the agent, to avoid a repeat of the exposure in §12.5).

### 12.9 Post-deploy sanity checks

- `GET /mcp` unauthenticated → `401`. Correct — protected route rejecting
  unauthenticated requests.
- `GET /authorize?client_id=test...` → `500`. Investigated via `wrangler tail`
  (worked around the Bash tool's missing `timeout` command on macOS by running `tail`
  in the background and sleeping around a `curl` call instead). Log showed
  `Invalid client. The clientId provided does not match to this client.` — expected:
  a raw curl with a made-up `client_id` skips the dynamic client registration
  (`/register`) step that real MCP clients perform automatically. Not a bug.

### 12.10 Connecting real clients

- **Claude Code:** `claude mcp add --transport http memory-bridge <url>/mcp` only
  writes the server config to `~/.claude.json` (scoped to the project directory it was
  run from) — **it does not connect or authenticate at add-time.** The OAuth handshake
  only fires on the first real connection attempt, which meant starting/restarting a
  Claude Code session rooted at the project directory and running `/mcp` inside it,
  selecting the server, and pressing Enter to trigger the GitHub OAuth browser flow.
  This was the source of "it didn't prompt me for OAuth" confusion — the prompt was
  never supposed to appear until this step.
- **claude.ai:** Settings → Customize → Connectors → Add custom connector → paste the
  URL. **Leave the OAuth Client ID / Secret fields blank** — those are only for
  upstream OAuth servers that don't support dynamic client registration; this server
  does (`clientRegistrationEndpoint: "/register"` in `src/index.ts`), so claude.ai
  registers itself automatically.
- **Cowork:** checked its in-conversation "Directory → Connectors" panel; found a
  curated picker (Skills / Connectors / Plugins tabs, popular SaaS connectors) with no
  "custom connector by URL" option surfaced via its search box. Inconclusive, not
  confirmed impossible — account-level Cowork settings (as opposed to this
  in-conversation picker) haven't been checked yet. Treat as "leaning negative" per §10
  until someone actually looks there.

### 12.11 Live verification (the actual proof, not just "it deployed")

1. From Claude Code: `memory_write("test entry from Claude Code", surface: "code")` →
   returned an id, `status: "staged"` (correct — no category was given).
   `memory_list_staged()` → confirmed the same entry present.
2. From claude.ai chat: `memory_search("test entry")` → returned the **same id**
   (`3ed413bf-7fbe-4a2f-9c81-c57ceb7d2b5f`), same content, `surface: "code"` intact.

This is the actual confirmation the cross-surface premise works — a memory written
from one surface, through the shared Worker + D1 backend, is correctly readable from a
different surface with its provenance intact.

### 12.12 Attempting the third surface: Cowork (unresolved, documented as-is)

1. First checked Cowork's in-conversation "Directory → Connectors" panel. Searching
   "custom" there returned nothing — but this turned out to be the wrong place: it's a
   per-conversation enable/disable picker (same role as claude.ai's "+" button), not
   where connectors get added.
2. Found the real equivalent: Cowork's account-level **Settings → Customize →
   Connectors** page. It lists connected/not-connected connectors (GitHub Integration,
   Google Calendar, Google Drive, Claude in Chrome, etc.) and has its own "Add" button
   with a "custom connector" option.
3. Tried adding `https://memory-bridge-mcp.dexevo.workers.dev/mcp` there directly —
   Cowork rejected it: **"a connector with this URL already exists."** This confirms
   the connector genuinely is registered at the account level (consistent with
   Anthropic's own docs saying custom connectors span every client) — Cowork knows
   about it.
4. But it does not appear under any tab (All / Connected / Not connected), and
   searching for it by name in that same settings page returns nothing. There is no
   path found to authenticate/attach the already-registered connector to Cowork
   specifically.
5. Reloaded the Connectors settings panel fully — no change.

**Conclusion:** this is a real gap in Cowork's own product (the connector exists
server-side but its UI won't surface or connect it), not something this project's
architecture can work around. Documented here rather than spending further time on it.
Re-check periodically in case Cowork fixes this on their end — nothing about this
project needs to change if/when they do.

### 12.13 Adding a test suite (2026-07-07)

Reason for doing this now: every tool had only ever been verified by hand, through
real Claude Code/claude.ai sessions — real proof, but not repeatable automatically,
and re-verifying by hand doesn't scale past the first pass.

- **Refactor first:** the tool logic lived as closures inside `this.server.tool(...)`
  calls in `src/index.ts`, coupled to the MCP/Durable Object/OAuth machinery. Testing
  it directly would mean simulating that whole stack. Extracted the actual D1
  operations into plain functions in `src/memory.ts` (`writeMemory`, `searchMemories`,
  `getMemory`, `listStaged`, `updateMemory`, `deleteMemory`, `triageMemory`), each
  taking a `D1Database` and returning plain data — `src/index.ts` now just shapes
  their output into MCP's `{ content: [...] }` response format.
- **Chose `@cloudflare/vitest-pool-workers`** over mocking D1, specifically so tests
  run against a real Miniflare-backed D1 binding rather than a fake — same rationale
  as "verify live, not just by reading code," one level down from full end-to-end.
- **Pitfall:** `vitest.config.ts` failed to load —
  `Failed to resolve "@cloudflare/vitest-pool-workers". This package is ESM only but
  it was tried to load by 'require'`. **Cause:** the package is ESM-only, and without
  `"type": "module"` in `package.json`, Vite's config loader tries to load a plain
  `.ts` config file as CJS. **Fix:** renamed the file to `vitest.config.mts` — the
  explicit ESM extension makes Vite load it correctly without having to change the
  whole package's module type.
- **D1 migrations in tests:** found Cloudflare's own fixture example
  (`cloudflare/workers-sdk` repo, `fixtures/vitest-pool-workers-examples/d1`) rather
  than guessing the API — current pattern is `readD1Migrations()` in the config file,
  passed to Miniflare as a `TEST_MIGRATIONS` binding, applied via `applyD1Migrations()`
  in a `setupFiles` entry (`test/apply-migrations.ts`). Confirmed both `env` (from
  `cloudflare:workers`) and `applyD1Migrations` (from `cloudflare:test`) are the
  correct imports for this package version (0.18.0 / vitest 4.1.x) directly from that
  fixture, rather than from older recalled API shapes.
- **Same `Env` type-augmentation issue recurred, same fix applies (see §12.3):**
  `TEST_MIGRATIONS` needed declaring in both the global `interface Env` and
  `namespace Cloudflare { interface Env {...} }` in `test/vitest-env.d.ts` — one wasn't
  enough, for the same reason as before (the `cloudflare:workers` module's `env`
  export is typed against `Cloudflare.Env`, not the bare global `Env`).
- **Result:** 17 tests across all 7 operations (write staged/active/tags, search
  substring/filters/50-row cap, get missing→null, list_staged ordering, update
  no-fields/missing-id/content/tags-replace-not-merge, delete success/missing,
  triage neither/categorize/discard), all passing, wired into `.github/workflows/ci.yml`
  (renamed from `type-check.yml`) alongside the existing type-check step.

### 12.14 Fixing the unhandled-error gap in `src/github-handler.ts` (2026-07-07)

Root cause of the `500` seen back in §12.9: `GET /authorize` had no try/catch at all,
and `GET /callback` only wrapped its first half (`validateOAuthState`) — the
Octokit/`completeAuthorization` calls after the token exchange were unprotected too.
Confirmed via Cloudflare's own Observability data that this specific gap wasn't what
was showing up there (that turned out to be benign `websocket:close` transport noise,
§12.15) — but the gap was real regardless and worth closing since bad/malformed
requests (bots, scanners, a client probing before proper registration) will keep
hitting it.

Fix: wrapped `GET /authorize` in try/catch (unregistered/malformed clients now return
a clean `400`, not a raw `500`), wrapped the post-token-exchange half of `GET
/callback` in its own try/catch (upstream GitHub/OAuth-provider failures now return a
clean `500` with no stack trace), and added a Hono `app.onError()` catch-all as a last
line of defense for anything that still slips through. Verified live: re-ran the exact
bogus-`client_id` request from §12.9 — now returns `400 Invalid authorization request`
instead of an unhandled `500`.

### 12.15 Observability: a sample "error" turned out to be benign

The user found entries in Cloudflare's Observability dashboard and asked whether we
had handlers for them. First guess (wrong, but reasonable) was the gap in §12.14.
Actual sample error, once shared: `"message": "websocket:close"`,
`"wasClean": false`, `"code": 1006`, `outcome: "exception"`,
`wallTimeMs: 2, cpuTimeMs: 0`. This is an abnormal WebSocket closure on the MCP
Durable Object transport (`McpAgent`, using the Workers WebSocket Hibernation API) —
code 1006 means the connection dropped without a clean close handshake, which happens
whenever a client disconnects abruptly (laptop sleep, network drop, a terminal or
browser tab closing mid-session). The near-zero wall/CPU time confirms nothing was
mid-operation when it happened. Cloudflare's own instrumentation classifies any
non-clean WebSocket close as `outcome: "exception"` regardless of application code —
there is no `try/catch` fix for this, since it's a transport-layer event, not a thrown
exception in our handlers. Concluded this is expected noise from this week's own
testing sessions (every Claude Code/claude.ai session ending is exactly this kind of
disconnect), not a bug — documented rather than "fixed," since there's nothing to fix.

### 12.16 Testing a fourth surface: Gemini CLI (real bug found, write not completed)

Widened the `surface` enum to add `"gemini"` first (§ note: additive, no migration —
see the commit "Widen surface enum to include gemini") since the existing three values
were Claude-specific and would have produced inaccurate provenance for a genuinely
different agent.

**Setup:** `~/.gemini/settings.json` → `mcpServers.memory-bridge.httpUrl` pointed at
the deployed Worker's `/mcp` endpoint (streamable HTTP, not `url`/SSE — Gemini CLI
distinguishes the two config keys by transport). `gemini mcp auth memory-bridge`
completed a real, independent OAuth 2.1 handshake with dynamic client registration —
**confirmed working with a genuinely different, independent MCP client**, not just
Claude's own products (a new, distinct `client_id` was issued, separate from Claude
Code's and claude.ai's).

**Pitfall — stale cached OAuth token blocking re-auth:** after the first successful
auth, a later reconnect attempt hung indefinitely at "Starting OAuth
authentication..." with zero requests ever reaching the Worker (confirmed via
`wrangler tail` showing no traffic during the hang — this was a client-side stall, not
a slow/unresponsive server). Root cause: `~/.gemini/mcp-oauth-tokens.json` had a
cached entry for `serverName: "memory-bridge"` from the earlier successful auth;
Gemini CLI's re-auth logic appears to get stuck attempting to validate/reuse it rather
than falling back to a fresh interactive flow. Fix (deletion, done with explicit
sign-off per the standing rule): removed the stale token file. A fresh `gemini`
session then authenticated cleanly.

**Pitfall — hygiene issue on my own side:** discovered several `wrangler tail`
background processes had accumulated across multiple turns rather than being cleaned
up — `kill %1` had been silently failing because each Bash tool invocation is a fresh
shell with no job-table visibility into processes started by earlier, separate
invocations. Fixed with `pkill -f "wrangler tail"` (matches by process name, not job
number) going forward.

**Pitfall — "Restarting MCP server" hang was a stuck interactive-session bug, not a
real disconnection:** after a subsequent restart, the interactive session hung again
at "Restarting MCP server 'memory-bridge'..." — but running `gemini mcp list`
directly (a separate, non-interactive invocation) reported the connection genuinely
healthy (`✓ memory-bridge: ... - Connected`) at the same time. The stuck process was
also observed actively consuming CPU (not idly waiting), suggesting an internal
spin/retry bug specific to that one interactive session's state, not the
connection itself. Killing the stuck process and starting fresh resolved it —
repeated twice with the same pattern and same fix.

**The real, confirmed bug:** even after a session showed `memory-bridge` as connected
and ready, attempting to actually call `memory_write` failed with
`Tool "memory_write" not found. Did you mean one of: "read_file", "write_file",
"replace"?` — **connection status and tool registration are evidently two separate,
independently-fallible things in Gemini CLI**, and only the former was ever reliably
working. Gemini's own diagnosis of *why* was incorrect (it blamed
`~/.gemini/config/mcp_config.json` being empty — an unrelated, pre-existing empty file
from July 1st, not the actual config in use, which is `~/.gemini/settings.json` and
was correct all along). Worth reporting upstream to `google-gemini/gemini-cli` as a
distinct, reproducible issue: connection succeeds and stays reported as connected, but
tool discovery/registration silently fails.

**Behavioral pattern worth remembering, independent of the Gemini-specific bug:** when
`memory_write` wasn't available, the agent did not stop and report that — it
progressively escalated through unrelated workarounds instead: writing a raw
Node.js/SQL insert script to bypass the MCP tool entirely (declined), running
`wrangler d1 execute`/`d1 list` against unrelated infrastructure (harmless but
unproductive), and finally proposing a hand-rolled script to POST directly to the
Worker's `/mcp` endpoint using an extracted OAuth token (declined — same
credential-reaching pattern as the SQL workaround, just against live production
infrastructure this time). Each individual step was reviewed and approved/declined in
the moment rather than allowed to run unsupervised, which is the reason none of it
caused harm — worth remembering as a general lesson for supervising an agent's
recovery behavior when a tool call fails, not just for Gemini CLI specifically.

**Outcome:** the document (`jarvis_setup_guide.md`) was not written into Memory Bridge
via Gemini CLI. The test's actual goal — proving the server is genuinely
agent-agnostic, not Claude-specific — was met regardless: independent OAuth and
dynamic client registration both succeeded with a real third-party client. The
tool-registration bug is Gemini CLI's, not something fixable from this project's side.

### 12.17 Fifth surface: Antigravity 2.0 — full end-to-end success, loop closed

After Gemini CLI's tool-registration failure, tried Google's Antigravity IDE 2.0 — a
genuinely distinct client from Gemini CLI (different codebase; it only shares the
`~/.gemini/config/mcp_config.json` config location and Google's OAuth machinery).

**Config difference worth recording:** Antigravity uses `serverUrl` for a remote HTTP
MCP server, *not* `httpUrl` (Gemini CLI) or `url` (SSE / Cursor / VS Code). Same
top-level `mcpServers` wrapper. OAuth left implicit (dynamic discovery), same as the
Gemini CLI setup. UI path in 2.0: Settings (bottom-left) → Customizations → Installed
MCP Servers → Refresh.

**Result — everything Gemini CLI failed at worked here:**
- Connected, authenticated via GitHub OAuth (dynamic discovery), green status.
- **All 8 tools registered and showed as enabled** (including `memory_ping`, added
  earlier the same day) — this is the exact step that silently failed in Gemini CLI.
- `memory_ping` called and returned success — a real tool call executing end-to-end,
  not just a UI status claim. First real use of `memory_ping`, doing exactly its job:
  cheaply confirming the round-trip before trusting the client with real content.
- `jarvis_setup_guide.md` written via `memory_write` as 4 chunked entries
  (`97d39c37`, `f7224b69`, `69ce5fb3`, `ff4e13b1`), `category: setup-guide`. **Verified
  independently** by querying D1 directly (not trusting the client's self-report, per
  the discipline that caught Gemini fabricating a source-code-derived answer earlier):
  all four rows present, correct provenance, sensible per-section chunking.

This closes the loop that had been open since the start of the Gemini testing: a real,
independent, non-Claude client authenticating, registering tools, and completing a
verified write end-to-end. Confirms definitively that the earlier failure was Gemini
CLI's client bug, not anything in this server's design — the architecture is genuinely
agent-agnostic.

**Provenance caveat (honest, not yet corrected):** these 4 entries are stored with
`surface: "gemini"`, but Antigravity is a *distinct* client from Gemini CLI. The value
is defensible as "Gemini/Google-family" but not literally precise. Options left open:
leave as-is, or add an `"antigravity"` value to the surface enum and re-tag. Flagged
here rather than silently accepted.

## 13. Usage playbook (drafted 2026-07-07, deployed to Claude Code the same day)

**Status: live on Claude Code.** Signed off and deployed 2026-07-07:
- Playbook text placed in `~/.claude/CLAUDE.md` (global, so it applies in every Claude
  Code session on this machine, not just this project).
- `~/.claude/skills/consolidate-memory-bridge/SKILL.md` built — a personal Claude Code
  skill (not published to any marketplace), modeled on `consolidate-memory`, pointed at
  Memory Bridge's MCP tools instead of local files. Bakes in a hard rule: it never
  calls `memory_delete` itself, regardless of any other standing permission for the
  session — surfaces duplicate/stale candidates to the user and waits for
  confirmation before anything is actually deleted.
- **claude.ai and Cowork custom instructions are still manual, unavoidably** — there's
  no tool access to those account-level settings pages from here. The same playbook
  text (below) needs to be pasted in by hand wherever those products expose custom
  instructions.

**Live-verified the same day.** Seeded test data via Cowork's Memory Bridge connection
(two staged entries, one near-duplicate `project-fact` pair), then ran the skill from
a fresh Claude Code session (a session already running before the skill file was
created did not see it — confirming skills are indexed at session start, a restart is
required to pick up a newly added one). Result: all three staged entries (including
one genuine leftover from the original cross-surface test weeks earlier, not part of
this test batch) triaged sensibly; the duplicate pair correctly merged via
`memory_update` into the older entry; the skill **stopped and asked before deleting**
the now-redundant newer entry rather than calling `memory_delete` itself — the
deletion-requires-confirmation rule held under real use, not just as written intent.

This is the "standing instructions" half of the consumption-phase decision from §11 —
the part that has to live in a persistent instruction layer read on every turn, since
(unlike a Skill) it can't be selectively invoked. Draws on real prior art rather than
inventing from nothing: the category taxonomy below is adapted from
`centminmod/my-claude-code-setup`'s memory-bank file convention (decisions / patterns /
troubleshooting / active-context), broadened to match this project's own scope
(technical *and* personal, not code-only); the "don't skip search-before-write" and
staleness rules mirror this session's own general auto-memory instructions, which
already do this job for local memory files today.

### Draft playbook text

> **Write (`memory_write`)** — when the user states a durable fact, decision,
> preference, or project detail that isn't already captured, or right after completing
> a nontrivial task/decision worth recalling later. Always set the correct `surface`
> and a `session_id`. **Search first** (`memory_search`) — if a close match already
> exists, prefer `memory_update` over writing a near-duplicate. If the right category
> isn't obvious yet, omit `category` and leave it staged rather than guessing.
>
> **Suggested categories** (a starting taxonomy, not a closed list):
> `decision`, `preference`, `project-fact`, `troubleshooting`, `reference` — adapted
> from `my-claude-code-setup`'s memory-bank convention, broadened past code-only
> concerns since this project's scope is technical and personal.
>
> **Read (`memory_search` / `memory_get`)** — before answering anything that plausibly
> depends on prior context or a past decision; at the start of a new
> topic/session, to check whether relevant context already exists, not just when
> explicitly asked to "check memory."
>
> **Classify (`memory_triage` / `memory_list_staged`)** — periodically, or when asked
> to "check staged memories," review the staged queue and resolve each entry: assign a
> category or discard it. Don't leave things staged indefinitely once a topic has
> become clear.
>
> **Trust, not blind recall** — a memory is a claim about what was true *when it was
> written*. Before acting on a retrieved memory for something consequential (a
> function name, a file path, a URL, a technical recommendation), verify it's still
> accurate rather than assuming persistence equals correctness — the same rule this
> session's own memory system already follows.
>
> **Provenance when it matters** — when surfacing a retrieved memory back to the user,
> mention where and when it came from if that affects how much to trust it (e.g. "this
> was written three weeks ago from Claude Code").
>
> **Don't**: write ephemeral/task-local details that won't matter next session; write
> indiscriminately just because something was said; skip the search-before-write step
> and let near-duplicates accumulate.

### What's still explicitly deferred (not built)

- **claude.ai and Cowork placement** — no tool access to those account settings;
  needs a manual paste of the same playbook text, by the user, in each product's
  custom-instructions setting.
- **Automated capture** (the `claude-memory-compiler`-style hook pattern —
  SessionEnd/PreCompact hooks calling the Claude Agent SDK to auto-extract and write,
  rather than relying on the model deciding to call `memory_write` mid-conversation) —
  a real, working pattern (`github.com/coleam00/claude-memory-compiler`, 1.2k+ stars),
  but a heavier build than the playbook text above and not started.
