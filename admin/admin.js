(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const API = new URL('api/', location.href.split('#')[0].replace(/[^/]*$/, ''));

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(new URL(path, API), opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error(data.error || 'Please log in.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const post = (p, body = {}) => api(p, { method: 'POST', body });
  const put = (p, body) => api(p, { method: 'PUT', body });
  const del = (p) => api(p, { method: 'DELETE' });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const dt = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const dur = (ms) => {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const ago = (t, now = Date.now()) => {
    if (!t) return 'never';
    const s = Math.round((now - t) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : dt(t);
  };
  const toLocalInput = (t) => {
    const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  };
  const REASONS = { student: 'Submitted', time_up: 'Time up (auto)', violations: 'Auto: violations', admin: 'Ended by admin' };
  const VIOLATION_LABELS = {
    tab_switch: 'Switched app/tab', window_blur: 'Left window', fullscreen_exit: 'Left full screen', copy_attempt: 'Tried to copy',
    paste_attempt: 'Tried to paste', context_menu: 'Right-click', print_screen: 'Print Screen key', devtools_key: 'Dev tools / save / print key',
    page_reload: 'Reloaded page', new_device_login: 'Logged in on another device',
  };

  // ---------- dialog ----------
  function dialog({ title, body, actions }) {
    const d = $('#dlg');
    $('#dlg-title').textContent = title;
    const b = $('#dlg-body');
    if (typeof body === 'string') b.innerHTML = body; else b.replaceChildren(body);
    $('#dlg-error').textContent = '';
    const bar = $('#dlg-actions');
    bar.replaceChildren();
    for (const a of actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${a.cls || 'ghost'}`;
      btn.textContent = a.label;
      btn.onclick = async () => {
        if (!a.run) return d.close();
        btn.disabled = true;
        try { const keep = await a.run(b); if (!keep) d.close(); } catch (e) { $('#dlg-error').textContent = e.message; } finally { btn.disabled = false; }
      };
      bar.append(btn);
    }
    d.showModal();
    return b;
  }
  $('#dlg-form').addEventListener('submit', (e) => e.preventDefault());
  $('#dlg-close').onclick = () => $('#dlg').close();
  const confirmBox = (title, text, label = 'Confirm', cls = 'danger') => new Promise((resolve) => {
    dialog({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel' }, { label, cls, run: () => { resolve(true); } }] });
    $('#dlg').addEventListener('close', () => resolve(false), { once: true });
  });

  // ---------- SheetJS (loaded only when needed) ----------
  let xlsxLoading;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    xlsxLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the Excel library. Please reload the page.')); };
      document.head.append(s);
    });
    return xlsxLoading;
  }
  async function exportXlsx(filename, sheetName, rows) {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName.slice(0, 31));
    XLSX.writeFile(wb, filename);
  }

  // ---------- auth ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await post('login', Object.fromEntries(new FormData(f)));
      f.reset();
      start();
    } catch (ex) { $('.error', f).textContent = ex.message; }
  });
  $('#btn-logout').onclick = async () => { await post('logout').catch(() => {}); showLogin(); };

  // ---------- tabs ----------
  let quizzes = [];
  let liveTimer = null;
  const loaders = {};
  function openTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
    clearInterval(liveTimer);
    history.replaceState(null, '', `#${name}`);
    loaders[name]?.();
  }
  $$('#tabs button').forEach((b) => { b.onclick = () => openTab(b.dataset.tab); });

  async function refreshQuizzes() {
    quizzes = await api('quizzes');
    for (const sel of $$('.quiz-picker')) {
      const keep = sel.value;
      sel.innerHTML = quizzes.length
        ? quizzes.map((q) => `<option value="${q.id}">${esc(q.title)}</option>`).join('')
        : '<option value="">No quizzes yet</option>';
      if (keep && quizzes.some((q) => String(q.id) === keep)) sel.value = keep;
    }
    return quizzes;
  }
  function pickQuiz(id) { for (const sel of $$('.quiz-picker')) sel.value = String(id); }

  function quizState(q, now = Date.now()) {
    if (!q.published) return '<span class="badge">Draft</span>';
    if (now < q.start_at) return '<span class="badge info">Scheduled</span>';
    if (now < q.end_at) return '<span class="badge good">Live now</span>';
    return '<span class="badge">Ended</span>';
  }

  // ---------- dashboard ----------
  loaders.dashboard = async () => {
    const s = await api('stats');
    $('#stat-tiles').innerHTML = [
      [s.profiles, 'Student profiles'], [s.saidPaid, 'Said they paid ₹50'], [s.liveAttempts, 'Doing the quiz now'], [s.submitted, 'Completed'],
    ].map(([n, l]) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`).join('');
    $('#upcoming').innerHTML = s.upcoming.length
      ? `<table><tr><th>Quiz</th><th>Opens</th><th>Closes</th><th>Status</th></tr>${s.upcoming.map((q) =>
        `<tr><td>${esc(q.title)}</td><td>${dt(q.start_at)}</td><td>${dt(q.end_at)}</td><td>${quizState(q, s.serverNow)}</td></tr>`).join('')}</table>`
      : '<p class="empty">No upcoming quizzes. Create one in the Quizzes tab.</p>';
  };

  // ---------- quizzes ----------
  loaders.quizzes = async () => {
    await refreshQuizzes();
    const t = $('#quiz-table');
    if (!quizzes.length) { t.innerHTML = '<tr><td class="empty">No quizzes yet.</td></tr>'; return; }
    t.innerHTML = `<tr><th>Quiz</th><th>Window</th><th>Duration</th><th>Questions</th><th>Attempts</th><th>Status</th><th></th></tr>${quizzes.map((q) => `
      <tr>
        <td><b>${esc(q.title)}</b></td>
        <td class="small">${dt(q.start_at)}<br>to ${dt(q.end_at)}</td>
        <td class="num">${q.duration_min} min</td>
        <td class="num">${q.questions_per_attempt > 0 ? `${Math.min(q.questions_per_attempt, q.question_count)} of ${q.question_count}` : q.question_count}</td>
        <td class="num">${q.submitted_count}/${q.attempt_count}</td>
        <td>${quizState(q)}</td>
        <td>
          <button class="btn sm ${q.published ? '' : 'primary'}" data-act="publish" data-id="${q.id}">${q.published ? 'Unpublish' : 'Publish'}</button>
          <button class="btn sm" data-act="questions" data-id="${q.id}">Questions</button>
          <button class="btn sm" data-act="edit" data-id="${q.id}">Edit</button>
          <button class="btn sm" data-act="results" data-id="${q.id}">Results</button>
          <button class="btn sm danger" data-act="delete" data-id="${q.id}">Delete</button>
        </td>
      </tr>`).join('')}`;
    $('#quiz-hint').hidden = !quizzes.some((q) => !q.published && q.end_at > Date.now());
  };
  $('#quiz-table').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const q = quizzes.find((x) => x.id === Number(b.dataset.id));
    if (b.dataset.act === 'publish') {
      try {
        await put(`quizzes/${q.id}`, {
          title: q.title, instructions: q.instructions, startAt: q.start_at, endAt: q.end_at, durationMin: q.duration_min,
          questionsPerAttempt: q.questions_per_attempt, maxViolations: q.max_violations, published: !q.published,
        });
        toast(q.published ? 'Quiz unpublished: students can no longer see it' : 'Quiz published: students can now see it');
        loaders.quizzes();
      } catch (ex) { toast(ex.message); }
    }
    if (b.dataset.act === 'edit') quizForm(q);
    if (b.dataset.act === 'questions') { pickQuiz(q.id); openTab('questions'); }
    if (b.dataset.act === 'results') { pickQuiz(q.id); openTab('results'); }
    if (b.dataset.act === 'delete') {
      if (!(await confirmBox('Delete quiz?', `"${q.title}" and all its questions, attempts and results will be deleted permanently.`, 'Delete'))) return;
      await del(`quizzes/${q.id}`);
      toast('Quiz deleted');
      loaders.quizzes();
    }
  });
  $('#btn-new-quiz').onclick = () => quizForm(null);

  function quizForm(q) {
    const now = Date.now();
    const start = q?.start_at ?? Math.ceil((now + 86400000) / 3600000) * 3600000;
    const v = q || { title: 'Aaroh Space & Tech Quiz', duration_min: 60, questions_per_attempt: 30, max_violations: 3, instructions: '', published: 0, end_at: start + 90 * 60000 };
    dialog({
      title: q ? 'Edit quiz' : 'New quiz',
      body: `
        <label>Title<input name="title" value="${esc(v.title)}" maxlength="120"></label>
        <div class="form-grid">
          <label>Duration (minutes)<input name="durationMin" type="number" min="1" max="600" value="${v.duration_min}"></label>
          <label>Opens at (students can start from)<input name="startAt" type="datetime-local" value="${toLocalInput(start)}"></label>
          <label>Closes at (everything auto-submits)<input name="endAt" type="datetime-local" value="${toLocalInput(v.end_at)}"></label>
          <label>Questions per student (0 = all)<input name="questionsPerAttempt" type="number" min="0" value="${v.questions_per_attempt}"></label>
          <label>Auto-submit after this many switches (0 = never)<input name="maxViolations" type="number" min="0" value="${v.max_violations}"></label>
        </div>
        <label>Extra instructions for students (optional)<textarea name="instructions" maxlength="4000">${esc(v.instructions)}</textarea></label>
        <label class="check"><input type="checkbox" name="published" ${v.published ? 'checked' : ''}> Published (students can see it)</label>
        <p class="muted small">Example: opens 7:00 PM, duration 60 minutes, closes 8:30 PM. A student who starts at 7:00 gets the full hour. A student who starts at 7:50 gets only until 8:30. At 8:30 every unfinished quiz is submitted automatically.</p>`,
      actions: [
        { label: 'Cancel' },
        {
          label: q ? 'Save' : 'Create quiz', cls: 'primary', run: async (b) => {
            const f = (n) => $(`[name=${n}]`, b);
            const body = {
              title: f('title').value, durationMin: f('durationMin').value,
              startAt: new Date(f('startAt').value).getTime(), endAt: new Date(f('endAt').value).getTime(),
              questionsPerAttempt: f('questionsPerAttempt').value, maxViolations: f('maxViolations').value,
              instructions: f('instructions').value, published: f('published').checked,
            };
            if (q) await put(`quizzes/${q.id}`, body); else await post('quizzes', body);
            toast(q ? 'Quiz saved' : 'Quiz created');
            loaders.quizzes();
          },
        },
      ],
    });
  }

  // ---------- questions ----------
  let questions = [];
  loaders.questions = async () => {
    await refreshQuizzes();
    const id = $('#q-quiz').value;
    if (!id) { $('#q-list').innerHTML = '<p class="empty">Create a quiz first.</p>'; $('#q-summary').textContent = ''; return; }
    questions = await api(`quizzes/${id}/questions`);
    const cats = {};
    questions.forEach((q) => { cats[q.category] = (cats[q.category] || 0) + 1; });
    $('#q-summary').textContent = `${questions.length} questions in the pool${Object.keys(cats).length ? ': ' + Object.entries(cats).map(([c, n]) => `${c} ${n}`).join(', ') : ''}.`;
    $('#q-list').innerHTML = questions.length ? questions.map((q, i) => `
      <div class="qitem">
        <div>
          <div class="qt">${i + 1}. ${esc(q.text)}</div>
          ${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}
          <ol type="A">${q.options.map((o, j) => `<li class="${j === q.correct ? 'correct' : ''}">${esc(o)}</li>`).join('')}</ol>
          <div class="qmeta"><span class="badge info">${esc(q.category)}</span><span class="badge">${esc(q.difficulty)}</span><span class="badge">${q.marks} mark${q.marks === 1 ? '' : 's'}</span></div>
        </div>
        <div><button class="btn sm" data-edit="${q.id}">Edit</button><button class="btn sm danger" data-del="${q.id}">Delete</button></div>
      </div>`).join('') : '<p class="empty">No questions yet. Add them one by one or bulk upload an Excel file.</p>';
  };
  $('#q-quiz').onchange = () => loaders.questions();
  $('#btn-new-q').onclick = () => { if ($('#q-quiz').value) questionForm(null); };
  $('#q-list').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const rm = e.target.closest('[data-del]');
    if (edit) questionForm(questions.find((q) => q.id === Number(edit.dataset.edit)));
    if (rm && await confirmBox('Delete question?', 'This question will be removed from the quiz.', 'Delete')) {
      await del(`questions/${rm.dataset.del}`);
      loaders.questions();
    }
  });

  function questionForm(q) {
    const v = q || { text: '', options: ['', '', '', ''], correct: 0, category: 'Space', difficulty: 'Medium', marks: 1, image: null };
    let image = v.image;
    const body = dialog({
      title: q ? 'Edit question' : 'Add question',
      body: `
        <label>Question<textarea name="text" maxlength="2000">${esc(v.text)}</textarea></label>
        <div class="stack"><span class="muted small">Options (select the correct one)</span><div id="opts" class="stack"></div>
          <button type="button" class="btn ghost sm" id="add-opt" style="align-self:flex-start">+ Add option</button></div>
        <div class="form-grid">
          <label>Category<input name="category" list="cat-list" value="${esc(v.category)}" maxlength="40">
            <datalist id="cat-list"><option>Space</option><option>Technology</option><option>Science</option><option>General</option></datalist></label>
          <label>Difficulty<select name="difficulty"><option>Easy</option><option>Medium</option><option>Hard</option></select></label>
          <label>Marks<input name="marks" type="number" min="0.5" step="0.5" value="${v.marks}"></label>
        </div>
        <div class="stack"><span class="muted small">Image (optional, under 2 MB)</span>
          <div class="opt-row"><input type="file" accept="image/*" id="q-img-file"><button type="button" class="btn ghost sm" id="q-img-clear">Remove image</button></div>
          <img id="q-img-prev" style="max-height:120px;border-radius:8px;align-self:flex-start" alt=""></div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save question', cls: 'primary', run: async (b) => {
            const options = $$('#opts input[type=text]', b).map((i) => i.value.trim());
            const correctIdx = $$('#opts input[type=radio]', b).findIndex((r) => r.checked);
            // Drop empty options but keep the correct answer pointing at the right one.
            const kept = options.map((o, i) => ({ o, i })).filter((x) => x.o);
            const payload = {
              text: $('[name=text]', b).value, options: kept.map((x) => x.o), correct: kept.findIndex((x) => x.i === correctIdx),
              category: $('[name=category]', b).value, difficulty: $('[name=difficulty]', b).value, marks: $('[name=marks]', b).value, image,
            };
            if (q) await put(`questions/${q.id}`, payload); else await post(`quizzes/${$('#q-quiz').value}/questions`, payload);
            toast('Question saved');
            await loaders.questions();
            if (!q) { questionForm(null); return true; } // keep adding
          },
        },
      ],
    });
    $('[name=difficulty]', body).value = v.difficulty;
    const opts = $('#opts', body);
    const addOpt = (text = '', checked = false) => {
      const n = opts.children.length;
      if (n >= 6) return;
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML = `<input type="radio" name="correct" ${checked ? 'checked' : ''} aria-label="Correct answer"><b>${'ABCDEF'[n]}</b><input type="text" maxlength="500">`;
      $('input[type=text]', row).value = text;
      opts.append(row);
    };
    v.options.forEach((o, i) => addOpt(o, i === v.correct));
    $('#add-opt', body).onclick = () => addOpt();
    const prev = $('#q-img-prev', body);
    const showImg = () => { prev.hidden = !image; if (image) prev.src = image; };
    showImg();
    $('#q-img-clear', body).onclick = () => { image = null; showImg(); };
    $('#q-img-file', body).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      try { image = (await post('upload-image', { dataUrl })).url; showImg(); } catch (ex) { $('#dlg-error').textContent = ex.message; }
    };
  }

  const TEMPLATE_HEADERS = ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct (A/B/C/D)', 'Category', 'Difficulty', 'Marks', 'Image URL'];
  $('#btn-template').onclick = async () => {
    try {
      const XLSX = await loadXLSX();
      const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS,
        ['Which planet is known as the Red Planet?', 'Venus', 'Mars', 'Jupiter', 'Mercury', 'B', 'Space', 'Easy', 1, ''],
        ['What does CPU stand for?', 'Central Processing Unit', 'Computer Power Unit', 'Core Program Utility', 'Central Peripheral Unit', 'A', 'Technology', 'Easy', 1, '']]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Questions');
      XLSX.writeFile(wb, 'aaroh-question-template.xlsx');
    } catch (ex) { toast(ex.message); }
  };

  $('#bulk-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !$('#q-quiz').value) return;
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const pick = (r, ...names) => {
        for (const k of Object.keys(r)) if (names.some((n) => k.trim().toLowerCase().startsWith(n))) return String(r[k]).trim();
        return '';
      };
      const parsed = rows.map((r) => {
        const options = ['option a', 'option b', 'option c', 'option d', 'option e', 'option f'].map((n) => pick(r, n)).filter(Boolean);
        const c = pick(r, 'correct').toUpperCase();
        return {
          text: pick(r, 'question'), options, correct: /^[A-F]$/.test(c) ? 'ABCDEF'.indexOf(c) : Number(c) - 1,
          category: pick(r, 'category') || 'General', difficulty: pick(r, 'difficulty') || 'Medium',
          marks: pick(r, 'marks') || 1, image: pick(r, 'image') || null,
        };
      }).filter((r) => r.text);
      if (!parsed.length) throw new Error('No questions found. Use the template columns: ' + TEMPLATE_HEADERS.join(', '));
      const res = await post(`quizzes/${$('#q-quiz').value}/questions/bulk`, { rows: parsed });
      await loaders.questions();
      dialog({
        title: 'Bulk upload finished',
        body: `<p>Added <b>${res.added}</b> question${res.added === 1 ? '' : 's'}.</p>${res.errors.length ? `<p class="error">${res.errors.length} row(s) skipped:</p><div class="log">${res.errors.map(esc).join('<br>')}</div>` : ''}`,
        actions: [{ label: 'OK', cls: 'primary' }],
      });
    } catch (ex) { toast(ex.message); }
  };

  // ---------- students (profiles created when they enter their details) ----------
  const PROGRESS = { waiting: ['Waiting', ''], doing: ['Doing', 'info'], completed: ['Completed', 'good'] };
  const paidBadge = (p) => (p ? '<span class="badge good">Yes</span>' : '<span class="badge bad">No</span>');
  let students = [];
  let searchT;
  loaders.students = async () => {
    const qs = new URLSearchParams({ q: $('#s-search').value, progress: $('#s-progress').value });
    students = await api(`students?${qs}`);
    const n = (p) => students.filter((s) => s.progress === p).length;
    $('#s-count').textContent = `${students.length} student${students.length === 1 ? '' : 's'} · ${n('waiting')} waiting · ${n('doing')} doing · ${n('completed')} completed`;
    $('#student-table').innerHTML = students.length
      ? `<tr><th>Name</th><th>Mobile</th><th>School</th><th>Paid ₹50?</th><th>Profile created</th><th>Status</th><th>Score</th><th>Right / Wrong / Flagged</th><th></th></tr>${students.map((s) => `
      <tr>
        <td>${s.attempt_id ? `<a href="#" data-view="${s.attempt_id}"><b>${esc(s.name)}</b></a>` : `<b>${esc(s.name)}</b>`}${s.status === 'blocked' ? ' <span class="badge bad">Blocked</span>' : ''}</td>
        <td class="num">${esc(s.phone)}</td>
        <td>${esc(s.school)}</td>
        <td>${paidBadge(s.paid)}</td>
        <td class="small">${dt(s.created_at)}</td>
        <td><span class="badge ${PROGRESS[s.progress][1]}">${PROGRESS[s.progress][0]}</span>${s.progress === 'completed' ? `<div class="muted small">${dt(s.submitted_at)}</div>` : ''}</td>
        <td class="num">${s.progress === 'completed' ? `<b>${s.score}</b> / ${s.total_marks}` : ''}</td>
        <td class="num">${s.progress === 'completed' ? `${s.correct_count} / ${s.wrong_count} / ${s.flagged_count}` : ''}</td>
        <td>
          ${s.attempt_id ? `<button class="btn sm" data-view="${s.attempt_id}">Details</button>` : ''}
          <button class="btn sm" data-act="${s.status === 'blocked' ? 'active' : 'blocked'}" data-id="${s.id}">${s.status === 'blocked' ? 'Unblock' : 'Block'}</button>
          <button class="btn sm danger" data-act="delete" data-id="${s.id}" title="Delete the profile so this phone can start again">Delete</button>
        </td>
      </tr>`).join('')}`
      : '<tr><td class="empty">No students yet. Profiles appear here when students enter their details on the quiz site.</td></tr>';
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (!$('#tab-students').hidden && !$('#dlg').open) loaders.students().catch(() => {}); }, 5000);
  };
  $('#s-search').oninput = () => { clearTimeout(searchT); searchT = setTimeout(loaders.students, 300); };
  $('#s-progress').onchange = () => loaders.students();
  $('#student-table').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { e.preventDefault(); attemptDetail(v.dataset.view); return; }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const s = students.find((x) => x.id === Number(b.dataset.id));
    const act = b.dataset.act;
    if (act === 'active' || act === 'blocked') { await put(`students/${s.id}`, { status: act }); toast(`${s.name}: ${act === 'blocked' ? 'blocked' : 'unblocked'}`); }
    if (act === 'delete') {
      if (!(await confirmBox('Delete student?', `${s.name}'s profile, answers and score will be deleted. This phone number can then start the quiz again.`, 'Delete'))) return;
      await del(`students/${s.id}`);
    }
    loaders.students();
  });
  $('#btn-export-students').onclick = () => exportXlsx('aaroh-students.xlsx', 'Students', students.map((s) => ({
    Name: s.name, Mobile: s.phone, School: s.school, 'Paid Rs 50 (says)': s.paid ? 'Yes' : 'No',
    'Profile created': dt(s.created_at), Status: PROGRESS[s.progress][0], Quiz: s.quiz_title || '',
    Score: s.progress === 'completed' ? s.score : '', 'Total marks': s.progress === 'completed' ? s.total_marks : '',
    Right: s.correct_count ?? '', Wrong: s.wrong_count ?? '', Unanswered: s.unanswered_count ?? '', 'Flagged for review': s.flagged_count ?? '',
    Started: dt(s.started_at), Submitted: dt(s.submitted_at), 'Ended by': REASONS[s.submit_reason] || '', Warnings: s.violations ?? '',
  }))).catch((ex) => toast(ex.message));

  // ---------- approved list (students who registered and paid) ----------
  let approved = [];
  const renderApproved = () => {
    const q = $('#a-search').value.trim().toLowerCase();
    const rows = q ? approved.filter((a) => `${a.name} ${a.school} ${a.phone}`.toLowerCase().includes(q)) : approved;
    const entered = approved.filter((a) => a.entered).length;
    $('#a-status').innerHTML = approved.length
      ? `<b>${approved.length}</b> approved number${approved.length === 1 ? '' : 's'} · ${entered} entered. Only these numbers can log in to the quiz.`
      : 'The list is empty, so <b>anyone</b> can log in. Upload your paid list to allow only registered students.';
    $('#approved-table').innerHTML = rows.length
      ? `<tr><th>Name</th><th>Mobile</th><th>School</th><th>Entered</th><th></th></tr>${rows.map((a) => `
      <tr>
        <td><b>${esc(a.name) || '<span class="muted">—</span>'}</b></td>
        <td class="num">${esc(a.phone)}</td>
        <td>${esc(a.school)}</td>
        <td>${a.entered ? '<span class="badge good">Yes</span>' : '<span class="badge">Not yet</span>'}</td>
        <td><button class="btn sm danger" data-phone="${esc(a.phone)}">Remove</button></td>
      </tr>`).join('')}`
      : `<tr><td class="empty">${approved.length ? 'No match.' : 'No approved students yet.'}</td></tr>`;
  };
  loaders.approved = async () => { approved = await api('approved'); renderApproved(); };
  $('#a-search').oninput = renderApproved;

  $('#approved-table').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-phone]');
    if (!b) return;
    const a = approved.find((x) => x.phone === b.dataset.phone);
    if (!(await confirmBox('Remove from list?', `${a.name || a.phone} (${a.phone}) will no longer be able to log in.`, 'Remove'))) return;
    await del(`approved/${a.phone}`);
    loaders.approved();
  });

  $('#btn-a-add').onclick = () => dialog({
    title: 'Add student',
    body: `<label>Name<input name="name" maxlength="80"></label>
      <label>Mobile number<input name="phone" inputmode="numeric" maxlength="14"></label>
      <label>School (optional)<input name="school" maxlength="150"></label>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Add', cls: 'primary', run: async (b) => {
        await post('approved', { name: $('[name=name]', b).value, phone: $('[name=phone]', b).value, school: $('[name=school]', b).value });
        toast('Added to the approved list');
        loaders.approved();
      },
    }],
  });

  $('#btn-a-clear').onclick = async () => {
    if (!(await confirmBox('Clear the approved list?', 'Every number will be removed and anyone will be able to log in again until you upload a new list.', 'Clear list'))) return;
    await del('approved');
    toast('Approved list cleared');
    loaders.approved();
  };

  $('#btn-a-template').onclick = async () => {
    try {
      const XLSX = await loadXLSX();
      const ws = XLSX.utils.aoa_to_sheet([['Name', 'Mobile', 'School'], ['Anika Menon', '9876543210', 'Govt HSS Kottayam']]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Approved');
      XLSX.writeFile(wb, 'aaroh-approved-list-template.xlsx');
    } catch (ex) { toast(ex.message); }
  };

  $('#a-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
      // Column names vary between registration sheets, so match on the words they usually contain, best word
      // first, skipping columns that contain an excluded word ("School name" is not the student's name).
      const pick = (r, words, not = []) => {
        const keys = Object.keys(r).map((k) => [k, k.trim().toLowerCase()]).filter(([, l]) => !not.some((n) => l.includes(n)));
        for (const w of words) for (const [k, l] of keys) if (l.includes(w)) return String(r[k]).trim();
        return '';
      };
      const parsed = rows.map((r) => ({
        name: pick(r, ['name', 'student'], ['school', 'parent', 'father', 'mother', 'guardian']),
        phone: pick(r, ['mobile', 'phone', 'whatsapp', 'contact']),
        school: pick(r, ['school']),
      })).filter((r) => r.name || r.phone);
      if (!parsed.length) throw new Error('No students found. Use the columns Name, Mobile and School (download the template).');
      const res = await post('approved/bulk', { rows: parsed });
      await loaders.approved();
      dialog({
        title: 'Upload finished',
        body: `<p>Added or updated <b>${res.added}</b> student${res.added === 1 ? '' : 's'}.</p>${res.errors.length ? `<p class="error">${res.errors.length} row(s) skipped:</p><div class="log">${res.errors.map(esc).join('<br>')}</div>` : ''}`,
        actions: [{ label: 'OK', cls: 'primary' }],
      });
    } catch (ex) { toast(ex.message); }
  };

  // ---------- live ----------
  loaders.live = async () => {
    await refreshQuizzes();
    const load = async () => {
      const id = $('#l-quiz').value;
      if (!id) return;
      const d = await api(`quizzes/${id}/live`);
      $('#l-summary').textContent = `${d.rows.length} taking the quiz now · ${d.submitted} submitted`;
      $('#live-table').innerHTML = d.rows.length
        ? `<tr><th>Student</th><th>School</th><th>Answered</th><th>Flagged</th><th>Time left</th><th>Warnings</th><th>Last seen</th><th></th></tr>${d.rows.map((r) => `
        <tr>
          <td><b>${esc(r.name)}</b><div class="muted small">${esc(r.phone)}</div></td>
          <td>${esc(r.school)}</td>
          <td class="num">${r.answered}/${r.total}</td>
          <td class="num">${r.flagged}</td>
          <td class="num">${dur(Math.max(0, r.deadline_at - d.serverNow))}</td>
          <td>${r.violations ? `<span class="badge ${r.violations >= 2 ? 'bad' : 'warn'}">${r.violations}</span>` : '<span class="badge good">0</span>'}</td>
          <td class="small">${ago(r.last_seen, d.serverNow)}</td>
          <td><button class="btn sm" data-view="${r.id}">Details</button><button class="btn sm danger" data-end="${r.id}">End now</button></td>
        </tr>`).join('')}`
        : '<tr><td class="empty">Nobody is taking this quiz right now.</td></tr>';
    };
    $('#l-quiz').onchange = load;
    await load();
    clearInterval(liveTimer);
    liveTimer = setInterval(() => load().catch(() => {}), 5000);
  };
  $('#live-table').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    const end = e.target.closest('[data-end]');
    if (v) attemptDetail(v.dataset.view);
    if (end && await confirmBox('End this attempt?', 'Their saved answers will be submitted now.', 'End now')) {
      await post(`attempts/${end.dataset.end}/submit`);
      loaders.live();
    }
  });

  // ---------- results ----------
  let results = [];
  loaders.results = async () => {
    await refreshQuizzes();
    const id = $('#r-quiz').value;
    if (!id) { $('#result-table').innerHTML = '<tr><td class="empty">Create a quiz first.</td></tr>'; return; }
    results = await api(`quizzes/${id}/results`);
    renderResults();
  };
  function renderResults() {
    const top = Number($('#r-top').value) || 0;
    $('#result-table').innerHTML = results.length
      ? `<tr><th>#</th><th>Student</th><th>School</th><th>Paid?</th><th>Score</th><th>Right</th><th>Wrong</th><th>Unanswered</th><th>Flagged</th><th>Time taken</th><th>Warnings</th><th>Ended by</th><th></th></tr>${results.map((r) => `
      <tr class="${r.rank <= top ? 'short' : ''}">
        <td class="num"><b>${r.rank}</b></td>
        <td><b>${esc(r.name)}</b><div class="muted small">${esc(r.phone)}</div></td>
        <td>${esc(r.school)}</td>
        <td>${paidBadge(r.paid)}</td>
        <td class="num"><b>${r.score}</b> / ${r.total_marks}</td>
        <td class="num">${r.correct_count}</td><td class="num">${r.wrong_count}</td><td class="num">${r.unanswered_count}</td><td class="num">${r.flagged_count}</td>
        <td class="num">${dur(r.time_taken_ms)}</td>
        <td>${r.violations ? `<span class="badge ${r.violations >= 2 ? 'bad' : 'warn'}">${r.violations}</span>` : '<span class="badge good">0</span>'}</td>
        <td class="small">${REASONS[r.submit_reason] || r.submit_reason}</td>
        <td><button class="btn sm" data-view="${r.id}">Details</button></td>
      </tr>`).join('')}`
      : '<tr><td class="empty">No submissions yet.</td></tr>';
  }
  $('#r-quiz').onchange = () => loaders.results();
  $('#r-top').oninput = renderResults;
  $('#result-table').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) attemptDetail(v.dataset.view);
  });
  const resultRow = (r) => ({
    Rank: r.rank, Name: r.name, Mobile: r.phone, School: r.school, 'Paid Rs 50 (says)': r.paid ? 'Yes' : 'No',
    Score: r.score, 'Total marks': r.total_marks, Right: r.correct_count, Wrong: r.wrong_count, Unanswered: r.unanswered_count,
    'Flagged for review': r.flagged_count, Questions: r.questions, 'Profile created': dt(r.entered_at), Started: dt(r.started_at),
    'Time taken': dur(r.time_taken_ms), Warnings: r.violations, 'Ended by': REASONS[r.submit_reason] || r.submit_reason, Submitted: dt(r.submitted_at),
  });
  const quizName = () => (quizzes.find((q) => String(q.id) === $('#r-quiz').value)?.title || 'quiz').replace(/[^\w-]+/g, '-');
  $('#btn-export-all').onclick = () => exportXlsx(`${quizName()}-results.xlsx`, 'Results', results.map(resultRow)).catch((ex) => toast(ex.message));
  $('#btn-export-short').onclick = () => {
    const top = Number($('#r-top').value) || 0;
    exportXlsx(`${quizName()}-shortlist-top${top}.xlsx`, 'Shortlist', results.filter((r) => r.rank <= top).map(resultRow)).catch((ex) => toast(ex.message));
  };

  async function attemptDetail(id) {
    const a = await api(`attempts/${id}`);
    const body = dialog({
      title: a.name,
      body: `
        <p class="muted">${esc(a.school)} · ${esc(a.phone)} · Paid ₹50: ${a.paid ? 'Yes (says)' : 'No'} · ${esc(a.quiz_title)}</p>
        <p class="muted small">Profile created ${dt(a.entered_at)} · Started ${dt(a.started_at)}${a.submitted_at ? ` · Submitted ${dt(a.submitted_at)} (${esc(REASONS[a.submit_reason] || a.submit_reason)})` : ' · Still doing the quiz'}</p>
        <div class="tiles">
          <div class="tile"><b>${a.status === 'submitted' ? a.score : '—'}</b><span>Score${a.total_marks ? ` / ${a.total_marks}` : ''}</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.isCorrect).length}</b><span>Right</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.chosen != null && !q.isCorrect).length}</b><span>Wrong</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.chosen == null).length}</b><span>Unanswered</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.flagged).length}</b><span>Flagged</span></div>
          <div class="tile"><b>${a.violations}</b><span>Warnings</span></div>
          <div class="tile"><b>${a.time_taken_ms != null ? dur(a.time_taken_ms) : '—'}</b><span>Time taken</span></div>
        </div>
        <h3>Activity log</h3>
        <div class="log">${a.violationLog.length ? `<table>${a.violationLog.map((v) => `<tr><td class="small">${dt(v.at)}</td><td>${esc(VIOLATION_LABELS[v.type] || v.type)}</td><td class="muted small">${esc(v.detail || '')}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing suspicious recorded.</p>'}</div>
        <h3>Answers</h3>
        <div class="log"><table><tr><th>#</th><th>Question</th><th>Their answer</th><th>Correct answer</th><th>Flagged</th></tr>${a.questions.map((q) => `
          <tr><td>${q.n}</td><td class="small">${esc(q.text)}</td>
          <td>${q.chosen == null ? '<span class="muted">—</span>' : `<span class="badge ${q.isCorrect ? 'good' : 'bad'}">${esc(q.chosen)}</span>`}</td>
          <td class="small">${esc(q.correctAnswer)}</td><td>${q.flagged ? '<span class="badge warn">★</span>' : ''}</td></tr>`).join('')}</table></div>`,
      actions: [
        {
          label: 'Allow retake', cls: 'danger', run: async () => {
            if (!confirm(`Delete this attempt so ${a.name} can take the quiz again? Their current answers and score will be lost.`)) return true;
            await del(`attempts/${a.id}`);
            toast('Attempt deleted. The student can start again.');
            loaders.results(); loaders.students();
          },
        },
        { label: 'Close', cls: 'primary' },
      ],
    });
    body.scrollTop = 0;
  }

  // ---------- settings ----------
  loaders.settings = async () => {
    const s = await api('settings');
    const f = $('#form-settings');
    f.siteName.value = s.siteName;
    $('#admin-url').textContent = location.href.split('#')[0];
  };
  $('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await put('settings', { siteName: f.siteName.value });
    $('.ok', f).textContent = 'Saved.';
    setTimeout(() => { $('.ok', f).textContent = ''; }, 2000);
  });
  $('#form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('.error', f).textContent = ''; $('.ok', f).textContent = '';
    try { await post('password', Object.fromEntries(new FormData(f))); f.reset(); $('.ok', f).textContent = 'Password changed.'; } catch (ex) { $('.error', f).textContent = ex.message; }
  });

  // ---------- boot ----------
  async function start() {
    try { await api('me'); } catch { return; }
    $('#login').hidden = true;
    $('#app').hidden = false;
    await refreshQuizzes();
    const tab = location.hash.slice(1);
    openTab(loaders[tab] ? tab : 'dashboard');
  }
  // Typing #results etc. in the address bar (or Back/Forward) switches the tab too.
  window.addEventListener('hashchange', () => {
    const tab = location.hash.slice(1);
    if (!$('#app').hidden && loaders[tab]) openTab(tab);
  });
  start();
})();
