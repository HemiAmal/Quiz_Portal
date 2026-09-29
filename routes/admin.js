const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const {
  hashPassword, verifyPassword, newToken, parseCookies, setCookie, rateLimit, finalizeAttempt,
} = require('../lib/common');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const COOKIE = 'asid';
const SESSION_HOURS = 12;
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

module.exports = function adminRouter(adminPath) {
  const router = express.Router();
  const cookieOpts = { path: adminPath };

  function requireAdmin(req, res, next) {
    const token = parseCookies(req)[COOKIE];
    const s = token && db.prepare("SELECT * FROM sessions WHERE token=? AND kind='admin' AND revoked IS NULL").get(token);
    if (!s || s.created_at < Date.now() - SESSION_HOURS * 3600_000) return res.status(401).json({ error: 'Please log in.' });
    req.admin = db.prepare('SELECT id, username FROM admins WHERE id=?').get(s.user_id);
    if (!req.admin) return res.status(401).json({ error: 'Please log in.' });
    next();
  }

  // ---------- auth ----------
  router.post('/login', rateLimit('admin-login', 10, 15 * 60_000), (req, res) => {
    const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(clean(req.body?.username, 60));
    if (!admin || !verifyPassword(String(req.body?.password || ''), admin.pass_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    const token = newToken();
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
                VALUES (?, 'admin', ?, ?, ?, ?, ?)`).run(token, admin.id, now, now, req.ip, clean(req.headers['user-agent'], 200));
    setCookie(res, COOKIE, token, { ...cookieOpts, maxAge: SESSION_HOURS * 3600 });
    res.json({ ok: true, username: admin.username });
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) db.prepare("UPDATE sessions SET revoked='logout' WHERE token=?").run(token);
    setCookie(res, COOKIE, '', { ...cookieOpts, maxAge: 0 });
    res.json({ ok: true });
  });

  router.use(requireAdmin);

  router.get('/me', (req, res) => res.json({ username: req.admin.username }));

  router.post('/password', (req, res) => {
    const { current, next: newPass } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
    if (!verifyPassword(String(current || ''), admin.pass_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
    if (String(newPass || '').length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
    db.prepare('UPDATE admins SET pass_hash=? WHERE id=?').run(hashPassword(String(newPass)), admin.id);
    res.json({ ok: true });
  });

  // ---------- settings ----------
  router.get('/settings', (req, res) => {
    res.json({ siteName: getSetting('site_name', 'Aaroh Quiz') });
  });
  router.put('/settings', (req, res) => {
    const b = req.body || {};
    if (b.siteName != null) setSetting('site_name', clean(b.siteName, 60) || 'Aaroh Quiz');
    res.json({ ok: true });
  });

  // ---------- dashboard ----------
  router.get('/stats', (req, res) => {
    const now = Date.now();
    res.json({
      profiles: db.prepare('SELECT COUNT(*) n FROM students').get().n,
      saidPaid: db.prepare('SELECT COUNT(*) n FROM students WHERE paid=1').get().n,
      quizzes: db.prepare('SELECT COUNT(*) n FROM quizzes').get().n,
      liveAttempts: db.prepare("SELECT COUNT(*) n FROM attempts WHERE status='in_progress' AND deadline_at > ?").get(now).n,
      submitted: db.prepare("SELECT COUNT(*) n FROM attempts WHERE status='submitted'").get().n,
      upcoming: db.prepare('SELECT id, title, start_at, end_at, published FROM quizzes WHERE end_at > ? ORDER BY start_at LIMIT 5').all(now),
      serverNow: now,
    });
  });

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

  router.get('/quizzes', (req, res) => {
    res.json(db.prepare(`SELECT q.*,
      (SELECT COUNT(*) FROM questions WHERE quiz_id=q.id) question_count,
      (SELECT COUNT(*) FROM attempts WHERE quiz_id=q.id) attempt_count,
      (SELECT COUNT(*) FROM attempts WHERE quiz_id=q.id AND status='submitted') submitted_count
      FROM quizzes q ORDER BY start_at DESC`).all());
  });

  router.post('/quizzes', (req, res) => {
    const { q, error } = quizFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = db.prepare(`INSERT INTO quizzes (title, instructions, start_at, end_at, duration_min, questions_per_attempt, max_violations, published, created_at)
      VALUES (@title, @instructions, @start_at, @end_at, @duration_min, @questions_per_attempt, @max_violations, @published, @now)`)
      .run({ ...q, now: Date.now() });
    res.json({ id: info.lastInsertRowid });
  });

  router.put('/quizzes/:id', (req, res) => {
    const { q, error } = quizFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    db.prepare(`UPDATE quizzes SET title=@title, instructions=@instructions, start_at=@start_at, end_at=@end_at,
      duration_min=@duration_min, questions_per_attempt=@questions_per_attempt, max_violations=@max_violations, published=@published WHERE id=@id`)
      .run({ ...q, id: Number(req.params.id) });
    res.json({ ok: true });
  });

  router.delete('/quizzes/:id', (req, res) => {
    db.prepare('DELETE FROM quizzes WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  });

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

  const insertQuestion = db.prepare(`INSERT INTO questions (quiz_id, text, image, options, correct, category, difficulty, marks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  router.get('/quizzes/:id/questions', (req, res) => {
    const rows = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY id').all(Number(req.params.id));
    res.json(rows.map((r) => ({ ...r, options: JSON.parse(r.options) })));
  });

  router.post('/quizzes/:id/questions', (req, res) => {
    const { q, error } = questionFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = insertQuestion.run(Number(req.params.id), q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Date.now());
    res.json({ id: info.lastInsertRowid });
  });

  // Bulk import: rows already parsed from Excel/CSV in the browser.
  router.post('/quizzes/:id/questions/bulk', (req, res) => {
    const quizId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM quizzes WHERE id=?').get(quizId)) return res.status(404).json({ error: 'Quiz not found.' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const errors = [];
    let added = 0;
    db.transaction(() => {
      rows.forEach((r, i) => {
        const { q, error } = questionFromBody(r);
        if (error) { errors.push(`Row ${i + 2}: ${error}`); return; }
        insertQuestion.run(quizId, q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Date.now());
        added++;
      });
    })();
    res.json({ added, errors });
  });

  router.put('/questions/:id', (req, res) => {
    const { q, error } = questionFromBody(req.body || {});
    if (error) return res.status(400).json({ error });
    db.prepare('UPDATE questions SET text=?, image=?, options=?, correct=?, category=?, difficulty=?, marks=? WHERE id=?')
      .run(q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Number(req.params.id));
    res.json({ ok: true });
  });

  router.delete('/questions/:id', (req, res) => {
    db.prepare('DELETE FROM questions WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.post('/upload-image', express.json({ limit: '3mb' }), (req, res) => {
    const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
    if (!m) return res.status(400).json({ error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 2 MB.' });
    const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ url: `/uploads/${name}` });
  });

  // ---------- student profiles (created when a student enters their details just before the exam) ----------
  // Progress: waiting (profile created, quiz not started), doing (quiz in progress), completed (submitted).
  router.get('/students', (req, res) => {
    const params = {};
    let where = '';
    if (req.query.q) { where = 'WHERE (s.name LIKE @q OR s.school LIKE @q OR s.phone LIKE @q)'; params.q = `%${req.query.q}%`; }
    const rows = db.prepare(`SELECT s.*,
        a.id attempt_id, a.status attempt_status, a.started_at, a.submitted_at, a.score, a.total_marks,
        a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count, a.violations, a.submit_reason, q.title quiz_title,
        (SELECT MAX(last_seen) FROM sessions WHERE kind='student' AND user_id=s.id AND revoked IS NULL) last_seen
      FROM students s
      LEFT JOIN attempts a ON a.id = (SELECT id FROM attempts WHERE student_id = s.id ORDER BY started_at DESC LIMIT 1)
      LEFT JOIN quizzes q ON q.id = a.quiz_id
      ${where} ORDER BY s.created_at DESC LIMIT 10000`).all(params);
    const progress = (r) => (r.attempt_status === 'submitted' ? 'completed' : r.attempt_status === 'in_progress' ? 'doing' : 'waiting');
    const wanted = req.query.progress;
    res.json(rows.map((r) => ({ ...r, progress: progress(r) })).filter((r) => !wanted || r.progress === wanted));
  });

  router.put('/students/:id', (req, res) => {
    const status = req.body?.status;
    if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    db.prepare('UPDATE students SET status=? WHERE id=?').run(status, Number(req.params.id));
    if (status === 'blocked') db.prepare("UPDATE sessions SET revoked='blocked' WHERE kind='student' AND user_id=? AND revoked IS NULL").run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.post('/students/:id/logout', (req, res) => {
    db.prepare("UPDATE sessions SET revoked='admin' WHERE kind='student' AND user_id=? AND revoked IS NULL").run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Deletes the profile and its attempts, so that phone number can enter again.
  router.delete('/students/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare("DELETE FROM sessions WHERE kind='student' AND user_id=?").run(id);
    db.prepare('DELETE FROM students WHERE id=?').run(id);
    res.json({ ok: true });
  });

  // ---------- attempts, live monitor, results ----------
  router.get('/quizzes/:id/live', (req, res) => {
    const now = Date.now();
    const rows = db.prepare(`SELECT a.id, a.started_at, a.deadline_at, a.violations, a.last_seen, a.question_order,
        s.name, s.school, s.phone, s.paid,
        (SELECT COUNT(*) FROM answers WHERE attempt_id=a.id AND chosen IS NOT NULL) answered,
        (SELECT COUNT(*) FROM answers WHERE attempt_id=a.id AND marked=1) flagged
      FROM attempts a JOIN students s ON s.id=a.student_id
      WHERE a.quiz_id=? AND a.status='in_progress' ORDER BY a.violations DESC, s.name`).all(Number(req.params.id));
    res.json({
      serverNow: now,
      rows: rows.map(({ question_order, ...r }) => ({ ...r, total: JSON.parse(question_order).length })),
      submitted: db.prepare("SELECT COUNT(*) n FROM attempts WHERE quiz_id=? AND status='submitted'").get(Number(req.params.id)).n,
    });
  });

  // Ranking: highest score first; ties go to whoever finished faster, then whoever submitted earlier.
  router.get('/quizzes/:id/results', (req, res) => {
    const rows = db.prepare(`SELECT a.id, a.score, a.total_marks, a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count,
        a.time_taken_ms, a.violations, a.submit_reason, a.started_at, a.submitted_at, a.question_order,
        s.id student_id, s.name, s.school, s.phone, s.paid, s.created_at entered_at
      FROM attempts a JOIN students s ON s.id=a.student_id
      WHERE a.quiz_id=? AND a.status='submitted'
      ORDER BY a.score DESC, a.time_taken_ms ASC, a.submitted_at ASC`).all(Number(req.params.id));
    res.json(rows.map(({ question_order, ...r }, i) => ({ rank: i + 1, ...r, questions: JSON.parse(question_order).length })));
  });

  router.get('/attempts/:id', (req, res) => {
    const a = db.prepare(`SELECT a.*, s.name, s.school, s.phone, s.paid, s.created_at entered_at,
      q.title quiz_title FROM attempts a JOIN students s ON s.id=a.student_id
      JOIN quizzes q ON q.id=a.quiz_id WHERE a.id=?`).get(Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'Not found.' });
    const order = JSON.parse(a.question_order);
    const answers = new Map(db.prepare('SELECT question_id, chosen, marked, answered_at FROM answers WHERE attempt_id=?').all(a.id).map((r) => [r.question_id, r]));
    const qs = new Map(db.prepare('SELECT id, text, options, correct FROM questions WHERE quiz_id=?').all(a.quiz_id).map((q) => [q.id, q]));
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
      violationLog: db.prepare('SELECT type, detail, at FROM violations WHERE attempt_id=? ORDER BY at').all(a.id),
    });
  });

  router.post('/attempts/:id/submit', (req, res) => {
    finalizeAttempt(Number(req.params.id), 'admin');
    res.json({ ok: true });
  });

  // Lets a student take the quiz again (e.g. after a genuine technical problem).
  router.delete('/attempts/:id', (req, res) => {
    db.prepare('DELETE FROM attempts WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
};
