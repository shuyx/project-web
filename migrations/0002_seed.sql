-- 0002_seed.sql: 种子数据（两个初始项目）
INSERT OR IGNORE INTO projects (id, name, emoji, sort_order, created_at) VALUES
  ('bci', 'BCI', '🧠', 1, datetime('now')),
  ('holdings', '控股平台', '🏢', 2, datetime('now'));
