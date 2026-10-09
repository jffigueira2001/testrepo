// Vídeos postos diretamente na pasta "Camões" do Google Drive e importados pela plataforma.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeDrive } from './fake-drive.js';

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videoteca-import-'));
let server;
let drive;
let cookie;
let camoes;

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

function makeVideo(name, codecArgs) {
  const file = path.join(tmp, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=duration=6', ...codecArgs, '-shortest', file]);
  return fs.readFileSync(file);
}

before(async () => {
  drive = await startFakeDrive();
  // A pasta e os vídeos que o utilizador pôs no Drive.
  camoes = drive.add({ name: 'Camões' });
  const jogo = drive.add({ name: '2026-10-08 vs ABC Braga', parent: camoes });
  drive.add({ name: '1a parte.mp4', parent: jogo, data: makeVideo('a.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']) });
  drive.add({ name: 'VID_20261001_201500.avi', parent: camoes, data: makeVideo('b.avi', ['-c:v', 'mpeg4', '-c:a', 'mp3']), mimeType: 'video/x-msvideo' });
  drive.add({ name: 'notas.txt', parent: camoes, data: Buffer.from('x'), mimeType: 'text/plain' });
  drive.add({ name: 'lixo.mp4', parent: camoes, data: Buffer.from('y') });

  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_EMAIL: 'a@t.pt', ADMIN_PASSWORD: 'admin1234',
      STORAGE: 'drive', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh',
      DRIVE_FOLDER_ID: camoes, DRIVE_CHUNK_MB: '1', DRIVE_API_BASE: drive.url, DRIVE_UPLOAD_BASE: drive.url, GOOGLE_TOKEN_URL: `${drive.url}/token`,
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

test('importar vídeos da pasta Camões do Drive', async () => {
  const inbox = (await call('GET', '/api/drive/videos')).data;
  assert.equal(inbox.enabled, true);
  assert.equal(inbox.folder, 'Camões');
  const byName = Object.fromEntries(inbox.files.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['1a parte.mp4', 'VID_20261001_201500.avi', 'lixo.mp4']); // .txt fica de fora
  assert.equal(byName['1a parte.mp4'].path, '2026-10-08 vs ABC Braga');
  assert.deepEqual(byName['1a parte.mp4'].suggestion, { date: '2026-10-08', opponent: 'ABC Braga', game_id: null });
  assert.equal(byName['VID_20261001_201500.avi'].suggestion.date, '2026-10-01');

  // MP4 H.264: fica ligado ao original, sem cópia.
  const a = (await call('POST', '/api/drive/import', { file_id: byName['1a parte.mp4'].id, title: '1.ª parte', game: { date: '2026-10-08', opponent: 'ABC Braga' } })).data;
  // AVI MPEG-4: convertido; o original fica intacto.
  const b = (await call('POST', '/api/drive/import', { file_id: byName['VID_20261001_201500.avi'].id, game: { date: '2026-10-01', opponent: 'FC Porto' } })).data;
  assert.equal((await call('POST', '/api/drive/import', { file_id: byName['1a parte.mp4'].id, game_id: a.gameId })).status, 400); // já importado
  await call('POST', '/api/drive/ignore', { file_id: byName['lixo.mp4'].id });
  await waitFor(jobsIdle);

  const va = (await call('GET', `/api/videos/${a.videoId}`)).data;
  const vb = (await call('GET', `/api/videos/${b.videoId}`)).data;
  assert.equal(va.status, 'ready', va.error);
  assert.equal(vb.status, 'ready', vb.error);
  assert.equal(vb.title, 'VID_20261001_201500');
  assert.ok(Math.abs(va.duration - 6) < 0.5 && Math.abs(vb.duration - 6) < 0.5);

  const uploaded = [...drive.files.values()].filter((f) => f.data && f.id.startsWith('f')); // criados pela plataforma
  assert.equal(uploaded.length, 1, 'só o AVI convertido é enviado');
  assert.equal(drive.pathOf(uploaded[0].id), 'Camões/2026-10-01 vs FC Porto/VID_20261001_201500.mp4');
  assert.equal(drive.files.get(byName['VID_20261001_201500.avi'].id).trashed, false);

  // Streaming do vídeo ligado vem do ficheiro original.
  const r = await fetch(`${BASE}/api/videos/${a.videoId}/stream`, { headers: { Cookie: cookie, Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), drive.files.get(byName['1a parte.mp4'].id).data.subarray(0, 10));

  // Já não aparecem como novos (importados, convertidos ou ignorados).
  assert.deepEqual((await call('GET', '/api/drive/videos')).data.files, []);

  // Editar um vídeo ligado cria uma versão nova, sem tocar no original.
  await call('POST', `/api/videos/${a.videoId}/edit`, { type: 'mute' });
  await call('PATCH', `/api/videos/${a.videoId}`, { title: 'Primeira parte' });
  await waitFor(jobsIdle);
  await new Promise((r2) => setTimeout(r2, 300));
  const original = drive.files.get(byName['1a parte.mp4'].id);
  assert.equal(original.trashed, false);
  assert.equal(original.name, '1a parte.mp4');

  // Apagar na plataforma não apaga o original; volta a aparecer para importar.
  await call('DELETE', `/api/videos/${b.videoId}`);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(drive.files.get(byName['VID_20261001_201500.avi'].id).trashed, false);
  assert.deepEqual((await call('GET', '/api/drive/videos')).data.files.map((f) => f.name), ['VID_20261001_201500.avi']);
});
