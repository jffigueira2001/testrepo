import express from 'express';
import fs from 'node:fs';
import { db, tx } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, sessionCookie, requireAuth, requireAdmin,
} from './auth.js';
import { enqueueJob, EDIT_TYPES, thumbPath, deleteVideoFiles } from './media.js';
import * as storage from './storage.js';
import { forgetFolder } from './drive.js';

export const api = express.Router();
api.use(express.json({ limit: '100kb' }));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Recurso') => new HttpError(404, `${what} não encontrado.`);

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

const failedLogins = new Map(); // ip -> { count, until }

api.post('/login', (req, res) => {
  const ip = req.ip;
  const f = failedLogins.get(ip);
  if (f && f.count >= 10 && f.until > Date.now()) {
    throw new HttpError(429, 'Demasiadas tentativas. Tenta novamente daqui a 15 minutos.');
  }
  const email = str(req.body?.email).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body?.password ?? ''), user.password_hash)) {
    failedLogins.set(ip, { count: (f?.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 });
    throw new HttpError(401, 'Email ou password incorretos.');
  }
  failedLogins.delete(ip);
  if (user.status !== 'active') {
    throw new HttpError(403, 'A tua conta ainda não foi aprovada. Um administrador tem de a aprovar antes de poderes entrar.');
  }
  const { token, expiresAt } = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// Pedido de conta: fica pendente até um administrador aprovar.
const registrations = new Map(); // ip -> { count, until }

api.post('/register', (req, res) => {
  const r = registrations.get(req.ip);
  if (r && r.count >= 5 && r.until > Date.now()) {
    throw new HttpError(429, 'Demasiados pedidos de conta. Tenta novamente mais tarde.');
  }
  const name = str(req.body?.name, 100);
  const email = str(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Indica o teu nome e um email válido.');
  if (password.length < 8) throw bad('A password tem de ter pelo menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Já existe uma conta com esse email.');
  db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, 'member', 'pending')")
    .run(name, email, hashPassword(password));
  registrations.set(req.ip, { count: (r?.until > Date.now() ? r.count : 0) + 1, until: Date.now() + 3600_000 });
  res.status(201).json({ ok: true });
});

api.post('/logout', (req, res) => {
  if (req.user) destroySession(req.user.token);
  res.setHeader('Set-Cookie', sessionCookie('', null));
  res.json({ ok: true });
});

api.get('/me', requireAuth, (req, res) => {
  const { token, ...user } = req.user;
  res.json(user);
});

api.post('/me/password', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body?.current ?? ''), user.password_hash)) throw bad('A password atual está errada.');
  const next = String(req.body?.next ?? '');
  if (next.length < 8) throw bad('A nova password tem de ter pelo menos 8 caracteres.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  // Termina as outras sessões deste utilizador.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, req.user.token);
  res.json({ ok: true });
});

// Tudo o que se segue exige sessão.
api.use(requireAuth);

// ---------------------------------------------------------------------------
// Equipas
// ---------------------------------------------------------------------------

api.get('/teams', (_req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM games g WHERE g.team_id = t.id) AS games,
      (SELECT COUNT(*) FROM videos v JOIN games g ON g.id = v.game_id WHERE g.team_id = t.id) AS videos,
      (SELECT COALESCE(SUM(v.size), 0) FROM videos v JOIN games g ON g.id = v.game_id WHERE g.team_id = t.id) AS bytes
    FROM teams t ORDER BY t.name`).all());
});

api.post('/teams', requireAdmin, (req, res) => {
  const name = str(req.body?.name, 80);
  if (!name) throw bad('Indica o nome da equipa.');
  if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name)) throw bad('Já existe uma equipa com esse nome.');
  const { lastInsertRowid } = db.prepare('INSERT INTO teams (name) VALUES (?)').run(name);
  res.status(201).json({ id: Number(lastInsertRowid), name });
});

api.patch('/teams/:id', requireAdmin, (req, res) => {
  const name = str(req.body?.name, 80);
  if (!name) throw bad('Indica o nome da equipa.');
  const r = db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, req.params.id);
  if (!r.changes) throw notFound('Equipa');
  storage.teamChanged(Number(req.params.id), name);
  res.json({ ok: true });
});

api.delete('/teams/:id', requireAdmin, (req, res) => {
  const videos = db.prepare(`SELECT v.* FROM videos v JOIN games g ON g.id = v.game_id WHERE g.team_id = ?`)
    .all(req.params.id);
  const gameIds = db.prepare('SELECT id FROM games WHERE team_id = ?').all(req.params.id).map((g) => g.id);
  const r = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  if (!r.changes) throw notFound('Equipa');
  videos.forEach(deleteVideoFiles);
  gameIds.forEach((id) => forgetFolder(`game:${id}`));
  storage.folderDeleted(`team:${req.params.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Jogos
// ---------------------------------------------------------------------------

function gameInput(body) {
  const game = {
    team_id: Number(body?.team_id),
    date: str(body?.date, 10),
    opponent: str(body?.opponent, 120),
    competition: str(body?.competition, 120),
    venue: ['casa', 'fora', 'neutro'].includes(body?.venue) ? body.venue : 'casa',
    notes: str(body?.notes, 2000),
  };
  if (!game.team_id || !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(game.team_id)) throw bad('Escolhe a equipa.');
  if (!isDate(game.date)) throw bad('Data do jogo inválida.');
  if (!game.opponent) throw bad('Indica o adversário.');
  return game;
}

api.get('/games', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.team_id) { where.push('g.team_id = ?'); args.push(Number(req.query.team_id)); }
  if (req.query.q) {
    where.push("(g.opponent LIKE ? OR g.competition LIKE ? OR g.date LIKE ? OR EXISTS (SELECT 1 FROM videos v WHERE v.game_id = g.id AND v.title LIKE ?))");
    const q = `%${str(req.query.q, 100)}%`;
    args.push(q, q, q, q);
  }
  res.json(db.prepare(`
    SELECT g.*, t.name AS team_name,
      (SELECT COUNT(*) FROM videos v WHERE v.game_id = g.id) AS videos,
      (SELECT COALESCE(SUM(v.duration), 0) FROM videos v WHERE v.game_id = g.id) AS duration,
      (SELECT v.id FROM videos v WHERE v.game_id = g.id AND v.thumb IS NOT NULL ORDER BY v.id LIMIT 1) AS cover_video_id
    FROM games g JOIN teams t ON t.id = g.team_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY g.date DESC, g.id DESC`).all(...args));
});

api.get('/games/:id', (req, res) => {
  const game = db.prepare(`SELECT g.*, t.name AS team_name FROM games g JOIN teams t ON t.id = g.team_id WHERE g.id = ?`)
    .get(req.params.id);
  if (!game) throw notFound('Jogo');
  game.videos = db.prepare(`
    SELECT v.id, v.title, v.original_name, v.status, v.size, v.duration, v.width, v.height, v.error,
           v.parent_id, v.created_at, v.updated_at, v.thumb IS NOT NULL AS has_thumb, u.name AS uploaded_by
    FROM videos v LEFT JOIN users u ON u.id = v.uploaded_by
    WHERE v.game_id = ? ORDER BY v.parent_id IS NOT NULL, v.created_at, v.id`).all(game.id);
  game.jobs = db.prepare(`
    SELECT j.id, j.video_id, j.type, j.status, j.progress, j.error FROM jobs j JOIN videos v ON v.id = j.video_id
    WHERE v.game_id = ? AND (j.status IN ('queued', 'running') OR (j.status = 'error' AND j.finished_at > datetime('now', '-1 day')))
    ORDER BY j.id`).all(game.id);
  res.json(game);
});

// Qualquer membro pode criar um jogo (para conseguir etiquetar o upload); editar/apagar é para admins.
api.post('/games', (req, res) => {
  const g = gameInput(req.body);
  const existing = db.prepare('SELECT id FROM games WHERE team_id = ? AND date = ? AND opponent = ? COLLATE NOCASE')
    .get(g.team_id, g.date, g.opponent);
  if (existing) return res.status(200).json({ id: existing.id, existing: true });
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO games (team_id, date, opponent, competition, venue, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(g.team_id, g.date, g.opponent, g.competition, g.venue, g.notes);
  res.status(201).json({ id: Number(lastInsertRowid) });
});

api.patch('/games/:id', requireAdmin, (req, res) => {
  const g = gameInput(req.body);
  const r = db.prepare(`UPDATE games SET team_id = ?, date = ?, opponent = ?, competition = ?, venue = ?, notes = ? WHERE id = ?`)
    .run(g.team_id, g.date, g.opponent, g.competition, g.venue, g.notes, req.params.id);
  if (!r.changes) throw notFound('Jogo');
  storage.gameChanged(Number(req.params.id));
  res.json({ ok: true });
});

api.delete('/games/:id', requireAdmin, (req, res) => {
  const videos = db.prepare('SELECT * FROM videos WHERE game_id = ?').all(req.params.id);
  const r = db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  if (!r.changes) throw notFound('Jogo');
  videos.forEach(deleteVideoFiles);
  storage.folderDeleted(`game:${req.params.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Vídeos
// ---------------------------------------------------------------------------

function loadVideo(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v) throw notFound('Vídeo');
  return v;
}

api.get('/videos/:id', (req, res) => {
  const v = loadVideo(req.params.id);
  const { source_path, file, thumb, ...rest } = v;
  rest.jobs = db.prepare(`SELECT id, type, status, progress, error, params, created_at, finished_at
                          FROM jobs WHERE video_id = ? ORDER BY id DESC LIMIT 20`).all(v.id);
  res.json(rest);
});

// Streaming com suporte a "Range" (permite saltar para qualquer minuto sem descarregar tudo).
api.get('/videos/:id/stream', async (req, res) => {
  const v = loadVideo(req.params.id);
  if (!v.file) throw notFound('Ficheiro de vídeo');
  await storage.send(v.file, req, res);
});

api.get('/videos/:id/download', async (req, res) => {
  const v = loadVideo(req.params.id);
  if (!v.file) throw notFound('Ficheiro de vídeo');
  const game = db.prepare('SELECT g.date, g.opponent, t.name AS team FROM games g JOIN teams t ON t.id = g.team_id WHERE g.id = ?').get(v.game_id);
  const name = `${game.date} ${game.team} vs ${game.opponent} - ${v.title}.mp4`.replace(/[\\/:*?"<>|]+/g, '_');
  await storage.send(v.file, req, res, { downloadName: name });
});

api.get('/videos/:id/thumb', (req, res) => {
  const file = thumbPath(loadVideo(req.params.id));
  if (!file || !fs.existsSync(file)) throw notFound('Miniatura');
  res.sendFile(file, { maxAge: '7d', immutable: true });
});

api.patch('/videos/:id', requireAdmin, (req, res) => {
  const v = loadVideo(req.params.id);
  const title = req.body?.title !== undefined ? str(req.body.title, 200) : v.title;
  const gameId = req.body?.game_id !== undefined ? Number(req.body.game_id) : v.game_id;
  if (!title) throw bad('O título não pode ficar vazio.');
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) throw bad('Jogo inválido.');
  db.prepare("UPDATE videos SET title = ?, game_id = ?, updated_at = datetime('now') WHERE id = ?").run(title, gameId, v.id);
  storage.videoChanged({ ...v, title, game_id: gameId }, v.game_id);
  res.json({ ok: true });
});

api.delete('/videos/:id', requireAdmin, (req, res) => {
  const v = loadVideo(req.params.id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  deleteVideoFiles(v);
  res.json({ ok: true });
});

/**
 * Edição (admins). Corpo: { type: 'trim'|'rotate'|'mute'|'compress', params: {...} }
 * trim: { start, end, precise?, mode: 'replace'|'clip', title? }  -> 'clip' cria um vídeo novo no mesmo jogo
 * rotate: { degrees: 90|180|270 }   compress: { height: 480|720|1080, crf? }   mute: {}
 */
api.post('/videos/:id/edit', requireAdmin, (req, res) => {
  const v = loadVideo(req.params.id);
  const type = req.body?.type;
  const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
  if (!EDIT_TYPES.includes(type)) throw bad('Operação de edição desconhecida.');
  if (v.status !== 'ready') throw bad('O vídeo ainda está a ser processado.');

  if (type === 'trim') {
    const start = Number(params.start);
    const end = Number(params.end);
    if (!(start >= 0) || !(end > start) || start >= v.duration) throw bad('Escolhe um início e fim válidos.');
    const clean = { start, end: Math.min(end, v.duration), precise: !!params.precise };
    if (params.mode === 'clip') {
      const title = str(params.title, 200) || `${v.title} (clip)`;
      const result = tx(() => {
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO videos (game_id, parent_id, title, original_name, status, uploaded_by)
          VALUES (?, ?, ?, ?, 'processing', ?)`).run(v.game_id, v.id, title, v.original_name, req.user.id);
        const clipId = Number(lastInsertRowid);
        return { videoId: clipId, jobId: enqueueJob(clipId, 'trim', { ...clean, sourceVideoId: v.id }, req.user.id) };
      });
      return res.status(202).json(result);
    }
    return res.status(202).json({ videoId: v.id, jobId: enqueueJob(v.id, 'trim', clean, req.user.id) });
  }
  if (type === 'rotate' && ![90, 180, 270].includes(Number(params.degrees))) throw bad('Rotação inválida.');
  res.status(202).json({ videoId: v.id, jobId: enqueueJob(v.id, type, params, req.user.id) });
});

// ---------------------------------------------------------------------------
// Fila de processamento
// ---------------------------------------------------------------------------

api.get('/jobs', (_req, res) => {
  res.json(db.prepare(`
    SELECT j.id, j.video_id, j.type, j.status, j.progress, j.error, j.created_at, j.finished_at,
           v.title, v.game_id, g.date, g.opponent, t.name AS team_name
    FROM jobs j JOIN videos v ON v.id = j.video_id JOIN games g ON g.id = v.game_id JOIN teams t ON t.id = g.team_id
    WHERE j.status IN ('queued', 'running') OR j.finished_at > datetime('now', '-1 day')
    ORDER BY j.id DESC LIMIT 100`).all());
});

// ---------------------------------------------------------------------------
// Utilizadores (admins)
// ---------------------------------------------------------------------------

api.get('/users', requireAdmin, (_req, res) => {
  res.json(db.prepare("SELECT id, name, email, role, status, created_at FROM users ORDER BY status = 'active', name").all());
});

api.post('/users', requireAdmin, (req, res) => {
  const name = str(req.body?.name, 100);
  const email = str(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Nome e email válidos são obrigatórios.');
  if (password.length < 8) throw bad('A password tem de ter pelo menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Já existe um utilizador com esse email.');
  const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role);
  res.status(201).json({ id: Number(lastInsertRowid) });
});

api.patch('/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) throw notFound('Utilizador');
  const role = req.body?.role ? (req.body.role === 'admin' ? 'admin' : 'member') : user.role;
  if (user.role === 'admin' && role !== 'admin') {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
    if (n <= 1) throw bad('Tem de existir pelo menos um administrador.');
  }
  const name = req.body?.name ? str(req.body.name, 100) : user.name;
  // Aprovar ('active') ou suspender ('pending') o acesso.
  const status = ['active', 'pending'].includes(req.body?.status) ? req.body.status : user.status;
  if (status === 'pending' && user.id === req.user.id) throw bad('Não podes suspender a tua própria conta.');
  if (status === 'pending' && user.role === 'admin') throw bad('Tira primeiro o perfil de admin a esta conta.');
  db.prepare('UPDATE users SET name = ?, role = ?, status = ? WHERE id = ?').run(name, role, status, user.id);
  if (status === 'pending') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  if (req.body?.password) {
    if (String(req.body.password).length < 8) throw bad('A password tem de ter pelo menos 8 caracteres.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.password)), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  res.json({ ok: true });
});

api.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) throw bad('Não podes apagar a tua própria conta.');
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (!r.changes) throw notFound('Utilizador');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------

api.use((_req, _res, next) => next(notFound('Endpoint')));

// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

