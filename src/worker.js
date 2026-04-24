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

  // Only fetch top-level cards (main + summary); knowledge cards attached as children
  let sql, binds;
  if (project && project !== 'all') {
    if (before) {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, before, limit];
    } else {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, limit];
    }
  } else {
    if (before) {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [before, limit];
    } else {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL ORDER BY created_at DESC LIMIT ?';
      binds = [limit];
    }
  }

  const result = await c.env.DB.prepare(sql).bind(...binds).all();
  const notes = result.results || [];

  // Attach children (knowledge cards) to each main note
  if (notes.length) {
    const ids = notes.map(n => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const childRes = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();
    const byParent = {};
    for (const child of (childRes.results || [])) {
      (byParent[child.parent_id] = byParent[child.parent_id] || []).push(child);
    }
    for (const n of notes) {
      n.children = byParent[n.id] || [];
    }
  }

  return c.json({ notes, hasMore: notes.length === limit });
});

app.post('/api/notes', async (c) => {
  const body = await c.req.json();
  const { project_id: rawProjectId, content, is_summary, parent_id, card_type: rawCardType } = body;
  const u = c.get('user');

  if (!content) return c.json({ error: 'content required' }, 400);

  // Resolve card_type and validate parent
  let card_type = rawCardType || (is_summary ? 'summary' : (parent_id ? 'knowledge' : 'main'));
  if (!['main', 'knowledge', 'summary'].includes(card_type)) {
    return c.json({ error: 'invalid card_type' }, 400);
  }

  let project_id = rawProjectId;
  let parentIdFinal = null;
  if (card_type === 'knowledge') {
    if (!parent_id) return c.json({ error: 'knowledge card requires parent_id' }, 400);
    const parent = await c.env.DB.prepare('SELECT project_id, parent_id FROM notes WHERE id = ?')
      .bind(parent_id).first();
    if (!parent) return c.json({ error: 'parent note not found' }, 404);
    if (parent.parent_id) return c.json({ error: 'cannot nest knowledge cards' }, 400);
    project_id = parent.project_id; // inherit
    parentIdFinal = parent_id;
  } else {
    if (!project_id) return c.json({ error: 'project_id required' }, 400);
  }

  const author_emoji = body.author_emoji || '👤';
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const is_summary_val = card_type === 'summary' ? 1 : 0;

  await c.env.DB.prepare(
    'INSERT INTO notes (id, author_name, author_emoji, project_id, content, created_at, is_summary, parent_id, card_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, u.name, author_emoji, project_id, content, created_at, is_summary_val, parentIdFinal, card_type).run();

  return c.json({
    id, author_name: u.name, author_emoji, project_id, content, created_at,
    is_summary: is_summary_val, parent_id: parentIdFinal, card_type,
  });
});

// PUT /api/notes/:id — edit content (author or admin only)
app.put('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const { content } = await c.req.json().catch(() => ({}));
  const u = c.get('user');

  if (!content || !content.trim()) return c.json({ error: 'content required' }, 400);

  const note = await c.env.DB.prepare('SELECT author_name FROM notes WHERE id = ?')
    .bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (!u.is_admin && note.author_name !== u.name) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const updated_at = new Date().toISOString();
  await c.env.DB.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
    .bind(content, updated_at, id).run();

  return c.json({ id, content, updated_at });
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

  // Cascade: if deleting a main card, also drop its knowledge cards + chats
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM notes WHERE id = ? OR parent_id = ?').bind(id, id),
    c.env.DB.prepare('DELETE FROM chats WHERE parent_note_id = ?').bind(id),
  ]);
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
// AI correction — lightweight proofread with people/project dictionary
// ============================================================

async function callMinimax(c, { messages, system, user, temperature = 0.3, max_tokens = 1200 }) {
  const apiKey = c.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('LLM 未配置：管理员需要设置 MINIMAX_API_KEY');
  const baseUrl = c.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
  const model = c.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';
  let msgs = messages;
  if (!msgs) {
    msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push({ role: 'user', content: user });
  }
  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, temperature, max_tokens }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API 失败: ${resp.status} ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

app.post('/api/ai/correct', async (c) => {
  const { text } = await c.req.json().catch(() => ({}));
  if (!text || !text.trim()) return c.json({ error: 'text required' }, 400);
  if (text.length > 2000) return c.json({ error: '文本过长（>2000 字）' }, 400);

  const people = await c.env.DB.prepare('SELECT name, aliases FROM people').all();
  const projects = await c.env.DB.prepare('SELECT name FROM projects').all();

  const personNames = [];
  for (const p of (people.results || [])) {
    personNames.push(p.name);
    if (p.aliases) {
      try {
        const arr = JSON.parse(p.aliases);
        if (Array.isArray(arr)) personNames.push(...arr);
      } catch {}
    }
  }
  const projectNames = (projects.results || []).map(p => p.name);

  const dictLine = personNames.length
    ? `关键人物姓名（请严格按这些字形匹配纠正拼写/同音错字）：${personNames.join('、')}`
    : '（无人物字典）';
  const projLine = projectNames.length ? `项目名：${projectNames.join('、')}` : '';

  const system = '你是中文文本纠错助手。只做拼写/错别字/姓名修正，不改写句子，不加解释。';
  const user = `请对下面这段项目进展记录做最小改动的拼写与姓名纠错：

${dictLine}
${projLine}

规则：
1. 仅修正错别字、同音错字、姓名字形错误
2. 不改变句子结构、语气、标点风格
3. 不新增或删除内容
4. 数字、日期、金额、百分比、单位保持原样
5. 如原文无需修改，原样返回
6. 只输出修正后的文本，不要加前缀、后缀、解释、markdown、引号

原文：
${text}`;

  try {
    const raw = await callMinimax(c, { system, user, temperature: 0.1, max_tokens: 1500 });
    let corrected = String(raw || '').trim();
    // Strip common wrapping: leading "修正后：" / surrounding quotes / code fences
    corrected = corrected.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    corrected = corrected.replace(/^(修正后[:：]|纠正后[:：]|结果[:：])\s*/i, '');
    corrected = corrected.replace(/^["“'']|["”'']$/g, '');
    const changed = corrected && corrected !== text.trim();
    return c.json({ corrected: corrected || text, changed });
  } catch (e) {
    return c.json({ error: e.message || 'LLM 调用异常' }, 502);
  }
});

// ============================================================
// Chat — multi-turn conversation anchored to a main note
// ============================================================

// GET /api/chat/:parent_note_id  — load latest saved conversation
app.get('/api/chat/:parent_note_id', async (c) => {
  const pid = c.req.param('parent_note_id');
  const row = await c.env.DB.prepare(
    'SELECT id, messages, created_at FROM chats WHERE parent_note_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(pid).first();
  if (!row) return c.json({ messages: [], chat_id: null });
  try {
    const msgs = JSON.parse(row.messages);
    return c.json({ messages: Array.isArray(msgs) ? msgs : [], chat_id: row.id });
  } catch {
    return c.json({ messages: [], chat_id: row.id });
  }
});

// POST /api/chat  — send message, get reply, persist updated history
app.post('/api/chat', async (c) => {
  const { parent_note_id, message, history = [] } = await c.req.json().catch(() => ({}));
  const u = c.get('user');

  if (!parent_note_id || !message || !message.trim()) {
    return c.json({ error: 'parent_note_id and message required' }, 400);
  }
  if (message.length > 2000) return c.json({ error: '消息过长（>2000 字）' }, 400);
  if (!Array.isArray(history)) return c.json({ error: 'history must be array' }, 400);

  // Load parent + children + recent project notes for context
  const parent = await c.env.DB.prepare(
    'SELECT id, author_name, content, project_id, created_at FROM notes WHERE id = ? AND parent_id IS NULL'
  ).bind(parent_note_id).first();
  if (!parent) return c.json({ error: 'parent note not found' }, 404);

  const childRes = await c.env.DB.prepare(
    'SELECT content FROM notes WHERE parent_id = ? ORDER BY created_at ASC'
  ).bind(parent_note_id).all();

  const recentRes = await c.env.DB.prepare(
    'SELECT author_name, content, created_at FROM notes WHERE project_id = ? AND parent_id IS NULL AND id != ? ORDER BY created_at DESC LIMIT 5'
  ).bind(parent.project_id, parent_note_id).all();

  const ctxLines = [
    `【当前主卡】${parent.author_name}（${parent.created_at.slice(0, 10)}）：${parent.content}`,
  ];
  for (const k of (childRes.results || [])) {
    ctxLines.push(`【已有知识卡】${k.content}`);
  }
  if (recentRes.results && recentRes.results.length) {
    ctxLines.push('\n【该项目近期进展（仅参考）】');
    for (const r of recentRes.results) {
      ctxLines.push(`- ${r.created_at.slice(0, 10)} ${r.author_name}：${r.content}`);
    }
  }

  const system = `你是项目协作助手，基于团队提供的进展记录回答用户问题。
规则：
1. 优先基于下面给到的上下文，不编造具体姓名、数字、金额
2. 回答简洁专业，用中文
3. 如上下文不足以判断，直说"基于当前信息无法判断"，然后给出通用建议
4. 不要加"好的我来"这类开场白

上下文：
${ctxLines.join('\n')}`;

  // Cap history to last 20 turns to control token usage
  const prior = history.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  const llmMessages = [
    { role: 'system', content: system },
    ...prior,
    { role: 'user', content: message },
  ];

  try {
    const reply = await callMinimax(c, { messages: llmMessages, temperature: 0.5, max_tokens: 1500 });
    const now = Date.now();
    const fullHistory = [
      ...history,
      { role: 'user', content: message, ts: now },
      { role: 'assistant', content: reply, ts: now + 1 },
    ];

    const existing = await c.env.DB.prepare(
      'SELECT id FROM chats WHERE parent_note_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(parent_note_id).first();
    if (existing) {
      await c.env.DB.prepare('UPDATE chats SET messages = ? WHERE id = ?')
        .bind(JSON.stringify(fullHistory), existing.id).run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO chats (id, parent_note_id, messages, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), parent_note_id, JSON.stringify(fullHistory), u.name, new Date().toISOString()).run();
    }

    return c.json({ reply, messages: fullHistory });
  } catch (e) {
    return c.json({ error: e.message || 'LLM 异常' }, 502);
  }
});

// ============================================================
// LLM summarize (Phase 2 — stub; wire up once MINIMAX_API_KEY is set)
// ============================================================

app.post('/api/summarize', async (c) => {
  const { timeRange = '7d', project = 'all', include_knowledge = false } =
    await c.req.json().catch(() => ({}));
  const days = timeRange === '30d' ? 30 : timeRange === 'all' ? 3650 : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Base filter: skip summary cards always; skip knowledge cards unless opted-in
  const extra = include_knowledge ? "card_type != 'summary'" : "card_type = 'main'";

  let sql, binds;
  if (project === 'all') {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND ${extra} ORDER BY created_at ASC LIMIT 500`;
    binds = [cutoff];
  } else {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND project_id = ? AND ${extra} ORDER BY created_at ASC LIMIT 500`;
    binds = [cutoff, project];
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  if (!results.length) {
    return c.json({ error: '所选范围内没有数据' }, 400);
  }

  const lines = results.map(n => {
    const tag = n.card_type === 'knowledge' ? '[知识卡]' : '';
    return `[${n.created_at.slice(0, 10)} ${n.author_name}] ${tag}${n.content}`;
  }).join('\n');

  const prompt = `你是一个项目进展整理助手。以下是「${project === 'all' ? '全部项目' : project}」近 ${days} 天的团队动态记录，按时间顺序排列。请输出结构化摘要，包含：

1. **关键进展**（3-5 条，含具体数字和人物）
2. **待办和风险**（从未完成事项中识别）
3. **关键人物动态**（谁做了什么重要的事）

要求：用中文，直接输出摘要 Markdown，不要说"好的我来整理"之类的开场白。保留原文里的数字和专有名词。${include_knowledge ? '\n标记 [知识卡] 的条目是 AI 问答沉淀，可作为补充参考。' : ''}

---
原始记录：
${lines}`;

  try {
    const summary = await callMinimax(c, {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1500,
    });
    return c.json({
      summary: summary || '(空返回)',
      meta: { days, project, noteCount: results.length, include_knowledge },
    });
  } catch (e) {
    const msg = e.message || 'LLM 调用异常';
    const isConfig = msg.includes('LLM 未配置');
    return c.json({ error: msg }, isConfig ? 503 : 502);
  }
});

// ============================================================
// Static fallback
// ============================================================

app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
