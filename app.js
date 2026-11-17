'use strict';

// Minimal vanilla-JS client for the Secure Notes API. All user content is rendered with
// textContent (never innerHTML) to prevent XSS.

const $ = (sel) => document.querySelector(sel);
const state = { token: localStorage.getItem('token'), me: null, pages: {} };
const PAGE_SIZE = 5;
const API = `${(window.API_URL || '').replace(/\/+$/, '')}/api`; // set in config.js

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function setStatus(msg, isError = false) {
  const s = $('#status');
  s.textContent = msg || '';
  s.className = isError ? 'error' : 'ok';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const usedToken = state.token;
  if (usedToken) headers.Authorization = `Bearer ${usedToken}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only log out if the rejected token is still the current one (a slow request sent with an
    // older token, e.g. just before a password change, must not end the new session).
    if (res.status === 401 && usedToken && usedToken === state.token && !path.startsWith('/auth/')) logout();
    if (res.status === 403 && usedToken && usedToken === state.token) refreshRole();
    const err = data.error || {};
    throw new Error([err.message || `Request failed (${res.status})`, ...(err.details || [])].join(': '));
  }
  return data;
}

// Wraps an async action and reports errors in the status line.
const run = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { setStatus(e.message, true); }
};

// Each list keeps only the response of its LATEST request, so fast clicks on the pager can't
// render an older, slower response over a newer one.
const latestCall = {};
function isLatest(key) {
  const n = (latestCall[key] = (latestCall[key] || 0) + 1);
  return () => latestCall[key] === n;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());
const parseInterests = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '');

function renderPager(container, pagination, onPage) {
  const box = $(container);
  box.replaceChildren();
  if (!pagination) return;
  const { page, totalPages, total } = pagination;
  const prev = el('button', { textContent: 'Prev', disabled: page <= 1, onclick: () => onPage(page - 1) });
  const next = el('button', { textContent: 'Next', disabled: page >= totalPages, onclick: () => onPage(page + 1) });
  box.append(prev, next, el('span', { className: 'muted' }, ` page ${page} of ${Math.max(totalPages, 1)} — ${total} total`));
}

function renderEmpty(container, text) {
  $(container).replaceChildren(el('p', { className: 'muted' }, text));
}

// ---------------- Auth ----------------
function saveSession({ token, user }) {
  state.token = token;
  localStorage.setItem('token', token);
  state.me = user;
}

function logout() {
  state.token = null;
  state.me = null;
  state.pages = {};
  localStorage.removeItem('token');
  // forget everything from the previous session (half-edited forms, filters, views)
  postsMode = { type: 'all' };
  interestFilter = '';
  adminNotesOwner = '';
  document.querySelectorAll('#app-view form').forEach((f) => {
    f.reset();
    if (f.elements.id) f.elements.id.value = '';
  });
  $('#note-cancel').classList.add('hidden');
  $('#user-cancel').classList.add('hidden');
  $('#post-cancel').classList.add('hidden');
  // drop the previous user's data from the page and ignore their in-flight responses
  ['notes', 'posts', 'interests', 'users', 'admin-notes'].forEach((k) => {
    latestCall[k] = (latestCall[k] || 0) + 1;
    $(`#${k}-list`).replaceChildren();
    $(`#${k}-pager`).replaceChildren();
  });
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  saveSession(await api('/auth/login', { method: 'POST', body: formData(e.target) }));
  e.target.reset();
  await enterApp();
}));

$('#register-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  saveSession(await api('/auth/register', {
    method: 'POST',
    body: { name: f.name, email: f.email, password: f.password, interests: parseInterests(f.interests) },
  }));
  e.target.reset();
  await enterApp();
}));

$('#logout').addEventListener('click', () => {
  // revoke the token on the server too (ends all of this user's sessions), then clear locally
  if (state.token) fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  logout();
  setStatus('Logged out');
});

// Called after a 403: the user's role may have been changed by an admin meanwhile.
async function refreshRole() {
  try {
    const { user } = await api('/profile');
    state.me = user;
    $('#me-role').textContent = user.role;
    document.querySelectorAll('.admin-only').forEach((b) => b.classList.toggle('hidden', user.role !== 'admin'));
    if (user.role !== 'admin' && !$('#tab-admin-users').classList.contains('hidden')) showTab('notes');
    if (user.role !== 'admin' && !$('#tab-admin-notes').classList.contains('hidden')) showTab('notes');
  } catch { /* the 401 path already handles an invalid session */ }
}

async function enterApp() {
  const { user } = await api('/profile');
  state.me = user;
  $('#me-name').textContent = user.name;
  $('#me-role').textContent = user.role;
  document.querySelectorAll('.admin-only').forEach((b) => b.classList.toggle('hidden', user.role !== 'admin'));
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setStatus('');
  showTab('notes');
}

// ---------------- Tabs ----------------
const loaders = {
  notes: () => loadNotes(1),
  posts: () => loadPosts(1),
  interests: () => loadInterests(1),
  profile: () => fillProfile(),
  'admin-users': () => loadUsers(1),
  'admin-notes': () => loadAdminNotes(1),
};

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  run(loaders[name])();
}

$('#tabs').addEventListener('click', (e) => {
  if (!e.target.dataset.tab) return;
  if (e.target.dataset.tab === 'posts') postsMode = { type: 'all' }; // tab click = full feed
  showTab(e.target.dataset.tab);
});

// ---------------- My notes ----------------
async function loadNotes(page) {
  const current = isLatest('notes');
  const res = await api(`/notes?page=${page}&limit=${PAGE_SIZE}`);
  if (!current()) return;
  state.pages.notes = page;
  if (!res.data.length && page > 1) return loadNotes(page - 1);
  if (!res.data.length) renderEmpty('#notes-list', 'No notes yet.');
  else {
    $('#notes-list').replaceChildren(...res.data.map((n) => el('div', { className: 'item' },
      el('strong', {}, n.title), el('div', {}, n.content),
      el('div', { className: 'muted' }, `updated ${fmtDate(n.updatedAt)} `),
      el('button', { textContent: 'Edit', onclick: () => editNote(n) }), ' ',
      el('button', { textContent: 'Delete', onclick: run(async () => {
        if (!confirm('Delete this note?')) return;
        await api(`/notes/${n._id}`, { method: 'DELETE' });
        setStatus('Note deleted');
        await loadNotes(state.pages.notes);
      }) }))));
  }
  renderPager('#notes-pager', res.pagination, run(loadNotes));
}

function editNote(n) {
  const f = $('#note-form');
  f.elements.id.value = n._id;
  f.elements.title.value = n.title;
  f.elements.content.value = n.content;
  $('#note-cancel').classList.remove('hidden');
}

function resetNoteForm() {
  $('#note-form').reset();
  $('#note-form').elements.id.value = '';
  $('#note-cancel').classList.add('hidden');
}

$('#note-cancel').addEventListener('click', resetNoteForm);
$('#note-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const { id, title, content } = formData(e.target);
  if (id) await api(`/notes/${id}`, { method: 'PATCH', body: { title, content } });
  else await api('/notes', { method: 'POST', body: { title, content } });
  setStatus(id ? 'Note updated' : 'Note created');
  resetNoteForm();
  await loadNotes(id ? state.pages.notes : 1);
}));

// ---------------- Posts ----------------
// mode: { type: 'all' } or { type: 'user', userId }
let postsMode = { type: 'all' };

async function loadPosts(page) {
  const current = isLatest('posts');
  let res;
  if (postsMode.type === 'user') {
    try {
      res = await api(`/posts/user/${postsMode.userId}?page=${page}&limit=${PAGE_SIZE}`);
      if (!current()) return;
    } catch (err) {
      postsMode = { type: 'all' }; // e.g. the user was deleted: fall back to the full feed
      throw err;
    }
    $('#posts-title').textContent = `Posts by ${res.author.name}`;
    res.data.forEach((p) => { p.author = res.author; });
  } else {
    res = await api(`/posts?page=${page}&limit=${PAGE_SIZE}`);
    if (!current()) return;
    $('#posts-title').textContent = 'All posts';
  }
  state.pages.posts = page;
  if (!res.data.length && page > 1) return loadPosts(page - 1);
  if (!res.data.length) renderEmpty('#posts-list', 'No posts.');
  else {
    $('#posts-list').replaceChildren(...res.data.map((p) => {
      const author = p.author || { name: '(deleted user)' };
      const isMine = author._id === state.me._id;
      const canDelete = isMine || state.me.role === 'admin';
      return el('div', { className: 'item' },
        el('strong', {}, p.title), el('div', {}, p.content),
        el('div', { className: 'muted' }, 'by ',
          author._id
            ? el('a', { href: '#', textContent: author.name, onclick: (ev) => { ev.preventDefault(); showUserPosts(author._id); } })
            : author.name,
          ` · ${fmtDate(p.createdAt)} `),
        isMine ? el('button', { textContent: 'Edit', onclick: () => editPost(p) }) : '', ' ',
        canDelete ? el('button', { textContent: 'Delete', onclick: run(async () => {
          if (!confirm('Delete this post?')) return;
          await api(`/posts/${p._id}`, { method: 'DELETE' });
          setStatus('Post deleted');
          await loadPosts(state.pages.posts);
        }) }) : '');
    }));
  }
  renderPager('#posts-pager', res.pagination, run(loadPosts));
}

function showUserPosts(userId) {
  postsMode = { type: 'user', userId };
  run(loadPosts)(1);
}

$('#posts-all').addEventListener('click', () => { postsMode = { type: 'all' }; run(loadPosts)(1); });
$('#posts-mine').addEventListener('click', () => showUserPosts(state.me._id));
function editPost(p) {
  const f = $('#post-form');
  f.elements.id.value = p._id;
  f.elements.title.value = p.title;
  f.elements.content.value = p.content;
  $('#post-cancel').classList.remove('hidden');
}

function resetPostForm() {
  $('#post-form').reset();
  $('#post-form').elements.id.value = '';
  $('#post-cancel').classList.add('hidden');
}

$('#post-cancel').addEventListener('click', resetPostForm);
$('#post-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const { id, title, content } = formData(e.target);
  if (id) await api(`/posts/${id}`, { method: 'PATCH', body: { title, content } });
  else await api('/posts', { method: 'POST', body: { title, content } });
  setStatus(id ? 'Post updated' : 'Post published');
  resetPostForm();
  await loadPosts(id ? state.pages.posts : 1);
}));

// ---------------- Interests (Scenario 1) ----------------
let interestFilter = '';

async function loadInterests(page) {
  const q = interestFilter ? `&interest=${encodeURIComponent(interestFilter)}` : '';
  const current = isLatest('interests');
  const res = await api(`/interests?page=${page}&limit=${PAGE_SIZE}${q}`);
  if (!current()) return;
  if (!res.data.length && page > 1) return loadInterests(page - 1);
  const who = (u) => el('li', {}, u.email ? `${u.name} <${u.email}>` : u.name);
  if (!res.data.length) renderEmpty('#interests-list', 'No users with interests found.');
  else if (res.interest) {
    // one group: all of its members, paginated
    $('#interests-list').replaceChildren(el('div', { className: 'item' },
      el('strong', {}, `${res.interest} (${res.pagination.total} user${res.pagination.total === 1 ? '' : 's'})`),
      el('ul', {}, ...res.data.map(who))));
  } else {
    // overview: each group with its member count and a short preview
    $('#interests-list').replaceChildren(...res.data.map((g) => el('div', { className: 'item' },
      el('strong', {}, `${g.interest} (${g.count})`),
      el('ul', {}, ...g.users.map(who)),
      g.count > g.users.length
        ? el('button', { textContent: `Show all ${g.count}`, onclick: () => showInterest(g.interest) })
        : '')));
  }
  renderPager('#interests-pager', res.pagination, run(loadInterests));
}

function showInterest(name) {
  interestFilter = name;
  $('#interest-filter').elements.interest.value = name;
  run(loadInterests)(1);
}

$('#interest-filter').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  interestFilter = formData(e.target).interest.trim();
  await loadInterests(1);
}));

// ---------------- Profile ----------------
async function fillProfile() {
  const { user } = await api('/profile');
  const f = $('#profile-form');
  f.reset();
  f.elements.name.value = user.name;
  f.elements.interests.value = user.interests.join(', ');
}

$('#profile-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const body = { name: f.name, interests: parseInterests(f.interests) };
  if (f.password) Object.assign(body, { password: f.password, currentPassword: f.currentPassword });
  const { user, token } = await api('/profile', { method: 'PATCH', body });
  if (token) saveSession({ token, user }); // a password change revokes the old token
  state.me = user;
  $('#me-name').textContent = user.name;
  setStatus('Profile updated');
  await fillProfile();
}));

// ---------------- Admin: users ----------------
async function loadUsers(page) {
  const current = isLatest('users');
  const res = await api(`/users?page=${page}&limit=${PAGE_SIZE}`);
  if (!current()) return;
  state.pages.users = page;
  if (!res.data.length && page > 1) return loadUsers(page - 1);
  $('#users-list').replaceChildren(...res.data.map((u) => el('div', { className: 'item' },
    el('strong', {}, u.name), ` <${u.email}> — ${u.role}`,
    el('div', { className: 'muted' }, `id ${u._id} · interests: ${u.interests.join(', ') || '—'}`),
    el('button', { textContent: 'Edit', onclick: () => editUser(u) }), ' ',
    el('button', { textContent: 'View notes', onclick: () => {
      $('#admin-notes-filter').elements.owner.value = u._id;
      adminNotesOwner = u._id;
      showTab('admin-notes');
    } }), ' ',
    el('button', { textContent: 'View posts', onclick: () => { postsMode = { type: 'user', userId: u._id }; showTab('posts'); } }), ' ',
    el('button', { textContent: 'Delete', disabled: u._id === state.me._id, onclick: run(async () => {
      if (!confirm(`Delete ${u.email} and all their notes and posts?`)) return;
      await api(`/users/${u._id}`, { method: 'DELETE' });
      setStatus('User deleted');
      await loadUsers(state.pages.users);
    }) }))));
  renderPager('#users-pager', res.pagination, run(loadUsers));
}

function editUser(u) {
  const f = $('#user-form');
  f.elements.id.value = u._id;
  f.elements.name.value = u.name;
  f.elements.email.value = u.email;
  f.elements.password.value = '';
  f.elements.role.value = u.role;
  f.elements.interests.value = u.interests.join(', ');
  $('#user-cancel').classList.remove('hidden');
}

function resetUserForm() {
  $('#user-form').reset();
  $('#user-form').elements.id.value = '';
  $('#user-cancel').classList.add('hidden');
}

$('#user-cancel').addEventListener('click', resetUserForm);
$('#user-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const body = { name: f.name, email: f.email, role: f.role, interests: parseInterests(f.interests) };
  if (f.password) body.password = f.password;
  if (f.id) {
    const res = await api(`/users/${f.id}`, { method: 'PATCH', body });
    if (res.token) saveSession({ token: res.token, user: res.user }); // own password changed
  } else await api('/users', { method: 'POST', body });
  setStatus(f.id ? 'User updated' : 'User created');
  resetUserForm();
  await loadUsers(f.id ? state.pages.users : 1);
}));

// ---------------- Admin: all notes ----------------
let adminNotesOwner = '';

async function loadAdminNotes(page) {
  const q = adminNotesOwner ? `&owner=${encodeURIComponent(adminNotesOwner)}` : '';
  const current = isLatest('admin-notes');
  const res = await api(`/notes/all?page=${page}&limit=${PAGE_SIZE}${q}`);
  if (!current()) return;
  if (!res.data.length && page > 1) return loadAdminNotes(page - 1);
  if (!res.data.length) renderEmpty('#admin-notes-list', 'No notes.');
  else {
    $('#admin-notes-list').replaceChildren(...res.data.map((n) => el('div', { className: 'item' },
      el('strong', {}, n.title), el('div', {}, n.content),
      el('div', { className: 'muted' },
        `owner: ${n.owner ? `${n.owner.name} <${n.owner.email}>` : '(deleted user)'} · ${fmtDate(n.createdAt)}`))));
  }
  renderPager('#admin-notes-pager', res.pagination, run(loadAdminNotes));
}

$('#admin-notes-filter').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  adminNotesOwner = formData(e.target).owner.trim();
  await loadAdminNotes(1);
}));

// ---------------- Boot ----------------
if (state.token) run(enterApp)();
