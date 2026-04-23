// ============================================================
// teamfeed app.js — v2 · 专业风格
// ============================================================

// ---------- Emoji pool & hashing ----------
const EMOJI_POOL = [
  '🦊', '🐯', '🦁', '🐻', '🐼', '🐨', '🐶', '🐱', '🦖', '🦄',
  '🐸', '🐵', '🦉', '🐧', '🐢', '🦋', '🌸', '🌈', '⭐', '🍀',
  '🔥', '💎', '🍊', '🍇', '🌊', '🌙', '☘️', '🌼', '🎯', '🎨'
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

function emojiForName(name, offset = 0) {
  const h = hashName(String(name || 'x'));
  return EMOJI_POOL[(h + offset) % EMOJI_POOL.length];
}

// ---------- State ----------
const state = {
  user: null,
  projects: [],
  people: [],
  currentTab: 'all',
  notes: [],
};

// ---------- LocalStorage ----------
const LS_USER = 'teamfeed.user';

function loadUser() {
  try {
    const raw = localStorage.getItem(LS_USER);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveUser(user) {
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) { console[isError ? 'error' : 'log'](msg); return; }
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // HTTP headers only allow ISO-8859-1; URL-encode author name for Chinese/Unicode chars
  if (state.user) headers['X-Author-Name'] = encodeURIComponent(state.user.name);
  const resp = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json();
}

async function loadConfig() {
  const data = await api('/api/config');
  state.projects = data.projects || [];
  state.people = data.people || [];
}

async function loadFeed() {
  const q = state.currentTab === 'all' ? '' : `?project=${encodeURIComponent(state.currentTab)}`;
  const data = await api(`/api/notes${q}`);
  state.notes = data.notes || [];
}

async function postNote(project_id, content) {
  return api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({
      author_name: state.user.name,
      author_emoji: state.user.emoji,
      project_id,
      content,
    }),
  });
}

async function deleteNote(id) {
  return api(`/api/notes/${id}`, { method: 'DELETE' });
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
  const input = $('login-name');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
  updateLoginEmoji(0);
}

let loginEmojiOffset = 0;

function updateLoginEmoji(offset) {
  const input = $('login-name');
  const name = input ? input.value.trim() : '';
  loginEmojiOffset = offset;
  const el = $('login-emoji');
  if (el) el.textContent = emojiForName(name || 'x', offset);
}

function setupLogin() {
  const input = $('login-name');
  const swap = $('login-emoji-swap');
  const submit = $('login-submit');
  if (input) {
    input.addEventListener('input', () => { loginEmojiOffset = 0; updateLoginEmoji(0); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
  }
  if (swap) swap.addEventListener('click', () => updateLoginEmoji(loginEmojiOffset + 1));
  if (submit) submit.addEventListener('click', submitLogin);
}

function submitLogin() {
  const input = $('login-name');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { toast('请输入名字', true); return; }
  const emoji = emojiForName(name, loginEmojiOffset);
  state.user = { name, emoji };
  saveUser(state.user);
  const modal = $('login-modal');
  if (modal) modal.hidden = true;
  initApp();
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
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
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
  const datePart = sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
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

  // Markdown **bold**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Money: ¥12,500 / ¥12500.5
  html = html.replace(/¥[\d,]+(?:\.\d+)?/g, m => `<span class="hl-money">${m}</span>`);
  // Units
  html = html.replace(/\d+(?:\.\d+)?(?:kg|千克|克|吨|mm|cm|m|km|元|万|亿|个|条|份)/gi, m => `<span class="hl-unit">${m}</span>`);
  // Percent
  html = html.replace(/\d+(?:\.\d+)?%/g, m => `<span class="hl-percent">${m}</span>`);
  // Dates
  html = html.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\b\d{1,2}[-/]\d{1,2}\b/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\d{1,2}月\d{1,2}日/g, m => `<span class="hl-date">${m}</span>`);
  // Time HH:MM
  html = html.replace(/\b\d{1,2}:\d{2}\b/g, m => `<span class="hl-time">${m}</span>`);

  // People dict
  for (const p of state.people) {
    let names = [p.name];
    try {
      if (p.aliases) {
        const arr = JSON.parse(p.aliases);
        if (Array.isArray(arr)) names = names.concat(arr);
      }
    } catch { /* ignore malformed aliases */ }
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

  el.innerHTML = groups.map(g => `
    <div class="date-group">
      <div class="date-divider">${escapeHtml(g.label)}</div>
      ${g.notes.map(n => {
        const proj = projectMap[n.project_id];
        const projLabel = proj ? `${proj.emoji ? proj.emoji + ' ' : ''}${escapeHtml(proj.name)}` : escapeHtml(n.project_id);
        const isMine = state.user && n.author_name === state.user.name;
        const isSummary = n.is_summary == 1 || n.is_summary === true;
        return `
          <article class="note ${isSummary ? 'is-summary' : ''}" data-id="${escapeHtml(n.id)}">
            <div class="note-head">
              <span class="note-author">
                <span class="small-emoji">${escapeHtml(n.author_emoji)}</span>
                ${escapeHtml(n.author_name)}
              </span>
              ${isSummary ? '<span class="summary-badge">AI 整理</span>' : ''}
              ${isMine ? '<button class="delete-btn" aria-label="删除">✕</button>' : ''}
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

  // Delete handlers
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
    // Enter 发送；Shift+Enter 换行
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

// ---------- Settings ----------
function setupSettings() {
  $('btn-settings')?.addEventListener('click', openSettings);
  $('settings-close')?.addEventListener('click', closeSettings);
  $('settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  $('settings-emoji-swap')?.addEventListener('click', () => {
    const nameInput = $('settings-name');
    const emojiEl = $('settings-emoji');
    if (!nameInput || !emojiEl) return;
    const name = nameInput.value.trim() || state.user?.name || 'x';
    const current = emojiEl.textContent;
    let offset = 1;
    for (let i = 1; i <= EMOJI_POOL.length; i++) {
      if (emojiForName(name, i) !== current) { offset = i; break; }
    }
    emojiEl.textContent = emojiForName(name, offset);
    emojiEl.dataset.offset = String(offset);
  });

  $('settings-save-identity')?.addEventListener('click', () => {
    const nameInput = $('settings-name');
    const emojiEl = $('settings-emoji');
    if (!nameInput || !emojiEl) return;
    const newName = nameInput.value.trim();
    if (!newName) { toast('名字不能为空', true); return; }
    const offset = parseInt(emojiEl.dataset.offset || '0');
    const emoji = emojiForName(newName, offset);
    state.user = { name: newName, emoji };
    saveUser(state.user);
    updateUserHeader();
    toast('已保存');
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
  if (!state.user) return;
  const nameInput = $('settings-name');
  const emojiEl = $('settings-emoji');
  if (nameInput) nameInput.value = state.user.name;
  if (emojiEl) { emojiEl.textContent = state.user.emoji; emojiEl.dataset.offset = '0'; }
  renderSettingsProjects();
  renderSettingsPeople();
  const modal = $('settings-modal');
  if (modal) modal.hidden = false;
}

function closeSettings() {
  const modal = $('settings-modal');
  if (modal) modal.hidden = true;
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
      const pid = b.dataset.del;
      if (!confirm(`删除项目「${pid}」？该项目下的条目仍会保留，但失去 tab。`)) return;
      try {
        await api(`/api/projects/${encodeURIComponent(pid)}`, { method: 'DELETE' });
        state.projects = state.projects.filter(p => p.id !== pid);
        renderSettingsProjects();
        renderTabs();
        if (state.currentTab === pid) {
          state.currentTab = 'all';
          renderTabs();
          refresh();
        }
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
      const n = b.dataset.del;
      if (!confirm(`删除「${n}」？`)) return;
      try {
        await api(`/api/people/${encodeURIComponent(n)}`, { method: 'DELETE' });
        state.people = state.people.filter(p => p.name !== n);
        renderSettingsPeople();
        renderFeed();
        toast('已删除');
      } catch (e) { toast('删除失败：' + e.message, true); }
    });
  });
}

// ---------- Header ----------
function updateUserHeader() {
  const e = $('user-emoji');
  const n = $('user-name');
  if (e && state.user) e.textContent = state.user.emoji;
  if (n && state.user) n.textContent = state.user.name;
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
  const app = $('app');
  if (app) app.hidden = false;
  updateUserHeader();
  try {
    await loadConfig();
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
    $('btn-refresh')?.addEventListener('click', refresh);
  } catch (e) {
    console.error('[setup]', e);
    toast('页面设置失败：' + e.message, true);
  }

  const existing = loadUser();
  if (existing) {
    state.user = existing;
    const loginModal = $('login-modal');
    if (loginModal) loginModal.hidden = true;
    initApp();
  } else {
    showLogin();
  }
});
