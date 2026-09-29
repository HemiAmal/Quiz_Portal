const express = require('express');
const { db, getSetting } = require('../db');
const {
  newToken, shuffle, parseCookies, setCookie, rateLimit, finalizeAttempt,
} = require('../lib/common');

const router = express.Router();
const COOKIE = 'sid';
const SESSION_DAYS = 1;

const clean = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- auth ----------
function requireStudent(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const session = token && db.prepare("SELECT * FROM sessions WHERE token = ? AND kind = 'student'").get(token);
  if (!session) return res.status(401).json({ code: 'NO_SESSION', error: 'Please enter your details.' });
  if (session.revoked) {
    const msg = session.revoked === 'replaced'
      ? 'Your details were entered on another device, so this device was logged out.'
      : 'You have been logged out.';
    return res.status(401).json({ code: 'SESSION_REPLACED', error: msg });
  }
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.user_id);
  if (!student) return res.status(401).json({ code: 'NO_SESSION', error: 'Please enter your details.' });
  if (student.status === 'blocked') return res.status(403).json({ code: 'BLOCKED', error: 'Your access has been blocked. Please contact the organisers.' });
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  req.student = student;
  req.session = session;
  next();
}

// The quiz this student should see: an unfinished attempt first, otherwise the next published quiz.
// Each student takes one quiz in total: after submitting any quiz there is nothing more to show
// (the admin's "Allow retake" deletes the attempt, which opens it up again).
function currentQuizFor(student) {
  const now = Date.now();
  const inProgress = db.prepare(`SELECT q.* FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
                                 WHERE a.student_id = ? AND a.status = 'in_progress'`).get(student.id);
  if (inProgress) return inProgress;
  if (hasSubmitted(student)) return null;
  return db.prepare('SELECT * FROM quizzes WHERE published = 1 AND end_at > ? ORDER BY start_at LIMIT 1').get(now);
}
const hasSubmitted = (student) => !!db.prepare("SELECT 1 FROM attempts WHERE student_id = ? AND status = 'submitted'").get(student.id);

function publicQuiz(q) {
  if (!q) return null;
  const pool = db.prepare('SELECT COUNT(*) n FROM questions WHERE quiz_id = ?').get(q.id).n;
  const count = q.questions_per_attempt > 0 ? Math.min(q.questions_per_attempt, pool) : pool;
  return {
    id: q.id, title: q.title, instructions: q.instructions, startAt: q.start_at, endAt: q.end_at,
    durationMin: q.duration_min, questionCount: count, maxViolations: q.max_violations,
  };
}

// ---------- public ----------
router.get('/config', (req, res) => {
  res.json({
    siteName: getSetting('site_name', 'Aaroh Quiz'),
    serverNow: Date.now(),
  });
});

// Announcements: the schedule of published quizzes that have not closed yet. Public, so the landing page can show it.
router.get('/schedule', (req, res) => {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM quizzes WHERE published = 1 AND end_at > ? ORDER BY start_at LIMIT 10').all(now);
  res.json({ serverNow: now, quizzes: rows.map(publicQuiz) });
});

// Students enter name, phone, school and whether they paid the Rs 50 fee. Nobody is blocked on the fee answer:
// organisers compare it with their paid list after the quiz. The first entry creates the profile.
// Each phone number can take the quiz only once.
router.post('/enter', rateLimit('enter', 15, 15 * 60_000), (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80);
  const school = clean(b.school, 150);
  const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Please enter your 10-digit mobile number.' });
  if (school.length < 3) return res.status(400).json({ error: 'Please enter your school name.' });
  if (b.paid !== 'yes' && b.paid !== 'no') return res.status(400).json({ error: 'Please tell us whether you paid the Rs 50 registration fee.' });
  const paid = b.paid === 'yes' ? 1 : 0;

  const now = Date.now();
  let student = db.prepare('SELECT * FROM students WHERE phone = ?').get(phone);
  if (student) {
    if (student.status === 'blocked') return res.status(403).json({ error: 'Your access has been blocked. Please contact the organisers.' });
    if (hasSubmitted(student)) {
      return res.status(409).json({ error: 'This mobile number has already taken the quiz. Each student can attend only one quiz.' });
    }
    // Re-entering (browser closed, phone restarted): one device at a time, and a running quiz records it.
    const older = db.prepare("SELECT token FROM sessions WHERE kind='student' AND user_id=? AND revoked IS NULL").all(student.id);
    if (older.length) {
      db.prepare("UPDATE sessions SET revoked='replaced' WHERE kind='student' AND user_id=? AND revoked IS NULL").run(student.id);
      const running = db.prepare("SELECT id FROM attempts WHERE student_id=? AND status='in_progress'").get(student.id);
      if (running) {
        db.prepare('INSERT INTO violations (attempt_id, type, detail, at) VALUES (?, ?, ?, ?)')
          .run(running.id, 'new_device_login', clean(req.headers['user-agent'], 200), now);
      }
    }
  } else {
    const id = db.prepare('INSERT INTO students (name, phone, school, paid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, phone, school, paid, now).lastInsertRowid;
    student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  }

  const token = newToken();
  db.prepare(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
              VALUES (?, 'student', ?, ?, ?, ?, ?)`)
    .run(token, student.id, now, now, req.ip, clean(req.headers['user-agent'], 200));
  setCookie(res, COOKIE, token, { maxAge: SESSION_DAYS * 86400 });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare("UPDATE sessions SET revoked='logout' WHERE token=?").run(token);
  setCookie(res, COOKIE, '', { maxAge: 0 });
  res.json({ ok: true });
});

// ---------- logged in ----------
router.get('/me', requireStudent, (req, res) => {
  const s = req.student;
  const quiz = currentQuizFor(s);
  let attempt = null;
  if (quiz) {
    const a = db.prepare('SELECT id, status, deadline_at FROM attempts WHERE quiz_id=? AND student_id=?').get(quiz.id, s.id);
    if (a && a.status === 'in_progress' && a.deadline_at <= Date.now()) finalizeAttempt(a.id, 'time_up');
    attempt = a ? db.prepare('SELECT status FROM attempts WHERE id=?').get(a.id) : null;
  }
  const done = db.prepare(`SELECT q.title, a.submitted_at FROM attempts a JOIN quizzes q ON q.id=a.quiz_id
                           WHERE a.student_id=? AND a.status='submitted' ORDER BY a.submitted_at DESC`).all(s.id);
  res.json({
    student: { name: s.name, school: s.school, phone: s.phone },
    quiz: attempt?.status === 'submitted' ? null : publicQuiz(quiz),
    attemptStatus: attempt?.status || null,
    completed: done.map((d) => ({ title: d.title, submittedAt: d.submitted_at })),
    serverNow: Date.now(),
  });
});

router.post('/attempt/start', requireStudent, (req, res) => {
  const s = req.student;
  const quiz = currentQuizFor(s);
  const now = Date.now();
  if (hasSubmitted(s)) return res.status(409).json({ code: 'SUBMITTED', error: 'You have already taken a quiz. Each student can attend only one quiz.' });
  if (!quiz || quiz.id !== Number(req.body?.quizId)) return res.status(404).json({ error: 'This quiz is not available.' });

  const existing = db.prepare('SELECT * FROM attempts WHERE quiz_id=? AND student_id=?').get(quiz.id, s.id);
  if (existing) {
    if (existing.status === 'submitted') return res.status(409).json({ code: 'SUBMITTED', error: 'You have already submitted this quiz.' });
    return res.json({ ok: true, resumed: true });
  }
  if (now < quiz.start_at) return res.status(403).json({ error: 'The quiz has not started yet.' });
  if (now >= quiz.end_at) return res.status(403).json({ error: 'The quiz window has closed.' });

  const pool = db.prepare('SELECT id, options FROM questions WHERE quiz_id=?').all(quiz.id);
  if (!pool.length) return res.status(503).json({ error: 'The quiz is not ready yet. Please try again shortly.' });
  const take = quiz.questions_per_attempt > 0 ? Math.min(quiz.questions_per_attempt, pool.length) : pool.length;
  // Each student gets their own random subset, question order and option order.
  const order = shuffle(pool).slice(0, take).map((q) => ({
    q: q.id,
    o: shuffle(JSON.parse(q.options).map((_, i) => i)),
  }));
  const deadline = Math.min(now + quiz.duration_min * 60_000, quiz.end_at);
  try {
    db.prepare(`INSERT INTO attempts (quiz_id, student_id, started_at, deadline_at, question_order, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)`).run(quiz.id, s.id, now, deadline, JSON.stringify(order), now);
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e; // double tap on "Start": the first one wins
  }
  res.json({ ok: true });
});

// Loads the running attempt; auto-submits it if time is up.
function requireAttempt(req, res, next) {
  const a = db.prepare("SELECT * FROM attempts WHERE student_id=? AND status='in_progress'").get(req.student.id);
  if (!a) return res.status(409).json({ code: 'SUBMITTED', error: 'Your quiz has been submitted.' });
  const now = Date.now();
  if (a.deadline_at <= now) {
    finalizeAttempt(a.id, 'time_up');
    return res.status(409).json({ code: 'SUBMITTED', error: 'Time is up. Your saved answers have been submitted.' });
  }
  db.prepare('UPDATE attempts SET last_seen=? WHERE id=?').run(now, a.id);
  req.attempt = a;
  req.order = JSON.parse(a.question_order);
  req.quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(a.quiz_id);
  next();
}

function attemptState(req) {
  const a = req.attempt;
  const answers = new Map(db.prepare('SELECT question_id, chosen, marked FROM answers WHERE attempt_id=?')
    .all(a.id).map((r) => [r.question_id, r]));
  return {
    total: req.order.length,
    answered: req.order.map((o) => answers.get(o.q)?.chosen != null),
    marked: req.order.map((o) => !!answers.get(o.q)?.marked),
    remainingMs: a.deadline_at - Date.now(),
    violations: a.violations,
    maxViolations: req.quiz.max_violations,
    title: req.quiz.title,
    serverNow: Date.now(),
  };
}

router.get('/attempt', requireStudent, requireAttempt, (req, res) => res.json(attemptState(req)));

// One question at a time, options in this student's order, and never the correct answer.
router.get('/attempt/q/:n', requireStudent, requireAttempt, (req, res) => {
  const n = Number(req.params.n);
  const entry = req.order[n];
  if (!Number.isInteger(n) || !entry) return res.status(404).json({ error: 'Question not found.' });
  const q = db.prepare('SELECT id, text, image, options FROM questions WHERE id=?').get(entry.q);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const options = JSON.parse(q.options);
  const saved = db.prepare('SELECT chosen, marked FROM answers WHERE attempt_id=? AND question_id=?').get(req.attempt.id, q.id);
  res.json({
    index: n,
    text: q.text,
    image: q.image,
    options: entry.o.map((orig) => options[orig]),
    chosen: saved?.chosen != null ? entry.o.indexOf(saved.chosen) : null,
    marked: !!saved?.marked,
    remainingMs: req.attempt.deadline_at - Date.now(),
  });
});

router.post('/attempt/answer', requireStudent, requireAttempt, (req, res) => {
  const n = Number(req.body?.index);
  const entry = req.order[n];
  if (!Number.isInteger(n) || !entry) return res.status(400).json({ error: 'Invalid question.' });
  const display = req.body?.choice;
  let chosen = null;
  if (display != null) {
    if (!Number.isInteger(display) || display < 0 || display >= entry.o.length) return res.status(400).json({ error: 'Invalid option.' });
    chosen = entry.o[display]; // map back to the original option index
  }
  db.prepare(`INSERT INTO answers (attempt_id, question_id, chosen, marked, answered_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(attempt_id, question_id) DO UPDATE SET chosen=excluded.chosen, marked=excluded.marked, answered_at=excluded.answered_at`)
    .run(req.attempt.id, entry.q, chosen, req.body?.marked ? 1 : 0, Date.now());
  res.json({ ok: true, remainingMs: req.attempt.deadline_at - Date.now() });
});

const VIOLATION_TYPES = new Set(['tab_switch', 'window_blur', 'fullscreen_exit', 'copy_attempt', 'paste_attempt',
  'context_menu', 'print_screen', 'devtools_key', 'page_reload']);

router.post('/attempt/violation', requireStudent, requireAttempt, (req, res) => {
  const type = String(req.body?.type || '');
  if (!VIOLATION_TYPES.has(type)) return res.status(400).json({ error: 'Unknown event.' });
  const now = Date.now();
  const a = req.attempt;
  db.prepare('INSERT INTO violations (attempt_id, type, detail, at) VALUES (?, ?, ?, ?)')
    .run(a.id, type, clean(req.body?.detail, 200), now);

  // Only leaving the quiz screen counts toward auto-submit; key presses and right-clicks are just logged.
  const counts = ['tab_switch', 'window_blur', 'fullscreen_exit'].includes(type);
  let violations = a.violations;
  if (counts) {
    violations++;
    db.prepare('UPDATE attempts SET violations=? WHERE id=?').run(violations, a.id);
  }
  const max = req.quiz.max_violations;
  if (counts && max > 0 && violations >= max) {
    finalizeAttempt(a.id, 'violations');
    return res.json({ violations, maxViolations: max, submitted: true });
  }
  res.json({ violations, maxViolations: max, submitted: false });
});

router.post('/attempt/submit', requireStudent, requireAttempt, (req, res) => {
  finalizeAttempt(req.attempt.id, 'student');
  res.json({ ok: true });
});

module.exports = router;
