const express = require('express');
const crypto = require('crypto');
const { db, withTransaction, getSetting, setSetting } = require('../db');
const {
  hashPassword, verifyPassword, newToken, parseCookies, setCookie, rateLimit, finalizeAttempt, sweepExpired, sweepIfDue,
} = require('../lib/common');

const COOKIE = 'asid';
const SESSION_HOURS = 12;
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// Express 4 doesn't catch rejected promises from async handlers on its own — without this, a DB
// error would just hang the request instead of reaching the error middleware in server.js.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

module.exports = function adminRouter(adminPath) {
  const router = express.Router();
  const cookieOpts = { path: adminPath };

  const requireAdmin = ah(async function requireAdmin(req, res, next) {
    const token = parseCookies(req)[COOKIE];
    const s = token && await db.get("SELECT * FROM sessions WHERE token=? AND kind='admin' AND revoked IS NULL", [token]);
    if (!s || Number(s.created_at) < Date.now() - SESSION_HOURS * 3600_000) return res.status(401).json({ error: 'Please log in.' });
    req.admin = await db.get('SELECT id, username FROM admins WHERE id=?', [s.user_id]);
    if (!req.admin) return res.status(401).json({ error: 'Please log in.' });
    next();
  });

  // ---------- auth ----------
  router.post('/login', rateLimit('admin-login', 10, 15 * 60_000), ah(async (req, res) => {
    const admin = await db.get('SELECT * FROM admins WHERE username=?', [clean(req.body?.username, 60)]);
    if (!admin || !verifyPassword(String(req.body?.password || ''), admin.pass_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    const token = newToken();
    const now = Date.now();
    await db.run(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
                VALUES (?, 'admin', ?, ?, ?, ?, ?)`, [token, admin.id, now, now, req.ip, clean(req.headers['user-agent'], 200)]);
    setCookie(res, COOKIE, token, { ...cookieOpts, maxAge: SESSION_HOURS * 3600 });
    res.json({ ok: true, username: admin.username });
  }));

  router.post('/logout', ah(async (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) await db.run("UPDATE sessions SET revoked='logout' WHERE token=?", [token]);
    setCookie(res, COOKIE, '', { ...cookieOpts, maxAge: 0 });
    res.json({ ok: true });
  }));

  router.use(requireAdmin);
  // Every admin view (dashboard, students, live, results) reflects quizzes whose time has run out.
  router.use(ah(async (req, res, next) => { await sweepIfDue(); next(); }));

  router.get('/me', (req, res) => res.json({ username: req.admin.username }));

  router.post('/password', ah(async (req, res) => {
    const { current, next: newPass } = req.body || {};
    const admin = await db.get('SELECT * FROM admins WHERE id=?', [req.admin.id]);
    if (!verifyPassword(String(current || ''), admin.pass_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
    if (String(newPass || '').length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
    await db.run('UPDATE admins SET pass_hash=? WHERE id=?', [hashPassword(String(newPass)), admin.id]);
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  router.get('/settings', ah(async (req, res) => {
    res.json({ siteName: await getSetting('site_name', 'Aaroh Quiz') });
  }));
  router.put('/settings', ah(async (req, res) => {
    const b = req.body || {};
    if (b.siteName != null) await setSetting('site_name', clean(b.siteName, 60) || 'Aaroh Quiz');
    res.json({ ok: true });
  }));

  // ---------- dashboard ----------
  router.get('/stats', ah(async (req, res) => {
    const now = Date.now();
    const [profiles, saidPaid, quizzes, liveAttempts, submitted, upcoming] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM students'),
      db.get('SELECT COUNT(*) n FROM students WHERE paid=1'),
      db.get('SELECT COUNT(*) n FROM quizzes'),
      db.get("SELECT COUNT(*) n FROM attempts WHERE status='in_progress' AND deadline_at > ?", [now]),
      db.get("SELECT COUNT(*) n FROM attempts WHERE status='submitted'"),
      db.all('SELECT id, title, start_at, end_at, published FROM quizzes WHERE end_at > ? ORDER BY start_at LIMIT 5', [now]),
    ]);
    res.json({
      profiles: Number(profiles.n),
      saidPaid: Number(saidPaid.n),
      quizzes: Number(quizzes.n),
      liveAttempts: Number(liveAttempts.n),
      submitted: Number(submitted.n),
      upcoming,
      serverNow: now,
    });
  }));

  // ---------- quizzes ----------
  function quizFromBody(b) {
    const q = {
      title: clean(b.title, 120), instructions: clean(b.instructions, 4000),
      start_at: Number(b.startAt), end_at: Number(b.endAt), duration_min: Math.round(Number(b.durationMin)),
      questions_per_attempt: Math.max(0, Math.round(Number(b.questionsPerAttempt) || 0)),
      max_violations: Math.max(0, Math.round(Number(b.maxViolations) || 0)),
      published: b.published ? 1 : 0,
    };
    if (!q.title) return { error: 'Title is required.' };
    if (!Number.isFinite(q.start_at) || !Number.isFinite(q.end_at) || q.end_at <= q.start_at) return { error: 'The end time must be after the start time.' };
    if (!(q.duration_min >= 1 && q.duration_min <= 600)) return { error: 'Duration must be between 1 and 600 minutes.' };
    return { q };
  }

  router.get('/quizzes', ah(async (req, res) => {
    const [quizzes, qCounts, aCounts] = await Promise.all([
      db.all('SELECT * FROM quizzes ORDER BY start_at DESC'),
      db.all('SELECT quiz_id, COUNT(*) n FROM questions GROUP BY quiz_id'),
      db.all('SELECT quiz_id, status, COUNT(*) n FROM attempts GROUP BY quiz_id, status'),
    ]);
    const questionCount = new Map(qCounts.map((r) => [r.quiz_id, r.n]));
    res.json(quizzes.map((q) => {
      const mine = aCounts.filter((r) => r.quiz_id === q.id);
      return {
        ...q,
        question_count: questionCount.get(q.id) || 0,
        attempt_count: mine.reduce((sum, r) => sum + r.n, 0),
        submitted_count: mine.filter((r) => r.status === 'submitted').reduce((sum, r) => sum + r.n, 0),
      };
    }));
  }));

  router.post('/quizzes', ah(async (req, res) => {
    const { q, error } = quizFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = await db.run(`INSERT INTO quizzes (title, instructions, start_at, end_at, duration_min, questions_per_attempt, max_violations, published, created_at)
      VALUES (@title, @instructions, @start_at, @end_at, @duration_min, @questions_per_attempt, @max_violations, @published, @now) RETURNING id`,
    { ...q, now: Date.now() });
    res.json({ id: info.lastInsertRowid });
  }));

  router.put('/quizzes/:id', ah(async (req, res) => {
    const { q, error } = quizFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    await db.run(`UPDATE quizzes SET title=@title, instructions=@instructions, start_at=@start_at, end_at=@end_at,
      duration_min=@duration_min, questions_per_attempt=@questions_per_attempt, max_violations=@max_violations, published=@published WHERE id=@id`,
    { ...q, id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  router.delete('/quizzes/:id', ah(async (req, res) => {
    await db.run('DELETE FROM quizzes WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- questions ----------
  function questionFromBody(b) {
    const options = (Array.isArray(b.options) ? b.options : []).map((o) => clean(o, 500)).filter(Boolean);
    const q = {
      text: clean(b.text, 2000), image: b.image ? clean(b.image, 300) : null, options,
      correct: Number(b.correct), category: clean(b.category, 40) || 'General',
      difficulty: ['Easy', 'Medium', 'Hard'].includes(b.difficulty) ? b.difficulty : 'Medium',
      marks: Number(b.marks) > 0 ? Number(b.marks) : 1,
    };
    if (!q.text) return { error: 'Question text is required.' };
    if (options.length < 2 || options.length > 6) return { error: 'Give between 2 and 6 options.' };
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= options.length) return { error: 'Choose which option is correct.' };
    if (q.image && !/^\/uploads\/[\w.-]+$|^https:\/\//.test(q.image)) return { error: 'Invalid image.' };
    return { q };
  }

  const INSERT_QUESTION_SQL = `INSERT INTO questions (quiz_id, text, image, options, correct, category, difficulty, marks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`;
  const insertQuestion = (queryable, quizId, q) => queryable.run(
    INSERT_QUESTION_SQL,
    [quizId, q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Date.now()],
  );

  router.get('/quizzes/:id/questions', ah(async (req, res) => {
    const rows = await db.all('SELECT * FROM questions WHERE quiz_id=? ORDER BY id', [Number(req.params.id)]);
    res.json(rows.map((r) => ({ ...r, options: JSON.parse(r.options) })));
  }));

  router.post('/quizzes/:id/questions', ah(async (req, res) => {
    const { q, error } = questionFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = await insertQuestion(db, Number(req.params.id), q);
    res.json({ id: info.lastInsertRowid });
  }));

  // Bulk import: rows already parsed from Excel/CSV in the browser.
  router.post('/quizzes/:id/questions/bulk', ah(async (req, res) => {
    const quizId = Number(req.params.id);
    if (!await db.get('SELECT 1 FROM quizzes WHERE id=?', [quizId])) return res.status(404).json({ error: 'Quiz not found.' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const errors = [];
    let added = 0;
    await withTransaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const { q, error } = questionFromBody(rows[i]);
        if (error) { errors.push(`Row ${i + 2}: ${error}`); continue; }
        await insertQuestion(tx, quizId, q);
        added++;
      }
    });
    res.json({ added, errors });
  }));

  router.put('/questions/:id', ah(async (req, res) => {
    const { q, error } = questionFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    await db.run('UPDATE questions SET text=?, image=?, options=?, correct=?, category=?, difficulty=?, marks=? WHERE id=?',
      [q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Number(req.params.id)]);
    res.json({ ok: true });
  }));

  router.delete('/questions/:id', ah(async (req, res) => {
    await db.run('DELETE FROM questions WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // Question images cannot live on the server's disk (Vercel does not keep files between requests).
  // With a Vercel Blob store connected they go there and are served from its CDN; otherwise they are
  // kept in the database and served from /uploads/<name> (see server.js), so no extra service is needed.
  router.post('/upload-image', express.json({ limit: '3mb' }), ah(async (req, res) => {
    const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
    if (!m) return res.status(400).json({ error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 2 MB.' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = require('@vercel/blob');
      const blob = await put(`question-images/${name}`, buf, { access: 'public', contentType: `image/${m[1]}` });
      return res.json({ url: blob.url });
    }
    await db.run('INSERT INTO images (name, mime, data, created_at) VALUES (?, ?, ?, ?)', [name, `image/${m[1]}`, m[2], Date.now()]);
    res.json({ url: `/uploads/${name}` });
  }));

  // ---------- student profiles (created when a student enters their details just before the exam) ----------
  // Progress: waiting (profile created, quiz not started), doing (quiz in progress), completed (submitted).
  router.get('/students', ah(async (req, res) => {
    let where = '';
    const params = [];
    if (req.query.q) { where = 'WHERE (name ILIKE ? OR school ILIKE ? OR phone ILIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`); }
    const [students, attempts, seen] = await Promise.all([
      db.all(`SELECT * FROM students ${where} ORDER BY created_at DESC LIMIT 10000`, params),
      db.all(`SELECT a.id attempt_id, a.student_id, a.status attempt_status, a.started_at, a.submitted_at, a.score, a.total_marks,
          a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count, a.violations, a.submit_reason, q.title quiz_title
        FROM attempts a JOIN quizzes q ON q.id = a.quiz_id ORDER BY a.started_at`),
      db.all("SELECT user_id, MAX(last_seen) last_seen FROM sessions WHERE kind='student' AND revoked IS NULL GROUP BY user_id"),
    ]);
    // Ordered oldest first, so each student's entry ends up being their most recent attempt.
    const latest = new Map(attempts.map(({ student_id, ...rest }) => [student_id, rest]));
    const lastSeen = new Map(seen.map((r) => [r.user_id, r.last_seen]));
    const noAttempt = {
      attempt_id: null, attempt_status: null, started_at: null, submitted_at: null, score: null, total_marks: null,
      correct_count: null, wrong_count: null, unanswered_count: null, flagged_count: null, violations: null, submit_reason: null, quiz_title: null,
    };
    const progress = (r) => (r.attempt_status === 'submitted' ? 'completed' : r.attempt_status === 'in_progress' ? 'doing' : 'waiting');
    const wanted = req.query.progress;
    const rows = students.map((s) => ({ ...s, ...(latest.get(s.id) || noAttempt), last_seen: lastSeen.get(s.id) ?? null }));
    res.json(rows.map((r) => ({ ...r, progress: progress(r) })).filter((r) => !wanted || r.progress === wanted));
  }));

  router.put('/students/:id', ah(async (req, res) => {
    const status = req.body?.status;
    if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    await db.run('UPDATE students SET status=? WHERE id=?', [status, Number(req.params.id)]);
    if (status === 'blocked') await db.run("UPDATE sessions SET revoked='blocked' WHERE kind='student' AND user_id=? AND revoked IS NULL", [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  router.post('/students/:id/logout', ah(async (req, res) => {
    await db.run("UPDATE sessions SET revoked='admin' WHERE kind='student' AND user_id=? AND revoked IS NULL", [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // Deletes the profile and its attempts, so that phone number can enter again.
  router.delete('/students/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.run("DELETE FROM sessions WHERE kind='student' AND user_id=?", [id]);
    await db.run('DELETE FROM students WHERE id=?', [id]);
    res.json({ ok: true });
  }));

  // ---------- approved list (students who registered and paid) ----------
  // While the list is empty anyone can enter; once it has numbers, only those numbers can.
  const toPhone = (v) => String(v ?? '').replace(/\D/g, '').slice(-10); // same rule as the student login
  const UPSERT_APPROVED = `INSERT INTO approved (phone, name, school, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (phone) DO UPDATE SET name = excluded.name, school = excluded.school`;

  router.get('/approved', ah(async (req, res) => {
    res.json(await db.all(`SELECT a.*, (s.id IS NOT NULL) AS entered FROM approved a
      LEFT JOIN students s ON s.phone = a.phone ORDER BY a.name, a.phone`));
  }));

  router.post('/approved', ah(async (req, res) => {
    const phone = toPhone(req.body?.phone);
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
    await db.run(UPSERT_APPROVED, [phone, clean(req.body?.name, 80), clean(req.body?.school, 150), Date.now()]);
    res.json({ ok: true });
  }));

  // Bulk upload: rows already parsed from Excel/CSV in the browser. A number already on the list is updated, not duplicated.
  router.post('/approved/bulk', ah(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const errors = [];
    let added = 0;
    await withTransaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const phone = toPhone(rows[i].phone);
        if (!/^\d{10}$/.test(phone)) { errors.push(`Row ${i + 2}: "${clean(rows[i].phone, 30)}" is not a 10-digit mobile number.`); continue; }
        await tx.run(UPSERT_APPROVED, [phone, clean(rows[i].name, 80), clean(rows[i].school, 150), Date.now()]);
        added++;
      }
    });
    res.json({ added, errors });
  }));

  router.delete('/approved/:phone', ah(async (req, res) => {
    await db.run('DELETE FROM approved WHERE phone = ?', [toPhone(req.params.phone)]);
    res.json({ ok: true });
  }));

  router.delete('/approved', ah(async (req, res) => {
    await db.run('DELETE FROM approved');
    res.json({ ok: true });
  }));

  // ---------- attempts, live monitor, results ----------
  router.get('/quizzes/:id/live', ah(async (req, res) => {
    await sweepExpired();
    const now = Date.now();
    const quizId = Number(req.params.id);
    const [rows, answerRows, submitted] = await Promise.all([
      db.all(`SELECT a.id, a.started_at, a.deadline_at, a.violations, a.last_seen, a.question_order,
        s.name, s.school, s.phone, s.paid
      FROM attempts a JOIN students s ON s.id=a.student_id
      WHERE a.quiz_id=? AND a.status='in_progress' ORDER BY a.violations DESC, s.name`, [quizId]),
      db.all(`SELECT an.attempt_id, an.chosen, an.marked FROM answers an JOIN attempts a ON a.id = an.attempt_id
      WHERE a.quiz_id=? AND a.status='in_progress'`, [quizId]),
      db.get("SELECT COUNT(*) n FROM attempts WHERE quiz_id=? AND status='submitted'", [quizId]),
    ]);
    const tally = new Map();
    for (const r of answerRows) {
      const t = tally.get(r.attempt_id) || { answered: 0, flagged: 0 };
      if (r.chosen != null) t.answered++;
      if (r.marked === 1) t.flagged++;
      tally.set(r.attempt_id, t);
    }
    res.json({
      serverNow: now,
      rows: rows.map(({ question_order, ...r }) => ({ ...r, ...(tally.get(r.id) || { answered: 0, flagged: 0 }), total: JSON.parse(question_order).length })),
      submitted: submitted.n,
    });
  }));

  // Ranking: highest score first; ties go to whoever finished faster, then whoever submitted earlier.
  router.get('/quizzes/:id/results', ah(async (req, res) => {
    await sweepExpired();
    const rows = await db.all(`SELECT a.id, a.score, a.total_marks, a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count,
        a.time_taken_ms, a.violations, a.submit_reason, a.started_at, a.submitted_at, a.question_order,
        s.id student_id, s.name, s.school, s.phone, s.paid, s.created_at entered_at
      FROM attempts a JOIN students s ON s.id=a.student_id
      WHERE a.quiz_id=? AND a.status='submitted'
      ORDER BY a.score DESC, a.time_taken_ms ASC, a.submitted_at ASC`, [Number(req.params.id)]);
    res.json(rows.map(({ question_order, ...r }, i) => ({ rank: i + 1, ...r, questions: JSON.parse(question_order).length })));
  }));

  router.get('/attempts/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const a = await db.get(`SELECT a.*, s.name, s.school, s.phone, s.paid, s.created_at entered_at,
      q.title quiz_title FROM attempts a JOIN students s ON s.id=a.student_id
      JOIN quizzes q ON q.id=a.quiz_id WHERE a.id=?`, [id]);
    if (!a) return res.status(404).json({ error: 'Not found.' });
    const order = JSON.parse(a.question_order);
    const [answerRows, questionRows, violationLog] = await Promise.all([
      db.all('SELECT question_id, chosen, marked, answered_at FROM answers WHERE attempt_id=?', [a.id]),
      db.all('SELECT id, text, options, correct FROM questions WHERE quiz_id=?', [a.quiz_id]),
      db.all('SELECT type, detail, at FROM violations WHERE attempt_id=? ORDER BY at', [a.id]),
    ]);
    const answers = new Map(answerRows.map((r) => [r.question_id, r]));
    const qs = new Map(questionRows.map((q) => [q.id, q]));
    const { question_order, ...rest } = a;
    res.json({
      ...rest,
      questions: order.map((o, i) => {
        const q = qs.get(o.q);
        const ans = answers.get(o.q);
        const opts = q ? JSON.parse(q.options) : [];
        return {
          n: i + 1, text: q?.text ?? '(deleted question)',
          chosen: ans?.chosen != null ? opts[ans.chosen] : null,
          correctAnswer: q ? opts[q.correct] : null,
          isCorrect: q && ans?.chosen === q.correct,
          flagged: !!ans?.marked,
        };
      }),
      violationLog,
    });
  }));

  router.post('/attempts/:id/submit', ah(async (req, res) => {
    await finalizeAttempt(Number(req.params.id), 'admin');
    res.json({ ok: true });
  }));

  // Lets a student take the quiz again (e.g. after a genuine technical problem).
  router.delete('/attempts/:id', ah(async (req, res) => {
    await db.run('DELETE FROM attempts WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  return router;
};
