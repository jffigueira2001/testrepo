// Videoteca CDE Camões — frontend (sem build: ES modules + tus-js-client global)

const $app = document.getElementById('app');
const state = { me: null, teams: [], uploads: [], timers: [], join: { items: [], source: '' } };

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
const CLUB = 'CDE Camões';
const VENUE = { casa: 'Casa', fora: 'Fora', neutro: 'Neutro' };
const JOB_LABEL = { ingest: 'Processar upload', trim: 'Cortar', rotate: 'Rodar', mute: 'Remover som', compress: 'Comprimir', concat: 'Juntar vídeos' };
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
  [/^#\/team\/(\d+)$/, () => viewLibrary()],
  [/^#\/players$/, viewPlayers],
  [/^#\/join$/, viewJoin],
  [/^#\/player\/(\d+)$/, (id) => viewPlayer(Number(id))],
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
    const section = hash.startsWith('#/upload') ? 'upload' : hash.startsWith('#/jobs') ? 'jobs' : hash.startsWith('#/admin') ? 'admin'
      : hash.startsWith('#/player') ? 'players' : 'library';
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
  if (!isAdmin()) return;
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
        <div>${CLUB} vs <strong>${esc(g.opponent)}</strong></div>
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

async function viewLibrary() {
  const games = await api('GET', '/games');
  const videos = games.reduce((n, g) => n + g.videos, 0);

  $app.innerHTML = `
    <div class="row spread">
      <div>
        <h1>Biblioteca</h1>
        <div class="muted small">${games.length} jogos · ${videos} vídeos</div>
      </div>
      <div class="row">
        <input id="q" type="search" placeholder="🔍 Adversário, jogador, competição, data…" style="width:300px">
        ${isAdmin() ? '<a class="btn" href="#/join">🎞 Juntar vídeos</a>' : ''}
        ${isAdmin() ? '<a class="btn primary" href="#/upload">⬆ Carregar vídeo</a>' : ''}
      </div>
    </div>
    <div id="list"></div>`;

  const render = (list, searching = false) => {
    const $list = document.getElementById('list');
    if (!list.length) {
      $list.innerHTML = searching
        ? '<div class="empty">Nenhum jogo encontrado.</div>'
        : `<div class="empty">${isAdmin() ? 'Sem jogos. Carrega o primeiro vídeo e cria o jogo nesse momento.' : 'Ainda não há jogos.'}</div>`;
      return;
    }
    $list.innerHTML = groupByMonth(list).map((m) =>
      `<div class="month">${m.label}</div><div class="cards">${m.games.map(gameCard).join('')}</div>`).join('');
  };
  render(games);

  let debounce;
  document.getElementById('q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = e.target.value.trim();
      render(q ? await api('GET', `/games?q=${encodeURIComponent(q)}`) : games, !!q);
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Jogo
// ---------------------------------------------------------------------------

function gameForm(g = {}) {
  return `
    <div class="grid-form">
      <div><label>Data do jogo</label><input name="date" type="date" required value="${esc(g.date || today())}"></div>
      <div><label>Adversário</label><input name="opponent" required value="${esc(g.opponent || '')}" placeholder="ex.: ABC Braga"></div>
      <div><label>Competição</label><input name="competition" value="${esc(g.competition || '')}" placeholder="ex.: Campeonato, Taça…"></div>
      <div><label>Local</label><select name="venue">
        ${Object.entries(VENUE).map(([k, v]) => `<option value="${k}" ${k === g.venue ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
    </div>`;
}

async function viewGame(id) {
  const game = await api('GET', `/games/${id}`);
  const jobsByVideo = {};
  for (const j of game.jobs) (jobsByVideo[j.video_id] ||= []).push(j);

  $app.innerHTML = `
    <div class="small muted"><a href="#/">Biblioteca</a> ›</div>
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
        ${isAdmin() ? `<a class="btn primary" href="#/upload?game=${game.id}">⬆ Carregar para este jogo</a>
          <button id="join-game">🎞 Juntar vídeos</button>
          <button id="edit-game">Editar jogo</button><button class="danger" id="del-game">Apagar jogo</button>` : ''}
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
          ${playerChips(v.players)}
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
  document.getElementById('join-game').onclick = () => openJoin([], `game:${game.id}`);
  const form = document.getElementById('game-form');
  document.getElementById('edit-game').onclick = () => { form.hidden = false; };
  document.getElementById('cancel-edit').onclick = () => { form.hidden = true; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('PATCH', `/games/${id}`, Object.fromEntries(new FormData(form))))) { toast('Jogo atualizado.'); route(); }
  });
  document.getElementById('del-game').onclick = async () => {
    if (!await ask(`Apagar o jogo e TODOS os ${game.videos.length} vídeos? Não há volta atrás.`)) return;
    if (await attempt(() => api('DELETE', `/games/${id}`))) { toast('Jogo apagado.'); location.hash = '#/'; }
  };
}

// ---------------------------------------------------------------------------
// Jogadores: etiquetas nos clips (do clube ou do adversário)
// ---------------------------------------------------------------------------

const playerLabel = (p) => `${p.number != null ? `${p.number} · ` : ''}${p.name}`;

/** Etiquetas de jogadores. linked=true torna-as links para a página do jogador. */
function playerChips(players = [], linked = false) {
  if (!players.length) return '';
  const tag = linked ? 'a' : 'span';
  return `<span class="chips">${players.map((p) => `<${tag} class="chip ${p.club ? 'opp' : 'own'}"
    ${linked ? `href="#/player/${p.id}"` : ''} title="${esc(p.club || CLUB)}">${esc(playerLabel(p))}${p.club ? ` <small>${esc(p.club)}</small>` : ''}</${tag}>`).join('')}</span>`;
}

let pickerSeq = 0;

/**
 * Seletor de jogadores para um clip: escolhe-se o lado (o nosso clube ou o adversário do jogo)
 * e escreve-se o nome ou o número. Nomes novos são criados quando se guarda (ids()).
 */
function playerPicker(el, { opponent, all, selected = [] }) {
  const listId = `players-${++pickerSeq}`;
  const chosen = selected.map((p) => ({ ...p }));
  let side = '';
  const sameClub = (p) => (p.club || '').toLowerCase() === side.toLowerCase();

  function render() {
    el.innerHTML = `
      <div class="picker">
        <div class="chips">${chosen.map((p, i) => `<span class="chip ${p.club ? 'opp' : 'own'}">${esc(playerLabel(p))}${p.club ? ` <small>${esc(p.club)}</small>` : ''}${p.id ? '' : ' <small>(novo)</small>'}
          <button type="button" class="chip-x" data-rm="${i}" aria-label="Remover ${esc(p.name)}">×</button></span>`).join('')
          || '<span class="small muted">Nenhum jogador.</span>'}</div>
        <div class="row picker-row">
          <select data-side aria-label="Equipa do jogador">
            <option value="" ${side ? '' : 'selected'}>${CLUB}</option>
            <option value="${esc(opponent)}" ${side ? 'selected' : ''}>${esc(opponent)}</option>
          </select>
          <input data-name list="${listId}" placeholder="Nome ou n.º" aria-label="Nome ou número do jogador">
          <button type="button" data-add>Adicionar</button>
        </div>
        <datalist id="${listId}">${all.filter((p) => sameClub(p) && !chosen.some((c) => c.id === p.id))
          .map((p) => `<option value="${esc(p.name)}">${p.number != null ? `n.º ${p.number}` : ''}</option>`).join('')}</datalist>
      </div>`;
    el.querySelector('[data-side]').onchange = (e) => { side = e.target.value; render(); el.querySelector('[data-name]').focus(); };
    el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { chosen.splice(Number(b.dataset.rm), 1); render(); });
    const input = el.querySelector('[data-name]');
    const add = () => {
      const text = input.value.trim();
      if (!text) return;
      const byNumber = /^\d{1,2}$/.test(text) ? all.find((p) => sameClub(p) && p.number === Number(text)) : null;
      const found = byNumber || all.find((p) => sameClub(p) && p.name.toLowerCase() === text.toLowerCase());
      const pick = found || { id: null, name: text, number: null, club: side };
      if (!chosen.some((c) => (c.id && c.id === pick.id) || (!c.id && !pick.id && c.name.toLowerCase() === pick.name.toLowerCase() && sameClub(c)))) {
        chosen.push(pick);
      }
      render();
      el.querySelector('[data-name]').focus();
    };
    el.querySelector('[data-add]').onclick = add;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  }
  render();

  return {
    /** Cria os jogadores novos e devolve os ids de todos os escolhidos. */
    async ids() {
      for (const p of chosen) {
        if (!p.id) {
          p.id = (await api('POST', '/players', { name: p.name, club: p.club })).id;
          all.push({ ...p });
        }
      }
      return chosen.map((p) => p.id);
    },
  };
}

async function viewPlayers() {
  const players = await api('GET', '/players');
  const own = players.filter((p) => !p.club);
  const clubs = [...new Set(players.filter((p) => p.club).map((p) => p.club))].sort((a, b) => a.localeCompare(b));
  const row = (p) => `<tr>
      <td class="num">${p.number ?? ''}</td>
      <td><a href="#/player/${p.id}">${esc(p.name)}</a></td>
      <td class="num">${p.clips} clip${p.clips === 1 ? '' : 's'}</td>
      ${isAdmin() ? `<td style="text-align:right;white-space:nowrap"><button data-edit-player="${p.id}">Editar</button>
        <button class="danger" data-del-player="${p.id}">Apagar</button></td>` : ''}</tr>`;
  const table = (list) => `<div class="panel"><table>
      <tr><th class="num">N.º</th><th>Nome</th><th class="num">Clips</th>${isAdmin() ? '<th></th>' : ''}</tr>
      ${list.map(row).join('')}</table></div>`;

  $app.innerHTML = `
    <h1>Jogadores</h1>
    <p class="muted">Os jogadores são associados aos clips quando um administrador os corta. Abre um jogador para ver todos os clips dele.</p>
    <h2>${CLUB}</h2>
    ${own.length ? table(own) : '<div class="empty">Ainda não há jogadores do clube.</div>'}
    ${isAdmin() ? `
    <form id="new-player" class="panel grid-form" style="margin-top:.75rem">
      <div><label for="np-name">Nome</label><input id="np-name" name="name" required></div>
      <div><label for="np-number">N.º camisola</label><input id="np-number" name="number" type="number" min="0" max="99"></div>
      <div style="align-self:end"><button class="primary">Adicionar jogador do ${CLUB}</button></div>
    </form>` : ''}
    <h2>Adversários</h2>
    ${clubs.length ? clubs.map((c) => `<h3 class="month">${esc(c)}</h3>${table(players.filter((p) => p.club === c))}`).join('')
      : '<div class="empty">Os jogadores adversários aparecem aqui quando forem associados a um clip.</div>'}`;

  if (!isAdmin()) return;
  document.getElementById('new-player').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (await attempt(() => api('POST', '/players', { ...fd, club: '' }))) { toast('Jogador adicionado.'); route(); }
  });
  $app.querySelectorAll('[data-edit-player]').forEach((b) => b.onclick = async () => {
    const p = players.find((x) => x.id === Number(b.dataset.editPlayer));
    const name = await askText('Nome do jogador:', p.name);
    if (name === null) return;
    const number = await askText('Número da camisola (deixa vazio se não souberes):', p.number ?? '', 'number');
    if (number === null) return;
    if (await attempt(() => api('PATCH', `/players/${p.id}`, { name: name || p.name, number, club: p.club }))) { toast('Jogador atualizado.'); route(); }
  });
  $app.querySelectorAll('[data-del-player]').forEach((b) => b.onclick = async () => {
    const p = players.find((x) => x.id === Number(b.dataset.delPlayer));
    if (!await ask(`Apagar ${p.name}? Os clips continuam, só perdem esta etiqueta.`)) return;
    if (await attempt(() => api('DELETE', `/players/${p.id}`))) { toast('Jogador apagado.'); route(); }
  });
}

async function viewPlayer(id) {
  const p = await api('GET', `/players/${id}`);
  $app.innerHTML = `
    <div class="small muted"><a href="#/players">Jogadores</a> ›</div>
    <h1>${p.number != null ? `<span class="muted">${p.number}</span> ` : ''}${esc(p.name)}</h1>
    <div class="row spread">
      <div class="muted small">${esc(p.club || CLUB)} · ${p.videos.length} clip${p.videos.length === 1 ? '' : 's'}</div>
      ${isAdmin() && p.videos.length > 1 ? '<button id="join-player">🎞 Juntar os clips deste jogador</button>' : ''}
    </div>
    ${p.videos.length ? `<div class="cards" style="margin-top:1rem">${p.videos.map((v) => `
      <a class="card" href="#/video/${v.id}">
        <div class="thumb" ${v.has_thumb ? `style="background-image:url('${thumbUrl(v)}')"` : ''}>${v.has_thumb ? '' : '⏳'}
          ${v.duration ? `<span class="dur">${fmtDuration(v.duration)}</span>` : ''}</div>
        <div class="body">
          <div style="font-weight:600">${esc(v.title)}</div>
          <div class="small muted">${fmtDate(v.date)} · vs ${esc(v.opponent)}</div>
          ${playerChips(v.players)}
        </div>
      </a>`).join('')}</div>` : '<div class="empty">Ainda não há clips com este jogador.</div>'}`;
  const joinBtn = document.getElementById('join-player');
  if (joinBtn) {
    // Do mais antigo para o mais recente: um resumo da época do jogador.
    joinBtn.onclick = () => openJoin(p.videos.filter((v) => v.status === 'ready').slice().reverse(),
      `player:${p.id}`, `${p.name}: resumo`);
  }
}

// ---------------------------------------------------------------------------
// Juntar vídeos (admins): escolher, ordenar e criar um vídeo novo
// ---------------------------------------------------------------------------

function openJoin(items, source = '', title = '') {
  const known = new Set(state.join.items.map((i) => i.id));
  state.join.items.push(...items.filter((i) => !known.has(i.id)));
  state.join.source = source || state.join.source;
  if (title && !state.join.title) state.join.title = title;
  location.hash = '#/join';
}

async function viewJoin() {
  if (!isAdmin()) { $app.innerHTML = '<div class="empty">Só para administradores.</div>'; return; }
  const [games, players] = await Promise.all([api('GET', '/games'), api('GET', '/players')]);
  const join = state.join;
  if (!join.source && games[0]) join.source = `game:${games[0].id}`;

  $app.innerHTML = `
    <div class="small muted"><a href="#/">Biblioteca</a> ›</div>
    <h1>Juntar vídeos</h1>
    <p class="muted">Escolhe os vídeos ou clips pela ordem em que devem aparecer. Fica um vídeo novo e os originais não mudam.</p>
    <div class="join-wrap">
      <section class="panel stack">
        <div class="row spread"><strong>Sequência</strong><span class="small muted" id="j-total"></span></div>
        <ol class="join-list" id="j-list"></ol>
        <div><label for="j-title">Título do vídeo novo</label>
          <input id="j-title" value="${esc(join.title || '')}" placeholder="ex.: Golos 1.ª volta, Resumo do jogo"></div>
        <div><label for="j-game">Guardar no jogo</label><select id="j-game">
          <option value="">O jogo do primeiro vídeo</option>
          ${games.map((g) => `<option value="${g.id}">${fmtDate(g.date)} vs ${esc(g.opponent)}</option>`).join('')}
        </select></div>
        <div class="row spread">
          <button type="button" id="j-clear" class="link">Limpar</button>
          <button class="primary" id="j-go">🎞 Juntar</button>
        </div>
      </section>
      <section class="stack">
        <div class="row"><label for="j-source" style="margin:0">Adicionar de</label>
          <select id="j-source" style="flex:1;width:auto">
            <optgroup label="Jogos">${games.map((g) => `<option value="game:${g.id}">${fmtDate(g.date)} vs ${esc(g.opponent)}</option>`).join('')}</optgroup>
            ${players.length ? `<optgroup label="Jogadores">${players.map((p) => `<option value="player:${p.id}">${esc(playerLabel(p))}${p.club ? ` (${esc(p.club)})` : ''}</option>`).join('')}</optgroup>` : ''}
          </select></div>
        <div id="j-results" class="join-results"></div>
      </section>
    </div>`;

  const $list = document.getElementById('j-list');
  const $results = document.getElementById('j-results');
  const $source = document.getElementById('j-source');
  if (join.source) $source.value = join.source;
  let results = [];

  const thumbStyle = (v) => (v.has_thumb ? `style="background-image:url('${thumbUrl(v)}')"` : '');
  const renderList = () => {
    const total = join.items.reduce((n, v) => n + (v.duration || 0), 0);
    document.getElementById('j-total').textContent = join.items.length
      ? `${join.items.length} vídeo${join.items.length === 1 ? '' : 's'} · ${fmtDuration(total)}` : '';
    $list.innerHTML = join.items.length ? join.items.map((v, i) => `
      <li class="join-item">
        <div class="thumb mini" ${thumbStyle(v)}></div>
        <div class="join-text"><div class="join-title">${esc(v.title)}</div>
          <div class="small muted">${v.date ? `${fmtDate(v.date)} vs ${esc(v.opponent)} · ` : ''}${fmtDuration(v.duration)}</div></div>
        <div class="join-actions">
          <button type="button" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Subir">↑</button>
          <button type="button" data-down="${i}" ${i < join.items.length - 1 ? '' : 'disabled'} aria-label="Descer">↓</button>
          <button type="button" data-rm="${i}" aria-label="Tirar">✕</button>
        </div>
      </li>`).join('') : '<li class="small muted">Ainda não escolheste nenhum vídeo. Adiciona-os a partir da lista de vídeos.</li>';
    document.getElementById('j-go').disabled = join.items.length < 2;
    $list.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => move(Number(b.dataset.up), -1));
    $list.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => move(Number(b.dataset.down), 1));
    $list.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { join.items.splice(Number(b.dataset.rm), 1); renderAll(); });
  };
  const move = (i, d) => {
    const [it] = join.items.splice(i, 1);
    join.items.splice(i + d, 0, it);
    renderAll();
  };
  const renderResults = () => {
    $results.innerHTML = results.length ? results.map((v, i) => {
      const added = join.items.some((x) => x.id === v.id);
      return `<div class="join-item">
        <div class="thumb mini" ${thumbStyle(v)}></div>
        <div class="join-text"><div class="join-title">${esc(v.title)}</div>
          <div class="small muted">${fmtDate(v.date)} vs ${esc(v.opponent)} · ${fmtDuration(v.duration)}</div>
          ${playerChips(v.players)}</div>
        <button type="button" data-add="${i}" ${added ? 'disabled' : ''}>${added ? '✓ Na sequência' : '+ Adicionar'}</button>
      </div>`;
    }).join('') : '<div class="empty">Sem vídeos prontos aqui.</div>';
    $results.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { join.items.push(results[Number(b.dataset.add)]); renderAll(); });
  };
  const renderAll = () => { renderList(); renderResults(); };

  async function loadSource() {
    join.source = $source.value;
    const [kind, sid] = join.source.split(':');
    if (kind === 'game') {
      const g = await api('GET', `/games/${sid}`);
      results = g.videos.map((v) => ({ ...v, date: g.date, opponent: g.opponent }));
    } else if (kind === 'player') {
      results = (await api('GET', `/players/${sid}`)).videos;
    } else {
      results = [];
    }
    results = results.filter((v) => v.status === 'ready');
    renderResults();
  }
  $source.onchange = loadSource;
  document.getElementById('j-title').oninput = (e) => { join.title = e.target.value; };
  document.getElementById('j-clear').onclick = () => { join.items = []; join.title = ''; document.getElementById('j-title').value = ''; renderAll(); };
  document.getElementById('j-go').onclick = async () => {
    const r = await attempt(() => api('POST', '/videos/concat', {
      video_ids: join.items.map((v) => v.id),
      title: document.getElementById('j-title').value,
      game_id: Number(document.getElementById('j-game').value) || undefined,
    }));
    if (!r) return;
    state.join = { items: [], source: join.source, title: '' };
    toast('A juntar os vídeos. Podes sair desta página: o processamento continua no servidor.');
    location.hash = `#/video/${r.videoId}`;
  };

  renderList();
  await loadSource();
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
    <div class="small muted"><a href="#/">Biblioteca</a> ›
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
        ${v.players.length ? `<div class="row small" style="margin-top:.6rem;gap:.4rem"><span class="muted">Jogadores:</span>${playerChips(v.players, true)}</div>` : ''}
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

  const [allGames, allPlayers] = await Promise.all([api('GET', '/games'), api('GET', '/players')]);
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
      <input id="clip-title" placeholder="Título do clip (ex.: Golo 15', Defesa, Contra-ataque)">
      <div><label>Jogadores no clip</label><div id="clip-players"></div></div>
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
      <div class="row"><button type="button" id="join-this" ${ready ? '' : 'disabled'}>🎞 Juntar com outros vídeos</button></div>
      <div class="small muted">Comprimir para 720p reduz muito o tamanho de jogos gravados em 4K/1080p.</div>
    </div>

    <form class="panel stack" id="meta">
      <strong>📝 Detalhes</strong>
      <div><label>Título</label><input name="title" value="${esc(v.title)}" required></div>
      <div><label>Jogo</label><select name="game_id">
        ${allGames.map((g) => `<option value="${g.id}" ${g.id === v.game_id ? 'selected' : ''}>${fmtDate(g.date)} vs ${esc(g.opponent)}</option>`).join('')}
      </select></div>
      <div><label>Jogadores</label><div id="video-players"></div></div>
      <div class="row spread"><button class="primary">Guardar</button><button type="button" class="danger" id="del">Apagar vídeo</button></div>
    </form>

    <details class="panel"><summary>Histórico de edições</summary>
      ${v.jobs.length ? `<table class="small">${v.jobs.map((j) => `<tr><td>${JOB_LABEL[j.type] || j.type}</td><td>${STATUS_PILL[j.status]}</td>
        <td class="muted">${esc((j.finished_at || j.created_at || '').replace('T', ' ').slice(0, 16))}</td></tr>
        ${j.error ? `<tr><td colspan="3" style="color:var(--err)">${esc(j.error)}</td></tr>` : ''}`).join('')}</table>` : '<p class="muted small">Sem edições.</p>'}
    </details>`;

  const clipPicker = playerPicker(document.getElementById('clip-players'), { opponent: game.opponent, all: allPlayers });
  const videoPicker = playerPicker(document.getElementById('video-players'), { opponent: game.opponent, all: allPlayers, selected: v.players });

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
    const playerIds = mode === 'clip' ? await attempt(() => clipPicker.ids()) : [];
    if (!playerIds) return;
    submitEdit('trim', { start, end, mode, precise: document.getElementById('precise').checked,
      title: document.getElementById('clip-title').value, playerIds });
  };

  $side.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
    const op = b.dataset.op;
    if (op === 'rotate') return submitEdit('rotate', { degrees: Number(b.dataset.deg) });
    if (op === 'mute') return await ask('Remover o áudio deste vídeo?') && submitEdit('mute', {});
    if (op === 'compress') return submitEdit('compress', { height: Number(document.getElementById('c-height').value) });
  }));

  document.getElementById('join-this').onclick = () =>
    openJoin([{ ...v, date: game.date, opponent: game.opponent, has_thumb: true }], `game:${game.id}`);

  // --- Metadados
  document.getElementById('meta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const saved = await attempt(async () => {
      await api('PATCH', `/videos/${id}`, { title: fd.title, game_id: Number(fd.game_id) });
      await api('PUT', `/videos/${id}/players`, { player_ids: await videoPicker.ids() });
      return true;
    });
    if (saved) { toast('Guardado.'); route(); }
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
  if (!isAdmin()) { $app.innerHTML = '<div class="empty">Só os administradores podem carregar vídeos.</div>'; return; }
  const games = await api('GET', '/games');
  const preset = games.find((g) => g.id === presetGameId);

  $app.innerHTML = `
    <h1>Carregar vídeos</h1>
    <p class="muted">Os vídeos são enviados em blocos: se a internet falhar o envio continua sozinho, e podes pausar e retomar.
      Não feches o separador até terminar (podes navegar na aplicação).</p>
    <div class="panel stack">
      <strong>1. A que jogo pertence?</strong>
      <div><label for="u-game">Jogo</label><select id="u-game"></select></div>
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

  const $game = document.getElementById('u-game');
  const $newGame = document.getElementById('new-game');
  const fillGames = (selectId) => {
    const tg = games;
    $game.innerHTML = `<option value="new">➕ Novo jogo…</option>${tg.map((g) =>
      `<option value="${g.id}" ${g.id === selectId ? 'selected' : ''}>${fmtDate(g.date)} vs ${esc(g.opponent)}${g.competition ? ` (${esc(g.competition)})` : ''}</option>`).join('')}`;
    if (!selectId && tg.length && tg[0].date === today()) $game.value = tg[0].id;
    $newGame.hidden = $game.value !== 'new';
  };
  fillGames(preset?.id);
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
      const body = Object.fromEntries(new FormData($newGame));
      const r = await attempt(() => api('POST', '/games', body));
      if (!r) return;
      gameId = r.id;
      gameLabel = `${fmtDate(body.date)} vs ${body.opponent}`;
    }
    for (const p of picked) {
      state.uploads.push({ file: p.file, title: p.title || p.file.name, gameId: Number(gameId),
        gameLabel, status: 'waiting', sent: 0, total: p.file.size });
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
  if (!isAdmin()) { $app.innerHTML = '<div class="empty">Só para administradores.</div>'; return; }
  const jobs = await api('GET', '/jobs');
  $app.innerHTML = `
    <h1>Processamento</h1>
    <p class="muted">Depois do envio, cada vídeo é convertido para um formato que reproduz em qualquer browser/telemóvel.
      As edições também aparecem aqui. Corre um trabalho de cada vez.</p>
    ${jobs.length ? `<div class="panel"><table>
      <tr><th>Vídeo</th><th>Operação</th><th>Estado</th><th style="width:30%">Progresso</th></tr>
      ${jobs.map((j) => `<tr>
        <td><a href="#/video/${j.video_id}">${esc(j.title)}</a>
          <div class="small muted">${fmtDate(j.date)} vs ${esc(j.opponent)}</div></td>
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
    <p class="muted">${teams.reduce((n, t) => n + t.games, 0)} jogos · ${teams.reduce((n, t) => n + t.videos, 0)} vídeos ·
      ${fmtBytes(teams.reduce((n, t) => n + t.bytes, 0))} ocupados</p>

    <h2>Utilizadores</h2>
    <div class="panel stack">
      <table>
        <tr><th>Nome</th><th>Email</th><th>Perfil</th><th></th></tr>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
          <td><select data-role="${u.id}" style="width:auto">
            <option value="member" ${u.role === 'member' ? 'selected' : ''}>Membro (só ver)</option>
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
