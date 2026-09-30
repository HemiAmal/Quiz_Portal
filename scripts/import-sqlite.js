// One-time move of the old SQLite data (data/aaroh.db) into Postgres.
//
//   node scripts/import-sqlite.js            into the local development database (data/pg)
//   POSTGRES_URL=... node scripts/import-sqlite.js    into the hosted database used by Vercel
//
// Copies the admin account, admin path, quizzes, questions, students, attempts, answers and the
// activity log, keeping every id. Login sessions are not copied (everyone just logs in again).
// Refuses to run if the target already has quizzes or students, unless --force is given, in which
// case the target's data is replaced. Needs Node 22.5 or newer (built-in SQLite reader).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { db, withTransaction, ensureSchema } = require('../db');

const TABLES = {
  settings: ['key', 'value'],
  admins: ['id', 'username', 'pass_hash', 'created_at'],
  students: ['id', 'name', 'phone', 'school', 'paid', 'status', 'created_at'],
  quizzes: ['id', 'title', 'instructions', 'start_at', 'end_at', 'duration_min', 'questions_per_attempt', 'max_violations', 'published', 'created_at'],
  questions: ['id', 'quiz_id', 'text', 'image', 'options', 'correct', 'category', 'difficulty', 'marks', 'created_at'],
  attempts: ['id', 'quiz_id', 'student_id', 'started_at', 'deadline_at', 'submitted_at', 'status', 'submit_reason', 'question_order',
    'score', 'correct_count', 'wrong_count', 'unanswered_count', 'flagged_count', 'total_marks', 'time_taken_ms', 'violations', 'last_seen'],
  answers: ['attempt_id', 'question_id', 'chosen', 'marked', 'answered_at'],
  violations: ['id', 'attempt_id', 'type', 'detail', 'at'],
};
const WITH_ID = ['admins', 'students', 'quizzes', 'questions', 'attempts', 'violations'];

(async () => {
  const file = process.argv.find((a) => a.endsWith('.db')) || path.join(__dirname, '..', 'data', 'aaroh.db');
  const force = process.argv.includes('--force');
  const old = new DatabaseSync(file, { readOnly: true });

  await ensureSchema();
  const busy = await db.get('SELECT (SELECT COUNT(*) FROM quizzes) + (SELECT COUNT(*) FROM students) n');
  if (busy.n > 0 && !force) {
    console.error('The target database already has quizzes or students. Run again with --force to replace them.');
    process.exit(1);
  }

  await withTransaction(async (tx) => {
    // Children first, so the foreign keys never point at a missing row.
    for (const t of ['violations', 'answers', 'attempts', 'questions', 'quizzes', 'sessions', 'students', 'admins', 'settings']) {
      await tx.run(`DELETE FROM ${t}`);
    }
    for (const [table, cols] of Object.entries(TABLES)) {
      const rows = old.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
      for (const row of rows) {
        await tx.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
      }
      console.log(`${table}: ${rows.length}`);
    }
    // Ids were copied as they were, so move each counter past the highest one.
    for (const t of WITH_ID) {
      await tx.run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
    }
  });

  // Question pictures that used to sit in uploads/ move into the database, under the same /uploads/<name> address.
  const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  let pictures = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const mime = MIME[name.split('.').pop()];
    if (!mime || !/^[\w.-]+$/.test(name)) continue;
    await db.run('INSERT INTO images (name, mime, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
      [name, mime, fs.readFileSync(path.join(dir, name)).toString('base64'), Date.now()]);
    pictures++;
  }
  console.log(`pictures: ${pictures}`);
  console.log('Import finished.');
  process.exit(0);
})().catch((e) => { console.error('Import failed:', e.message); process.exit(1); });
