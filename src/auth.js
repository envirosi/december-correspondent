const crypto = require('crypto');
const { q } = require('./db');

const SECRET = process.env.SESSION_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret-do-not-use-in-production');
if (!SECRET) throw new Error('SESSION_SECRET must be set in production');

const COOKIE = 'dc_s';
const INVITE_DAYS = 21;
const SESSION_DAYS = 90;

const newToken = () => crypto.randomBytes(32).toString('base64url');
const digest = t => crypto.createHmac('sha256', SECRET).update(String(t)).digest('hex');
const csrfFor = sd => crypto.createHmac('sha256', SECRET).update('csrf:' + sd).digest('base64url');
const publicOrigin = () => (process.env.PUBLIC_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const secureCookies = () => publicOrigin().startsWith('https://');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Issue a fresh invite, revoking any earlier unused ones for this reader.
async function issueInvite(readerId) {
  const token = newToken();
  await q('update invitation set revoked_at=now() where reader_id=$1 and used_at is null and revoked_at is null', [readerId]);
  await q("insert into invitation(reader_id, digest, expires_at) values ($1,$2, now() + ($3 || ' days')::interval)",
    [readerId, digest(token), String(INVITE_DAYS)]);
  return `${publicOrigin()}/welcome#${token}`;
}

// Atomically consume an invite and create a session. Returns session token or null.
async function redeemInvite(token) {
  if (!token || token.length > 100) return null;
  const r = await q(`update invitation set used_at=now()
      where digest=$1 and used_at is null and revoked_at is null and expires_at > now()
      returning reader_id`, [digest(token)]);
  if (!r.rowCount) return null;
  const readerId = r.rows[0].reader_id;
  const active = await q('select 1 from reader where id=$1 and active', [readerId]);
  if (!active.rowCount) return null;
  const s = newToken();
  await q("insert into session(reader_id, digest, expires_at) values ($1,$2, now() + ($3 || ' days')::interval)",
    [readerId, digest(s), String(SESSION_DAYS)]);
  return s;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: secureCookies(), path: '/',
    maxAge: SESSION_DAYS * 86400000,
  });
}

async function loadSession(req, res, next) {
  try {
    const t = readCookie(req, COOKIE);
    if (t && t.length < 100) {
      const d = digest(t);
      const r = await q(`select r.* from session s join reader r on r.id=s.reader_id
          where s.digest=$1 and s.revoked_at is null and s.expires_at > now() and r.active`, [d]);
      if (r.rowCount) {
        req.reader = r.rows[0];
        req.sessionDigest = d;
        req.csrf = csrfFor(d);
      }
    }
    next();
  } catch (e) { next(e); }
}

function checkOrigin(req) {
  const o = req.get('origin');
  if (!o) return true;
  return o.replace(/\/$/, '') === publicOrigin();
}

function csrfOk(req) {
  if (!checkOrigin(req)) return false;
  if (!req.sessionDigest) return false;
  const given = String((req.body && req.body._csrf) || '');
  const want = req.csrf;
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

module.exports = {
  COOKIE, newToken, digest, issueInvite, redeemInvite, setSessionCookie, loadSession,
  csrfOk, checkOrigin, publicOrigin,
};
