// Armazenamento dos vídeos finais: disco local ou Google Drive.
// Na base de dados, videos.file guarda uma referência:
//   "nome.mp4"          ficheiro local (STORAGE=local)
//   "drive:<id>"        ficheiro criado pela plataforma no Google Drive
//   "drivelink:<id>"    vídeo que já estava na pasta do Drive e foi importado sem cópia.
//                       A plataforma nunca o apaga, renomeia nem move: o original é teu.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { db } from './db.js';
import * as drive from './drive.js';

export const usingDrive = config.storage === 'drive';
const driveId = (ref) => (ref?.startsWith('drive:') ? ref.slice(6) : ref?.startsWith('drivelink:') ? ref.slice(10) : null);
export const isLinked = (ref) => !!ref?.startsWith('drivelink:');

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'video';
const driveName = (video) => `${safeName(video.title)}.mp4`;

/** Guarda o ficheiro acabado de produzir (em videosDir) e devolve a referência para a BD. */
export async function store(localPath, video) {
  if (!usingDrive) return path.basename(localPath);
  const id = await drive.uploadFile(localPath, { name: driveName(video), parentId: await drive.gameFolder(video.game_id) });
  fs.rmSync(localPath, { force: true });
  return `drive:${id}`;
}

export async function remove(ref) {
  if (!ref || isLinked(ref)) return;
  const id = driveId(ref);
  if (id) await drive.trash(id);
  else fs.rmSync(path.join(config.videosDir, ref), { force: true });
}

/**
 * Argumentos de entrada do ffmpeg para editar um vídeo guardado.
 * partial=true: só vai ler um pedaço (corte), por isso lê diretamente do Drive com pedidos Range.
 * Caso contrário descarrega primeiro para disco (leituras longas não dependem do token de 1 h).
 */
export async function openInput(ref, { partial = false } = {}) {
  const id = driveId(ref);
  if (!id) {
    const file = path.join(config.videosDir, ref);
    if (!fs.existsSync(file)) throw new Error('Ficheiro de vídeo não encontrado.');
    return { args: ['-i', file], cleanup() {} };
  }
  if (partial) {
    const token = await drive.accessToken();
    return { args: ['-headers', `Authorization: Bearer ${token}\r\n`, '-i', drive.mediaUrl(id)], cleanup() {} };
  }
  const tmp = path.join(config.videosDir, `src-${id}-${Date.now()}.mp4`);
  const res = await drive.download(id);
  if (!res.ok) throw new Error(`Google Drive: não foi possível descarregar o vídeo (${res.status}).`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  return { args: ['-i', tmp], cleanup: () => fs.rmSync(tmp, { force: true }) };
}

/** Envia o vídeo ao browser, com suporte a Range (saltar para qualquer minuto). */
export async function send(ref, req, res, { downloadName } = {}) {
  const id = driveId(ref);
  if (!id) {
    const file = path.join(config.videosDir, ref);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Ficheiro de vídeo não encontrado.' });
    if (downloadName) return res.download(file, downloadName);
    return res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' }, maxAge: '7d', immutable: true });
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const upstream = await drive.download(id, { range: req.headers.range, signal: abort.signal });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return res.status(upstream.status === 416 ? 416 : 502).json({ error: 'Não foi possível obter o vídeo do Google Drive.' });
  }
  res.status(upstream.status);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (downloadName) res.attachment(downloadName);
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // o browser fechou a ligação (ex.: saltou para outro minuto) — normal
  }
}

// ---------------------------------------------------------------------------
// Manter as pastas do Drive coerentes com a biblioteca
// ---------------------------------------------------------------------------

function background(promise) {
  promise.catch((err) => console.error('[drive]', err.message));
}

/** Depois de mudar o título ou o jogo de um vídeo. */
export function videoChanged(video, oldGameId) {
  const id = driveId(video.file);
  if (!id || isLinked(video.file)) return;
  background((async () => {
    const changes = { name: driveName(video) };
    if (oldGameId !== video.game_id) {
      changes.addParents = await drive.gameFolder(video.game_id);
      changes.removeParents = drive.getFolder(`game:${oldGameId}`);
    }
    await drive.updateFile(id, changes);
  })());
}

/** Depois de editar um jogo (data/adversário mudam o nome da pasta). */
export function gameChanged(gameId) {
  const folder = usingDrive && drive.getFolder(`game:${gameId}`);
  if (!folder) return;
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  background(drive.updateFile(folder, { name: drive.gameFolderName(game) }));
}

export function teamChanged(teamId, name) {
  const folder = usingDrive && drive.getFolder(`team:${teamId}`);
  if (folder) background(drive.updateFile(folder, { name }));
}

/** Depois de apagar um jogo/equipa (os vídeos já foram para a reciclagem). */
export function folderDeleted(key) {
  const folder = usingDrive && drive.getFolder(key);
  if (!folder) return;
  drive.forgetFolder(key);
  background(drive.trash(folder));
}

export function removeInBackground(ref) {
  background(remove(ref));
}
