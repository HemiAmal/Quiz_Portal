const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ensureSchema, db, getSetting, setSetting } = require('./db');
const { hashPassword, sweepExpired } = require('./lib/common');
const studentRouter = require('./routes/student');
const adminRouter = require('./routes/admin');

const PORT = Number(process.env.PORT) || 3000;

// Builds the Express app once. On a traditional host (local dev, Render, Railway — anywhere the process
// stays alive) this runs once at boot. On Vercel it runs once per cold start and the result is reused
// for every request the warm instance handles afterward (see the export at the bottom of this file).
async function buildApp() {
  // Two instances starting at the same moment on an empty database can collide while creating the
  // tables; the second try then finds them already there.
  await ensureSchema().catch(() => ensureSchema());

  // ---------- first-run setup ----------
  // The admin panel lives at a secret path. Students never see a link to it, and /admin is just a 404.
  let ADMIN_PATH = process.env.ADMIN_PATH || await getSetting('admin_path');
  if (!ADMIN_PATH) {
    ADMIN_PATH = `/control-${crypto.randomBytes(6).toString('hex')}`;
    await setSetting('admin_path', ADMIN_PATH);
  }
  if (!ADMIN_PATH.startsWith('/')) ADMIN_PATH = `/${ADMIN_PATH}`;
  ADMIN_PATH = ADMIN_PATH.replace(/\/+$/, '');

  if (!await db.get('SELECT 1 FROM admins LIMIT 1')) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    try {
      await db.run('INSERT INTO admins (username, pass_hash, created_at) VALUES (?, ?, ?)', [username, hashPassword(password), Date.now()]);
      console.log('\n  First run: admin account created');
      console.log(`    username: ${username}`);
      if (!process.env.ADMIN_PASSWORD) console.log(`    password: ${password}   (change it in Settings after logging in)`);
    } catch (e) {
      // Two cold starts racing to create the first admin at the exact same moment: harmless, the
      // first one to land wins and this one just proceeds without creating a duplicate.
      if (!/unique/i.test(String(e.message))) throw e;
    }
  }

  // ---------- app ----------
  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel's proxy the real visitor address is in X-Forwarded-For; rate limits need it.
  const trustProxy = process.env.TRUST_PROXY || (process.env.VERCEL ? 'true' : '');
  if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? 1 : trustProxy);

  function securityHeaders(scriptSrc) {
    return (req, res, next) => {
      res.set({
        'Content-Security-Policy': `default-src 'self'; script-src 'self'${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      });
      next();
    };
  }

  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  // Backstop for expired attempts whose student closed the page: a long-running process can keep a
  // setInterval, but Vercel functions can't run code between requests, so Vercel instead calls this on
  // a schedule (see vercel.json's cron). Individual students still get caught immediately on their own
  // next request via requireAttempt in routes/student.js — this endpoint only cleans up abandoned ones.
  app.get('/api/cron/sweep', noStore, async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
      await sweepExpired();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Admin (secret path). SheetJS (Excel import/export) is served from node_modules, admin only.
  app.use(ADMIN_PATH, securityHeaders(''));
  app.get(`${ADMIN_PATH}/vendor/xlsx.full.min.js`, (req, res) => res.sendFile(require.resolve('xlsx/dist/xlsx.full.min.js')));
  app.use(`${ADMIN_PATH}/api`, noStore, express.json({ limit: '3mb' }), adminRouter(ADMIN_PATH));
  app.use(ADMIN_PATH, express.static(path.join(__dirname, 'admin'), { index: 'index.html' }));

  // Student side
  app.use(securityHeaders(''));
  app.use('/api', noStore, express.json({ limit: '50kb' }), studentRouter);
  // Question images: kept in the database (or in Vercel Blob when a store is connected, in which case
  // the question holds the Blob URL and this route is not used). See routes/admin.js.
  app.get('/uploads/:name', async (req, res, next) => {
    try {
      const img = await db.get('SELECT mime, data FROM images WHERE name = ?', [req.params.name]);
      if (!img) return res.status(404).type('text').send('Not found');
      res.set('Cache-Control', 'public, max-age=604800, immutable').type(img.mime).send(Buffer.from(img.data, 'base64'));
    } catch (e) { next(e); }
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err.status === 404) return res.status(404).type('text').send('Not found');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  console.log(`  Admin panel (keep this secret): ${ADMIN_PATH}/`);
  return app;
}

let appPromise;
// A failed start (say the database was briefly unreachable) is not remembered: the next request tries again.
const getApp = () => {
  if (!appPromise) appPromise = buildApp().catch((e) => { appPromise = null; throw e; });
  return appPromise;
};

if (require.main === module) {
  // Traditional long-running host: local dev, Render, Railway, a VPS. Also runs the auto-submit sweep
  // on its own 15s interval here, since the process stays alive between requests.
  getApp().then((app) => {
    setInterval(sweepExpired, 15_000).unref();
    sweepExpired();
    app.listen(PORT, () => {
      console.log(`\n  Aaroh Quiz running on http://localhost:${PORT}`);
    });
  }).catch((e) => { console.error('Failed to start:', e); process.exit(1); });
} else {
  // Required as a module — this is the Vercel serverless entry point (see api/index.js).
  module.exports = async (req, res) => {
    let app;
    try { app = await getApp(); } catch (e) {
      console.error('Failed to start:', e);
      // Setup problems (no database connected) say what to do; anything else stays in the logs only.
      const error = e.setup ? e.message : 'The quiz server could not start. Please try again in a moment. (Organisers: see the Logs tab in Vercel.)';
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ error }));
    }
    return app(req, res);
  };
}
