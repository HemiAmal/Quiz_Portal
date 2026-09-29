const crypto = require('crypto');
const { db } = require('../db');

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
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  const age = maxAge != null ? `; Max-Age=${maxAge}` : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Strict${age}${secure}`);
}

// ---------- rate limiting (in memory, per IP + bucket) ----------
const hits = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60_000).unref();

// ---------- scoring ----------
// Grades an attempt on the server. The correct answers never leave the server.
const finalizeAttempt = db.transaction((attemptId, reason) => {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt || attempt.status === 'submitted') return attempt;

  const order = JSON.parse(attempt.question_order);
  const ids = order.map((o) => o.q);
  const questions = new Map(
    db.prepare(`SELECT id, correct, marks FROM questions WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`)
      .all(...ids).map((q) => [q.id, q])
  );
  const answers = new Map(
    db.prepare('SELECT question_id, chosen, marked FROM answers WHERE attempt_id = ?').all(attemptId)
      .map((a) => [a.question_id, a])
  );

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
  db.prepare(`UPDATE attempts SET status='submitted', submitted_at=?, submit_reason=?, score=?, correct_count=?, wrong_count=?,
              unanswered_count=?, flagged_count=?, total_marks=?, time_taken_ms=? WHERE id=?`)
    .run(submittedAt, reason, score, correct, wrong, unanswered, flagged, total, submittedAt - attempt.started_at, attemptId);
  return db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
});

// Auto-submits every attempt whose time has run out (students who closed the page, lost network, etc.)
function sweepExpired() {
  const expired = db.prepare("SELECT id FROM attempts WHERE status='in_progress' AND deadline_at <= ?").all(Date.now());
  for (const a of expired) finalizeAttempt(a.id, 'time_up');
}

module.exports = {
  hashPassword, verifyPassword, newToken, shuffle,
  parseCookies, setCookie, rateLimit, finalizeAttempt, sweepExpired,
};
