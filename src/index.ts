import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";

// Only these GitHub logins may use the memory tools. This is a personal,
// single-user store — GitHub OAuth alone proves identity, not authorization.
const ALLOWED_USERNAMES = new Set<string>(["tbalt88"]);

type MemoryRow = {
	id: string;
	content: string;
	category: string | null;
	tags: string | null;
	status: string;
	surface: string;
	session_id: string | null;
	created_at: string;
	updated_at: string;
};

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Memory Bridge MCP",
		version: "1.0.0",
	});

	async init() {
		if (!ALLOWED_USERNAMES.has(this.props!.login)) {
			return;
		}

		const db = this.env.DB;

		this.server.tool(
			"memory_write",
			"Store a memory entry. Omit category to leave it staged for later triage instead of guessing.",
			{
				content: z.string().describe("The memory content."),
				category: z.string().optional().describe("Leave unset to stage for triage."),
				tags: z.array(z.string()).optional().describe("Flat tags, no hierarchy."),
				surface: z.enum(["chat", "cowork", "code"]).describe("Where this memory originated."),
				session_id: z.string().optional().describe("Session identifier on that surface."),
			},
			async ({ content, category, tags, surface, session_id }) => {
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				const status = category ? "active" : "staged";
				await db
					.prepare(
						`INSERT INTO memories (id, content, category, tags, status, surface, session_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(id, content, category ?? null, tags?.join(",") ?? null, status, surface, session_id ?? null, now, now)
					.run();
				return {
					content: [{ type: "text", text: JSON.stringify({ id, status }) }],
				};
			},
		);

		this.server.tool(
			"memory_search",
			"Search memory entries by keyword and optional filters. Plain SQL filtering, no semantic search.",
			{
				query: z.string().describe("Substring to match against content."),
				tags: z.string().optional().describe("Substring to match against stored tags."),
				surface: z.enum(["chat", "cowork", "code"]).optional(),
				status: z.enum(["active", "staged", "archived"]).optional(),
			},
			async ({ query, tags, surface, status }) => {
				let sql = "SELECT * FROM memories WHERE content LIKE ?";
				const params: unknown[] = [`%${query}%`];
				if (tags) {
					sql += " AND tags LIKE ?";
					params.push(`%${tags}%`);
				}
				if (surface) {
					sql += " AND surface = ?";
					params.push(surface);
				}
				if (status) {
					sql += " AND status = ?";
					params.push(status);
				}
				sql += " ORDER BY created_at DESC LIMIT 50";
				const { results } = await db
					.prepare(sql)
					.bind(...params)
					.all<MemoryRow>();
				return {
					content: [{ type: "text", text: JSON.stringify(results) }],
				};
			},
		);

		this.server.tool(
			"memory_get",
			"Fetch a single memory entry by id.",
			{ id: z.string() },
			async ({ id }) => {
				const row = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<MemoryRow>();
				return {
					content: [{ type: "text", text: JSON.stringify(row ?? null) }],
				};
			},
		);

		this.server.tool(
			"memory_list_staged",
			"List memory entries awaiting triage (written without a category).",
			{},
			async () => {
				const { results } = await db
					.prepare("SELECT * FROM memories WHERE status = 'staged' ORDER BY created_at ASC")
					.all<MemoryRow>();
				return {
					content: [{ type: "text", text: JSON.stringify(results) }],
				};
			},
		);

		this.server.tool(
			"memory_update",
			"Edit an existing entry's content, tags, or surface. Does not touch category/status — use memory_classify for that.",
			{
				id: z.string(),
				content: z.string().optional(),
				tags: z.array(z.string()).optional().describe("Replaces the existing tag list entirely."),
				surface: z.enum(["chat", "cowork", "code"]).optional(),
			},
			async ({ id, content, tags, surface }) => {
				if (content === undefined && tags === undefined && surface === undefined) {
					return {
						content: [{ type: "text", text: "Provide at least one of content, tags, or surface." }],
						isError: true,
					};
				}
				const existing = await db.prepare("SELECT id FROM memories WHERE id = ?").bind(id).first();
				if (!existing) {
					return { content: [{ type: "text", text: `No entry with id ${id}.` }], isError: true };
				}
				const sets: string[] = [];
				const params: unknown[] = [];
				if (content !== undefined) {
					sets.push("content = ?");
					params.push(content);
				}
				if (tags !== undefined) {
					sets.push("tags = ?");
					params.push(tags.join(","));
				}
				if (surface !== undefined) {
					sets.push("surface = ?");
					params.push(surface);
				}
				const now = new Date().toISOString();
				sets.push("updated_at = ?");
				params.push(now);
				params.push(id);
				await db
					.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
					.bind(...params)
					.run();
				return { content: [{ type: "text", text: JSON.stringify({ id, updated_at: now }) }] };
			},
		);

		this.server.tool(
			"memory_delete",
			"Permanently delete an entry. This is a hard delete, not archiving — use memory_classify with discard for a reversible removal instead.",
			{ id: z.string() },
			async ({ id }) => {
				const result = await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
				const deleted = (result.meta?.changes ?? 0) > 0;
				return {
					content: [{ type: "text", text: JSON.stringify({ id, deleted }) }],
					isError: !deleted,
				};
			},
		);

		this.server.tool(
			"memory_triage",
			"Resolve a staged memory entry: assign it a category, or discard it.",
			{
				id: z.string(),
				category: z.string().optional().describe("Assign this category to activate the entry."),
				discard: z.boolean().optional().describe("Set true to archive instead of categorizing."),
			},
			async ({ id, category, discard }) => {
				const now = new Date().toISOString();
				if (discard) {
					await db
						.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?")
						.bind(now, id)
						.run();
					return { content: [{ type: "text", text: JSON.stringify({ id, status: "archived" }) }] };
				}
				if (!category) {
					return {
						content: [{ type: "text", text: "Provide either category or discard: true." }],
						isError: true,
					};
				}
				await db
					.prepare("UPDATE memories SET category = ?, status = 'active', updated_at = ? WHERE id = ?")
					.bind(category, now, id)
					.run();
				return { content: [{ type: "text", text: JSON.stringify({ id, status: "active", category }) }] };
			},
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
