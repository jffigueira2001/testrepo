import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from './db.js';
import { config } from './config.js';
import * as storage from './storage.js';

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe
// ---------------------------------------------------------------------------

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} terminou com código ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('O ficheiro não contém uma faixa de vídeo.');
  return {
    duration: Number(info.format.duration) || Number(video.duration) || 0,
    size: Number(info.format.size) || fs.statSync(file).size,
    width: video.width || 0,
    height: video.height || 0,
    vcodec: video.codec_name,
    pixFmt: video.pix_fmt,
    acodec: audio?.codec_name || null,
  };
}

/** Corre ffmpeg reportando o progresso (0..1) com base na duração esperada do resultado. */
function ffmpeg(args, expectedDuration, onProgress) {
  let buffer = '';
  return run('ffmpeg', ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args], {
    onStdout(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && expectedDuration > 0) {
          onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / expectedDuration));
        }
      }
    },
  });
}

function h264Args(extraVideoFilters = []) {
  const args = ['-c:v', 'libx264', '-preset', config.x264Preset, '-crf', '23', '-pix_fmt', 'yuv420p'];
  if (extraVideoFilters.length) args.push('-vf', extraVideoFilters.join(','));
  return args;
}

const AAC = ['-c:a', 'aac', '-b:a', '128k'];
const FASTSTART = ['-movflags', '+faststart'];

async function makeThumbnail(videoFile, duration, thumbName) {
  const at = duration > 0 ? Math.min(duration * 0.1, 60) : 0;
  const out = path.join(config.thumbsDir, thumbName);
  await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(at), '-i', videoFile,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out]);
  return thumbName;
}

function newName(videoId, ext) {
  return `${videoId}-${Date.now().toString(36)}.${ext}`;
}

function safeUnlink(file) {
  if (!file) return;
  fs.rm(file, { force: true }, () => {});
}

export function thumbPath(video) {
  return video.thumb ? path.join(config.thumbsDir, video.thumb) : null;
}

export function deleteVideoFiles(video) {
  storage.removeInBackground(video.file);
  safeUnlink(thumbPath(video));
  if (video.source_path) {
    safeUnlink(video.source_path);
    safeUnlink(`${video.source_path}.json`);
  }
}

// ---------------------------------------------------------------------------
// Operações. Cada uma escreve um MP4 novo em videosDir e devolve { outName }.
// ---------------------------------------------------------------------------

const getVideo = (id) => db.prepare('SELECT * FROM videos WHERE id = ?').get(id);

/**
 * Converte o ficheiro carregado num MP4 (H.264/AAC) pronto a ver no browser.
 * Se já for H.264 apenas reorganiza o contentor (rápido, sem perda de qualidade).
 */
async function ingest(video, _params, onProgress) {
  const src = video.source_path;
  if (!src || !fs.existsSync(src)) throw new Error('Ficheiro carregado não encontrado.');
  const info = await probe(src);
  const canCopy = info.vcodec === 'h264' && ['yuv420p', 'yuvj420p'].includes(info.pixFmt)
    && (!info.acodec || ['aac', 'mp3'].includes(info.acodec));

  const outName = newName(video.id, 'mp4');
  const out = path.join(config.videosDir, outName);
  const map = ['-map', '0:v:0', '-map', '0:a:0?'];
  const codec = canCopy ? ['-c', 'copy'] : [...h264Args(), ...AAC];
  await ffmpeg(['-i', src, ...map, ...codec, ...FASTSTART, out], info.duration, onProgress);
  return { outName, removeSource: true };
}

/** Corta [start, end]. Rápido = sem recodificar (corta no keyframe mais próximo); preciso = recodifica. */
async function trim(video, params, onProgress, sourceVideo) {
  const start = Math.max(0, Number(params.start) || 0);
  const end = Number(params.end);
  if (!(end > start)) throw new Error('Intervalo de corte inválido.');
  const dur = end - start;
  // Cortes curtos (clips) leem só o pedaço necessário; cortes longos descarregam o vídeo primeiro.
  const input = await storage.openInput(sourceVideo.file, { partial: dur <= 20 * 60 });
  try {
    const outName = newName(video.id, 'mp4');
    const codec = params.precise ? [...h264Args(), ...AAC] : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
    await ffmpeg(['-ss', String(start), ...input.args, '-t', String(dur), '-map', '0:v:0', '-map', '0:a:0?',
      ...codec, ...FASTSTART, path.join(config.videosDir, outName)], dur, onProgress);
    return { outName };
  } finally {
    input.cleanup();
  }
}

/** Corre ffmpeg sobre o vídeo inteiro com os argumentos de saída indicados. */
async function transform(video, outputArgs, onProgress) {
  const input = await storage.openInput(video.file);
  try {
    const outName = newName(video.id, 'mp4');
    await ffmpeg([...input.args, ...outputArgs, ...FASTSTART, path.join(config.videosDir, outName)],
      video.duration, onProgress);
    return { outName };
  } finally {
    input.cleanup();
  }
}

function rotate(video, params, onProgress) {
  const filters = { 90: ['transpose=1'], 180: ['hflip', 'vflip'], 270: ['transpose=2'] }[Number(params.degrees)];
  if (!filters) throw new Error('Rotação inválida (usa 90, 180 ou 270).');
  return transform(video, ['-map', '0:v:0', '-map', '0:a:0?', ...h264Args(filters), '-c:a', 'copy'], onProgress);
}

function mute(video, _params, onProgress) {
  return transform(video, ['-map', '0:v:0', '-c:v', 'copy', '-an'], onProgress);
}

/** Reduz resolução/tamanho. Útil para jogos gravados em 4K que ocupam dezenas de GB. */
function compress(video, params, onProgress) {
  const height = [480, 720, 1080].includes(Number(params.height)) ? Number(params.height) : 720;
  const crf = Math.min(32, Math.max(18, Number(params.crf) || 26));
  return transform(video, ['-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', config.x264Preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-vf', `scale=-2:'min(ih,${height})'`, ...AAC], onProgress);
}

const OPERATIONS = { ingest, trim, rotate, mute, compress };
export const EDIT_TYPES = ['trim', 'rotate', 'mute', 'compress'];

// ---------------------------------------------------------------------------
// Fila de trabalhos (um de cada vez: o ffmpeg já usa todos os cores)
// ---------------------------------------------------------------------------

export function enqueueJob(videoId, type, params = {}, userId = null) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO jobs (video_id, type, params, created_by) VALUES (?, ?, ?, ?)',
  ).run(videoId, type, JSON.stringify(params), userId);
  setImmediate(pump);
  return Number(lastInsertRowid);
}

let busy = false;

async function pump() {
  if (busy) return;
  const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  if (!job) return;
  busy = true;
  try {
    await runJob(job);
  } finally {
    busy = false;
    setImmediate(pump);
  }
}

async function runJob(job) {
  const params = JSON.parse(job.params);
  const setJob = db.prepare('UPDATE jobs SET status = ?, progress = ?, error = ?, finished_at = ? WHERE id = ?');
  setJob.run('running', 0, null, null, job.id);

  let lastWrite = 0;
  const onProgress = (p) => {
    if (Date.now() - lastWrite < 1000) return;
    lastWrite = Date.now();
    db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(p, job.id);
  };

  const video = getVideo(job.video_id);
  if (!video) return; // apagado entretanto (o job foi apagado em cascata)
  // Num corte para "novo clip", o job pertence ao clip e o vídeo de origem vem nos parâmetros.
  const sourceVideo = params.sourceVideoId ? getVideo(params.sourceVideoId) : video;

  let out = null;
  let thumb = null;
  try {
    if (!sourceVideo) throw new Error('Vídeo de origem já não existe.');
    if (job.type !== 'ingest' && !sourceVideo.file) throw new Error('O vídeo ainda não está pronto.');
    const result = await OPERATIONS[job.type](video, params, onProgress, sourceVideo);
    out = path.join(config.videosDir, result.outName);
    const info = await probe(out);
    thumb = await makeThumbnail(out, info.duration, newName(video.id, 'jpg'));

    // Com o Google Drive, envia o ficheiro final (e apaga a cópia local).
    const ref = await storage.store(out, getVideo(video.id) || video);
    out = null;

    const current = getVideo(video.id);
    if (!current) { // apagado durante o processamento
      storage.removeInBackground(ref);
      safeUnlink(path.join(config.thumbsDir, thumb));
      return;
    }
    db.prepare(`UPDATE videos SET file = ?, thumb = ?, size = ?, duration = ?, width = ?, height = ?,
                status = 'ready', error = NULL, source_path = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(ref, thumb, info.size, info.duration, info.width, info.height, video.id);
    // Remove os ficheiros antigos só depois de o novo estar registado.
    storage.removeInBackground(current.file);
    safeUnlink(thumbPath(current));
    if (result.removeSource && current.source_path) {
      safeUnlink(current.source_path);
      safeUnlink(`${current.source_path}.json`);
    }
    setJob.run('done', 1, null, new Date().toISOString(), job.id);
  } catch (err) {
    console.error(`[job ${job.id}] ${job.type} falhou:`, err.message);
    safeUnlink(out);
    if (thumb) safeUnlink(path.join(config.thumbsDir, thumb));
    setJob.run('error', 0, err.message, new Date().toISOString(), job.id);
    // Se o vídeo ainda não tinha ficheiro (upload novo ou clip), fica marcado com erro.
    if (!getVideo(video.id)?.file) {
      db.prepare("UPDATE videos SET status = 'error', error = ? WHERE id = ?").run(err.message, video.id);
    }
  }
}

/** No arranque: trabalhos interrompidos voltam para a fila. */
export function startQueue() {
  db.prepare("UPDATE jobs SET status = 'queued', progress = 0 WHERE status = 'running'").run();
  setImmediate(pump);
}
