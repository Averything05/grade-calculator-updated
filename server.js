const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 100_000;

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8; // per IP + username
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = 20; // new accounts per IP per hour

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- passwords and sessions ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Used when a username doesn't exist, so "unknown user" takes as long as "wrong password".
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('not-a-real-password'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const isSecure = (req) => Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_TTL_MS
  );
  return token;
}

function getUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const row = db
    .prepare(
      'SELECT u.id AS id, u.username AS username, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .get(hash);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return { id: row.id, username: row.username };
}

function requireUser(req) {
  const user = getUser(req);
  if (!user) throw new HttpError(401, 'Please log in.');
  return user;
}

// ---------- rate limiting (in memory, resets on restart) ----------

const failedLogins = new Map();
const registrations = new Map();

function bucket(map, key, windowMs) {
  const now = Date.now();
  if (map.size > 5000) for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  let entry = map.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    map.set(key, entry);
  }
  return entry;
}

function checkLimit(map, key, max, windowMs) {
  if (bucket(map, key, windowMs).count >= max) {
    throw new HttpError(429, 'Too many attempts. Please try again later.');
  }
}

const recordHit = (map, key, windowMs) => {
  bucket(map, key, windowMs).count++;
};

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- validation helpers ----------

const toComponent = (r) => ({
  id: r.id,
  subjectId: r.subject_id,
  name: r.name,
  weight: r.weight,
  score: r.score,
  maxScore: r.max_score,
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function parseName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= 100 ? s : null;
}

function validateCredentials(body, { isRegistration }) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (isRegistration) {
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username))
      throw new HttpError(400, 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  } else if (!username || !password) {
    throw new HttpError(400, 'Enter your username and password.');
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long (max 200 characters).');
  return { username, password };
}

function validateComponent(body) {
  const name = parseName(body.name);
  if (!name) throw new HttpError(400, 'Name is required (max 100 characters).');
  if (!isNum(body.weight) || body.weight < 0 || body.weight > 100)
    throw new HttpError(400, 'Weight must be a number between 0 and 100.');
  const maxScore = body.maxScore === undefined ? 100 : body.maxScore;
  if (!isNum(maxScore) || maxScore <= 0)
    throw new HttpError(400, 'Max score must be greater than 0.');
  const score = body.score === undefined || body.score === null ? null : body.score;
  if (score !== null && (!isNum(score) || score < 0))
    throw new HttpError(400, 'Score must be a number of 0 or more, or left empty.');
  return { name, weight: body.weight, score, maxScore };
}

function validateSubject(body) {
  const name = parseName(body.name);
  if (!name) throw new HttpError(400, 'Name is required (max 100 characters).');
  const target = body.target === undefined ? 80 : body.target;
  if (!isNum(target) || target < 0 || target > 100)
    throw new HttpError(400, 'Target must be a number between 0 and 100.');
  return { name, target };
}

// ---------- data access (always scoped to one user) ----------

function loadSubject(id, userId) {
  const s = db.prepare('SELECT * FROM subjects WHERE id = ? AND user_id = ?').get(id, userId);
  if (!s) return null;
  const components = db
    .prepare('SELECT * FROM components WHERE subject_id = ? ORDER BY id')
    .all(id)
    .map(toComponent);
  return { id: s.id, name: s.name, target: s.target, components };
}

function getComponentRow(id, userId) {
  return db
    .prepare(
      'SELECT c.* FROM components c JOIN subjects s ON s.id = c.subject_id WHERE c.id = ? AND s.user_id = ?'
    )
    .get(id, userId);
}

// ---------- http helpers ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body too large.'));
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

function allow(req, methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'Method not allowed.');
}

// ---------- account routes ----------

async function handleAccount(req, res, pathname) {
  if (pathname === '/api/register') {
    allow(req, ['POST']);
    const ip = clientIp(req);
    checkLimit(registrations, ip, REGISTER_MAX, REGISTER_WINDOW_MS);
    const { username, password } = validateCredentials(await readBody(req), { isRegistration: true });

    const passwordHash = await hashPassword(password);
    let userId;
    try {
      const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
      userId = Number(info.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'That username is already taken.');
      throw err;
    }
    recordHit(registrations, ip, REGISTER_WINDOW_MS);
    const token = createSession(userId);
    return sendJson(res, 201, { id: userId, username }, {
      'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000),
    });
  }

  if (pathname === '/api/login') {
    allow(req, ['POST']);
    const { username, password } = validateCredentials(await readBody(req), { isRegistration: false });
    const limitKey = `${clientIp(req)}|${username.toLowerCase()}`;
    checkLimit(failedLogins, limitKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);

    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
    if (!user || !ok) {
      recordHit(failedLogins, limitKey, LOGIN_WINDOW_MS);
      throw new HttpError(401, 'Incorrect username or password.');
    }
    failedLogins.delete(limitKey);
    const token = createSession(user.id);
    return sendJson(res, 200, { id: user.id, username: user.username }, {
      'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000),
    });
  }

  if (pathname === '/api/logout') {
    allow(req, ['POST']);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return sendEmpty(res, 204, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (pathname === '/api/me') {
    allow(req, ['GET']);
    return sendJson(res, 200, requireUser(req));
  }

  return false;
}

// ---------- subject and component routes ----------

async function handleData(req, res, pathname) {
  const user = requireUser(req);
  let m;

  if (pathname === '/api/subjects') {
    allow(req, ['GET', 'POST']);
    if (req.method === 'GET') {
      const ids = db.prepare('SELECT id FROM subjects WHERE user_id = ? ORDER BY id').all(user.id);
      return sendJson(res, 200, ids.map((r) => loadSubject(r.id, user.id)));
    }
    const v = validateSubject(await readBody(req));
    const info = db
      .prepare('INSERT INTO subjects (user_id, name, target) VALUES (?, ?, ?)')
      .run(user.id, v.name, v.target);
    return sendJson(res, 201, loadSubject(Number(info.lastInsertRowid), user.id));
  }

  if ((m = pathname.match(/^\/api\/subjects\/(\d+)$/))) {
    allow(req, ['PUT', 'DELETE']);
    const id = Number(m[1]);
    const existing = loadSubject(id, user.id);
    if (!existing) throw new HttpError(404, 'Subject not found.');
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM subjects WHERE id = ? AND user_id = ?').run(id, user.id);
      return sendEmpty(res, 204);
    }
    const v = validateSubject({ name: existing.name, target: existing.target, ...(await readBody(req)) });
    db.prepare('UPDATE subjects SET name = ?, target = ? WHERE id = ? AND user_id = ?').run(
      v.name, v.target, id, user.id
    );
    return sendJson(res, 200, loadSubject(id, user.id));
  }

  if ((m = pathname.match(/^\/api\/subjects\/(\d+)\/components$/))) {
    allow(req, ['POST']);
    const subjectId = Number(m[1]);
    if (!loadSubject(subjectId, user.id)) throw new HttpError(404, 'Subject not found.');
    const v = validateComponent(await readBody(req));
    const info = db
      .prepare('INSERT INTO components (subject_id, name, weight, score, max_score) VALUES (?, ?, ?, ?, ?)')
      .run(subjectId, v.name, v.weight, v.score, v.maxScore);
    return sendJson(res, 201, toComponent(getComponentRow(Number(info.lastInsertRowid), user.id)));
  }

  if ((m = pathname.match(/^\/api\/components\/(\d+)$/))) {
    allow(req, ['PUT', 'DELETE']);
    const id = Number(m[1]);
    const row = getComponentRow(id, user.id);
    if (!row) throw new HttpError(404, 'Component not found.');
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM components WHERE id = ?').run(id);
      return sendEmpty(res, 204);
    }
    const v = validateComponent({ ...toComponent(row), ...(await readBody(req)) });
    db.prepare('UPDATE components SET name = ?, weight = ?, score = ?, max_score = ? WHERE id = ?').run(
      v.name, v.weight, v.score, v.maxScore, id
    );
    return sendJson(res, 200, toComponent(getComponentRow(id, user.id)));
  }

  throw new HttpError(404, 'Not found.');
}

async function handleApi(req, res, pathname) {
  const handled = await handleAccount(req, res, pathname);
  if (handled === false) await handleData(req, res, pathname);
}

// ---------- static files ----------

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden.');

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      if (req.url.startsWith('/api/')) return sendJson(res, err.status, { error: err.message });
      res.writeHead(err.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(err.message);
    }
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error.' });
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
  server.listen(port, () => console.log(`Grade calculator running at http://localhost:${port}`));
}

module.exports = server;
