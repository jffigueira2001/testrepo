// Mesmo fluxo que o e2e, mas com STORAGE=drive contra um Google Drive simulado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { startFakeDrive } from './fake-drive.js';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videoteca-drive-'));
let server;
let drive;
let cookie;

const call = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
};

async function waitFor(fn, timeout = 60_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}
const jobsIdle = async () => (await call('GET', '/api/jobs')).data.every((j) => j.status === 'done' || j.status === 'error');
const liveFiles = () => [...drive.files.values()].filter((f) => f.data && !f.trashed);
const settle = () => new Promise((r) => setTimeout(r, 300)); // operações do Drive em segundo plano

before(async () => {
  drive = await startFakeDrive();
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_EMAIL: 'a@t.pt', ADMIN_PASSWORD: 'admin1234',
      STORAGE: 'drive', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh',
      DRIVE_CHUNK_MB: '1', DRIVE_API_BASE: drive.url, DRIVE_UPLOAD_BASE: drive.url, GOOGLE_TOKEN_URL: `${drive.url}/token`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(() => fetch(BASE).then(() => true).catch(() => false), 10_000);
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@t.pt', password: 'admin1234' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.kill();
  drive?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('vídeos guardados no Google Drive: upload, streaming, edição e organização em pastas', async () => {
  const game = (await call('POST', '/api/games', { date: '2026-10-08', opponent: 'ABC Braga' })).data;
  const game2 = (await call('POST', '/api/games', { date: '2026-10-01', opponent: 'FC Porto' })).data;

  // Vários MB para obrigar a vários blocos (1 MB no teste) no envio para o Drive.
  const file = path.join(tmp, 'jogo.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=20:size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.ok(fs.statSync(file).size > 3 * 1024 * 1024, `ficheiro de teste pequeno demais: ${fs.statSync(file).size}`);

  await new Promise((resolve, reject) => new tus.Upload(fs.createReadStream(file), {
    endpoint: `${BASE}/api/uploads`, uploadSize: fs.statSync(file).size, chunkSize: 1024 * 1024,
    headers: { Cookie: cookie }, metadata: { filename: 'jogo.mp4', gameId: String(game.id), title: '1.ª parte' },
    onError: reject, onSuccess: resolve,
  }).start());

  const [video] = await waitFor(async () => {
    const v = (await call('GET', `/api/games/${game.id}`)).data.videos;
    return v.length === 1 && v[0].status !== 'processing' && v;
  });
  assert.equal(video.status, 'ready', video.error);
  assert.ok(drive.stats.chunkPuts >= 2, 'upload para o Drive devia ser em blocos');

  // Nada fica no disco do servidor: só no Drive, na pasta Equipa/Jogo.
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data/videos')), []);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data/uploads')), []);
  let files = liveFiles();
  assert.equal(files.length, 1);
  assert.equal(drive.pathOf(files[0].id), 'Videoteca CDE Camões/2026-10-08 vs ABC Braga/1.ª parte.mp4');
  assert.equal(files[0].data.length, video.size);

  // Streaming com Range através do servidor.
  const r = await fetch(`${BASE}/api/videos/${video.id}/stream`, { headers: { Cookie: cookie, Range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-1999/${video.size}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), files[0].data.subarray(1000, 2000));
  const dl = await fetch(`${BASE}/api/videos/${video.id}/download`, { headers: { Cookie: cookie } });
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await dl.arrayBuffer()).byteLength, video.size);

  // Clip: o ffmpeg lê só o pedaço necessário diretamente do Drive (pedidos Range).
  const rangeBefore = drive.stats.rangeGets;
  const clip = (await call('POST', `/api/videos/${video.id}/edit`, { type: 'trim', params: { start: 5, end: 8, mode: 'clip', title: 'Golo' } })).data;
  await waitFor(jobsIdle);
  const clipV = (await call('GET', `/api/videos/${clip.videoId}`)).data;
  assert.equal(clipV.status, 'ready', clipV.error);
  assert.ok(Math.abs(clipV.duration - 3) < 0.6, `clip ${clipV.duration}`);
  assert.ok(drive.stats.rangeGets > rangeBefore);

  // Rodar: descarrega, processa, envia a nova versão e manda a antiga para a reciclagem.
  const oldFileId = liveFiles().find((f) => f.name === '1.ª parte.mp4').id;
  await call('POST', `/api/videos/${video.id}/edit`, { type: 'rotate', params: { degrees: 90 } });
  await waitFor(jobsIdle);
  await settle();
  const rotated = (await call('GET', `/api/videos/${video.id}`)).data;
  assert.equal(rotated.width, 720);
  assert.equal(drive.files.get(oldFileId).trashed, true);
  assert.equal(liveFiles().length, 2);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data/videos')), []);

  // Renomear e mudar de jogo move/renomeia no Drive.
  await call('PATCH', `/api/videos/${clip.videoId}`, { title: 'Golo do Rui', game_id: game2.id });
  await settle();
  const clipFile = liveFiles().find((f) => f.name === 'Golo do Rui.mp4');
  assert.equal(drive.pathOf(clipFile.id), 'Videoteca CDE Camões/2026-10-01 vs FC Porto/Golo do Rui.mp4');

  // Editar o jogo (adversário) renomeia a pasta.
  await call('PATCH', `/api/games/${game2.id}`, { date: '2026-10-01', opponent: 'FC Porto B' });
  await settle();
  assert.equal(drive.pathOf(clipFile.id), 'Videoteca CDE Camões/2026-10-01 vs FC Porto B/Golo do Rui.mp4');

  // Apagar vai para a reciclagem do Drive.
  await call('DELETE', `/api/videos/${clip.videoId}`);
  await settle();
  assert.equal(drive.files.get(clipFile.id).trashed, true);
  await call('DELETE', `/api/games/${game.id}`);
  await settle();
  assert.equal(liveFiles().length, 0);
});
