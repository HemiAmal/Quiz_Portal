const crypto = require('crypto');
const { db, withTransaction } = require('../db');

// ---------- passwords & tokens ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- cookies ----------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { path = '/', maxAge } = {}) {
  // Vercel always serves over HTTPS, so cookies are Secure there without any setting.
  const secure = (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : !!process.env.VERCEL) ? '; Secure' : '';
  const age = maxAge != null ? `; Max-Age=${maxAge}` : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Strict${age}${secure}`);
}

// ---------- rate limiting (per IP + bucket, counted in the database so every server instance shares it) ----------
function rateLimit(bucket, max, windowMs) {
  return async (req, res, next) => {
    try {
      const now = Date.now();
      // One atomic statement: start a fresh window if the old one has run out, otherwise count this hit.
      const row = await db.get(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.count + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at < ? THEN excluded.reset_at ELSE rate_limits.reset_at END
         RETURNING count`,
        [`${bucket}:${req.ip}`, now + windowMs, now, now],
      );
      if (row.count > max) {
        return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      if (Math.random() < 0.02) db.run('DELETE FROM rate_limits WHERE reset_at < ?', [now]).catch(() => {});
      next();
    } catch (e) { next(e); }
  };
}

// ---------- scoring ----------
// Grades an attempt on the server. The correct answers never leave the server.
async function finalizeAttempt(attemptId, reason) {
  return withTransaction(async (tx) => {
    const attempt = await tx.get('SELECT * FROM attempts WHERE id = ? FOR UPDATE', [attemptId]);
    if (!attempt || attempt.status === 'submitted') return attempt;

    const order = JSON.parse(attempt.question_order);
    const ids = order.map((o) => o.q);
    const questionRows = ids.length
      ? await tx.all(`SELECT id, correct, marks FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
      : [];
    const questions = new Map(questionRows.map((q) => [q.id, q]));
    const answerRows = await tx.all('SELECT question_id, chosen, marked FROM answers WHERE attempt_id = ?', [attemptId]);
    const answers = new Map(answerRows.map((a) => [a.question_id, a]));

    let score = 0, correct = 0, wrong = 0, unanswered = 0, flagged = 0, total = 0;
    for (const qid of ids) {
      const q = questions.get(qid);
      if (!q) continue;
      total += q.marks;
      const a = answers.get(qid);
      if (a?.marked) flagged++;
      if (a?.chosen == null) unanswered++;
      else if (a.chosen === q.correct) { score += q.marks; correct++; } else wrong++;
    }

    // Never count time beyond the deadline, even if the sweep runs late.
    const submittedAt = Math.min(Date.now(), attempt.deadline_at);
    await tx.run(
      `UPDATE attempts SET status='submitted', submitted_at=?, submit_reason=?, score=?, correct_count=?, wrong_count=?,
       unanswered_count=?, flagged_count=?, total_marks=?, time_taken_ms=? WHERE id=?`,
      [submittedAt, reason, score, correct, wrong, unanswered, flagged, total, submittedAt - attempt.started_at, attemptId],
    );
    return tx.get('SELECT * FROM attempts WHERE id = ?', [attemptId]);
  });
}

// Auto-submits every attempt whose time has run out (students who closed the page, lost network, etc.)
async function sweepExpired() {
  const expired = await db.all("SELECT id FROM attempts WHERE status='in_progress' AND deadline_at <= ?", [Date.now()]);
  for (const a of expired) await finalizeAttempt(a.id, 'time_up');
}

// The sweep, at most once every 15 seconds per server instance. Vercel cannot run a timer between
// requests, so admin requests call this instead: whenever an organiser looks, overdue quizzes are already in.
let lastSweep = 0;
async function sweepIfDue() {
  if (Date.now() - lastSweep < 15_000) return;
  lastSweep = Date.now();
  await sweepExpired();
}

module.exports = {
  hashPassword, verifyPassword, newToken, shuffle,
  parseCookies, setCookie, rateLimit, finalizeAttempt, sweepExpired, sweepIfDue,
};
