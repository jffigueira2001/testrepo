// Teste ponta-a-ponta: arranca o servidor numa pasta temporária, carrega vídeos via tus
// e testa o processamento e as edições. Requer ffmpeg instalado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tus from 'tus-js-client';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videoteca-'));
let server;
let adminCookie;

async function call(method, url, body, cookie = adminCookie) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

async function login(email, password) {
  const r = await call('POST', '/api/login', { email, password }, null);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.headers.get('set-cookie').split(';')[0];
}

function makeVideo(name, codecArgs, seconds = 6) {
  const file = path.join(tmp, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x360:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...codecArgs, file]);
  return file;
}

function upload(file, metadata, cookie = adminCookie) {
  return new Promise((resolve, reject) => {
    const up = new tus.Upload(fs.createReadStream(file), {
      endpoint: `${BASE}/api/uploads`,
      uploadSize: fs.statSync(file).size,
      chunkSize: 64 * 1024, // blocos pequenos para exercitar o envio em várias partes
      headers: { Cookie: cookie },
      metadata,
      onError: reject,
      onSuccess: resolve,
    });
    up.start();
  });
}

async function waitFor(fn, timeout = 60_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const videosOfGame = async (gameId) => (await call('GET', `/api/games/${gameId}`)).data.videos;
const jobsIdle = async () => (await call('GET', '/api/jobs')).data.every((j) => j.status === 'done' || j.status === 'error');

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_EMAIL: 'admin@test.pt', ADMIN_PASSWORD: 'admin1234' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(() => fetch(BASE).then(() => true).catch(() => false), 10_000);
  adminCookie = await login('admin@test.pt', 'admin1234');
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fluxo completo: equipa → jogo → upload → processamento → edição', async () => {
  // Sem sessão não há acesso.
  assert.equal((await call('GET', '/api/teams', null, null)).status, 401);
  await assert.rejects(upload(makeVideo('x.mp4', ['-c:v', 'libx264', '-c:a', 'aac', '-shortest']), { gameId: '1' }, 'vt_session=nope'));

  const team = (await call('GET', '/api/teams')).data[0]; // equipa única criada no arranque
  // Sem escalões: o jogo vai para a equipa única sem ser preciso indicá-la.
  const game = (await call('POST', '/api/games', { date: '2026-10-08', opponent: 'ABC Braga', competition: 'Campeonato', venue: 'casa' })).data;
  assert.ok(game.id);
  // Criar o mesmo jogo duas vezes devolve o existente.
  assert.equal((await call('POST', '/api/games', { team_id: team.id, date: '2026-10-08', opponent: 'abc braga' })).data.id, game.id);

  // Jogo inexistente é recusado.
  await assert.rejects(upload(makeVideo('y.mp4', ['-c:v', 'libx264', '-c:a', 'aac', '-shortest']), { gameId: '999' }));

  // 1) H.264 → apenas remux. 2) MPEG-4 Part 2 em .avi → recodificado para H.264.
  const h264 = makeVideo('jogo-1parte.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']);
  const avi = makeVideo('jogo-2parte.avi', ['-c:v', 'mpeg4', '-c:a', 'mp3', '-shortest']);
  await upload(h264, { filename: 'jogo-1parte.mp4', gameId: String(game.id), title: '1.ª parte' });
  await upload(avi, { filename: 'jogo-2parte.avi', gameId: String(game.id), title: '' });

  const vids = await waitFor(async () => {
    const v = await videosOfGame(game.id);
    return v.length === 2 && v.every((x) => x.status === 'ready') && v;
  });
  assert.deepEqual(vids.map((v) => v.title).sort(), ['1.ª parte', 'jogo-2parte']);
  for (const v of vids) {
    assert.ok(Math.abs(v.duration - 6) < 0.5, `duração ${v.duration}`);
    assert.equal(v.width, 640);
  }
  // Os ficheiros brutos do upload foram removidos.
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data/uploads')), []);

  // Streaming com Range.
  const first = vids.find((v) => v.title === '1.ª parte');
  const range = await fetch(`${BASE}/api/videos/${first.id}/stream`, { headers: { Cookie: adminCookie, Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal((await call('GET', `/api/videos/${first.id}/thumb`)).status, 200);

  // Biblioteca agrupada.
  const teams = (await call('GET', '/api/teams')).data;
  assert.equal(teams[0].videos, 2);
  assert.equal((await call('GET', `/api/games?team_id=${team.id}&q=Braga`)).data.length, 1);

  // Membro: pode ver, não pode editar.
  await call('POST', '/api/users', { name: 'Jogador', email: 'j@test.pt', password: 'jogador123', role: 'member' });
  const member = await login('j@test.pt', 'jogador123');
  assert.equal((await call('GET', `/api/games/${game.id}`, null, member)).status, 200);
  assert.equal((await call('POST', `/api/videos/${first.id}/edit`, { type: 'mute' }, member)).status, 403);
  assert.equal((await call('DELETE', `/api/videos/${first.id}`, null, member)).status, 403);
  // Membros só veem: não carregam vídeos nem criam jogos.
  assert.equal((await call('POST', '/api/games', { date: '2026-10-09', opponent: 'X' }, member)).status, 403);
  await assert.rejects(upload(makeVideo('m.mp4', ['-c:v', 'libx264', '-c:a', 'aac', '-shortest']), { gameId: String(game.id) }, member), /403/);

  // Pedido de conta: fica pendente e não entra até um admin aprovar.
  assert.equal((await call('POST', '/api/register', { name: 'Marta', email: 'marta@test.pt', password: 'marta1234' }, null)).status, 201);
  assert.equal((await call('POST', '/api/register', { name: 'Marta', email: 'marta@test.pt', password: 'marta1234' }, null)).status, 400);
  let r = await call('POST', '/api/login', { email: 'marta@test.pt', password: 'marta1234' }, null);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /aprovada/);
  const pendingUser = (await call('GET', '/api/users')).data.find((u) => u.email === 'marta@test.pt');
  assert.equal(pendingUser.status, 'pending');
  assert.equal((await call('PATCH', `/api/users/${pendingUser.id}`, { status: 'active' }, member)).status, 403);
  assert.equal((await call('PATCH', `/api/users/${pendingUser.id}`, { status: 'active' })).status, 200);
  const marta = await login('marta@test.pt', 'marta1234');
  assert.equal((await call('GET', `/api/games/${game.id}`, null, marta)).status, 200);
  // Suspender corta o acesso imediatamente (a sessão aberta deixa de valer).
  assert.equal((await call('PATCH', `/api/users/${pendingUser.id}`, { status: 'pending' })).status, 200);
  assert.equal((await call('GET', `/api/games/${game.id}`, null, marta)).status, 401);
  assert.equal((await call('GET', `/api/videos/${first.id}/stream`, null, marta)).status, 401);

  // Jogadores: do nosso clube (club '') e do adversário; criar duas vezes devolve o mesmo.
  const rui = (await call('POST', '/api/players', { name: 'Rui Silva', number: 7, club: '' })).data;
  const ze = (await call('POST', '/api/players', { name: 'Zé Costa', club: 'ABC Braga' })).data;
  assert.equal((await call('POST', '/api/players', { name: 'rui silva', club: '' })).data.id, rui.id);
  assert.equal((await call('POST', '/api/players', { name: 'Rui Silva', club: 'ABC Braga' })).status, 201); // homónimo noutro clube
  assert.equal((await call('POST', '/api/players', { name: 'X', number: 120 })).status, 400);
  assert.equal((await call('POST', '/api/players', { name: 'Y' }, member)).status, 403);

  // Admin: cortar para novo clip (preciso, com jogadores), cortar substituindo (rápido), rodar, tirar som, comprimir.
  const clip = (await call('POST', `/api/videos/${first.id}/edit`, { type: 'trim', params: { start: 1, end: 3, mode: 'clip', precise: true, title: 'Golo', playerIds: [rui.id, ze.id] } })).data;
  const tagged = (await call('GET', `/api/videos/${clip.videoId}`)).data.players;
  assert.deepEqual(tagged.map((p) => p.name), ['Rui Silva', 'Zé Costa']); // o nosso clube primeiro
  const ruiPage = (await call('GET', `/api/players/${rui.id}`, null, member)).data;
  assert.deepEqual(ruiPage.videos.map((v) => v.id), [clip.videoId]);
  assert.equal(ruiPage.videos[0].opponent, 'ABC Braga');
  assert.equal((await call('GET', `/api/games?q=Zé Costa`)).data.length, 1);
  assert.equal((await call('PUT', `/api/videos/${clip.videoId}/players`, { player_ids: [ze.id] }, member)).status, 403);
  assert.equal((await call('PUT', `/api/videos/${clip.videoId}/players`, { player_ids: [ze.id] })).status, 200);
  assert.deepEqual((await call('GET', `/api/videos/${clip.videoId}`)).data.players.map((p) => p.id), [ze.id]);
  assert.equal((await call('GET', '/api/players')).data.find((p) => p.id === rui.id).clips, 0);
  assert.notEqual(clip.videoId, first.id);
  const second = vids.find((v) => v.id !== first.id);
  assert.equal((await call('POST', `/api/videos/${second.id}/edit`, { type: 'trim', params: { start: 0, end: 4, mode: 'replace' } })).status, 202);
  assert.equal((await call('POST', `/api/videos/${first.id}/edit`, { type: 'rotate', params: { degrees: 90 } })).status, 202);
  assert.equal((await call('POST', `/api/videos/${first.id}/edit`, { type: 'mute' })).status, 202);
  assert.equal((await call('POST', `/api/videos/${first.id}/edit`, { type: 'rotate', params: { degrees: 45 } })).status, 400);
  await waitFor(jobsIdle);

  const after = Object.fromEntries((await videosOfGame(game.id)).map((v) => [v.id, v]));
  assert.equal(after[clip.videoId].title, 'Golo');
  assert.equal(after[clip.videoId].status, 'ready');
  assert.ok(Math.abs(after[clip.videoId].duration - 2) < 0.3, `clip ${after[clip.videoId].duration}`);
  assert.ok(after[second.id].duration <= 4.6, `trim ${after[second.id].duration}`);
  assert.equal(after[first.id].width, 360); // rodado 90°
  assert.equal(after[first.id].height, 640);
  const jobs = (await call('GET', '/api/jobs')).data;
  assert.ok(jobs.every((j) => j.status === 'done'), JSON.stringify(jobs.filter((j) => j.status !== 'done')));

  assert.equal((await call('POST', `/api/videos/${first.id}/edit`, { type: 'compress', params: { height: 480 } })).status, 202);
  await waitFor(jobsIdle);
  const compressed = (await call('GET', `/api/videos/${first.id}`)).data;
  assert.equal(compressed.height, 480);

  // Juntar: dois clips com o mesmo formato (junta sem recodificar)…
  const clipA = (await call('POST', `/api/videos/${second.id}/edit`, { type: 'trim', params: { start: 0, end: 2, mode: 'clip', precise: true, playerIds: [rui.id] } })).data;
  const clipB = (await call('POST', `/api/videos/${second.id}/edit`, { type: 'trim', params: { start: 1, end: 3, mode: 'clip', precise: true } })).data;
  await waitFor(jobsIdle);
  assert.equal((await call('POST', '/api/videos/concat', { video_ids: [clipA.videoId] })).status, 400);
  assert.equal((await call('POST', '/api/videos/concat', { video_ids: [clipA.videoId, clipB.videoId] }, member)).status, 403);
  const reel = (await call('POST', '/api/videos/concat', { video_ids: [clipA.videoId, clipB.videoId], title: 'Resumo' })).data;
  // …e vídeos diferentes (paisagem com som + vertical sem som): normaliza para o formato do primeiro.
  const mixed = (await call('POST', '/api/videos/concat', { video_ids: [clip.videoId, first.id] })).data;
  await waitFor(jobsIdle);
  const reelV = (await call('GET', `/api/videos/${reel.videoId}`)).data;
  assert.equal(reelV.status, 'ready', reelV.error);
  assert.equal(reelV.title, 'Resumo');
  assert.ok(Math.abs(reelV.duration - 4) < 0.4, `resumo ${reelV.duration}`);
  assert.deepEqual(reelV.players.map((p) => p.id), [rui.id]); // herda os jogadores dos clips
  const mixedV = (await call('GET', `/api/videos/${mixed.videoId}`)).data;
  assert.equal(mixedV.status, 'ready', mixedV.error);
  assert.equal(mixedV.title, 'Compilação (2 vídeos)');
  assert.equal(mixedV.width, 640);
  assert.equal(mixedV.height, 360);
  assert.ok(Math.abs(mixedV.duration - (after[clip.videoId].duration + compressed.duration)) < 0.5, `misto ${mixedV.duration}`);
  assert.deepEqual(mixedV.players.map((p) => p.id), [ze.id]);

  // Os ficheiros antigos são removidos: um mp4 por vídeo.
  const files = fs.readdirSync(path.join(tmp, 'data/videos'));
  assert.equal(files.length, 7, files.join(','));

  // Apagar o jogo apaga os vídeos e os ficheiros.
  assert.equal((await call('DELETE', `/api/games/${game.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data/videos')), []);
});
