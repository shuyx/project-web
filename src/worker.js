import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/api/*', cors());

// ===== Config =====
app.get('/api/config', async (c) => {
  const projects = await c.env.DB.prepare(
    'SELECT * FROM projects ORDER BY sort_order ASC'
  ).all();
  const people = await c.env.DB.prepare(
    'SELECT * FROM people ORDER BY name ASC'
  ).all();
  return c.json({
    projects: projects.results,
    people: people.results,
  });
});

// ===== Notes: list =====
app.get('/api/notes', async (c) => {
  const project = c.req.query('project');
  const before = c.req.query('before');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

  let sql;
  let binds;
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
  return c.json({ notes: result.results });
});

// ===== Notes: create =====
app.post('/api/notes', async (c) => {
  const body = await c.req.json();
  const { author_name, author_emoji, project_id, content, is_summary } = body;

  if (!author_name || !author_emoji || !project_id || !content) {
    return c.json({ error: 'missing fields' }, 400);
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO notes (id, author_name, author_emoji, project_id, content, created_at, is_summary) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    id,
    author_name,
    author_emoji,
    project_id,
    content,
    created_at,
    is_summary ? 1 : 0
  ).run();

  return c.json({
    id,
    author_name,
    author_emoji,
    project_id,
    content,
    created_at,
    is_summary: is_summary ? 1 : 0,
  });
});

// ===== Notes: delete (only own) =====
app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const rawAuthor = c.req.header('X-Author-Name');
  // Header may be URL-encoded (client side encodes Chinese/Unicode names)
  let authorName = rawAuthor;
  if (rawAuthor) {
    try { authorName = decodeURIComponent(rawAuthor); } catch { /* use raw */ }
  }

  if (!authorName) {
    return c.json({ error: 'missing author header' }, 400);
  }

  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?')
    .bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.author_name !== authorName) {
    return c.json({ error: 'forbidden' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ===== People: add =====
app.post('/api/people', async (c) => {
  const { name, color, aliases } = await c.req.json();
  if (!name || !color) return c.json({ error: 'missing fields' }, 400);
  const created_at = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      'INSERT INTO people (name, color, aliases, created_at) VALUES (?, ?, ?, ?)'
    ).bind(name, color, aliases || null, created_at).run();
    return c.json({ name, color, aliases: aliases || null, created_at });
  } catch (e) {
    return c.json({ error: 'already exists' }, 409);
  }
});

// ===== People: update =====
app.put('/api/people/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { color, aliases } = await c.req.json();
  await c.env.DB.prepare(
    'UPDATE people SET color = COALESCE(?, color), aliases = COALESCE(?, aliases) WHERE name = ?'
  ).bind(color, aliases, name).run();
  return c.json({ success: true });
});

// ===== People: delete =====
app.delete('/api/people/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  await c.env.DB.prepare('DELETE FROM people WHERE name = ?').bind(name).run();
  return c.json({ success: true });
});

// ===== Projects: add =====
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
  } catch (e) {
    return c.json({ error: 'already exists' }, 409);
  }
});

// ===== Projects: delete =====
app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ===== Static assets fallback =====
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
