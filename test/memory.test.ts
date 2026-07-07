import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deleteMemory,
	getMemory,
	listStaged,
	searchMemories,
	triageMemory,
	updateMemory,
	writeMemory,
} from "../src/memory";

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM memories").run();
});

describe("writeMemory", () => {
	it("stages an entry when no category is given", async () => {
		const result = await writeMemory(env.DB, { content: "no category", surface: "code" });
		expect(result.status).toBe("staged");
		const row = await getMemory(env.DB, result.id);
		expect(row?.category).toBeNull();
	});

	it("activates an entry when a category is given", async () => {
		const result = await writeMemory(env.DB, { content: "has category", category: "work", surface: "chat" });
		expect(result.status).toBe("active");
		const row = await getMemory(env.DB, result.id);
		expect(row?.category).toBe("work");
	});

	it("joins tags with commas and stamps provenance", async () => {
		const result = await writeMemory(env.DB, {
			content: "tagged",
			category: "work",
			tags: ["a", "b"],
			surface: "cowork",
			session_id: "sess-1",
		});
		const row = await getMemory(env.DB, result.id);
		expect(row?.tags).toBe("a,b");
		expect(row?.surface).toBe("cowork");
		expect(row?.session_id).toBe("sess-1");
	});
});

describe("searchMemories", () => {
	it("matches content by substring", async () => {
		await writeMemory(env.DB, { content: "find the needle here", category: "x", surface: "chat" });
		await writeMemory(env.DB, { content: "unrelated entry", category: "x", surface: "chat" });
		const results = await searchMemories(env.DB, { query: "needle" });
		expect(results).toHaveLength(1);
		expect(results[0].content).toContain("needle");
	});

	it("filters by surface and status together", async () => {
		await writeMemory(env.DB, { content: "match one", category: "x", surface: "code" });
		await writeMemory(env.DB, { content: "match two", surface: "chat" }); // staged
		const activeCode = await searchMemories(env.DB, { query: "match", surface: "code", status: "active" });
		expect(activeCode).toHaveLength(1);
		expect(activeCode[0].content).toBe("match one");
	});

	it("caps results at 50", async () => {
		for (let i = 0; i < 55; i++) {
			await writeMemory(env.DB, { content: `bulk entry ${i}`, category: "x", surface: "chat" });
		}
		const results = await searchMemories(env.DB, { query: "bulk" });
		expect(results).toHaveLength(50);
	});
});

describe("getMemory", () => {
	it("returns null for a missing id", async () => {
		expect(await getMemory(env.DB, "does-not-exist")).toBeNull();
	});
});

describe("listStaged", () => {
	it("returns only staged entries, oldest first", async () => {
		const first = await writeMemory(env.DB, { content: "first staged", surface: "chat" });
		await writeMemory(env.DB, { content: "active one", category: "x", surface: "chat" });
		const second = await writeMemory(env.DB, { content: "second staged", surface: "chat" });
		const staged = await listStaged(env.DB);
		expect(staged.map((r) => r.id)).toEqual([first.id, second.id]);
	});
});

describe("updateMemory", () => {
	it("errors when no fields are provided", async () => {
		const written = await writeMemory(env.DB, { content: "original", category: "x", surface: "chat" });
		const result = await updateMemory(env.DB, { id: written.id });
		expect(result.ok).toBe(false);
	});

	it("errors when the id doesn't exist", async () => {
		const result = await updateMemory(env.DB, { id: "missing-id", content: "new" });
		expect(result.ok).toBe(false);
	});

	it("updates content without touching category/status", async () => {
		const written = await writeMemory(env.DB, { content: "original", surface: "chat" }); // staged
		const result = await updateMemory(env.DB, { id: written.id, content: "edited" });
		expect(result.ok).toBe(true);
		const row = await getMemory(env.DB, written.id);
		expect(row?.content).toBe("edited");
		expect(row?.status).toBe("staged");
		expect(row?.category).toBeNull();
	});

	it("replaces tags entirely rather than merging", async () => {
		const written = await writeMemory(env.DB, { content: "x", category: "x", tags: ["a", "b"], surface: "chat" });
		await updateMemory(env.DB, { id: written.id, tags: ["c"] });
		const row = await getMemory(env.DB, written.id);
		expect(row?.tags).toBe("c");
	});
});

describe("deleteMemory", () => {
	it("hard-deletes an existing entry", async () => {
		const written = await writeMemory(env.DB, { content: "to delete", category: "x", surface: "chat" });
		const result = await deleteMemory(env.DB, written.id);
		expect(result.deleted).toBe(true);
		expect(await getMemory(env.DB, written.id)).toBeNull();
	});

	it("reports deleted: false for a missing id", async () => {
		const result = await deleteMemory(env.DB, "missing-id");
		expect(result.deleted).toBe(false);
	});
});

describe("triageMemory", () => {
	it("errors when neither category nor discard is given", async () => {
		const written = await writeMemory(env.DB, { content: "staged", surface: "chat" });
		const result = await triageMemory(env.DB, { id: written.id });
		expect(result.ok).toBe(false);
	});

	it("categorizes a staged entry, moving it to active", async () => {
		const written = await writeMemory(env.DB, { content: "staged", surface: "chat" });
		const result = await triageMemory(env.DB, { id: written.id, category: "personal" });
		expect(result).toMatchObject({ ok: true, status: "active", category: "personal" });
		const row = await getMemory(env.DB, written.id);
		expect(row?.status).toBe("active");
		expect(row?.category).toBe("personal");
	});

	it("discards a staged entry, archiving it and ignoring category", async () => {
		const written = await writeMemory(env.DB, { content: "staged", surface: "chat" });
		const result = await triageMemory(env.DB, { id: written.id, category: "ignored", discard: true });
		expect(result).toMatchObject({ ok: true, status: "archived" });
		const row = await getMemory(env.DB, written.id);
		expect(row?.status).toBe("archived");
		expect(row?.category).toBeNull();
	});
});
