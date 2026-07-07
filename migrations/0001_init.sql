CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  status TEXT NOT NULL,
  surface TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memories_status ON memories (status);
CREATE INDEX idx_memories_surface ON memories (surface);
