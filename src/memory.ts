export type MemoryRow = {
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

export type Surface = "chat" | "cowork" | "code";
export type Status = "active" | "staged" | "archived";

export async function writeMemory(
	db: D1Database,
	params: { content: string; category?: string; tags?: string[]; surface: Surface; session_id?: string },
): Promise<{ id: string; status: Status }> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const status: Status = params.category ? "active" : "staged";
	await db
		.prepare(
			`INSERT INTO memories (id, content, category, tags, status, surface, session_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			params.content,
			params.category ?? null,
			params.tags?.join(",") ?? null,
			status,
			params.surface,
			params.session_id ?? null,
			now,
			now,
		)
		.run();
	return { id, status };
}

export async function searchMemories(
	db: D1Database,
	params: { query: string; tags?: string; surface?: Surface; status?: Status },
): Promise<MemoryRow[]> {
	let sql = "SELECT * FROM memories WHERE content LIKE ?";
	const sqlParams: unknown[] = [`%${params.query}%`];
	if (params.tags) {
		sql += " AND tags LIKE ?";
		sqlParams.push(`%${params.tags}%`);
	}
	if (params.surface) {
		sql += " AND surface = ?";
		sqlParams.push(params.surface);
	}
	if (params.status) {
		sql += " AND status = ?";
		sqlParams.push(params.status);
	}
	sql += " ORDER BY created_at DESC LIMIT 50";
	const { results } = await db
		.prepare(sql)
		.bind(...sqlParams)
		.all<MemoryRow>();
	return results;
}

export async function getMemory(db: D1Database, id: string): Promise<MemoryRow | null> {
	const row = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<MemoryRow>();
	return row ?? null;
}

export async function listStaged(db: D1Database): Promise<MemoryRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM memories WHERE status = 'staged' ORDER BY created_at ASC")
		.all<MemoryRow>();
	return results;
}

export type UpdateResult = { ok: true; id: string; updated_at: string } | { ok: false; error: string };

export async function updateMemory(
	db: D1Database,
	params: { id: string; content?: string; tags?: string[]; surface?: Surface },
): Promise<UpdateResult> {
	if (params.content === undefined && params.tags === undefined && params.surface === undefined) {
		return { ok: false, error: "Provide at least one of content, tags, or surface." };
	}
	const existing = await db.prepare("SELECT id FROM memories WHERE id = ?").bind(params.id).first();
	if (!existing) {
		return { ok: false, error: `No entry with id ${params.id}.` };
	}
	const sets: string[] = [];
	const sqlParams: unknown[] = [];
	if (params.content !== undefined) {
		sets.push("content = ?");
		sqlParams.push(params.content);
	}
	if (params.tags !== undefined) {
		sets.push("tags = ?");
		sqlParams.push(params.tags.join(","));
	}
	if (params.surface !== undefined) {
		sets.push("surface = ?");
		sqlParams.push(params.surface);
	}
	const now = new Date().toISOString();
	sets.push("updated_at = ?");
	sqlParams.push(now);
	sqlParams.push(params.id);
	await db
		.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...sqlParams)
		.run();
	return { ok: true, id: params.id, updated_at: now };
}

export async function deleteMemory(db: D1Database, id: string): Promise<{ id: string; deleted: boolean }> {
	const result = await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
	return { id, deleted: (result.meta?.changes ?? 0) > 0 };
}

export type TriageResult =
	| { ok: true; id: string; status: "archived" }
	| { ok: true; id: string; status: "active"; category: string }
	| { ok: false; error: string };

export async function triageMemory(
	db: D1Database,
	params: { id: string; category?: string; discard?: boolean },
): Promise<TriageResult> {
	const now = new Date().toISOString();
	if (params.discard) {
		await db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").bind(now, params.id).run();
		return { ok: true, id: params.id, status: "archived" };
	}
	if (!params.category) {
		return { ok: false, error: "Provide either category or discard: true." };
	}
	await db
		.prepare("UPDATE memories SET category = ?, status = 'active', updated_at = ? WHERE id = ?")
		.bind(params.category, now, params.id)
		.run();
	return { ok: true, id: params.id, status: "active", category: params.category };
}
