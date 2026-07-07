# memory-bridge-mcp

A personal, cross-surface memory system exposed as a remote MCP server — reachable
from claude.ai (chat/mobile) and Claude Code (both live-verified). Cowork is currently
blocked by a bug on their end, not ours — see ARCHITECTURE.md's Surface support table.
See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the current high-level system design,
[TESTING.md](./TESTING.md) for the test record and a runnable interactive test plan, and
[TDD.md](./TDD.md) for the full design rationale, decision history, and non-goals.

Built on Cloudflare Workers + D1, scaffolded from Cloudflare's official
`remote-mcp-github-oauth` template. Access is gated by GitHub OAuth plus an
allowlist of GitHub logins (`ALLOWED_USERNAMES` in `src/index.ts`) — this is a
single-user personal store, not a multi-tenant service.

## Tools

- `memory_write(content, category?, tags?, surface, session_id)` — omit `category` to
  leave the entry staged for later triage.
- `memory_search(query, tags?, surface?, status?)` — keyword filter, no embeddings in v1.
- `memory_get(id)`
- `memory_list_staged()` — the untriaged FIFO queue.
- `memory_triage(id, category | discard)`

## Setup

### 1. GitHub OAuth App

Create an [OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app):

- Homepage URL: `https://<worker-name>.<subdomain>.workers.dev`
- Callback URL: `https://<worker-name>.<subdomain>.workers.dev/callback`

Then set the secrets:

```bash
wrangler login
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY   # e.g. openssl rand -hex 32
```

### 2. KV namespace (OAuth state) and D1 database (memory storage)

```bash
wrangler kv namespace create "OAUTH_KV"
wrangler d1 create memory-bridge-db
```

Copy the returned IDs into `wrangler.jsonc` (`<Add-KV-ID>` and `<Add-D1-ID>`), then
apply the schema:

```bash
wrangler d1 migrations apply memory-bridge-db --remote
```

### 3. Deploy

```bash
npm run deploy
```

### 4. Connect

- **claude.ai**: Settings → Connectors → Add custom connector →
  `https://<worker-name>.<subdomain>.workers.dev/mcp`
- **Claude Code**: `claude mcp add --transport http memory-bridge https://<worker-name>.<subdomain>.workers.dev/mcp`
- **Cowork**: check its settings for the same custom-connector-by-URL mechanism —
  unconfirmed as of this writing, see TDD.md §10.

## Local development

Create a second, separate GitHub OAuth App pointed at `http://localhost:8788` /
`http://localhost:8788/callback`, then a `.dev.vars` file (gitignored):

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
COOKIE_ENCRYPTION_KEY=...
```

Apply migrations locally and run the dev server:

```bash
wrangler d1 migrations apply memory-bridge-db --local
npm run dev
```

Inspect with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):
`npx @modelcontextprotocol/inspector@latest`, pointed at `http://localhost:8788/mcp`.

## Why not Cloudflare Access as the auth gate

Considered and rejected: Cloudflare Access as an SSO wall in front of the route has a
documented, open failure against claude.ai's web/mobile MCP connector
([anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410)).
The Worker-embedded OAuth provider (this template's approach) is what claude.ai's
connector is actually designed to drive. Details in [TDD.md](./TDD.md) §5.
