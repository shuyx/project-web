-- 0001_init.sql: 初始化表结构
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  author_name TEXT NOT NULL,
  author_emoji TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_summary INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_feed ON notes(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_time ON notes(created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  name TEXT PRIMARY KEY,
  color TEXT NOT NULL,
  aliases TEXT,
  created_at TEXT NOT NULL
);
