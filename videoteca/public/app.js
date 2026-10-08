// Videoteca CDE Camões — frontend (sem build: ES modules + tus-js-client global)

const $app = document.getElementById('app');
const state = { me: null, teams: [], uploads: [], timers: [] };

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTimePrecise(sec) {
  const base = fmtDuration(Math.floor(sec));
  const tenths = Math.floor((sec % 1) * 10);
  return `${base}.${tenths}`;
}

/** Aceita "1:02:03", "12:30", "12:30.5" ou segundos. */
function parseTime(text) {
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

const today = () => new Date().toISOString().slice(0, 10);
const VENUE = { casa: 'Casa', fora: 'Fora', neutro: 'Neutro' };
const JOB_LABEL = { ingest: 'Processar upload', trim: 'Cortar', rotate: 'Rodar', mute: 'Remover som', compress: 'Comprimir' };
const STATUS_PILL = {
  processing: '<span class="pill warn">a processar</span>',
  ready: '<span class="pill ok">pronto</span>',
  error: '<span class="pill err">erro</span>',
  queued: '<span class="pill">em fila</span>',
  running: '<span class="pill warn">a correr</span>',
  done: '<span class="pill ok">concluído</span>',
};

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}

/** Diálogo de confirmação próprio (em vez de confirm()). Devolve true/false. */
function ask(message, { okLabel = 'Confirmar', danger = true } = {}) {
  return openDialog(message, null, okLabel, danger).then((v) => v !== null);
}

/** Pede um texto (em vez de prompt()). Devolve o texto ou null se cancelado. */
function askText(message, value = '', type = 'text') {
  return openDialog(message, { value, type }, 'Guardar', false);
}

function openDialog(message, input, okLabel, danger) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `
    <form method="dialog" class="stack">
      <p>${esc(message)}</p>
      ${input ? `<input id="dlg-input" type="${input.type}" value="${esc(input.value)}" required>` : ''}
      <div class="row" style="justify-content:flex-end">
        <button type="button" value="cancel" id="dlg-cancel">Cancelar</button>
        <button value="ok" class="${danger ? 'danger-solid' : 'primary'}">${esc(okLabel)}</button>
      </div>
    </form>`;
  document.body.append(dlg);
  return new Promise((resolve) => {
    const field = dlg.querySelector('#dlg-input');
    dlg.querySelector('#dlg-cancel').onclick = () => dlg.close('cancel');
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? (field ? field.value.trim() : '') : null);
      dlg.remove();
    });
    dlg.showModal();
    (field || dlg.querySelector('button[value=ok]')).focus();
  });
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') {
    state.me = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

/** Corre fn e mostra o erro num toast. */
async function attempt(fn) {
  try { return await fn(); } catch (err) { toast(err.message, true); return undefined; }
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  state.timers.push(id);
}

const isAdmin = () => state.me?.role === 'admin';
const thumbUrl = (v) => `/api/videos/${v.id}/thumb?v=${encodeURIComponent(v.updated_at || '')}`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/register$/, viewRegister],
  [/^#\/?$/, viewLibrary],
  [/^#\/team\/(\d+)$/, (id) => viewLibrary(Number(id))],
  [/^#\/game\/(\d+)$/, (id) => viewGame(Number(id))],
  [/^#\/video\/(\d+)$/, (id) => viewVideo(Number(id))],
  [/^#\/upload(?:\?game=(\d+))?$/, (id) => viewUpload(id ? Number(id) : null)],
  [/^#\/jobs$/, viewJobs],
  [/^#\/admin$/, viewAdmin],
  [/^#\/account$/, viewAccount],
];

async function route() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  const hash = location.hash || '#/';

  const isPublic = hash === '#/login' || hash === '#/register';
  if (!state.me && !isPublic) {
    try { state.me = await api('GET', '/me'); } catch { location.hash = '#/login'; return; }
  }
  document.getElementById('topbar').hidden = !state.me;
  if (state.me) {
    document.getElementById('me-name').textContent = `${state.me.name}${isAdmin() ? ' (admin)' : ''}`;
    document.querySelectorAll('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
    const section = hash.startsWith('#/upload') ? 'upload' : hash.startsWith('#/jobs') ? 'jobs' : hash.startsWith('#/admin') ? 'admin' : 'library';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  }

  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await view(...m.slice(1)); } catch (err) { $app.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
      return;
    }
  }
  $app.innerHTML = '<div class="empty">Página não encontrada.</div>';
}

window.addEventListener('hashchange', route);
document.getElementById('logout').addEventListener('click', async () => {
  if (state.uploads.some((u) => u.status === 'uploading') && !await ask('Há uploads a decorrer. Sair mesmo assim?')) return;
  await api('POST', '/logout');
  state.me = null;
  location.hash = '#/login';
});
window.addEventListener('beforeunload', (e) => {
  if (state.uploads.some((u) => u.status === 'uploading')) { e.preventDefault(); e.returnValue = ''; }
});

// Contador de trabalhos ativos no menu.
async function refreshJobsBadge() {
  if (!state.me) return;
  const jobs = await api('GET', '/jobs').catch(() => []);
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const badge = document.getElementById('jobs-badge');
  badge.hidden = !active;
  badge.textContent = active;
  // Pedidos de conta à espera de aprovação (só admins).
  const adminBadge = document.getElementById('admin-badge');
  const pending = isAdmin() ? (await api('GET', '/users').catch(() => [])).filter((u) => u.status === 'pending').length : 0;
  adminBadge.hidden = !pending;
  adminBadge.textContent = pending;
}
setInterval(refreshJobsBadge, 5000);

async function loadTeams() {
  state.teams = await api('GET', '/teams');
  return state.teams;
}

// ---------------------------------------------------------------------------
// Login / conta
// ---------------------------------------------------------------------------

function viewLogin() {
  document.getElementById('topbar').hidden = true;
  $app.innerHTML = `
    <form class="panel login stack" id="f">
      <img src="/logo.svg" alt="" class="login-logo">
      <h1>CDE Camões</h1>
      <p class="muted">Videoteca de andebol: os vídeos dos nossos jogos.</p>
      <div><label>Email</label><input name="email" type="email" autocomplete="username" required autofocus></div>
      <div><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
      <button class="primary" style="width:100%;justify-content:center">Entrar</button>
      <p class="small muted">Ainda não tens conta? <a href="#/register">Pedir acesso</a></p>
    </form>`;
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const me = await attempt(() => api('POST', '/login', fd));
    if (me) { state.me = me; location.hash = '#/'; refreshJobsBadge(); }
  });
}

function viewRegister() {
  document.getElementById('topbar').hidden = true;
  $app.innerHTML = `
    <form class="panel login stack" id="f">
      <img src="/logo.svg" alt="" class="login-logo">
      <h1>Pedir acesso</h1>
      <p class="muted">Cria a tua conta. Só podes ver os vídeos depois de um administrador do clube a aprovar.</p>
      <div><label for="r-name">Nome</label><input id="r-name" name="name" autocomplete="name" required autofocus></div>
      <div><label for="r-email">Email</label><input id="r-email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="r-pass">Password (mín. 8 caracteres)</label><input id="r-pass" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div><label for="r-pass2">Repetir password</label><input id="r-pass2" name="password2" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="primary" style="width:100%;justify-content:center">Pedir acesso</button>
      <p class="small muted">Já tens conta? <a href="#/login">Entrar</a></p>
    </form>`;
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.password !== fd.password2) return toast('As passwords não coincidem.', true);
    const ok = await attempt(() => api('POST', '/register', { name: fd.name, email: fd.email, password: fd.password }));
    if (!ok) return;
    $app.innerHTML = `
      <div class="panel login stack">
        <img src="/logo.svg" alt="" class="login-logo">
        <h1>Pedido enviado</h1>
        <p class="muted">Um administrador do clube vai aprovar a tua conta. Depois disso entras com
          <b>${esc(fd.email)}</b> e a password que escolheste.</p>
        <a class="btn" href="#/login" style="justify-content:center">Voltar ao login</a>
      </div>`;
  });
}

function viewAccount() {
  $app.innerHTML = `
    <h1>A minha conta</h1>
    <p class="muted">${esc(state.me.name)} · ${esc(state.me.email)} · ${state.me.role === 'admin' ? 'Administrador' : 'Membro'}</p>
    <form class="panel stack" id="f" style="max-width:420px">
      <h2 style="margin-top:0">Mudar password</h2>
      <div><label>Password atual</label><input name="current" type="password" required autocomplete="current-password"></div>
      <div><label>Nova password (mín. 8 caracteres)</label><input name="next" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="primary">Guardar</button>
    </form>`;
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await attempt(() => api('POST', '/me/password', Object.fromEntries(new FormData(e.target))));
    if (ok) { toast('Password alterada.'); e.target.reset(); }
  });
}

// ---------------------------------------------------------------------------
// Biblioteca: equipas → jogos (por data)
// ---------------------------------------------------------------------------

function gameCard(g) {
  const cover = g.cover_video_id
    ? `style="background-image:url('/api/videos/${g.cover_video_id}/thumb')"` : '';
  return `
    <a class="card" href="#/game/${g.id}">
      <div class="thumb" ${cover}>${g.cover_video_id ? '' : '🎬'}
        ${g.duration ? `<span class="dur">${fmtDuration(g.duration)}</span>` : ''}</div>
      <div class="body">
        <div class="date">${fmtDate(g.date)}</div>
        <div>${esc(g.team_name)} vs <strong>${esc(g.opponent)}</strong></div>
        <div class="row small muted" style="margin-top:.3rem;gap:.4rem">
          ${g.competition ? `<span class="pill">${esc(g.competition)}</span>` : ''}
          <span class="pill">${VENUE[g.venue]}</span>
          <span>${g.videos} vídeo${g.videos === 1 ? '' : 's'}</span>
        </div>
      </div>
    </a>`;
}

function groupByMonth(games) {
  const out = [];
  let current = null;
  for (const g of games) {
    const key = g.date.slice(0, 7);
    if (key !== current?.key) {
      const [y, m] = key.split('-');
      current = { key, label: `${MONTHS[Number(m) - 1]} ${y}`, games: [] };
      out.push(current);
    }
    current.games.push(g);
  }
  return out;
}

async function viewLibrary(teamId = null) {
  const [teams, games] = await Promise.all([loadTeams(), api('GET', `/games${teamId ? `?team_id=${teamId}` : ''}`)]);
  const team = teams.find((t) => t.id === teamId);

  $app.innerHTML = `
    <div class="row spread">
      <div>
        <h1>${team ? esc(team.name) : 'Biblioteca'}</h1>
        <div class="muted small">${team
          ? `${team.games} jogos · ${team.videos} vídeos · ${fmtBytes(team.bytes)}`
          : `${teams.length} equipas · ${games.length} jogos`}</div>
      </div>
      <div class="row">
        <input id="q" type="search" placeholder="🔍 Adversário, competição, data…" style="width:280px">
        <a class="btn primary" href="#/upload">⬆ Carregar vídeo</a>
      </div>
    </div>
    <div class="tabs">
      <button class="${teamId ? '' : 'active'}" data-team="">Todas</button>
      ${teams.map((t) => `<button class="${t.id === teamId ? 'active' : ''}" data-team="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>
    <div id="list"></div>`;

  $app.querySelectorAll('[data-team]').forEach((b) =>
    b.addEventListener('click', () => { location.hash = b.dataset.team ? `#/team/${b.dataset.team}` : '#/'; }));

  const render = (list) => {
    const $list = document.getElementById('list');
    if (!teams.length) {
      $list.innerHTML = `<div class="empty">Ainda não há equipas.
        ${isAdmin() ? '<br><br><a class="btn primary" href="#/admin">Criar a primeira equipa</a>' : 'Pede a um administrador para criar as equipas.'}</div>`;
      return;
    }
    if (!list.length) {
      $list.innerHTML = '<div class="empty">Sem jogos. Carrega o primeiro vídeo e cria o jogo nesse momento.</div>';
      return;
    }
    if (teamId) {
      $list.innerHTML = groupByMonth(list).map((m) =>
        `<div class="month">${m.label}</div><div class="cards">${m.games.map(gameCard).join('')}</div>`).join('');
    } else {
      // Vista geral: agrupado por equipa.
      $list.innerHTML = teams.map((t) => {
        const tg = list.filter((g) => g.team_id === t.id);
        if (!tg.length) return '';
        return `<h2><a href="#/team/${t.id}">${esc(t.name)}</a> <span class="muted small">${tg.length} jogos</span></h2>
                <div class="cards">${tg.map(gameCard).join('')}</div>`;
      }).join('');
    }
  };
  render(games);

  let debounce;
  document.getElementById('q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = e.target.value.trim();
      const params = new URLSearchParams();
      if (teamId) params.set('team_id', teamId);
      if (q) params.set('q', q);
      render(await api('GET', `/games?${params}`));
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Jogo
// ---------------------------------------------------------------------------

function gameForm(g = {}, teams = state.teams) {
  return `
    <div class="grid-form">
      <div><label>Equipa</label><select name="team_id" required>
        ${teams.map((t) => `<option value="${t.id}" ${t.id === g.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select></div>
      <div><label>Data do jogo</label><input name="date" type="date" required value="${esc(g.date || today())}"></div>
      <div><label>Adversário</label><input name="opponent" required value="${esc(g.opponent || '')}" placeholder="ex.: ABC Braga"></div>
      <div><label>Competição</label><input name="competition" value="${esc(g.competition || '')}" placeholder="ex.: Campeonato, Taça…"></div>
      <div><label>Local</label><select name="venue">
        ${Object.entries(VENUE).map(([k, v]) => `<option value="${k}" ${k === g.venue ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
    </div>`;
}

async function viewGame(id) {
  const [game] = await Promise.all([api('GET', `/games/${id}`), loadTeams()]);
  const jobsByVideo = {};
  for (const j of game.jobs) (jobsByVideo[j.video_id] ||= []).push(j);

  $app.innerHTML = `
    <div class="small muted"><a href="#/team/${game.team_id}">${esc(game.team_name)}</a> ›</div>
    <div class="row spread">
      <div>
        <h1>${fmtDate(game.date)} · vs ${esc(game.opponent)}</h1>
        <div class="row small muted" style="gap:.4rem">
          ${game.competition ? `<span class="pill">${esc(game.competition)}</span>` : ''}
          <span class="pill">${VENUE[game.venue]}</span>
          <span>${game.videos.length} vídeo(s)</span>
        </div>
      </div>
      <div class="row">
        <a class="btn primary" href="#/upload?game=${game.id}">⬆ Carregar para este jogo</a>
        ${isAdmin() ? '<button id="edit-game">Editar jogo</button><button class="danger" id="del-game">Apagar jogo</button>' : ''}
      </div>
    </div>
    ${game.notes ? `<p>${esc(game.notes)}</p>` : ''}
    <form id="game-form" class="panel stack" hidden style="margin-top:1rem">
      ${gameForm(game)}
      <div><label>Notas</label><textarea name="notes" rows="2">${esc(game.notes)}</textarea></div>
      <div class="row"><button class="primary">Guardar</button><button type="button" id="cancel-edit">Cancelar</button></div>
    </form>
    <h2>Vídeos</h2>
    ${game.videos.length ? `<div class="cards">${game.videos.map((v) => {
      const job = (jobsByVideo[v.id] || []).find((j) => j.status === 'running' || j.status === 'queued');
      return `
      <a class="card" href="#/video/${v.id}">
        <div class="thumb" ${v.has_thumb ? `style="background-image:url('${thumbUrl(v)}')"` : ''}>
          ${v.has_thumb ? '' : v.status === 'error' ? '⚠️' : '⏳'}
          ${v.duration ? `<span class="dur">${fmtDuration(v.duration)}</span>` : ''}
        </div>
        <div class="body">
          <div style="font-weight:600">${esc(v.title)}</div>
          <div class="row small muted" style="gap:.4rem;margin-top:.25rem">
            ${STATUS_PILL[v.status]} ${v.parent_id ? '<span class="pill">clip</span>' : ''}
            <span>${fmtBytes(v.size)}</span>
            ${v.height ? `<span>${v.height}p</span>` : ''}
          </div>
          ${job ? `<div class="small muted" style="margin-top:.4rem">${JOB_LABEL[job.type]}: ${Math.round(job.progress * 100)}%
            <div class="progress"><div style="width:${job.progress * 100}%"></div></div></div>` : ''}
          ${v.status === 'error' ? `<div class="small" style="color:var(--err)">${esc(v.error)}</div>` : ''}
        </div>
      </a>`;
    }).join('')}</div>` : '<div class="empty">Ainda não há vídeos deste jogo.</div>'}`;

  if (game.videos.some((v) => v.status === 'processing') || game.jobs.some((j) => j.status !== 'error')) {
    every(3000, async () => {
      const fresh = await api('GET', `/games/${id}`).catch(() => null);
      if (fresh && JSON.stringify([fresh.videos, fresh.jobs]) !== JSON.stringify([game.videos, game.jobs])) route();
    });
  }

  if (!isAdmin()) return;
  const form = document.getElementById('game-form');
  document.getElementById('edit-game').onclick = () => { form.hidden = false; };
  document.getElementById('cancel-edit').onclick = () => { form.hidden = true; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('PATCH', `/games/${id}`, Object.fromEntries(new FormData(form))))) { toast('Jogo atualizado.'); route(); }
  });
  document.getElementById('del-game').onclick = async () => {
    if (!await ask(`Apagar o jogo e TODOS os ${game.videos.length} vídeos? Não há volta atrás.`)) return;
    if (await attempt(() => api('DELETE', `/games/${id}`))) { toast('Jogo apagado.'); location.hash = `#/team/${game.team_id}`; }
  };
}

// ---------------------------------------------------------------------------
// Vídeo: leitor + editor (admins)
// ---------------------------------------------------------------------------

async function viewVideo(id) {
  const v = await api('GET', `/videos/${id}`);
  const game = await api('GET', `/games/${v.game_id}`);
  const activeJob = v.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const ready = v.status === 'ready';

  $app.innerHTML = `
    <div class="small muted"><a href="#/team/${game.team_id}">${esc(game.team_name)}</a> ›
      <a href="#/game/${game.id}">${fmtDate(game.date)} vs ${esc(game.opponent)}</a> ›</div>
    <div class="row spread"><h1>${esc(v.title)}</h1>
      <div class="row">${ready ? `<a class="btn" href="/api/videos/${v.id}/download">⬇ Descarregar</a>` : ''}</div></div>
    <div class="player-wrap" style="margin-top:.75rem">
      <div>
        ${ready
          ? `<video id="player" controls preload="metadata" playsinline poster="${thumbUrl(v)}" src="/api/videos/${v.id}/stream?v=${encodeURIComponent(v.updated_at)}"></video>`
          : `<div class="thumb panel" style="font-size:1rem">${v.status === 'error' ? `⚠️ ${esc(v.error)}` : '⏳ A processar o vídeo…'}</div>`}
        <div class="row small muted" style="margin-top:.5rem;gap:.6rem">
          ${STATUS_PILL[v.status]}
          <span>${fmtDuration(v.duration)}</span><span>${v.width}×${v.height}</span><span>${fmtBytes(v.size)}</span>
          <span>Ficheiro original: ${esc(v.original_name)}</span>
        </div>
        ${activeJob ? `<div class="panel" style="margin-top:.75rem">
          <strong>${JOB_LABEL[activeJob.type]}</strong> — ${activeJob.status === 'queued' ? 'em fila' : `${Math.round(activeJob.progress * 100)}%`}
          <div class="progress" style="margin-top:.4rem"><div style="width:${activeJob.progress * 100}%"></div></div>
          <div class="small muted" style="margin-top:.3rem">Podes continuar a ver o vídeo atual; é substituído quando a edição terminar.</div></div>` : ''}
      </div>
      <aside id="side" class="stack"></aside>
    </div>`;

  if (activeJob || v.status === 'processing') {
    every(2500, async () => {
      const fresh = await api('GET', `/videos/${id}`).catch(() => null);
      if (fresh && JSON.stringify(fresh.jobs[0]) !== JSON.stringify(v.jobs[0])) route();
    });
  }

  const $side = document.getElementById('side');
  if (!isAdmin()) {
    $side.innerHTML = `<div class="panel small muted">Só os administradores podem editar vídeos.</div>`;
    return;
  }

  const teams = await loadTeams();
  const allGames = await api('GET', '/games');
  $side.innerHTML = `
    <div class="panel stack">
      <strong>✂️ Cortar</strong>
      <div class="timeline" id="tl"><div class="sel" id="tl-sel"></div><div class="head" id="tl-head"></div></div>
      <div class="grid-form" style="grid-template-columns:1fr 1fr">
        <div><label>Início</label><input id="t-start" value="0:00.0"></div>
        <div><label>Fim</label><input id="t-end" value="${fmtTimePrecise(v.duration)}"></div>
      </div>
      <div class="row">
        <button type="button" id="mark-in">⇤ Marcar início</button>
        <button type="button" id="mark-out">Marcar fim ⇥</button>
        <button type="button" id="preview">▶ Ver seleção</button>
      </div>
      <div class="small" id="t-len"></div>
      <label class="row" style="gap:.4rem;color:var(--text)"><input type="radio" name="mode" value="clip" checked><span>Guardar como <b>novo clip</b> (mantém o original)</span></label>
      <input id="clip-title" placeholder="Título do clip (ex.: 2.ª parte, Golo 15')">
      <label class="row" style="gap:.4rem;color:var(--text)"><input type="radio" name="mode" value="replace"><span>Substituir o vídeo original</span></label>
      <label class="row small" style="gap:.4rem;flex-wrap:nowrap"><input type="checkbox" id="precise"><span>Corte preciso ao frame (mais lento: recodifica)</span></label>
      <button class="primary" id="do-trim" ${ready ? '' : 'disabled'}>Cortar</button>
    </div>

    <div class="panel stack">
      <strong>🛠 Outras edições</strong>
      <div class="row">
        <button data-op="rotate" data-deg="90" ${ready ? '' : 'disabled'}>↻ 90°</button>
        <button data-op="rotate" data-deg="180" ${ready ? '' : 'disabled'}>180°</button>
        <button data-op="rotate" data-deg="270" ${ready ? '' : 'disabled'}>↺ 90°</button>
        <button data-op="mute" ${ready ? '' : 'disabled'}>🔇 Tirar som</button>
      </div>
      <div class="row">
        <select id="c-height" style="width:auto">
          <option value="1080">1080p</option><option value="720" selected>720p</option><option value="480">480p</option>
        </select>
        <button data-op="compress" ${ready ? '' : 'disabled'}>🗜 Comprimir</button>
      </div>
      <div class="small muted">Comprimir para 720p reduz muito o tamanho de jogos gravados em 4K/1080p.</div>
    </div>

    <form class="panel stack" id="meta">
      <strong>📝 Detalhes</strong>
      <div><label>Título</label><input name="title" value="${esc(v.title)}" required></div>
      <div><label>Jogo</label><select name="game_id">
        ${teams.map((t) => `<optgroup label="${esc(t.name)}">${allGames.filter((g) => g.team_id === t.id).map((g) =>
          `<option value="${g.id}" ${g.id === v.game_id ? 'selected' : ''}>${fmtDate(g.date)} vs ${esc(g.opponent)}</option>`).join('')}</optgroup>`).join('')}
      </select></div>
      <div class="row spread"><button class="primary">Guardar</button><button type="button" class="danger" id="del">Apagar vídeo</button></div>
    </form>

    <details class="panel"><summary>Histórico de edições</summary>
      ${v.jobs.length ? `<table class="small">${v.jobs.map((j) => `<tr><td>${JOB_LABEL[j.type] || j.type}</td><td>${STATUS_PILL[j.status]}</td>
        <td class="muted">${esc((j.finished_at || j.created_at || '').replace('T', ' ').slice(0, 16))}</td></tr>
        ${j.error ? `<tr><td colspan="3" style="color:var(--err)">${esc(j.error)}</td></tr>` : ''}`).join('')}</table>` : '<p class="muted small">Sem edições.</p>'}
    </details>`;

  // --- Corte
  const player = document.getElementById('player');
  const $start = document.getElementById('t-start');
  const $end = document.getElementById('t-end');
  const dur = () => player?.duration || v.duration || 1;
  const sel = () => ({ start: parseTime($start.value), end: parseTime($end.value) });

  function drawTimeline() {
    const { start, end } = sel();
    const d = dur();
    const s = document.getElementById('tl-sel');
    s.style.left = `${(Math.max(0, start) / d) * 100}%`;
    s.style.width = `${Math.max(0, (Math.min(end, d) - start) / d) * 100}%`;
    document.getElementById('tl-head').style.left = `${((player?.currentTime || 0) / d) * 100}%`;
    document.getElementById('t-len').textContent = end > start
      ? `Seleção: ${fmtDuration(end - start)}` : 'Seleção inválida';
  }
  drawTimeline();
  $start.addEventListener('input', drawTimeline);
  $end.addEventListener('input', drawTimeline);

  let stopAt = null;
  if (player) {
    player.addEventListener('timeupdate', () => {
      drawTimeline();
      if (stopAt !== null && player.currentTime >= stopAt) { player.pause(); stopAt = null; }
    });
    document.getElementById('tl').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      player.currentTime = ((e.clientX - r.left) / r.width) * dur();
    });
  }
  document.getElementById('mark-in').onclick = () => { $start.value = fmtTimePrecise(player?.currentTime || 0); drawTimeline(); };
  document.getElementById('mark-out').onclick = () => { $end.value = fmtTimePrecise(player?.currentTime || 0); drawTimeline(); };
  document.getElementById('preview').onclick = () => {
    if (!player) return;
    const { start, end } = sel();
    player.currentTime = start;
    stopAt = end;
    player.play();
  };

  const submitEdit = async (type, params) => {
    const r = await attempt(() => api('POST', `/videos/${id}/edit`, { type, params }));
    if (!r) return;
    toast('Edição em fila. Podes sair desta página: o processamento continua no servidor.');
    if (r.videoId !== id) location.hash = `#/video/${r.videoId}`; else route();
  };

  document.getElementById('do-trim').onclick = async () => {
    const { start, end } = sel();
    if (!(end > start)) return toast('O fim tem de ser depois do início.', true);
    const mode = $side.querySelector('input[name=mode]:checked').value;
    if (mode === 'replace' && !await ask('Substituir o vídeo original pela parte selecionada? O resto é apagado.')) return;
    submitEdit('trim', { start, end, mode, precise: document.getElementById('precise').checked,
      title: document.getElementById('clip-title').value });
  };

  $side.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
    const op = b.dataset.op;
    if (op === 'rotate') return submitEdit('rotate', { degrees: Number(b.dataset.deg) });
    if (op === 'mute') return await ask('Remover o áudio deste vídeo?') && submitEdit('mute', {});
    if (op === 'compress') return submitEdit('compress', { height: Number(document.getElementById('c-height').value) });
  }));

  // --- Metadados
  document.getElementById('meta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (await attempt(() => api('PATCH', `/videos/${id}`, { title: fd.title, game_id: Number(fd.game_id) }))) { toast('Guardado.'); route(); }
  });
  document.getElementById('del').onclick = async () => {
    if (!await ask('Apagar este vídeo definitivamente?')) return;
    if (await attempt(() => api('DELETE', `/videos/${id}`))) { toast('Vídeo apagado.'); location.hash = `#/game/${v.game_id}`; }
  };
}

// ---------------------------------------------------------------------------
// Upload (tus: envio em blocos, retoma automática)
// ---------------------------------------------------------------------------

const CHUNK = 50 * 1024 * 1024; // 50 MB por pedido (passa em proxies como Cloudflare, limite 100 MB)
const MAX_PARALLEL = 2;

function startNextUploads() {
  const running = state.uploads.filter((u) => u.status === 'uploading').length;
  state.uploads.filter((u) => u.status === 'waiting').slice(0, MAX_PARALLEL - running).forEach(startUpload);
}

async function startUpload(u) {
  u.status = 'uploading';
  u.startedAt = Date.now();
  u.startBytes = u.sent || 0;
  u.tus = new window.tus.Upload(u.file, {
    endpoint: '/api/uploads',
    chunkSize: CHUNK,
    retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000],
    removeFingerprintOnSuccess: true,
    metadata: { filename: u.file.name, filetype: u.file.type || 'video/mp4', gameId: String(u.gameId), title: u.title },
    onProgress(sent, total) {
      u.sent = sent;
      u.total = total;
      renderUploads();
    },
    onError(err) {
      u.status = 'error';
      u.error = err?.originalResponse?.getBody?.() || err.message;
      renderUploads();
      startNextUploads();
    },
    onSuccess() {
      u.status = 'done';
      u.sent = u.total;
      renderUploads();
      refreshJobsBadge();
      startNextUploads();
    },
  });
  // Se este ficheiro já tinha sido parcialmente enviado (mesmo noutra sessão do browser), continua daí.
  const previous = await u.tus.findPreviousUploads();
  if (previous.length) u.tus.resumeFromPreviousUpload(previous[0]);
  u.tus.start();
  renderUploads();
}

function renderUploads() {
  const $list = document.getElementById('uploads');
  if (!$list) return;
  if (!state.uploads.length) { $list.innerHTML = ''; return; }
  $list.innerHTML = `<h2>Envios</h2><div class="panel"><table>${state.uploads.map((u, i) => {
    const pct = u.total ? (u.sent / u.total) * 100 : 0;
    const elapsed = (Date.now() - (u.startedAt || Date.now())) / 1000;
    const speed = elapsed > 2 ? ((u.sent || 0) - (u.startBytes || 0)) / elapsed : 0;
    const eta = speed > 0 ? (u.total - u.sent) / speed : 0;
    const label = {
      waiting: 'em espera', uploading: `${pct.toFixed(1)}%${speed ? ` · ${fmtBytes(speed)}/s · falta ${fmtDuration(eta)}` : ''}`,
      paused: `em pausa (${pct.toFixed(1)}%)`, done: '✅ enviado — a processar no servidor', error: `❌ ${u.error}`, canceled: 'cancelado',
    }[u.status];
    return `<tr>
      <td><div style="font-weight:600">${esc(u.title)}</div>
        <div class="small muted">${esc(u.file.name)} · ${fmtBytes(u.file.size)} · ${esc(u.gameLabel)}</div>
        <div class="progress" style="margin-top:.35rem"><div style="width:${u.status === 'done' ? 100 : pct}%"></div></div>
        <div class="small muted" style="margin-top:.2rem">${label}</div></td>
      <td style="width:1%;white-space:nowrap">
        ${u.status === 'uploading' ? `<button data-pause="${i}">⏸</button>` : ''}
        ${u.status === 'paused' || u.status === 'error' ? `<button data-resume="${i}">▶ Retomar</button>` : ''}
        ${['waiting', 'uploading', 'paused', 'error'].includes(u.status) ? `<button data-cancel="${i}" class="danger">✕</button>` : ''}
        ${u.status === 'done' ? `<a class="btn" href="#/game/${u.gameId}">Ver jogo</a>` : ''}
      </td></tr>`;
  }).join('')}</table></div>`;

  $list.querySelectorAll('[data-pause]').forEach((b) => b.onclick = () => {
    const u = state.uploads[b.dataset.pause];
    u.tus.abort();
    u.status = 'paused';
    renderUploads();
    startNextUploads();
  });
  $list.querySelectorAll('[data-resume]').forEach((b) => b.onclick = () => {
    const u = state.uploads[b.dataset.resume];
    u.status = 'uploading';
    u.startedAt = Date.now();
    u.startBytes = u.sent || 0;
    u.tus ? u.tus.start() : startUpload(u);
    renderUploads();
  });
  $list.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
    const u = state.uploads[b.dataset.cancel];
    if (!await ask(`Cancelar o envio de "${u.title}"?`)) return;
    u.status = 'canceled';
    if (u.tus) await u.tus.abort(true).catch(() => {});
    renderUploads();
    startNextUploads();
  });
}

async function viewUpload(presetGameId) {
  const teams = await loadTeams();
  const games = await api('GET', '/games');
  const preset = games.find((g) => g.id === presetGameId);

  if (!teams.length) {
    $app.innerHTML = `<div class="empty">Ainda não há equipas. ${isAdmin() ? '<a href="#/admin">Cria uma equipa primeiro.</a>' : 'Pede a um administrador para criar as equipas.'}</div>`;
    return;
  }

  $app.innerHTML = `
    <h1>Carregar vídeos</h1>
    <p class="muted">Os vídeos são enviados em blocos: se a internet falhar o envio continua sozinho, e podes pausar e retomar.
      Não feches o separador até terminar (podes navegar na aplicação).</p>
    <div class="panel stack">
      <strong>1. A que jogo pertence?</strong>
      <div class="grid-form">
        <div><label>Equipa</label><select id="u-team">
          ${teams.map((t) => `<option value="${t.id}" ${t.id === (preset?.team_id ?? teams[0].id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></div>
        <div><label>Jogo</label><select id="u-game"></select></div>
      </div>
      <form id="new-game" class="stack" hidden>
        <div class="small muted">Novo jogo:</div>
        <div class="grid-form">
          <div><label>Data do jogo</label><input name="date" type="date" required value="${today()}"></div>
          <div><label>Adversário</label><input name="opponent" required placeholder="ex.: ABC Braga"></div>
          <div><label>Competição</label><input name="competition" placeholder="opcional"></div>
          <div><label>Local</label><select name="venue">${Object.entries(VENUE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        </div>
      </form>

      <strong>2. Escolhe os ficheiros</strong>
      <div class="dropzone" id="drop">
        <div style="font-size:2rem">🎥</div>
        <div><strong>Arrasta os vídeos para aqui</strong> ou clica para escolher</div>
        <div class="small muted">MP4, MOV, MTS, MKV… Ficheiros grandes são bem-vindos.</div>
        <input type="file" id="files" accept="video/*,.mts,.m2ts,.mkv,.avi" multiple hidden>
      </div>
      <div id="picked"></div>
      <button class="primary" id="go" disabled>Começar envio</button>
    </div>
    <div id="uploads"></div>`;

  const $team = document.getElementById('u-team');
  const $game = document.getElementById('u-game');
  const $newGame = document.getElementById('new-game');
  const fillGames = (selectId) => {
    const tg = games.filter((g) => g.team_id === Number($team.value));
    $game.innerHTML = `<option value="new">➕ Novo jogo…</option>${tg.map((g) =>
      `<option value="${g.id}" ${g.id === selectId ? 'selected' : ''}>${fmtDate(g.date)} vs ${esc(g.opponent)}${g.competition ? ` (${esc(g.competition)})` : ''}</option>`).join('')}`;
    if (!selectId && tg.length && tg[0].date === today()) $game.value = tg[0].id;
    $newGame.hidden = $game.value !== 'new';
  };
  fillGames(preset?.id);
  $team.onchange = () => fillGames();
  $game.onchange = () => { $newGame.hidden = $game.value !== 'new'; };

  let picked = [];
  const $picked = document.getElementById('picked');
  const renderPicked = () => {
    $picked.innerHTML = picked.map((p, i) => `
      <div class="row" style="margin-bottom:.4rem">
        <input data-title="${i}" value="${esc(p.title)}" style="flex:1;min-width:200px" placeholder="Título (ex.: 1.ª parte)">
        <span class="small muted">${esc(p.file.name)} · ${fmtBytes(p.file.size)}</span>
        <button data-rm="${i}">✕</button>
      </div>`).join('');
    $picked.querySelectorAll('[data-title]').forEach((inp) => inp.oninput = () => { picked[inp.dataset.title].title = inp.value; });
    $picked.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { picked.splice(b.dataset.rm, 1); renderPicked(); });
    document.getElementById('go').disabled = !picked.length;
  };
  const addFiles = (files) => {
    for (const file of files) {
      picked.push({ file, title: file.name.replace(/\.[^.]+$/, '') });
    }
    renderPicked();
  };

  const $drop = document.getElementById('drop');
  const $files = document.getElementById('files');
  $drop.onclick = () => $files.click();
  $files.onchange = () => { addFiles($files.files); $files.value = ''; };
  $drop.addEventListener('dragover', (e) => { e.preventDefault(); $drop.classList.add('over'); });
  $drop.addEventListener('dragleave', () => $drop.classList.remove('over'));
  $drop.addEventListener('drop', (e) => { e.preventDefault(); $drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  document.getElementById('go').onclick = async () => {
    let gameId = $game.value;
    let gameLabel = $game.selectedOptions[0]?.textContent;
    if (gameId === 'new') {
      if (!$newGame.reportValidity()) return;
      const body = { ...Object.fromEntries(new FormData($newGame)), team_id: Number($team.value) };
      const r = await attempt(() => api('POST', '/games', body));
      if (!r) return;
      gameId = r.id;
      gameLabel = `${fmtDate(body.date)} vs ${body.opponent}`;
    }
    const teamName = $team.selectedOptions[0].textContent;
    for (const p of picked) {
      state.uploads.push({ file: p.file, title: p.title || p.file.name, gameId: Number(gameId),
        gameLabel: `${teamName} · ${gameLabel}`, status: 'waiting', sent: 0, total: p.file.size });
    }
    picked = [];
    renderPicked();
    startNextUploads();
    renderUploads();
  };

  renderUploads();
  every(1000, () => { if (state.uploads.some((u) => u.status === 'uploading')) renderUploads(); });
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

async function viewJobs() {
  const jobs = await api('GET', '/jobs');
  $app.innerHTML = `
    <h1>Processamento</h1>
    <p class="muted">Depois do envio, cada vídeo é convertido para um formato que reproduz em qualquer browser/telemóvel.
      As edições também aparecem aqui. Corre um trabalho de cada vez.</p>
    ${jobs.length ? `<div class="panel"><table>
      <tr><th>Vídeo</th><th>Operação</th><th>Estado</th><th style="width:30%">Progresso</th></tr>
      ${jobs.map((j) => `<tr>
        <td><a href="#/video/${j.video_id}">${esc(j.title)}</a>
          <div class="small muted">${esc(j.team_name)} · ${fmtDate(j.date)} vs ${esc(j.opponent)}</div></td>
        <td>${JOB_LABEL[j.type] || j.type}</td>
        <td>${STATUS_PILL[j.status]}${j.error ? `<div class="small" style="color:var(--err)">${esc(j.error)}</div>` : ''}</td>
        <td>${j.status === 'running' ? `<div class="progress"><div style="width:${j.progress * 100}%"></div></div>
          <span class="small muted">${Math.round(j.progress * 100)}%</span>` : ''}</td></tr>`).join('')}
    </table></div>` : '<div class="empty">Nada a processar nas últimas 24 horas.</div>'}`;
  if (jobs.some((j) => j.status === 'running' || j.status === 'queued')) every(3000, route);
}

// ---------------------------------------------------------------------------
// Administração: equipas e utilizadores
// ---------------------------------------------------------------------------

async function viewAdmin() {
  if (!isAdmin()) { $app.innerHTML = '<div class="empty">Só para administradores.</div>'; return; }
  const [teams, allUsers] = await Promise.all([loadTeams(), api('GET', '/users')]);
  const pending = allUsers.filter((u) => u.status === 'pending');
  const users = allUsers.filter((u) => u.status === 'active');
  $app.innerHTML = `
    <h1>Administração</h1>
    ${pending.length ? `
    <h2>Pedidos de acesso <span class="badge">${pending.length}</span></h2>
    <div class="panel"><table>
      <tr><th>Nome</th><th>Email</th><th>Pedido em</th><th></th></tr>
      ${pending.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td class="muted small">${esc(String(u.created_at).slice(0, 16))}</td>
        <td style="text-align:right;white-space:nowrap"><button class="primary" data-approve="${u.id}">Aprovar</button>
          <button class="danger" data-reject="${u.id}">Recusar</button></td></tr>`).join('')}
    </table></div>` : ''}
    <h2>Equipas</h2>
    <div class="panel stack">
      <table>
        <tr><th>Nome</th><th>Jogos</th><th>Vídeos</th><th>Espaço</th><th></th></tr>
        ${teams.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.games}</td><td>${t.videos}</td><td>${fmtBytes(t.bytes)}</td>
          <td style="text-align:right;white-space:nowrap"><button data-rename-team="${t.id}">Renomear</button>
          <button class="danger" data-del-team="${t.id}">Apagar</button></td></tr>`).join('')}
      </table>
      <form id="new-team" class="row"><input name="name" placeholder="Nova equipa (ex.: Seniores, Juniores, Iniciados…)" required style="flex:1">
        <button class="primary">Adicionar equipa</button></form>
    </div>

    <h2>Utilizadores</h2>
    <div class="panel stack">
      <table>
        <tr><th>Nome</th><th>Email</th><th>Perfil</th><th></th></tr>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
          <td><select data-role="${u.id}" style="width:auto">
            <option value="member" ${u.role === 'member' ? 'selected' : ''}>Membro (ver + carregar)</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin (editar + apagar)</option></select></td>
          <td style="text-align:right;white-space:nowrap"><button data-reset="${u.id}">Nova password</button>
            ${u.id === state.me.id || u.role === 'admin' ? '' : `<button data-suspend="${u.id}">Suspender</button>`}
            ${u.id === state.me.id ? '' : `<button class="danger" data-del-user="${u.id}">Apagar</button>`}</td></tr>`).join('')}
      </table>
      <form id="new-user" class="grid-form">
        <div><label>Nome</label><input name="name" required></div>
        <div><label>Email</label><input name="email" type="email" required></div>
        <div><label>Password inicial</label><input name="password" type="text" minlength="8" required></div>
        <div><label>Perfil</label><select name="role"><option value="member">Membro</option><option value="admin">Admin</option></select></div>
        <div style="align-self:end"><button class="primary">Adicionar utilizador</button></div>
      </form>
    </div>`;

  $app.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async () => {
    if (await attempt(() => api('PATCH', `/users/${b.dataset.approve}`, { status: 'active' }))) {
      toast('Conta aprovada. Já pode entrar e ver os vídeos.');
      route();
      refreshJobsBadge();
    }
  });
  $app.querySelectorAll('[data-reject]').forEach((b) => b.onclick = async () => {
    const u = pending.find((x) => x.id === Number(b.dataset.reject));
    if (!await ask(`Recusar o pedido de ${u.name} (${u.email})?`, { okLabel: 'Recusar' })) return;
    if (await attempt(() => api('DELETE', `/users/${u.id}`))) { toast('Pedido recusado.'); route(); refreshJobsBadge(); }
  });
  $app.querySelectorAll('[data-suspend]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === Number(b.dataset.suspend));
    if (!await ask(`Suspender o acesso de ${u.name}? Deixa de poder entrar até voltares a aprovar a conta.`, { okLabel: 'Suspender' })) return;
    if (await attempt(() => api('PATCH', `/users/${u.id}`, { status: 'pending' }))) { toast('Acesso suspenso.'); route(); refreshJobsBadge(); }
  });
  document.getElementById('new-team').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', '/teams', Object.fromEntries(new FormData(e.target))))) { toast('Equipa criada.'); route(); }
  });
  $app.querySelectorAll('[data-rename-team]').forEach((b) => b.onclick = async () => {
    const t = teams.find((x) => x.id === Number(b.dataset.renameTeam));
    const name = await askText('Novo nome da equipa:', t.name);
    if (name && await attempt(() => api('PATCH', `/teams/${t.id}`, { name }))) route();
  });
  $app.querySelectorAll('[data-del-team]').forEach((b) => b.onclick = async () => {
    const t = teams.find((x) => x.id === Number(b.dataset.delTeam));
    if (!await ask(`Apagar "${t.name}" com ${t.games} jogos e ${t.videos} vídeos? Não há volta atrás.`)) return;
    if (await attempt(() => api('DELETE', `/teams/${t.id}`))) { toast('Equipa apagada.'); route(); }
  });
  document.getElementById('new-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', '/users', Object.fromEntries(new FormData(e.target))))) { toast('Utilizador criado.'); route(); }
  });
  $app.querySelectorAll('[data-role]').forEach((s) => s.onchange = async () => {
    if (!await attempt(() => api('PATCH', `/users/${s.dataset.role}`, { role: s.value }))) route();
    else toast('Perfil atualizado.');
  });
  $app.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
    const password = await askText('Nova password (mín. 8 caracteres):', '', 'text');
    if (password && await attempt(() => api('PATCH', `/users/${b.dataset.reset}`, { password }))) toast('Password alterada.');
  });
  $app.querySelectorAll('[data-del-user]').forEach((b) => b.onclick = async () => {
    if (await ask('Apagar este utilizador?') && await attempt(() => api('DELETE', `/users/${b.dataset.delUser}`))) route();
  });
}

route();
refreshJobsBadge();
