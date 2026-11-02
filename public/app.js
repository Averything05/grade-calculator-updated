(() => {
  'use strict';

  const { summarize, formatGrade, fmt } = window.GradeCalc;

  const $ = (sel, el = document) => el.querySelector(sel);
  const subjectsEl = $('#subjects');
  const emptyEl = $('#empty');
  const errorEl = $('#error');
  const scaleEl = $('#scale');
  const authEl = $('#auth');
  const appEl = $('#app');
  const accountEl = $('#account');
  const whoamiEl = $('#whoami');
  const authForm = $('#auth-form');
  const authSubmit = $('#auth-submit');
  const tabLogin = $('#tab-login');
  const tabRegister = $('#tab-register');

  let subjects = [];
  let scale = 'percent';
  try { scale = localStorage.getItem('scale') || 'percent'; } catch { /* storage unavailable */ }
  scaleEl.value = scale;
  if (scaleEl.value !== scale) { scale = 'percent'; scaleEl.value = scale; }

  // ---------- small helpers ----------

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const valueAttr = (v) => (v === null || v === undefined ? '' : esc(v));

  const errMsg = (err) =>
    err instanceof TypeError ? 'Could not reach the server. Is it running?' : err.message;

  let errorTimer;
  function showError(msg) {
    errorEl.textContent = msg || '';
    clearTimeout(errorTimer);
    if (msg) errorTimer = setTimeout(() => { errorEl.textContent = ''; }, 6000);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/login') && url !== '/api/me') {
      showAuth(); // session expired or logged out in another tab
      throw new Error('Your session expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  const findSubject = (id) => subjects.find((s) => s.id === Number(id));
  const findCard = (id) => subjectsEl.querySelector(`[data-subject="${id}"]`);

  // ---------- rendering ----------

  function summaryHTML(s) {
    if (!s.components.length) {
      return '<p class="muted">Add components below (quizzes, exams, projects…) to see your grade.</p>';
    }
    const r = summarize(s.components, s.target);
    const f = (p) => formatGrade(p, scale);
    const t = fmt(s.target ?? 0);

    if (r.status === 'empty') {
      return '<p class="verdict warn">Give at least one component a weight above 0 to see results.</p>';
    }

    const note =
      Math.abs(r.totalWeight - 100) > 0.001
        ? `<p class="note">Weights add up to ${fmt(r.totalWeight)}%, not 100%. Results are scaled to your total.</p>`
        : '';

    const progress = Math.min(100, (r.gradedWeight / r.totalWeight) * 100);
    const stats = `
      <div class="stats">
        <div class="stat"><div class="stat-label">Current grade</div><div class="stat-value">${f(r.current)}</div></div>
        <div class="stat"><div class="stat-label">Best possible</div><div class="stat-value">${f(r.bestPossible)}</div></div>
        <div class="stat"><div class="stat-label">Graded so far</div><div class="stat-value">${fmt(r.gradedWeight)} / ${fmt(r.totalWeight)}%</div></div>
      </div>
      <div class="bar" role="img" aria-label="${fmt(progress)}% of the grade is graded so far"><span style="width:${progress}%"></span></div>`;

    const left = r.ungraded.map((c) => esc(c.name)).join(', ');
    let verdict;
    switch (r.status) {
      case 'complete': {
        const met = r.finalGrade + 1e-9 >= s.target;
        verdict = `<p class="verdict ${met ? 'ok' : 'bad'}">Final grade: <strong>${f(r.finalGrade)}</strong>. ${
          met ? 'You hit' : 'You finished below'} your target of ${t}%.</p>`;
        break;
      }
      case 'secured':
        verdict = `<p class="verdict ok">Target secured. You've already locked in enough for ${t}%, even with a zero on the remaining ${fmt(r.remainingWeight)}%.</p>`;
        break;
      case 'unreachable':
        verdict = `<p class="verdict bad">A target of ${t}% is out of reach. Even perfect scores on what's left top out at ${f(r.bestPossible)}.</p>`;
        break;
      default:
        verdict = `<p class="verdict ${r.required >= 90 ? 'warn' : 'ok'}">To reach ${t}%, you need an average of <strong>${fmt(r.required)}%</strong> on the remaining ${fmt(r.remainingWeight)}% (${left}).</p>`;
    }
    return note + stats + verdict;
  }

  function rowHTML(c) {
    return `
      <tr data-component="${c.id}">
        <td><input data-field="name" value="${valueAttr(c.name)}" maxlength="100" aria-label="Component name"></td>
        <td><input data-field="weight" type="number" min="0" max="100" step="any" value="${valueAttr(c.weight)}" aria-label="Weight percent"></td>
        <td><input data-field="score" type="number" min="0" step="any" value="${valueAttr(c.score)}" placeholder="—" aria-label="Score"></td>
        <td><input data-field="maxScore" type="number" min="0.01" step="any" value="${valueAttr(c.maxScore)}" aria-label="Out of"></td>
        <td><button type="button" class="icon-btn" data-action="delete-component" aria-label="Delete ${esc(c.name)}">✕</button></td>
      </tr>`;
  }

  function cardHTML(s) {
    const rows = s.components.length
      ? s.components.map(rowHTML).join('')
      : '<tr class="empty-row"><td colspan="5">No components yet.</td></tr>';
    return `
      <article class="card" data-subject="${s.id}">
        <header class="card-head">
          <input class="subject-name" value="${valueAttr(s.name)}" maxlength="100" aria-label="Subject name">
          <label class="target">Target
            <input class="subject-target" type="number" min="0" max="100" step="any" value="${valueAttr(s.target)}"> %
          </label>
          <button type="button" class="icon-btn" data-action="delete-subject" aria-label="Delete subject">✕</button>
        </header>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Component</th><th>Weight %</th><th>Score</th><th>Out of</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <form class="add-component" autocomplete="off">
          <input name="name" placeholder="Component (e.g. Midterm)" maxlength="100" required aria-label="New component name">
          <input name="weight" type="number" min="0" max="100" step="any" placeholder="Weight %" required aria-label="New component weight percent">
          <input name="score" type="number" min="0" step="any" placeholder="Score" aria-label="Score, leave empty if not graded yet">
          <input name="maxScore" type="number" min="0.01" step="any" value="100" aria-label="Out of">
          <button type="submit">Add</button>
        </form>
        <div class="summary" aria-live="polite">${summaryHTML(s)}</div>
      </article>`;
  }

  function cardEl(s) {
    const t = document.createElement('template');
    t.innerHTML = cardHTML(s).trim();
    return t.content.firstElementChild;
  }

  function updateEmpty() { emptyEl.hidden = subjects.length > 0; }

  function renderAll() {
    subjectsEl.replaceChildren(...subjects.map(cardEl));
    updateEmpty();
  }

  function rerenderCard(s) {
    const el = cardEl(s);
    const old = findCard(s.id);
    if (old) old.replaceWith(el); else subjectsEl.append(el);
    updateEmpty();
    return el;
  }

  function updateSummary(s) {
    const card = findCard(s.id);
    if (card) $('.summary', card).innerHTML = summaryHTML(s);
  }

  // ---------- data ----------

  async function load() {
    try {
      subjects = await api('GET', '/api/subjects');
      renderAll();
    } catch (err) {
      showError(errMsg(err));
    }
  }

  // Copy what's typed in an input into local state so the summary updates live.
  function syncFromDom(el) {
    const card = el.closest('[data-subject]');
    if (!card) return null;
    const s = findSubject(card.dataset.subject);
    if (!s) return null;

    const row = el.closest('[data-component]');
    if (row) {
      const c = s.components.find((x) => x.id === Number(row.dataset.component));
      const field = el.dataset.field;
      if (!c || !field) return null;
      c[field] = field === 'name' ? el.value : num(el.value);
      return { s, c };
    }
    if (el.classList.contains('subject-name')) { s.name = el.value; return { s }; }
    if (el.classList.contains('subject-target')) { s.target = num(el.value); return { s }; }
    return null;
  }

  // ---------- events ----------

  subjectsEl.addEventListener('input', (e) => {
    const r = syncFromDom(e.target);
    if (r) updateSummary(r.s);
  });

  subjectsEl.addEventListener('change', async (e) => {
    const r = syncFromDom(e.target);
    if (!r) return;
    try {
      if (r.c) {
        await api('PUT', `/api/components/${r.c.id}`, {
          name: r.c.name, weight: r.c.weight, score: r.c.score, maxScore: r.c.maxScore,
        });
      } else {
        await api('PUT', `/api/subjects/${r.s.id}`, { name: r.s.name, target: r.s.target });
      }
    } catch (err) {
      showError(err.message);
      await load(); // put the screen back in sync with what's actually saved
    }
  });

  subjectsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('[data-subject]');
    const s = findSubject(card.dataset.subject);
    if (!s) return;

    try {
      if (btn.dataset.action === 'delete-subject') {
        if (!confirm(`Delete "${s.name}" and all its components?`)) return;
        await api('DELETE', `/api/subjects/${s.id}`);
        subjects = subjects.filter((x) => x !== s);
        card.remove();
        updateEmpty();
      } else if (btn.dataset.action === 'delete-component') {
        const id = Number(btn.closest('[data-component]').dataset.component);
        await api('DELETE', `/api/components/${id}`);
        s.components = s.components.filter((c) => c.id !== id);
        rerenderCard(s);
      }
    } catch (err) {
      showError(err.message);
    }
  });

  subjectsEl.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.add-component');
    if (!form) return;
    e.preventDefault();
    const s = findSubject(form.closest('[data-subject]').dataset.subject);
    const data = new FormData(form);
    try {
      const c = await api('POST', `/api/subjects/${s.id}/components`, {
        name: data.get('name'),
        weight: num(data.get('weight')),
        score: num(data.get('score')),
        maxScore: num(data.get('maxScore')) ?? 100,
      });
      s.components.push(c);
      $('input[name="name"]', rerenderCard(s).querySelector('.add-component')).focus();
    } catch (err) {
      showError(err.message);
    }
  });

  $('#subject-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = new FormData(form);
    try {
      const s = await api('POST', '/api/subjects', { name: data.get('name'), target: num(data.get('target')) });
      subjects.push(s);
      const card = rerenderCard(s);
      form.reset();
      $('.add-component input[name="name"]', card).focus();
    } catch (err) {
      showError(err.message);
    }
  });

  scaleEl.addEventListener('change', () => {
    scale = scaleEl.value;
    try { localStorage.setItem('scale', scale); } catch { /* ignore */ }
    subjects.forEach(updateSummary);
  });

  // ---------- accounts ----------

  let authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    tabLogin.setAttribute('aria-selected', String(isLogin));
    tabRegister.setAttribute('aria-selected', String(!isLogin));
    authSubmit.textContent = isLogin ? 'Log in' : 'Create account';
    authForm.elements.password.autocomplete = isLogin ? 'current-password' : 'new-password';
    showError('');
  }

  function showAuth() {
    subjects = [];
    subjectsEl.replaceChildren();
    appEl.hidden = true;
    accountEl.hidden = true;
    authEl.hidden = false;
  }

  function showApp(user) {
    whoamiEl.textContent = user.username;
    authEl.hidden = true;
    appEl.hidden = false;
    accountEl.hidden = false;
    return load();
  }

  tabLogin.addEventListener('click', () => setAuthMode('login'));
  tabRegister.addEventListener('click', () => setAuthMode('register'));

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(authForm);
    authSubmit.disabled = true;
    try {
      const user = await api('POST', `/api/${authMode}`, {
        username: data.get('username'),
        password: data.get('password'),
      });
      authForm.reset();
      showError('');
      await showApp(user);
    } catch (err) {
      showError(errMsg(err));
    } finally {
      authSubmit.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* already logged out */ }
    showError('');
    showAuth();
    authForm.elements.username.focus();
  });

  async function init() {
    try {
      await showApp(await api('GET', '/api/me'));
    } catch {
      showAuth();
    }
  }

  init();
})();
