-- 0004_cards.sql: Phase 3 — 知识卡片 + 编辑 + Chat 会话
-- 设计：
--   - notes 加 parent_id（knowledge 卡指向主卡）
--   - notes 加 card_type：'main' | 'knowledge' | 'summary'（兼容旧 is_summary）
--   - notes 加 updated_at（编辑功能用）
--   - chats 新表：记录与主卡关联的完整对话上下文

ALTER TABLE notes ADD COLUMN parent_id TEXT;
ALTER TABLE notes ADD COLUMN card_type TEXT NOT NULL DEFAULT 'main';
ALTER TABLE notes ADD COLUMN updated_at TEXT;

-- 回填旧 summary 卡
UPDATE notes SET card_type = 'summary' WHERE is_summary = 1;

CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_card_type ON notes(card_type);

-- Chat 会话（P3.4/P3.5 使用；提前建表避免二次迁移）
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  parent_note_id TEXT NOT NULL,
  messages TEXT NOT NULL,      -- JSON: [{role, content, ts}]
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats(parent_note_id);
