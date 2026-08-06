import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import {
	deleteMemory,
	getMemory,
	listStaged,
	ping,
	searchMemories,
	triageMemory,
	updateMemory,
	writeMemory,
} from "./memory";
import type { Props } from "./utils";

// Only these GitHub logins may use the memory tools. This is a personal,
// single-user store — GitHub OAuth alone proves identity, not authorization.
const ALLOWED_USERNAMES = new Set<string>(["tbalt88"]);

export class MemoryBridgeMCP extends McpAgent<Env, Record<string, never>, Props> {
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
			"memory_ping",
			"Zero-side-effect connectivity check — no DB access. Call this first when integrating a new client, so a broken tool registration surfaces in one cheap call instead of partway through a real write.",
			{},
			async () => {
				return { content: [{ type: "text", text: JSON.stringify(ping()) }] };
			},
		);

		this.server.tool(
			"memory_write",
			"Store a MEMORY-SHAPED entry: an atomic fact, decision, preference, or pointer — paragraphs at most. Routing rule (fabric-routing, 2026-08-06): documents, research, logs, and narratives belong in the vault (vault_capture on Vault Bridge), NEVER here — a memory entry may point at a vault note, not contain one. Omit category to leave it staged for later triage instead of guessing.",
			{
				content: z.string().describe("The memory content."),
				category: z.string().optional().describe("Leave unset to stage for triage."),
				tags: z.array(z.string()).optional().describe("Flat tags, no hierarchy."),
				surface: z.enum(["chat", "cowork", "code", "gemini"]).describe("Where this memory originated."),
				session_id: z.string().optional().describe("Session identifier on that surface."),
			},
			async (params) => {
				const result = await writeMemory(db, params);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);

		this.server.tool(
			"memory_search",
			"Search memory entries by keyword and optional filters. Plain SQL filtering, no semantic search.",
			{
				query: z.string().describe("Substring to match against content."),
				tags: z.string().optional().describe("Substring to match against stored tags."),
				surface: z.enum(["chat", "cowork", "code", "gemini"]).optional(),
				status: z.enum(["active", "staged", "archived"]).optional(),
			},
			async (params) => {
				const results = await searchMemories(db, params);
				return { content: [{ type: "text", text: JSON.stringify(results) }] };
			},
		);

		this.server.tool("memory_get", "Fetch a single memory entry by id.", { id: z.string() }, async ({ id }) => {
			const row = await getMemory(db, id);
			return { content: [{ type: "text", text: JSON.stringify(row) }] };
		});

		this.server.tool(
			"memory_list_staged",
			"List memory entries awaiting triage (written without a category).",
			{},
			async () => {
				const results = await listStaged(db);
				return { content: [{ type: "text", text: JSON.stringify(results) }] };
			},
		);

		this.server.tool(
			"memory_update",
			"Edit an existing entry's content, tags, or surface. Does not touch category/status — use memory_triage for that.",
			{
				id: z.string(),
				content: z.string().optional(),
				tags: z.array(z.string()).optional().describe("Replaces the existing tag list entirely."),
				surface: z.enum(["chat", "cowork", "code", "gemini"]).optional(),
			},
			async (params) => {
				const result = await updateMemory(db, params);
				if (!result.ok) {
					return { content: [{ type: "text", text: result.error }], isError: true };
				}
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);

		this.server.tool(
			"memory_delete",
			"Permanently delete an entry. This is a hard delete, not archiving — use memory_triage with discard for a reversible removal instead.",
			{ id: z.string() },
			async ({ id }) => {
				const result = await deleteMemory(db, id);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					isError: !result.deleted,
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
			async (params) => {
				const result = await triageMemory(db, params);
				if (!result.ok) {
					return { content: [{ type: "text", text: result.error }], isError: true };
				}
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);
	}
}

export default new OAuthProvider({
	apiHandler: MemoryBridgeMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
