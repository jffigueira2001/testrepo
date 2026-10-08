// Cliente mínimo da API do Google Drive v3 (REST, sem dependências).
// Autenticação: OAuth com refresh token da conta Google do clube (ver scripts/drive-auth.js).
import fs from 'node:fs';
import { db } from './db.js';
import { config } from './config.js';

const { drive: cfg } = config;
const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK = cfg.chunkMb * 1024 * 1024; // múltiplo de 256 KB, como exige a API

let token = null; // { value, expiresAt }

export async function accessToken() {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) return token.value;
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive: não foi possível autenticar (${data.error || res.status}). Volta a correr "npm run drive:auth".`);
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function request(method, url, { body, headers = {}, query, raw = false, signal } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
        ...headers,
      },
      body: body && !(body instanceof Buffer) ? JSON.stringify(body) : body,
    });
    // Erros temporários / limites de taxa: tenta outra vez com espera crescente.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (res.status === 401 && attempt === 0) { token = null; await res.body?.cancel(); continue; }
    if (raw) return res;
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`Google Drive: ${data.error?.message || res.status}`);
    return data;
  }
}

const api = (path) => `${cfg.apiBase}/drive/v3/files${path}`;

export function createFolder(name, parentId) {
  return request('POST', api(''), {
    body: { name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) },
    query: { fields: 'id' },
  }).then((f) => f.id);
}

export function updateFile(id, { name, addParents, removeParents, trashed } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (trashed !== undefined) body.trashed = trashed;
  return request('PATCH', api(`/${id}`), { body, query: { addParents, removeParents, fields: 'id,parents' } });
}

export function getFile(id, fields = 'id,name,parents,size') {
  return request('GET', api(`/${id}`), { query: { fields } });
}

/** Envia para a reciclagem do Drive (recuperável durante 30 dias). */
export function trash(id) {
  return updateFile(id, { trashed: true }).catch((err) => {
    if (!/not found/i.test(err.message)) throw err;
  });
}

/** Upload retomável em blocos de 64 MB (ficheiros de vários GB). */
export async function uploadFile(localPath, { name, parentId, mimeType = 'video/mp4' }) {
  const size = fs.statSync(localPath).size;
  const init = await request('POST', `${cfg.uploadBase}/upload/drive/v3/files`, {
    query: { uploadType: 'resumable', fields: 'id' },
    headers: { 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
    body: { name, parents: [parentId] },
    raw: true,
  });
  if (!init.ok) throw new Error(`Google Drive: falha ao iniciar upload (${init.status})`);
  await init.body?.cancel();
  const session = init.headers.get('location');

  const fd = fs.openSync(localPath, 'r');
  try {
    let offset = 0;
    for (let failures = 0; ;) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      let res;
      try {
        res = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Range': len ? `bytes ${offset}-${offset + len - 1}/${size}` : `bytes */${size}` },
          body: buf,
        });
      } catch (err) {
        if (++failures > 6) throw err;
        await new Promise((r) => setTimeout(r, 2 ** failures * 1000));
        offset = await resumeOffset(session, size);
        continue;
      }
      if (res.status === 200 || res.status === 201) return (await res.json()).id;
      if (res.status === 308) {
        await res.body?.cancel();
        const range = res.headers.get('range'); // "bytes=0-N"
        offset = range ? Number(range.split('-')[1]) + 1 : 0;
        failures = 0;
        continue;
      }
      await res.body?.cancel();
      if (res.status >= 500 && ++failures <= 6) {
        await new Promise((r) => setTimeout(r, 2 ** failures * 1000));
        offset = await resumeOffset(session, size);
        continue;
      }
      throw new Error(`Google Drive: upload falhou (${res.status})`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function resumeOffset(session, size) {
  const res = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
  await res.body?.cancel();
  const range = res.headers.get('range');
  return range ? Number(range.split('-')[1]) + 1 : 0;
}

/** Descarrega o conteúdo (com Range opcional). Devolve a Response do fetch. */
export function download(id, { range, signal } = {}) {
  return request('GET', api(`/${id}`), { query: { alt: 'media' }, headers: range ? { Range: range } : {}, raw: true, signal });
}

export const mediaUrl = (id) => `${api(`/${id}`)}?alt=media`;

// ---------------------------------------------------------------------------
// Pastas: Videoteca / <Equipa> / <AAAA-MM-DD vs Adversário>
// Os IDs ficam guardados na tabela drive_folders para não repetir pesquisas.
// ---------------------------------------------------------------------------

db.exec(`CREATE TABLE IF NOT EXISTS drive_folders (key TEXT PRIMARY KEY, id TEXT NOT NULL)`);
const getFolder = (key) => db.prepare('SELECT id FROM drive_folders WHERE key = ?').get(key)?.id;
const setFolder = (key, id) => db.prepare('INSERT OR REPLACE INTO drive_folders (key, id) VALUES (?, ?)').run(key, id);
export const forgetFolder = (key) => db.prepare('DELETE FROM drive_folders WHERE key = ?').run(key);
export { getFolder };

export const gameFolderName = (game) => `${game.date} vs ${game.opponent}`;

async function ensure(key, name, parentId) {
  const existing = getFolder(key);
  if (existing) return existing;
  const id = await createFolder(name, parentId);
  setFolder(key, id);
  return id;
}

export async function rootFolder() {
  return cfg.rootFolderId || ensure('root', cfg.rootFolderName);
}

export async function teamFolder(teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) throw new Error('Equipa não encontrada.');
  return ensure(`team:${team.id}`, team.name, await rootFolder());
}

export async function gameFolder(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) throw new Error('Jogo não encontrado.');
  return ensure(`game:${game.id}`, gameFolderName(game), await rootFolder());
}
