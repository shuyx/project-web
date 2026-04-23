import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/api/*', cors());

// ============================================================
// Auth helpers (Web Crypto)
// ============================================================

function b64encode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return b64encode(new Uint8Array(bits));
}

function generateSalt() {
  return b64encode(crypto.getRandomValues(new Uint8Array(16)));
}

async function signToken(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const body = b64encode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return body + '.' + b64encode(new Uint8Array(sig));
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const [body, sigB64] = token.split('.');
  if (!body || !sigB64) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  try {
    const sig = b64decode(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64decode(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function getAuthSecret(env) {
  // Secret 通过 wrangler secret put AUTH_SECRET 配；本地开发 fallback 防崩
  return env.AUTH_SECRET || 'local-dev-secret-do-not-use-in-prod';
}

function isAdminName(name, env) {
  const list = (env.ADMIN_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(name);
}

function bearerFrom(req) {
  const h = req.header('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Middleware: require valid token on all /api/* except /api/login
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();
  const token = bearerFrom(c.req);
  const payload = await verifyToken(token, getAuthSecret(c.env));
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', payload);
  await next();
});

// ============================================================
// Auth endpoints
// ============================================================

// POST /api/login  { name, password }
// - If user exists: verify password; on success return token
// - If user doesn't exist: register with given password (first-come-first-serve)
app.post('/api/login', async (c) => {
  const { name, password } = await c.req.json().catch(() => ({}));
  if (!name || !password) return c.json({ error: 'name and password required' }, 400);
  if (name.length > 40 || password.length < 4) {
    return c.json({ error: 'name too long or password too short (min 4 chars)' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE name = ?')
    .bind(name).first();

  const admin = isAdminName(name, c.env);

  if (user) {
    // Existing user — verify password
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      return c.json({ error: 'invalid password' }, 401);
    }
    // Sync admin flag (in case ADMIN_NAMES changed)
    const isAdmin = admin ? 1 : 0;
    if (user.is_admin !== isAdmin) {
      await c.env.DB.prepare('UPDATE users SET is_admin = ? WHERE name = ?')
        .bind(isAdmin, name).run();
    }
    const token = await signToken(
      { name, is_admin: !!admin, exp: Date.now() + 30 * 24 * 3600 * 1000 },
      getAuthSecret(c.env)
    );
    return c.json({ name, is_admin: !!admin, token });
  }

  // First-time — auto register
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const created_at = new Date().toISOString();
  await c.env.DB.prepare(
    'INSERT INTO users (name, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, hash, salt, admin ? 1 : 0, created_at).run();

  const token = await signToken(
    { name, is_admin: !!admin, exp: Date.now() + 30 * 24 * 3600 * 1000 },
    getAuthSecret(c.env)
  );
  return c.json({ name, is_admin: !!admin, token, registered: true });
});

// GET /api/me — verify token + return identity
app.get('/api/me', (c) => {
  const u = c.get('user');
  return c.json({ name: u.name, is_admin: !!u.is_admin });
});

// ============================================================
// Config
// ============================================================

app.get('/api/config', async (c) => {
  const projects = await c.env.DB.prepare(
    'SELECT * FROM projects ORDER BY sort_order ASC'
  ).all();
  const people = await c.env.DB.prepare(
    'SELECT * FROM people ORDER BY name ASC'
  ).all();
  const u = c.get('user');
  return c.json({
    projects: projects.results,
    people: people.results,
    me: { name: u.name, is_admin: !!u.is_admin },
  });
});

// ============================================================
// Notes
// ============================================================

app.get('/api/notes', async (c) => {
  const project = c.req.query('project');
  const before = c.req.query('before');
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100);

  let sql, binds;
  if (project && project !== 'all') {
    if (before) {
      sql = 'SELECT * FROM notes WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, before, limit];
    } else {
      sql = 'SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, limit];
    }
  } else {
    if (before) {
      sql = 'SELECT * FROM notes WHERE created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [before, limit];
    } else {
      sql = 'SELECT * FROM notes ORDER BY created_at DESC LIMIT ?';
      binds = [limit];
    }
  }

  const result = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ notes: result.results, hasMore: result.results.length === limit });
});

app.post('/api/notes', async (c) => {
  const body = await c.req.json();
  const { project_id, content, is_summary } = body;
  const u = c.get('user');

  if (!project_id || !content) {
    return c.json({ error: 'missing fields' }, 400);
  }

  // author_emoji from body (client side computed); fallback to a default
  const author_emoji = body.author_emoji || '👤';
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO notes (id, author_name, author_emoji, project_id, content, created_at, is_summary) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, u.name, author_emoji, project_id, content, created_at, is_summary ? 1 : 0).run();

  return c.json({
    id, author_name: u.name, author_emoji, project_id, content, created_at,
    is_summary: is_summary ? 1 : 0,
  });
});

app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const u = c.get('user');

  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?')
    .bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);

  // Admin can delete anything; regular user only own
  if (!u.is_admin && note.author_name !== u.name) {
    return c.json({ error: 'forbidden' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ============================================================
// People dict
// ============================================================

app.post('/api/people', async (c) => {
  const { name, color, aliases } = await c.req.json();
  if (!name || !color) return c.json({ error: 'missing fields' }, 400);
  const created_at = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      'INSERT INTO people (name, color, aliases, created_at) VALUES (?, ?, ?, ?)'
    ).bind(name, color, aliases || null, created_at).run();
    return c.json({ name, color, aliases: aliases || null, created_at });
  } catch {
    return c.json({ error: 'already exists' }, 409);
  }
});

app.put('/api/people/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { color, aliases } = await c.req.json();
  await c.env.DB.prepare(
    'UPDATE people SET color = COALESCE(?, color), aliases = COALESCE(?, aliases) WHERE name = ?'
  ).bind(color, aliases, name).run();
  return c.json({ success: true });
});

app.delete('/api/people/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  await c.env.DB.prepare('DELETE FROM people WHERE name = ?').bind(name).run();
  return c.json({ success: true });
});

// ============================================================
// Projects
// ============================================================

app.post('/api/projects', async (c) => {
  const { id, name, emoji } = await c.req.json();
  if (!id || !name) return c.json({ error: 'missing fields' }, 400);
  const created_at = new Date().toISOString();
  const maxOrder = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM projects'
  ).first();
  const nextOrder = (maxOrder?.m || 0) + 1;
  try {
    await c.env.DB.prepare(
      'INSERT INTO projects (id, name, emoji, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, name, emoji || null, nextOrder, created_at).run();
    return c.json({ id, name, emoji, sort_order: nextOrder, created_at });
  } catch {
    return c.json({ error: 'already exists' }, 409);
  }
});

app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ============================================================
// LLM summarize (Phase 2 — stub; wire up once MINIMAX_API_KEY is set)
// ============================================================

app.post('/api/summarize', async (c) => {
  const apiKey = c.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'LLM 未配置：管理员需要设置 MINIMAX_API_KEY' }, 503);
  }

  const { timeRange = '7d', project = 'all' } = await c.req.json().catch(() => ({}));
  const days = timeRange === '30d' ? 30 : timeRange === 'all' ? 3650 : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  let sql, binds;
  if (project === 'all') {
    sql = 'SELECT * FROM notes WHERE created_at >= ? AND is_summary = 0 ORDER BY created_at ASC LIMIT 500';
    binds = [cutoff];
  } else {
    sql = 'SELECT * FROM notes WHERE created_at >= ? AND project_id = ? AND is_summary = 0 ORDER BY created_at ASC LIMIT 500';
    binds = [cutoff, project];
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  if (!results.length) {
    return c.json({ error: '所选范围内没有数据' }, 400);
  }

  const lines = results.map(n =>
    `[${n.created_at.slice(0, 10)} ${n.author_name}] ${n.content}`
  ).join('\n');

  const prompt = `你是一个项目进展整理助手。以下是「${project === 'all' ? '全部项目' : project}」近 ${days} 天的团队动态记录，按时间顺序排列。请输出结构化摘要，包含：

1. **关键进展**（3-5 条，含具体数字和人物）
2. **待办和风险**（从未完成事项中识别）
3. **关键人物动态**（谁做了什么重要的事）

要求：用中文，直接输出摘要 Markdown，不要说"好的我来整理"之类的开场白。保留原文里的数字和专有名词。

---
原始记录：
${lines}`;

  const baseUrl = c.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1/text/chatcompletion_v2';
  const model = c.env.MINIMAX_MODEL || 'MiniMax-Text-01';

  try {
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json({ error: `LLM API 失败: ${resp.status} ${errText.slice(0, 200)}` }, 502);
    }

    const data = await resp.json();
    const summary = data.choices?.[0]?.message?.content || '(空返回)';

    return c.json({
      summary,
      meta: { days, project, noteCount: results.length, model },
    });
  } catch (e) {
    return c.json({ error: 'LLM 调用异常: ' + e.message }, 502);
  }
});

// ============================================================
// Static fallback
// ============================================================

app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
