// ============================================================
// teamfeed app.js — v3.0 · 登录系统 + 无限滚动 + LLM 整理
// ============================================================

// ---------- Emoji pool & hashing ----------
const EMOJI_POOL = [
  '🦊', '🐯', '🦁', '🐻', '🐼', '🐨', '🐶', '🐱', '🦖', '🦄',
  '🐸', '🐵', '🦉', '🐧', '🐢', '🦋', '🌸', '🌈', '⭐', '🍀',
  '🔥', '💎', '🍊', '🍇', '🌊', '🌙', '☘️', '🌼', '🎯', '🎨'
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function emojiForName(name, offset = 0) {
  const h = hashName(String(name || 'x'));
  return EMOJI_POOL[(h + offset) % EMOJI_POOL.length];
}

// ---------- State ----------
const state = {
  auth: null, // { name, emoji, is_admin, token }
  projects: [],
  people: [],
  currentTab: 'all',
  notes: [],
  hasMore: false,
  loading: false,
};

// ---------- LocalStorage ----------
const LS_KEY = 'teamfeed.auth';

function loadAuth() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveAuth(auth) {
  localStorage.setItem(LS_KEY, JSON.stringify(auth));
}

function clearAuth() {
  localStorage.removeItem(LS_KEY);
  state.auth = null;
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.auth?.token) headers['Authorization'] = 'Bearer ' + state.auth.token;
  const resp = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (resp.status === 401 && state.auth) {
    // token expired / invalid — force re-login
    clearAuth();
    showLogin();
    throw new Error('登录已过期，请重新登录');
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json();
}

async function login(name, password) {
  const resp = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '登录失败');
  return data; // { name, is_admin, token, registered? }
}

async function loadConfig() {
  const data = await api('/api/config');
  state.projects = data.projects || [];
  state.people = data.people || [];
  if (data.me) {
    // Sync is_admin from server (in case ADMIN_NAMES changed)
    state.auth = { ...state.auth, is_admin: !!data.me.is_admin };
    saveAuth(state.auth);
  }
}

async function loadFeed(append = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams();
    if (state.currentTab !== 'all') params.set('project', state.currentTab);
    params.set('limit', '30');
    if (append && state.notes.length > 0) {
      params.set('before', state.notes[state.notes.length - 1].created_at);
    }
    const data = await api('/api/notes?' + params.toString());
    state.notes = append ? [...state.notes, ...(data.notes || [])] : (data.notes || []);
    state.hasMore = !!data.hasMore;
  } finally {
    state.loading = false;
  }
}

async function postNote(project_id, content) {
  return api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({
      project_id,
      content,
      author_emoji: state.auth.emoji,
    }),
  });
}

async function deleteNote(id) {
  return api(`/api/notes/${id}`, { method: 'DELETE' });
}

async function summarize(timeRange, project) {
  return api('/api/summarize', {
    method: 'POST',
    body: JSON.stringify({ timeRange, project }),
  });
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function $(id) { return document.getElementById(id); }

// ---------- Login ----------
function showLogin() {
  const modal = $('login-modal');
  const app = $('app');
  if (modal) modal.hidden = false;
  if (app) app.hidden = true;
  setTimeout(() => $('login-name')?.focus(), 100);
  updateLoginEmoji();
}

function updateLoginEmoji() {
  const name = $('login-name')?.value.trim() || '';
  const el = $('login-emoji');
  if (el) el.textContent = emojiForName(name || 'x');
}

function setupLogin() {
  const nameInput = $('login-name');
  const passInput = $('login-password');
  const submit = $('login-submit');

  nameInput?.addEventListener('input', updateLoginEmoji);
  nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput?.focus(); });
  passInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
  submit?.addEventListener('click', submitLogin);
}

async function submitLogin() {
  const name = $('login-name')?.value.trim();
  const password = $('login-password')?.value;
  if (!name) { toast('请输入名字', true); return; }
  if (!password || password.length < 4) { toast('密码至少 4 位', true); return; }

  const submit = $('login-submit');
  if (submit) submit.disabled = true;

  try {
    const data = await login(name, password);
    state.auth = {
      name: data.name,
      emoji: emojiForName(data.name),
      is_admin: !!data.is_admin,
      token: data.token,
    };
    saveAuth(state.auth);
    const modal = $('login-modal');
    if (modal) modal.hidden = true;
    if (data.registered) toast('欢迎，已创建账号');
    else toast('登录成功');
    initApp();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

function logout() {
  clearAuth();
  state.notes = [];
  state.projects = [];
  state.people = [];
  location.reload();
}

// ---------- Tabs ----------
function renderTabs() {
  const el = $('project-tabs');
  if (!el) return;
  const items = [{ id: 'all', name: '全部', emoji: '' }, ...state.projects];
  el.innerHTML = items.map(p => {
    const active = p.id === state.currentTab ? ' active' : '';
    const label = (p.emoji ? p.emoji + ' ' : '') + escapeHtml(p.name);
    return `<button class="tab${active}" role="tab" data-id="${escapeHtml(p.id)}">${label}</button>`;
  }).join('');
  el.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.currentTab = btn.dataset.id;
      renderTabs();
      await refresh();
    });
  });
}

// ---------- Feed ----------
function formatDateLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  const td = ymd(now);
  const yd = ymd(new Date(Date.now() - 86400000));
  const dmd = ymd(d);
  if (dmd === td) return '今天';
  if (dmd === yd) return '昨天';
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatCardDateTime(iso) {
  const d = new Date(iso);
  const time = formatTime(iso);
  const now = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  const td = ymd(now);
  const yd = ymd(new Date(Date.now() - 86400000));
  const dmd = ymd(d);
  if (dmd === td) return `今天 · ${time}`;
  if (dmd === yd) return `昨天 · ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${datePart} · ${time}`;
}

function groupNotesByDate(notes) {
  const groups = [];
  let cur = null;
  for (const n of notes) {
    const label = formatDateLabel(n.created_at);
    if (!cur || cur.label !== label) {
      cur = { label, notes: [] };
      groups.push(cur);
    }
    cur.notes.push(n);
  }
  return groups;
}

function highlightContent(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/¥[\d,]+(?:\.\d+)?/g, m => `<span class="hl-money">${m}</span>`);
  html = html.replace(/\d+(?:\.\d+)?(?:kg|千克|克|吨|mm|cm|m|km|元|万|亿|个|条|份)/gi, m => `<span class="hl-unit">${m}</span>`);
  html = html.replace(/\d+(?:\.\d+)?%/g, m => `<span class="hl-percent">${m}</span>`);
  html = html.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\b\d{1,2}[-/]\d{1,2}\b/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\d{1,2}月\d{1,2}日/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\b\d{1,2}:\d{2}\b/g, m => `<span class="hl-time">${m}</span>`);

  for (const p of state.people) {
    let names = [p.name];
    try {
      if (p.aliases) {
        const arr = JSON.parse(p.aliases);
        if (Array.isArray(arr)) names = names.concat(arr);
      }
    } catch { /* ignore */ }
    for (const n of names) {
      if (!n) continue;
      const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${esc})(?![^<]*>)`, 'g');
      html = html.replace(re, `<span class="hl-person" style="color:${escapeHtml(p.color)}">$1</span>`);
    }
  }

  return html;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <div class="big">📝</div>
      <p><strong>还没有内容</strong></p>
      <p class="muted small">在下方写点什么开始吧</p>
    </div>
  `;
}

function renderFeed() {
  const el = $('feed');
  if (!el) return;

  if (!state.notes.length) {
    el.innerHTML = renderEmpty();
    return;
  }

  const groups = groupNotesByDate(state.notes);
  const projectMap = Object.fromEntries(state.projects.map(p => [p.id, p]));
  const showProjectBadge = state.currentTab === 'all';

  const groupsHtml = groups.map(g => `
    <div class="date-group">
      <div class="date-divider">${escapeHtml(g.label)}</div>
      ${g.notes.map(n => {
        const proj = projectMap[n.project_id];
        const projLabel = proj ? `${proj.emoji ? proj.emoji + ' ' : ''}${escapeHtml(proj.name)}` : escapeHtml(n.project_id);
        const canDelete = state.auth?.is_admin || n.author_name === state.auth?.name;
        const isSummary = n.is_summary == 1 || n.is_summary === true;
        return `
          <article class="note ${isSummary ? 'is-summary' : ''}" data-id="${escapeHtml(n.id)}">
            <div class="note-head">
              <span class="note-author">
                <span class="small-emoji">${escapeHtml(n.author_emoji)}</span>
                ${escapeHtml(n.author_name)}
              </span>
              ${isSummary ? '<span class="summary-badge">🤖 AI 整理</span>' : ''}
              ${canDelete ? '<button class="delete-btn" aria-label="删除">✕</button>' : ''}
            </div>
            <div class="note-body">${highlightContent(n.content)}</div>
            <div class="note-foot">
              <span class="note-time">${formatCardDateTime(n.created_at)}</span>
              ${showProjectBadge ? `<span class="note-project">${projLabel}</span>` : '<span></span>'}
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `).join('');

  const sentinel = state.hasMore ? '<div id="feed-sentinel" class="feed-sentinel"><span class="spinner"></span> 加载更多…</div>' : '';

  el.innerHTML = groupsHtml + sentinel;

  el.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      if (!confirm('确认删除这条？')) return;
      try {
        await deleteNote(id);
        state.notes = state.notes.filter(n => n.id !== id);
        renderFeed();
        toast('已删除');
      } catch (err) {
        toast('删除失败：' + err.message, true);
      }
    });
  });

  // Setup infinite scroll sentinel
  setupInfiniteScroll();
}

// ---------- Infinite scroll ----------
let scrollObserver = null;
function setupInfiniteScroll() {
  const sentinel = $('feed-sentinel');
  if (!sentinel) return;
  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !state.loading && state.hasMore) {
        try {
          await loadFeed(true);
          renderFeed();
        } catch (e) {
          toast('加载更多失败：' + e.message, true);
        }
      }
    }
  }, { rootMargin: '200px' });
  scrollObserver.observe(sentinel);
}

// ---------- Composer ----------
function setupComposer() {
  const input = $('composer-input');
  const btn = $('composer-submit');
  if (!input || !btn) return;

  function updateSendBtn() {
    btn.disabled = !input.value.trim();
  }
  updateSendBtn();

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateSendBtn();
  });

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  async function submit() {
    const content = input.value.trim();
    if (!content) return;

    let projectId = state.currentTab;
    if (projectId === 'all') {
      projectId = await pickProject();
      if (!projectId) return;
    }

    btn.disabled = true;
    try {
      const note = await postNote(projectId, content);
      state.notes.unshift(note);
      input.value = '';
      input.style.height = 'auto';
      renderFeed();
      updateSendBtn();
      input.focus();
    } catch (err) {
      toast('发布失败：' + err.message, true);
    } finally {
      updateSendBtn();
    }
  }
}

function pickProject() {
  return new Promise((resolve) => {
    const modal = $('project-picker-modal');
    const list = $('project-picker-list');
    if (!modal || !list) { resolve(null); return; }
    list.innerHTML = state.projects.map(p => `
      <button data-id="${escapeHtml(p.id)}">${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)}</button>
    `).join('');
    modal.hidden = false;
    const done = (res) => { modal.hidden = true; resolve(res); };
    list.querySelectorAll('[data-id]').forEach(b => {
      b.addEventListener('click', () => done(b.dataset.id));
    });
    $('project-picker-cancel').onclick = () => done(null);
  });
}

// ---------- Summarize ----------
function setupSummarize() {
  $('btn-summary')?.addEventListener('click', openSummarize);
  $('sum-close')?.addEventListener('click', closeSummarize);
  $('sum-run')?.addEventListener('click', runSummarize);
  $('sum-save')?.addEventListener('click', saveSummaryAsCard);
  $('sum-close-result')?.addEventListener('click', closeSummarize);
}

function openSummarize() {
  const modal = $('summarize-modal');
  if (modal) modal.hidden = false;
  $('sum-config').hidden = false;
  $('sum-result').hidden = true;
  $('sum-loading').hidden = true;
}

function closeSummarize() {
  const modal = $('summarize-modal');
  if (modal) modal.hidden = true;
}

let lastSummary = null;

async function runSummarize() {
  const timeRange = document.querySelector('input[name="sum-time"]:checked')?.value || '7d';
  const project = document.querySelector('input[name="sum-proj"]:checked')?.value || state.currentTab;
  $('sum-config').hidden = true;
  $('sum-loading').hidden = false;
  try {
    const data = await summarize(timeRange, project);
    lastSummary = { ...data, timeRange, project };
    $('sum-loading').hidden = true;
    $('sum-result').hidden = false;
    const meta = data.meta || {};
    $('sum-meta').textContent = `近 ${meta.days} 天 · ${meta.project === 'all' ? '全部项目' : meta.project} · ${meta.noteCount} 条记录`;
    $('sum-body').innerHTML = renderMarkdown(data.summary || '');
  } catch (e) {
    $('sum-loading').hidden = true;
    $('sum-config').hidden = false;
    toast(e.message, true);
  }
}

async function saveSummaryAsCard() {
  if (!lastSummary) return;
  const meta = lastSummary.meta || {};
  const header = `📊 近 ${meta.days} 天整理（${meta.project === 'all' ? '全部项目' : meta.project}） · 共 ${meta.noteCount} 条\n\n`;
  const content = header + (lastSummary.summary || '');
  const projectId = (meta.project === 'all') ? (state.projects[0]?.id || 'bci') : meta.project;
  try {
    const note = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, content, author_emoji: '🤖', is_summary: 1 }),
    });
    state.notes.unshift(note);
    renderFeed();
    closeSummarize();
    toast('已保存为卡片');
  } catch (e) {
    toast('保存失败：' + e.message, true);
  }
}

// Simple markdown renderer (headings, bold, lists, linebreaks)
function renderMarkdown(md) {
  let h = escapeHtml(md);
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*?<\/li>(\n|$))+/gs, m => `<ul>${m.replace(/\n/g, '')}</ul>`);
  h = h.replace(/\n\n/g, '</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/<p>(<h\d|<ul)/g, '$1').replace(/(<\/h\d>|<\/ul>)<\/p>/g, '$1');
  return h;
}

// ---------- Settings ----------
function setupSettings() {
  $('btn-settings')?.addEventListener('click', openSettings);
  $('settings-close')?.addEventListener('click', closeSettings);
  $('settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  $('btn-logout')?.addEventListener('click', () => {
    if (confirm('确认退出登录？')) logout();
  });

  $('add-project')?.addEventListener('click', async () => {
    const idEl = $('new-project-id'), nameEl = $('new-project-name'), emEl = $('new-project-emoji');
    const id = idEl?.value.trim(), name = nameEl?.value.trim(), emoji = emEl?.value.trim();
    if (!id || !name) { toast('id 和项目名必填', true); return; }
    try {
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id, name, emoji }) });
      state.projects.push(p);
      renderSettingsProjects();
      renderTabs();
      if (idEl) idEl.value = '';
      if (nameEl) nameEl.value = '';
      if (emEl) emEl.value = '';
      toast('项目已添加');
    } catch (e) { toast('添加失败：' + e.message, true); }
  });

  $('add-person')?.addEventListener('click', async () => {
    const nameEl = $('new-person-name'), colorEl = $('new-person-color');
    const name = nameEl?.value.trim(), color = colorEl?.value;
    if (!name) { toast('姓名必填', true); return; }
    try {
      const p = await api('/api/people', { method: 'POST', body: JSON.stringify({ name, color }) });
      state.people.push(p);
      renderSettingsPeople();
      renderFeed();
      if (nameEl) nameEl.value = '';
      toast('已添加');
    } catch (e) { toast('添加失败：' + e.message, true); }
  });
}

function openSettings() {
  if (!state.auth) return;
  $('settings-me-name').textContent = state.auth.name;
  $('settings-me-emoji').textContent = state.auth.emoji;
  $('settings-me-role').textContent = state.auth.is_admin ? '管理员' : '普通成员';
  $('settings-me-role').className = state.auth.is_admin ? 'role-badge admin' : 'role-badge';
  renderSettingsProjects();
  renderSettingsPeople();
  $('settings-modal').hidden = false;
}

function closeSettings() {
  $('settings-modal').hidden = true;
}

function renderSettingsProjects() {
  const el = $('settings-projects');
  if (!el) return;
  el.innerHTML = state.projects.map(p => `
    <li>
      <span>${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)} <span class="muted small">(${escapeHtml(p.id)})</span></span>
      <button class="ghost-btn small" data-del="${escapeHtml(p.id)}">删除</button>
    </li>
  `).join('');
  el.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm(`删除项目「${b.dataset.del}」？该项目下的条目保留，但失去 tab。`)) return;
      try {
        await api(`/api/projects/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        state.projects = state.projects.filter(p => p.id !== b.dataset.del);
        renderSettingsProjects();
        renderTabs();
        if (state.currentTab === b.dataset.del) { state.currentTab = 'all'; renderTabs(); refresh(); }
        toast('项目已删除');
      } catch (e) { toast('删除失败：' + e.message, true); }
    });
  });
}

function renderSettingsPeople() {
  const el = $('settings-people');
  if (!el) return;
  if (!state.people.length) {
    el.innerHTML = `<li style="justify-content:center; color:var(--muted)"><span class="small">还没有人物，添加后正文会自动高亮</span></li>`;
    return;
  }
  el.innerHTML = state.people.map(p => `
    <li>
      <span class="hl-person" style="color:${escapeHtml(p.color)}">${escapeHtml(p.name)}</span>
      <button class="ghost-btn small" data-del="${escapeHtml(p.name)}">删除</button>
    </li>
  `).join('');
  el.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm(`删除「${b.dataset.del}」？`)) return;
      try {
        await api(`/api/people/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        state.people = state.people.filter(p => p.name !== b.dataset.del);
        renderSettingsPeople();
        renderFeed();
        toast('已删除');
      } catch (e) { toast('删除失败：' + e.message, true); }
    });
  });
}

// ---------- Header ----------
function updateUserHeader() {
  if (!state.auth) return;
  $('user-emoji').textContent = state.auth.emoji;
  $('user-name').textContent = state.auth.name;
  $('btn-summary').hidden = false; // show summary button for all logged users
  // Project picker in summarize dialog needs projects loaded
  renderSumProjects();
}

function renderSumProjects() {
  const el = $('sum-projects-list');
  if (!el) return;
  const items = [{ id: 'all', name: '全部项目', emoji: '' }, ...state.projects];
  el.innerHTML = items.map((p, i) => `
    <label class="radio-row">
      <input type="radio" name="sum-proj" value="${escapeHtml(p.id)}" ${i === 0 ? 'checked' : ''}>
      <span>${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)}</span>
    </label>
  `).join('');
}

// ---------- Refresh ----------
async function refresh() {
  try {
    await loadFeed();
    renderFeed();
  } catch (e) {
    console.error('[refresh]', e);
    toast('加载失败：' + e.message, true);
  }
}

// ---------- Init ----------
async function initApp() {
  $('app').hidden = false;
  updateUserHeader();
  try {
    await loadConfig();
    updateUserHeader(); // re-render with projects
    renderTabs();
    await loadFeed();
    renderFeed();
  } catch (e) {
    console.error('[init]', e);
    toast('初始化失败：' + e.message, true);
  }
}

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  try {
    setupLogin();
    setupComposer();
    setupSettings();
    setupSummarize();
    $('btn-refresh')?.addEventListener('click', refresh);
  } catch (e) {
    console.error('[setup]', e);
    toast('页面设置失败：' + e.message, true);
  }

  const existing = loadAuth();
  if (existing && existing.token) {
    state.auth = existing;
    $('login-modal').hidden = true;
    initApp();
  } else {
    showLogin();
  }
});
