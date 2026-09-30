const path = require('path');
const fs = require('fs');

// Two ways to reach Postgres, same SQL for both:
//  - Hosted (Vercel): the Postgres (Neon) integration injects POSTGRES_URL; a plain Neon project uses DATABASE_URL.
//  - Local development with neither set: PGlite, a real Postgres engine that runs inside Node and keeps
//    its files in DATA_DIR/pg. Nothing to install, and `npm start` works offline.
// Each driver exposes query(text, values) -> { rows, fields, rowCount }, exec(sql) for the multi-statement
// schema, and transaction(fn) where fn receives a query function pinned to one connection.
const CONNECTION = process.env.POSTGRES_URL || process.env.DATABASE_URL;

function hostedDriver() {
  const { createPool } = require('@vercel/postgres');
  const pool = createPool({ connectionString: CONNECTION });
  return {
    query: (text, values) => pool.query(text, values),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      // One pinned connection: the pool hands out a different one per query, which would break atomicity.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, values) => client.query(text, values));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

function localDriver() {
  if (process.env.VERCEL) {
    throw new Error('No database configured. Connect a Postgres (Neon) database to this Vercel project so POSTGRES_URL is set, then redeploy.');
  }
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'pg');
  fs.mkdirSync(dir, { recursive: true });
  // Built from parts so Vercel's bundler does not pull this dev-only package into the deployed function.
  const { PGlite } = require(['@electric-sql', 'pglite'].join('/'));
  const pg = new PGlite(dir);
  const shape = (r) => ({ rows: r.rows, fields: r.fields, rowCount: r.affectedRows });
  return {
    query: async (text, values) => shape(await pg.query(text, values)),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn(async (text, values) => shape(await tx.query(text, values)))),
  };
}

const driver = CONNECTION ? hostedDriver() : localDriver();

// Postgres returns BIGINT (and COUNT(*)) as strings. Every BIGINT here is a millisecond timestamp or a
// count, all far below 2^53, so turn them back into numbers — the rest of the app and both front ends
// expect numbers, as SQLite gave them.
function fixRows(result) {
  const big = (result.fields || []).filter((f) => f.dataTypeID === 20).map((f) => f.name);
  if (big.length) {
    for (const row of result.rows) for (const name of big) if (row[name] != null) row[name] = Number(row[name]);
  }
  return result;
}

// ---------- ?/@name placeholder compatibility layer ----------
// The rest of the app was written against better-sqlite3's `?` and `@name` placeholder styles.
// This converts either style into Postgres's `$1, $2, ...` style, reusing the same number when
// a named placeholder (e.g. `@q`) appears more than once in a query.
function toPgQuery(text, params) {
  if (Array.isArray(params)) {
    let i = 0;
    return { text: text.replace(/\?/g, () => `$${++i}`), values: params };
  }
  const values = [];
  const seen = new Map();
  const converted = text.replace(/@(\w+)/g, (_, name) => {
    if (!seen.has(name)) { values.push(params[name]); seen.set(name, values.length); }
    return `$${seen.get(name)}`;
  });
  return { text: converted, values };
}

function makeDb(query) {
  return {
    async get(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows } = fixRows(await query(t, values));
      return rows[0];
    },
    async all(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows } = fixRows(await query(t, values));
      return rows;
    },
    // For INSERT statements that need the new row's id, the call site's SQL must end with `RETURNING id`.
    async run(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows, rowCount } = fixRows(await query(t, values));
      return { lastInsertRowid: rows[0]?.id, rowCount };
    },
  };
}

const db = makeDb(driver.query);

// Runs `fn(tx)` inside a single Postgres transaction. Inside `fn`, use only `tx`, never `db`.
const withTransaction = (fn) => driver.transaction((query) => fn(makeDb(query)));

// ---------- schema ----------
// Millisecond epoch columns (created_at, start_at, deadline_at, ...) are BIGINT: Postgres's plain
// INTEGER is 32-bit (~2.1 billion) and overflows on Date.now()-style values (13 digits) — SQLite's
// INTEGER didn't have this problem because it's dynamically 64-bit regardless of the declared type.
async function ensureSchema() {
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      school TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('student','admin')),
      user_id INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      revoked TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(kind, user_id);

    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      instructions TEXT,
      start_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      duration_min INTEGER NOT NULL,
      questions_per_attempt INTEGER NOT NULL DEFAULT 0,
      max_violations INTEGER NOT NULL DEFAULT 3,
      published INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      image TEXT,
      options TEXT NOT NULL,
      correct INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      difficulty TEXT NOT NULL DEFAULT 'Medium',
      marks DOUBLE PRECISION NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);

    CREATE TABLE IF NOT EXISTS attempts (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      started_at BIGINT NOT NULL,
      deadline_at BIGINT NOT NULL,
      submitted_at BIGINT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
      submit_reason TEXT,
      question_order TEXT NOT NULL,
      score DOUBLE PRECISION,
      correct_count INTEGER,
      wrong_count INTEGER,
      unanswered_count INTEGER,
      flagged_count INTEGER,
      total_marks DOUBLE PRECISION,
      time_taken_ms BIGINT,
      violations INTEGER NOT NULL DEFAULT 0,
      last_seen BIGINT,
      UNIQUE (quiz_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, deadline_at);

    CREATE TABLE IF NOT EXISTS answers (
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL,
      chosen INTEGER,
      marked INTEGER NOT NULL DEFAULT 0,
      answered_at BIGINT NOT NULL,
      PRIMARY KEY (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS violations (
      id SERIAL PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      detail TEXT,
      at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_violations_attempt ON violations(attempt_id);

    -- Rate limiting is kept here rather than in memory: on Vercel every instance has its own memory,
    -- so an in-memory counter would let each instance be tried separately.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at BIGINT NOT NULL
    );

    -- Question images, used only when no Vercel Blob store is connected.
    CREATE TABLE IF NOT EXISTS images (
      name TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
}

async function getSetting(key, fallback = null) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
}

module.exports = { db, withTransaction, ensureSchema, getSetting, setSetting };
