-- 0003_users.sql: 用户表（注册 + 登录）
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin);
