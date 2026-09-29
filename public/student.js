(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let config = {};
  let me = null;
  let lobbyTimer = null;

  // ---------- api ----------
  class ApiError extends Error {
    constructor(status, body) { super(body.error || 'Request failed'); this.status = status; this.code = body.code; }
  }
  async function api(path, body) {
    const opts = { method: body === undefined ? 'GET' : 'POST', headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(`/api${path}`, opts); } catch { throw new ApiError(0, { error: 'No internet connection. Please check your network.' }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new ApiError(res.status, data);
      if (err.code === 'SESSION_REPLACED' || err.code === 'BLOCKED') { showMessage('Logged out', err.message); }
      throw err;
    }
    return data;
  }

  // ---------- views ----------
  function show(name) {
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    document.body.classList.toggle('on-landing', name === 'home' || name === 'enter');
    // During the quiz the logos move into the compact sticky bar to leave room for the question.
    document.body.classList.toggle('in-quiz', name === 'quiz');
    window.scrollTo(0, 0);
    if (name !== 'lobby') clearInterval(lobbyTimer);
  }
  function showMessage(title, text) {
    quiz.stop();
    $('#msg-title').textContent = title;
    $('#msg-text').textContent = text;
    show('message');
  }

  function modal(title, text, actions, warn = false) {
    const m = $('#modal');
    m.classList.toggle('warn', warn);
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    const box = $('#modal-actions');
    box.replaceChildren();
    return new Promise((resolve) => {
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = `btn ${a.cls || 'ghost'}`;
        b.textContent = a.label;
        b.onclick = () => { m.hidden = true; resolve(a.value); };
        box.append(b);
      }
      m.hidden = false;
    });
  }

  // Hide a logo if its image file is missing.
  $$('.site-head img, .qbar-logo').forEach((img) => img.addEventListener('error', () => { img.hidden = true; }));

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

  const fmt = (ms) => {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // "Tue, 29 Sept, 7:00 pm – 9:00 pm" (end date repeated only if it is a different day)
  const windowText = (a, b) => (new Date(a).toDateString() === new Date(b).toDateString() ? `${when(a)} – ${clock(b)}` : `${when(a)} – ${when(b)}`);
  const inText = (ms) => {
    const m = Math.ceil(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `Opens in ${d}d ${h}h` : h ? `Opens in ${h}h ${m % 60}m` : `Opens in ${m} min`;
  };

  // ---------- announcements (landing page) ----------
  async function loadSchedule() {
    const list = $('#announce-list');
    const el = (tag, className, textContent = '') => Object.assign(document.createElement(tag), { className, textContent });
    const empty = (text) => list.replaceChildren(el('li', 'announce-empty', text));
    try {
      const { serverNow, quizzes } = await api('/schedule');
      if (!quizzes.length) return empty('No quiz has been announced yet. Please check back soon.');
      list.replaceChildren(...quizzes.map((q) => {
        const live = serverNow >= q.startAt;
        const info = el('div', 'announce-info');
        info.append(el('span', 'announce-name', q.title), el('span', 'announce-when', windowText(q.startAt, q.endAt)),
          el('span', 'announce-meta', `${q.questionCount} questions · ${q.durationMin} minutes`));
        const li = el('li', 'announce-item');
        li.append(info, el('span', live ? 'pill live' : 'pill', live ? 'Live now' : inText(q.startAt - serverNow)));
        return li;
      }));
    } catch { empty('Could not load the schedule. Please refresh the page.'); }
  }
  loadSchedule();
  setInterval(() => { if (!$('#view-home').hidden) loadSchedule(); }, 60_000);

  // ---------- enter details ----------
  const enterForm = $('#form-enter');
  enterForm.elements.phone.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  enterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', enterForm);
    err.textContent = '';
    const btn = $('button[type=submit]', enterForm);
    btn.disabled = true;
    try {
      await api('/enter', Object.fromEntries(new FormData(enterForm)));
      enterForm.reset();
      await loadLobby();
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });

  // ---------- lobby ----------
  async function loadLobby() {
    me = await api('/me');
    const s = me.student;
    $('#lobby-name').textContent = s.name.split(' ')[0];
    $('#lobby-meta').textContent = `${s.school} · ${s.phone}`;
    const q = me.quiz;

    if (q && me.attemptStatus === 'in_progress') return quiz.enter();

    $('#lobby-quiz').hidden = !q;
    $('#lobby-empty').hidden = !!q;
    if (!q) {
      $('#lobby-empty-text').textContent = me.completed.length
        ? `You have submitted "${me.completed[0].title}". Each student can attend one quiz. Thank you for taking part!`
        : 'There is no quiz scheduled right now. Please check back at the announced time.';
      show('lobby');
      return;
    }
    $('#quiz-title').textContent = q.title;
    $('#quiz-qcount').textContent = q.questionCount;
    $('#quiz-duration').textContent = q.durationMin;
    $('#quiz-window').textContent = `You can start from ${when(q.startAt)}. The quiz closes for everyone at ${when(q.endAt)}.`;
    $('#quiz-status').textContent = me.serverNow >= q.startAt ? 'Live now' : 'Upcoming quiz';
    $('#quiz-instructions').textContent = q.instructions || '';
    const rules = [
      'Each question has one correct answer. Your answer is saved as soon as you choose it and when you go to the next question.',
      'Use the question numbers at the top to jump to any question. You can go back and change answers until you submit.',
      `You get ${q.durationMin} minutes, but the quiz closes at ${when(q.endAt)}. If you start late, you only get the time left until then.`,
      'The timer keeps running even if you close the page. When time is up, your saved answers are submitted automatically.',
      'You can submit early. Once submitted you cannot change answers, and you can take the quiz only once.',
      'Marks and answers are not shown to students.',
      `Stay on the quiz screen. Switching apps or tabs is recorded${q.maxViolations > 0 ? `, and after ${q.maxViolations} times your quiz is submitted automatically` : ''}.`,
      'On a laptop the quiz runs in full screen. Leaving full screen counts as switching away.',
      'Entering your details on another device will log out this one.',
    ];
    $('#rules-list').replaceChildren(...rules.map((r) => Object.assign(document.createElement('li'), { textContent: r })));

    // Count down using server time so a wrong phone clock doesn't matter.
    const offset = me.serverNow - Date.now();
    const tick = () => {
      const left = q.startAt - (Date.now() + offset);
      const open = left <= 0;
      $('#countdown-wrap').hidden = open;
      $('#countdown').textContent = fmt(left);
      $('#btn-start').disabled = !open || !$('#agree').checked;
      $('#btn-start').textContent = open ? 'Start quiz' : 'Waiting for start time';
    };
    clearInterval(lobbyTimer);
    tick();
    lobbyTimer = setInterval(tick, 1000);
    $('#agree').onchange = tick;
    show('lobby');
  }

  $('#btn-start').addEventListener('click', async () => {
    $('#start-error').textContent = '';
    requestFullscreen(); // must happen inside the tap/click
    try {
      await api('/attempt/start', { quizId: me.quiz.id });
      await quiz.enter();
    } catch (ex) {
      if (ex.code === 'SUBMITTED') return show('done');
      $('#start-error').textContent = ex.message;
    }
  });

  // ---------- anti-cheat helpers ----------
  const isDesktop = () => window.matchMedia('(pointer: fine)').matches && !('ontouchstart' in window);
  function requestFullscreen() {
    if (!isDesktop()) return;
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn && !document.fullscreenElement) fn.call(el).catch?.(() => {});
  }

  // ---------- quiz ----------
  const quiz = (() => {
    let state = null;          // from GET /attempt
    let current = 0;
    let cache = new Map();     // index -> question
    let endsAt = 0;            // performance.now() based deadline
    let timerId = null;
    let active = false;
    let lastViolation = 0;
    let logged = {};           // throttle for non-counting events
    const PENDING = 'aaroh.pending';

    function syncClock(remainingMs) { endsAt = performance.now() + remainingMs; }

    async function enter() {
      try { state = await api('/attempt'); } catch (ex) { return handleErr(ex); }
      active = true;
      cache = new Map();
      syncClock(state.remainingMs);
      $('#q-total').textContent = state.total;
      buildWatermark();
      show('quiz');
      if (store.get('aaroh.inQuiz')) report('page_reload', 'Quiz page was reloaded or reopened');
      store.set('aaroh.inQuiz', true);
      clearInterval(timerId);
      timerId = setInterval(tick, 500);
      tick();
      flushPending();
      const firstOpen = state.answered.findIndex((a) => !a);
      await go(firstOpen >= 0 ? firstOpen : 0);
    }

    function stop() {
      active = false;
      clearInterval(timerId);
      store.del('aaroh.inQuiz');
    }

    function buildWatermark() {
      const text = `${me.student.name} · ${me.student.phone}     `;
      $('#watermark').textContent = Array.from({ length: 40 }, () => text.repeat(6)).join('\n');
    }

    function tick() {
      const left = endsAt - performance.now();
      const t = $('#timer');
      t.textContent = fmt(left);
      t.classList.toggle('low', left <= 5 * 60_000);
      if (left <= 0 && active) timeUp();
    }

    async function timeUp() {
      active = false;
      clearInterval(timerId);
      await flushPending();
      finish('Time is up. Your saved answers have been submitted automatically.');
    }

    function finish(text) {
      stop();
      store.del(PENDING);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      $('#done-text').textContent = `${text} Thank you for taking part.`;
      show('done');
    }

    function handleErr(ex) {
      if (ex.code === 'SUBMITTED') return finish(ex.message);
      if (ex.status === 401 || ex.status === 403) return; // message view already shown
      setSave(ex.message, true);
    }

    async function go(n) {
      if (n < 0 || n >= state.total) return;
      current = n;
      let q = cache.get(n);
      if (!q) {
        try { q = await api(`/attempt/q/${n}`); } catch (ex) { return handleErr(ex); }
        cache.set(n, q);
        syncClock(q.remainingMs);
      }
      if (current !== n) return; // user moved on while loading
      render(q);
      // Quietly fetch the next question so "Next" is instant on slow networks.
      if (n + 1 < state.total && !cache.has(n + 1)) api(`/attempt/q/${n + 1}`).then((nq) => cache.set(n + 1, nq)).catch(() => {});
    }

    function render(q) {
      $('#q-pos').textContent = q.index + 1;
      $('#q-label').textContent = `Question ${q.index + 1}`;
      $('#q-text').textContent = q.text;
      const img = $('#q-img');
      if (q.image) { img.src = q.image; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
      const box = $('#q-options');
      box.replaceChildren(...q.options.map((text, i) => {
        const b = document.createElement('button');
        b.className = 'opt';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(q.chosen === i));
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = 'ABCDEF'[i];
        const label = document.createElement('span');
        label.textContent = text;
        b.append(key, label);
        b.onclick = () => choose(q, i);
        return b;
      }));
      const mark = $('#btn-mark');
      mark.setAttribute('aria-pressed', String(q.marked));
      mark.textContent = q.marked ? 'Marked ★' : 'Mark for review';
      $('#btn-prev').disabled = q.index === 0;
      $('#btn-next').disabled = q.index === state.total - 1;
      renderStrip();
    }

    function renderStrip() {
      const strip = $('#qstrip');
      if (strip.children.length !== state.total) {
        strip.replaceChildren(...state.answered.map((_, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = i + 1;
          b.onclick = () => go(i);
          return b;
        }));
      }
      Array.from(strip.children).forEach((b, i) => {
        b.classList.toggle('answered', !!state.answered[i]);
        b.classList.toggle('marked', !!state.marked[i]);
        b.classList.toggle('current', i === current);
        if (i === current) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
      strip.children[current]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    function choose(q, i) {
      q.chosen = q.chosen === i ? null : i; // tap again to clear
      state.answered[q.index] = q.chosen != null;
      render(q);
      save(q);
    }

    function toggleMark() {
      const q = cache.get(current);
      if (!q) return;
      q.marked = !q.marked;
      state.marked[q.index] = q.marked;
      render(q);
      save(q);
    }

    // ---- autosave with offline retry ----
    function setSave(text, offline = false) {
      const el = $('#save-state');
      el.textContent = text;
      el.classList.toggle('offline', offline);
    }

    function save(q) {
      const pending = store.get(PENDING) || {};
      pending[q.index] = { index: q.index, choice: q.chosen, marked: q.marked };
      store.set(PENDING, pending);
      flushPending();
    }

    let flushing = null;
    function flushPending() {
      if (flushing) return flushing.then(() => (Object.keys(store.get(PENDING) || {}).length ? flushPending() : undefined));
      flushing = (async () => {
        const pending = store.get(PENDING) || {};
        const items = Object.values(pending);
        if (!items.length) return;
        setSave('Saving…');
        for (const item of items) {
          try {
            const r = await api('/attempt/answer', item);
            syncClock(r.remainingMs);
            const now = store.get(PENDING) || {};
            if (JSON.stringify(now[item.index]) === JSON.stringify(item)) { delete now[item.index]; store.set(PENDING, now); }
          } catch (ex) {
            if (ex.code === 'SUBMITTED') { store.del(PENDING); return handleErr(ex); }
            if (ex.status >= 400 && ex.status < 500) { const now = store.get(PENDING) || {}; delete now[item.index]; store.set(PENDING, now); continue; }
            setSave('Offline. Your answers will save when the connection is back.', true);
            return;
          }
        }
        setSave('All answers saved ✓');
      })().finally(() => { flushing = null; });
      return flushing;
    }
    setInterval(() => { if (active && Object.keys(store.get(PENDING) || {}).length) flushPending(); }, 4000);
    window.addEventListener('online', () => active && flushPending());

    // ---- submit ----

    async function submit() {
      const unanswered = state.answered.filter((a) => !a).length;
      const marked = state.marked.filter(Boolean).length;
      let text = 'Once you submit, you cannot change your answers.';
      if (unanswered) text = `You have ${unanswered} unanswered question${unanswered > 1 ? 's' : ''}. ${text}`;
      if (marked) text += ` ${marked} question${marked > 1 ? 's are' : ' is'} marked for review.`;
      const ok = await modal('Submit quiz?', text, [
        { label: 'Go back', value: false },
        { label: 'Submit', value: true, cls: 'danger' },
      ]);
      if (!ok) return;
      await flushPending();
      try { await api('/attempt/submit', {}); finish('Your answers have been submitted.'); } catch (ex) { handleErr(ex); }
    }

    // ---- violations ----
    async function report(type, detail) {
      if (!active) return;
      const counts = ['tab_switch', 'window_blur', 'fullscreen_exit'].includes(type);
      const now = Date.now();
      if (counts) {
        // visibilitychange + blur usually fire together; treat them as one event.
        if (now - lastViolation < 2500) return;
        lastViolation = now;
      } else {
        if (logged[type] && now - logged[type] < 10_000) return;
        logged[type] = now;
      }
      let r;
      try { r = await api('/attempt/violation', { type, detail }); } catch (ex) { return handleErr(ex); }
      if (!counts) return;
      if (r.submitted) return finish('You left the quiz screen too many times, so your quiz was submitted automatically.');
      const left = r.maxViolations > 0 ? r.maxViolations - r.violations : null;
      pendingWarning = left == null
        ? `Leaving the quiz screen is recorded (${r.violations} so far). Please stay on this screen.`
        : `Leaving the quiz screen is recorded. ${left} more time${left === 1 ? '' : 's'} and your quiz will be submitted automatically.`;
      if (!document.hidden) showWarning();
    }
    let pendingWarning = null;
    async function showWarning() {
      if (!pendingWarning) return;
      const text = pendingWarning;
      pendingWarning = null;
      await modal('Warning', text, [{ label: isDesktop() ? 'Return to full screen' : 'Continue quiz', value: true, cls: 'primary' }], true);
      requestFullscreen();
    }

    document.addEventListener('visibilitychange', () => {
      if (!active) return;
      if (document.hidden) report('tab_switch', 'Page hidden (switched app/tab or locked screen)');
      else showWarning();
    });
    window.addEventListener('blur', () => { if (active && !document.hidden) report('window_blur', 'Window lost focus'); });
    document.addEventListener('fullscreenchange', () => {
      if (active && isDesktop() && !document.fullscreenElement) report('fullscreen_exit', 'Left full screen');
    });

    const block = (type) => (e) => { if (active) { e.preventDefault(); report(type); } };
    document.addEventListener('copy', block('copy_attempt'));
    document.addEventListener('cut', block('copy_attempt'));
    document.addEventListener('paste', block('paste_attempt'));
    document.addEventListener('contextmenu', block('context_menu'));
    document.addEventListener('selectstart', (e) => { if (active) e.preventDefault(); });
    document.addEventListener('dragstart', (e) => { if (active) e.preventDefault(); });
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (k === 'printscreen') { report('print_screen'); return; }
      if (k === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (mod && ['u', 's', 'p'].includes(k))) {
        e.preventDefault(); report('devtools_key', e.key);
      } else if (mod && ['c', 'x', 'a'].includes(k)) {
        e.preventDefault(); report('copy_attempt', `Ctrl+${e.key}`);
      }
    });
    window.addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = ''; } });

    // ---- buttons ----
    // Moving between questions also pushes any unsaved answer to the server.
    $('#btn-prev').onclick = () => { flushPending(); go(current - 1); };
    $('#btn-next').onclick = () => { flushPending(); go(current + 1); };
    $('#btn-mark').onclick = toggleMark;
    $('#btn-submit').onclick = submit;

    return { enter, stop };
  })();

  // ---------- boot ----------
  (async () => {
    try {
      config = await api('/config');
      // First word in black (outlined), the rest in yellow: "AAROH QUIZ".
      const [first, ...rest] = config.siteName.trim().split(/\s+/);
      $('#site-name').replaceChildren(
        Object.assign(document.createElement('span'), { className: 'name-a', textContent: first }),
        rest.length ? ' ' : '',
        Object.assign(document.createElement('span'), { className: 'name-b', textContent: rest.join(' ') }),
      );
      document.title = config.siteName;
    } catch { /* offline on first load: defaults are fine */ }
    try { await loadLobby(); } catch (ex) { if (ex.code !== 'SESSION_REPLACED' && ex.code !== 'BLOCKED') show('home'); }
  })();
})();
