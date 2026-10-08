# 🤾 Videoteca Andebol

Plataforma web para guardar os vídeos dos jogos da equipa.

- **Uploads de ficheiros pesados.** O browser envia os vídeos em blocos de 50 MB através do
  protocolo [tus](https://tus.io). Se a internet falhar, o envio retoma sozinho. Também se pode
  pausar e retomar, e um ficheiro escolhido de novo continua de onde parou.
- **Etiqueta do jogo no upload.** Escolhe-se a equipa e o jogo (data + adversário). Se o jogo
  ainda não existir, cria-se no próprio ecrã de upload.
- **Biblioteca agrupada por equipa → jogo**, ordenada por data (ex.: *Seniores › 08/10/2026 vs ABC Braga*),
  com pesquisa por adversário, competição ou data.
- **Reprodução direta no browser e no telemóvel.** Pode-se saltar para qualquer minuto sem
  descarregar o jogo inteiro.
- **Edição na plataforma para admins:**
  - ✂️ cortar e guardar como **novo clip** (ex.: "Golo 15'"), mantendo o original, ou substituir o original;
  - corte rápido (sem perda, sem recodificar) ou preciso ao frame;
  - ↻ rodar 90° / 180° / 270°;
  - 🔇 remover o som;
  - 🗜 comprimir para 1080p / 720p / 480p (um jogo em 4K passa de dezenas de GB para poucos GB);
  - mudar o título, mudar o vídeo de jogo e apagar.
- **Perfis:** *Admin* edita, apaga e gere equipas e utilizadores. *Membro* vê, descarrega,
  carrega vídeos e cria jogos.

## Como funciona

```
Browser ──(tus, blocos de 50 MB)──▶ /api/uploads ──▶ data/uploads/   (ficheiro bruto)
                                                       │
                                     fila de trabalhos (ffmpeg, 1 de cada vez)
                                                       ▼
                                     data/videos/*.mp4  (H.264/AAC, "faststart")
                                     data/thumbs/*.jpg
Browser ◀──(HTTP Range / streaming)── /api/videos/:id/stream
```

- Depois do upload, cada vídeo é convertido para MP4 H.264/AAC, que reproduz em qualquer browser.
  Se já vier em H.264 (o caso da maioria das câmaras e telemóveis), o ffmpeg só reorganiza o
  ficheiro: é muito rápido e não perde qualidade. Formatos como `.mts`, `.avi` ou HEVC são recodificados.
- As edições correm no servidor, numa fila. Pode-se fechar a página e o vídeo atual continua
  visível até a nova versão estar pronta.
- A base de dados é SQLite (`data/videoteca.db`). Os vídeos ficam em ficheiros no disco.
- Stack: Node.js 22 + Express, `@tus/server`, ffmpeg. A frontend é JavaScript simples, sem passo de build.

## Instalar (Docker, recomendado)

Precisas de um servidor ou PC sempre ligado com Docker e um **disco grande**. Conta com 2–10 GB
por jogo, conforme a câmara. Um mini-PC, um NAS (Synology/QNAP com Docker) ou uma VPS servem.

```bash
cd videoteca
cp .env.example .env        # edita o email/password do admin
docker compose up -d --build
```

Abre `http://IP-DO-SERVIDOR:3000` e entra com o admin definido no `.env`. Depois:

1. **Administração → Equipas**: cria as equipas (Seniores, Juniores, …).
2. **Administração → Utilizadores**: cria contas para treinadores e jogadores (Membro ou Admin).
3. **Carregar**: escolhe a equipa e o jogo (ou cria-o com a data e o adversário) e arrasta os vídeos.

Para guardar os vídeos noutro disco, muda o volume no `docker-compose.yml`, por exemplo
`- /mnt/disco-videos:/data`.

### Acesso pela internet com HTTPS

Com um domínio (ex.: `videos.meuclube.pt`) a apontar para o servidor e as portas 80/443 abertas:

```bash
# no .env
DOMAIN=videos.meuclube.pt
SECURE_COOKIES=true
TRUST_PROXY=1

docker compose --profile https up -d --build
```

O Caddy trata do certificado automaticamente. Os uploads em blocos de 50 MB também passam por
proxies com limite de tamanho por pedido, como o Cloudflare (limite de 100 MB).

### Link público sem abrir portas (Cloudflare Tunnel)

Serve para um PC ou NAS no clube ou em casa, sem mexer no router.

1. Cria uma conta gratuita na Cloudflare e adiciona o teu domínio.
2. Em **Zero Trust → Networks → Tunnels**, cria um túnel e copia o token.
3. Em *Public Hostname*, aponta `videos.meuclube.pt` para `http://videoteca:3000`.
4. No `.env`, define `TUNNEL_TOKEN=...`, `SECURE_COOKIES=true` e `TRUST_PROXY=1`.
5. Corre `docker compose --profile tunnel up -d --build`.

Os blocos de upload de 50 MB ficam abaixo do limite de 100 MB por pedido da Cloudflare.

Para um teste rápido sem domínio, corre `cloudflared tunnel --url http://localhost:3000`.
Isto dá um link `https://….trycloudflare.com` temporário, que muda sempre que o comando é reiniciado.

## Correr sem Docker

Requer Node.js ≥ 22.13 e `ffmpeg`/`ffprobe` no PATH.

```bash
cd videoteca
npm install
ADMIN_EMAIL=admin@clube.pt ADMIN_PASSWORD=uma-password-forte npm start
# http://localhost:3000
```

Testes ponta-a-ponta (arranca o servidor, faz uploads reais e testa todas as edições):

```bash
npm test
```

## Configuração (variáveis de ambiente)

| Variável         | Por omissão              | Descrição |
|------------------|--------------------------|-----------|
| `PORT`           | `3000`                   | Porta HTTP |
| `DATA_DIR`       | `./data`                 | Pasta da base de dados, vídeos, miniaturas e uploads em curso |
| `ADMIN_EMAIL`    | `admin@clube.pt`         | Admin criado no 1.º arranque (só se não houver utilizadores) |
| `ADMIN_PASSWORD` | `mudar-esta-password`    | Password desse admin. **Muda-a.** |
| `MAX_UPLOAD_GB`  | `50`                     | Tamanho máximo por ficheiro |
| `X264_PRESET`    | `veryfast`               | Velocidade de recodificação (mais lento = ficheiros mais pequenos) |
| `SESSION_DAYS`   | `30`                     | Duração das sessões |
| `SECURE_COOKIES` | `false`                  | `true` quando servido por HTTPS |
| `TRUST_PROXY`    | `0`                      | Nº de proxies reversos à frente (ex.: `1` com Caddy) |

## Cópias de segurança

Tudo o que importa está em `DATA_DIR`. Para copiar com a app a correr:

```bash
sqlite3 data/videoteca.db ".backup data/backup.db"   # base de dados consistente
rsync -a data/videos data/thumbs data/backup.db destino:/backups/videoteca/
```

## API (resumo)

Todas as rotas exigem sessão (cookie), exceto `POST /api/login`.

| Método | Rota | Quem |
|---|---|---|
| `GET` | `/api/teams`, `/api/games?team_id=&q=`, `/api/games/:id` | todos |
| `POST` | `/api/games` | todos |
| `POST/PATCH/HEAD` | `/api/uploads[/:id]` (tus) | todos |
| `GET` | `/api/videos/:id`, `/stream`, `/download`, `/thumb` | todos |
| `POST` | `/api/videos/:id/edit` `{type: trim\|rotate\|mute\|compress, params}` | admin |
| `PATCH/DELETE` | `/api/videos/:id`, `/api/games/:id`, `/api/teams/:id` | admin |
| `GET/POST/PATCH/DELETE` | `/api/users` | admin |
| `GET` | `/api/jobs` | todos |
