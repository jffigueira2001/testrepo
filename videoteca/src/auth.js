import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const COOKIE = 'vt_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.sessionDays * 86400_000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function sessionCookie(token, expiresAt) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (expiresAt) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  else parts.push('Max-Age=0');
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function tokenFromCookieHeader(header) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** Devolve o utilizador associado ao cabeçalho Cookie, ou null. */
export function userFromCookieHeader(header) {
  const token = tokenFromCookieHeader(header);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return null;
  }
  const { expires_at, ...user } = row;
  return { ...user, token };
}

export function loadUser(req, _res, next) {
  req.user = userFromCookieHeader(req.headers.cookie);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sessão expirada. Faz login novamente.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sessão expirada. Faz login novamente.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem fazer isto.' });
  next();
}

/** Cria a conta de admin inicial quando a base de dados está vazia. */
export function ensureAdmin() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Administrador', config.adminEmail, hashPassword(config.adminPassword), 'admin');
  console.log(`[auth] Conta de admin criada: ${config.adminEmail} (muda a password depois do primeiro login)`);
}

// Limpa sessões expiradas de hora a hora.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();
