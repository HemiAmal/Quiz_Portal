const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const { hashPassword, sweepExpired } = require('./lib/common');
const studentRouter = require('./routes/student');
const adminRouter = require('./routes/admin');

const PORT = Number(process.env.PORT) || 3000;

// ---------- first-run setup ----------
// The admin panel lives at a secret path. Students never see a link to it, and /admin is just a 404.
let ADMIN_PATH = process.env.ADMIN_PATH || getSetting('admin_path');
if (!ADMIN_PATH) {
  ADMIN_PATH = `/control-${crypto.randomBytes(6).toString('hex')}`;
  setSetting('admin_path', ADMIN_PATH);
}
if (!ADMIN_PATH.startsWith('/')) ADMIN_PATH = `/${ADMIN_PATH}`;
ADMIN_PATH = ADMIN_PATH.replace(/\/+$/, '');

if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO admins (username, pass_hash, created_at) VALUES (?, ?, ?)').run(username, hashPassword(password), Date.now());
  console.log('\n  First run: admin account created');
  console.log(`    username: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`    password: ${password}   (change it in Settings after logging in)`);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

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

// Admin (secret path). SheetJS (Excel import/export) is served from node_modules, admin only.
app.use(ADMIN_PATH, securityHeaders(''));
app.get(`${ADMIN_PATH}/vendor/xlsx.full.min.js`, (req, res) => res.sendFile(require.resolve('xlsx/dist/xlsx.full.min.js')));
app.use(`${ADMIN_PATH}/api`, noStore, express.json({ limit: '3mb' }), adminRouter(ADMIN_PATH));
app.use(ADMIN_PATH, express.static(path.join(__dirname, 'admin'), { index: 'index.html' }));

// Student side
app.use(securityHeaders(''));
app.use('/api', noStore, express.json({ limit: '50kb' }), studentRouter);
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'), { maxAge: '7d', fallthrough: false }));
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

// Auto-submit attempts whose time ran out even if the student closed the page.
setInterval(sweepExpired, 15_000).unref();
sweepExpired();

app.listen(PORT, () => {
  console.log(`\n  Aaroh Quiz running on http://localhost:${PORT}`);
  console.log(`  Admin panel (keep this secret): http://localhost:${PORT}${ADMIN_PATH}/\n`);
});
