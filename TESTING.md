# Testing — Memory Bridge MCP

Two parts:
- **Part A — Test record**: everything that has actually been tested, and the result.
- **Part B — Interactive test plan**: a checklist you can run yourself to re-verify the
  whole system, from connectivity through cross-machine continuity and auto-capture.

The guiding discipline throughout: **verify against the database, never trust a
client's "done."** Every live test below was confirmed by querying D1 directly, not by
believing the agent's summary — a habit that caught two separate false "done" reports
during development (§ Part A, Update and Auto-capture).

---

## Part A — Test record

### A1. Automated tests (in-repo, run in CI)

`test/memory.test.ts` — **18 Vitest tests** against a real Miniflare-backed D1 binding
(`@cloudflare/vitest-pool-workers`), not mocks. Run with `npm test`; run in CI
(`.github/workflows/ci.yml`) on every push alongside `npm run type-check`.

| Tool | Cases covered |
|---|---|
| `ping` | returns ok, no DB access |
| `memory_write` | stages when no category; activates with category; joins tags + stamps provenance |
| `memory_search` | substring match; surface+status filters combined; 50-row cap |
| `memory_get` | returns null for a missing id |
| `memory_list_staged` | returns only staged, oldest-first (FIFO) |
| `memory_update` | errors on no fields; errors on missing id; updates content without touching category/status; replaces tags (not merge) |
| `memory_delete` | hard-deletes existing; reports `deleted:false` for missing id |
| `memory_triage` | errors on neither category nor discard; categorizes staged→active; discards→archived (ignoring category) |

### A2. Live end-to-end tests

| # | What | Result |
|---|---|---|
| 1 | **Cross-surface write→read**: `memory_write` from Claude Code, `memory_search` from claude.ai chat | ✅ Same id/content/provenance round-tripped |
| 2 | **Auth / access control**: GitHub OAuth via the Worker's own provider; `ALLOWED_USERNAMES` gate | ✅ Connects with dynamic client registration; no manual client id/secret needed |
| 3 | **Error handling**: `GET /authorize` with a bogus `client_id` | ✅ Clean `400` (was a raw `500` before the fix) |
| 4 | **Consolidation skill** (`consolidate-memory-bridge`): staged triage + duplicate merge | ✅ Triaged staged entries, merged a near-duplicate via `memory_update`, **stopped to ask before deleting** |
| 5 | **Gemini CLI** (a non-Claude client) | ⚠️ OAuth + dynamic registration succeeded, but tool registration silently failed — **client bug**, not the server (see TDD §12.16). Server behaved correctly throughout. |
| 6 | **Antigravity 2.0** (a non-Claude client) | ✅ All 8 tools registered; `memory_ping` ok; wrote the Jarvis guide as 4 entries — verified in D1 |
| 7 | **Cross-machine retrieval** (Windows, claude.ai browser) | ✅ Retrieved + reassembled the 4-chunk doc; connector was already available (account-level) with zero setup |
| 8 | **Cross-machine retrieval, 2nd client** (Windows, Claude Code) | ✅ Independently reconstructed the same doc |
| 9 | **Update from Windows** (`memory_update`) | ✅ *After* catching a silent client no-op (client re-sent unchanged content; `updated_at` bumped but content identical — caught only by reading D1). Second attempt made a real, verified change. |
| 10 | **`memory_ping`** across clients | ✅ Verified on Antigravity, Claude Code, and inside the auto-capture agent |
| 11 | **Auto-capture hook** (headless SessionEnd) | ✅ Extracted a durable fact, correctly skipped ephemeral chatter, wrote with provenance; recursion guard held. Required a `memory_ping`-retry fix to beat the connection race (see TDD §12.20). |

### A3. Operations coverage (live, cross-machine/cross-vendor)

| Op | Verified | Where |
|---|---|---|
| Create | ✅ | Antigravity / Mac |
| Read | ✅ | claude.ai + Claude Code, Mac **and** Windows |
| Update | ✅ | Claude Code / Windows |
| Classify | ✅ | Cowork + consolidation skill |
| Ping | ✅ | Antigravity, Claude Code, capture agent |
| Delete | ⏸️ | Deliberately not exercised on real data (standing ask-before-delete rule; only run once on a throwaway skill-test entry) |

### A4. Surface support (as of last test)

| Surface | Status |
|---|---|
| claude.ai (chat, web/mobile) | ✅ Working |
| Claude Code | ✅ Working |
| Antigravity 2.0 | ✅ Working |
| Cowork | ⛔ Blocked by a Cowork UI bug (connector registers account-wide but isn't surfaced/attachable). Not fixable server-side. |
| Gemini CLI | ⛔ Client-side tool-registration bug. OAuth works; tools don't register. |

---

## Part B — Interactive test plan

A checklist to re-verify the system yourself. Copy the prompts into whichever client
you're testing. Where it says **verify in D1**, run the given `wrangler` command from
the repo directory to confirm independently rather than trusting the client's reply.

> **Independent-verification helper** — run from the repo dir:
> ```bash
> npx wrangler d1 execute memory-bridge-db --remote --command "<SQL>"
> ```

### B0. Connectivity (do this first, on any new client)

- [ ] Ask: **"Call the memory_ping tool."**
  - Expect: `{"ok": true, "server": "memory-bridge-mcp", "time": ...}`
  - If it says the tool isn't available: the client connected but didn't register tools
    (the Gemini-CLI failure mode) — stop; that client can't be tested further.

### B1. Create + Read (single surface)

- [ ] Ask: **"Use memory_write to store 'TEST-B1: the sky is blue' with surface 'chat' and category 'reference'."**
  - Expect: an id + `status: "active"`. Note the id.
- [ ] Ask: **"Use memory_search to find 'TEST-B1'."**
  - Expect: the entry comes back with matching content.
- [ ] **Verify in D1:**
  ```sql
  SELECT id, category, surface, status FROM memories WHERE content LIKE '%TEST-B1%';
  ```
  - Expect: one row, `category=reference`, `surface=chat`, `status=active`.

### B2. Staging + Classify

- [ ] Ask: **"Use memory_write to store 'TEST-B2: something I might categorize later' with surface 'chat' and NO category."**
  - Expect: `status: "staged"`.
- [ ] Ask: **"Use memory_list_staged."**
  - Expect: TEST-B2 appears in the staged list.
- [ ] Ask: **"Use memory_triage on that entry with category 'reference'."**
  - Expect: `status: "active"`, `category: "reference"`.
- [ ] **Verify in D1:**
  ```sql
  SELECT status, category FROM memories WHERE content LIKE '%TEST-B2%';
  ```
  - Expect: `status=active`, `category=reference`.

### B3. Update (and the no-op trap)

- [ ] Ask: **"Get the TEST-B1 entry's current content, append ' — updated' to it, show me the full new content, then memory_update it with that exact new content."**
  - The "show me the full new content" step matters: it stops the client from silently
    re-sending unchanged content (a real failure mode seen in testing).
- [ ] **Verify in D1:**
  ```sql
  SELECT length(content) AS len, updated_at FROM memories WHERE content LIKE '%TEST-B1%';
  ```
  - Expect: `len` grew by ~10, `updated_at` is newer, `category`/`status` unchanged.

### B4. Provenance

- [ ] **Verify in D1** that every test entry carries its origin:
  ```sql
  SELECT surface, session_id, created_at FROM memories WHERE content LIKE '%TEST-B%';
  ```
  - Expect: `surface` set correctly per where you wrote it; timestamps present.

### B5. Cross-surface continuity (the core premise)

- [ ] In **client A** (e.g. Claude Code): **"Use memory_write to store 'TEST-B5 from <client A name>' with surface 'code'."** Note the id.
- [ ] In a **different client B** (e.g. claude.ai): **"Use memory_search to find 'TEST-B5'."**
  - Expect: the same entry, same id, `surface: code` — written in A, read in B.

### B6. Cross-machine continuity (if you have a second machine)

- [ ] On **machine 2**, connect a client to the same server
  (`https://memory-bridge-mcp.dexevo.workers.dev/mcp`) — for claude.ai, the connector is
  already there account-wide; for Claude Code, `claude mcp add --transport http` then
  `/mcp` to auth.
- [ ] Call `memory_ping` (B0) to confirm.
- [ ] Ask: **"Search for TEST-B5 and show it in full."**
  - Expect: the entry written on machine 1 comes back on machine 2.

### B7. Auto-capture (Claude Code only, hook installed)

- [ ] In a Claude Code session, state a **clearly durable** fact, e.g.
  **"For the record: I always deploy on Fridays and never on weekends."**
- [ ] End the session normally.
- [ ] Wait ~30s, then check the log:
  ```bash
  tail -20 ~/.claude/memory-bridge-capture.log
  ```
  - Expect: a capture entry + the agent's summary of what it stored.
- [ ] **Verify in D1:**
  ```sql
  SELECT category, surface, session_id, content FROM memories WHERE content LIKE '%Friday%' OR content LIKE '%deploy%';
  ```
  - Expect: a `surface=code` entry capturing the deploy preference. (Ephemeral chatter
    from the same session should *not* appear.)

### B8. Consolidation skill (Claude Code only)

- [ ] Create a couple of staged entries and one near-duplicate of an active entry.
- [ ] Ask: **"Consolidate Memory Bridge."** (invokes the `consolidate-memory-bridge` skill)
  - Expect: it triages the staged queue, flags the duplicate, and **asks before
    deleting** anything — it must never delete on its own.

### B9. Cleanup

- [ ] Ask the client to `memory_triage ... discard: true` (reversible archive) on the
  `TEST-B*` entries, **or** decide to hard-delete them.
  - Note: `memory_delete` is a permanent hard delete. Per the project's standing rule,
    deletion should be a deliberate, confirmed action — the safer default is
    `memory_triage` with `discard: true` (archives, keeps the row).
- [ ] **Verify in D1:**
  ```sql
  SELECT status FROM memories WHERE content LIKE '%TEST-B%';
  ```
  - Expect: `archived` (if you discarded) or gone (if you hard-deleted).

---

### Pass criteria

The system passes if: `memory_ping` returns on the client (B0); all CRUD + Classify
operations behave as specified **and match D1** (B1–B3); provenance is intact (B4);
an entry written in one surface/machine is readable in another (B5–B6); auto-capture
stores durable facts and skips ephemeral ones (B7); and the consolidation skill never
deletes without asking (B8).
