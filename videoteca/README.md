# Videoteca CDE Camões

Plataforma web para guardar os vídeos dos jogos da equipa.

- **Uploads de ficheiros pesados.** O browser envia os vídeos em blocos de 50 MB através do
  protocolo [tus](https://tus.io). Se a internet falhar, o envio retoma sozinho. Também se pode
  pausar e retomar, e um ficheiro escolhido de novo continua de onde parou.
- **Etiqueta do jogo no upload.** Escolhe-se o jogo (data + adversário). Se o jogo ainda não
  existir, cria-se no próprio ecrã de upload. A equipa é sempre a sénior, por isso não se escolhe escalão.
- **Biblioteca por jogo**, agrupada por mês (ex.: *08/10/2026 vs ABC Braga*), com pesquisa por
  adversário, jogador, competição ou data.
- **Jogadores nos clips.** Ao cortar um clip, o admin associa-lhe um ou mais jogadores, do
  CDE Camões ou do adversário desse jogo. Escreve-se o nome ou o número, e os jogadores novos
  são criados na hora. Na página **Jogadores**, cada jogador tem todos os seus clips de todos os jogos.
- **Reprodução direta no browser e no telemóvel.** Pode-se saltar para qualquer minuto sem
  descarregar o jogo inteiro.
- **Edição na plataforma para admins:**
  - ✂️ cortar e guardar como **novo clip** (ex.: "Golo 15'"), mantendo o original, ou substituir o original;
  - corte rápido (sem perda, sem recodificar) ou preciso ao frame;
  - ↻ rodar 90° / 180° / 270°;
  - 🔇 remover o som;
  - 🎞 **juntar** vários vídeos ou clips num vídeo novo, pela ordem escolhida (ex.: resumo de um jogo, ou todos os
    clips de um jogador na época). Se os clips tiverem o mesmo formato, a junção é rápida e sem perda de qualidade.
    Se não tiverem, tudo é ajustado ao formato do primeiro. O vídeo novo herda os jogadores dos clips usados;
  - 🗜 comprimir para 1080p / 720p / 480p (um jogo em 4K passa de dezenas de GB para poucos GB);
  - mudar o título, mudar o vídeo de jogo e apagar.
- **Vídeos no disco do servidor ou no Google Drive.** Com o Google Drive, os vídeos ficam
  organizados em pastas `Videoteca CDE Camões / AAAA-MM-DD vs Adversário`. O servidor só
  precisa de espaço temporário.
- **Acesso só com conta aprovada.** Qualquer pessoa pode pedir conta em "Pedir acesso", mas só
  entra e vê os vídeos depois de um administrador a aprovar (Administração → Pedidos de acesso).
  Os admins também podem suspender o acesso de alguém a qualquer momento.
- **Perfis:** *Admin* edita e apaga vídeos, associa jogadores e gere utilizadores. *Membro* vê, descarrega,
  carrega vídeos e cria jogos.

## Logo e cores do clube

- **Logo:** substitui `public/logo.svg` pelo emblema do clube. Se o ficheiro for PNG, guarda-o
  como `public/logo.png` e troca `logo.svg` por `logo.png` em `public/index.html` e `public/app.js`.
- **Cores:** muda `--accent` (cor principal) e `--accent-ink` (texto sobre a cor principal) no topo
  de `public/styles.css`.

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
- A base de dados é SQLite (`data/videoteca.db`). Os vídeos finais ficam no disco
  (`data/videos/`) ou no Google Drive (`STORAGE=drive`, ver abaixo).
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

1. **Administração → Utilizadores**: cria contas para treinadores e jogadores (Membro ou Admin),
   ou deixa-os pedir acesso e aprova os pedidos.
2. **Carregar**: escolhe o jogo (ou cria-o com a data e o adversário) e arrasta os vídeos.
3. **Jogadores**: opcionalmente, adiciona o plantel com os números das camisolas.

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

⚠️ Os termos da Cloudflare restringem servir vídeo através da rede gratuita deles, e um túnel
público conta para isso. Para uso pequeno e privado é uma zona cinzenta. Como solução
permanente, prefere abrir as portas 80/443 com o Caddy (secção anterior), por exemplo com um
subdomínio gratuito do [DuckDNS](https://www.duckdns.org).

## Guardar os vídeos no Google Drive

Com `STORAGE=drive`, cada vídeo é enviado para o Google Drive da conta do clube depois de
processado, e a cópia local é apagada. As funcionalidades da plataforma mantêm-se todas.

```
Browser ──upload──▶ servidor (ffmpeg: converte, miniatura) ──▶ Google Drive
Browser ◀──vídeo (Range)── servidor ◀──────────────────────── Google Drive
```

- **Pastas:** `Videoteca CDE Camões / 2026-10-08 vs ABC Braga / 1.ª parte.mp4`. Renomear
  ou mudar vídeos e jogos na plataforma também muda no Drive.
- **Apagar** na plataforma manda o ficheiro para a **reciclagem** do Drive, onde pode ser
  recuperado durante 30 dias.
- **Edições:** os cortes até 20 minutos leem só o pedaço necessário do Drive. As outras edições
  descarregam o vídeo, processam-no e enviam a nova versão.
- **Acesso da app ao Drive:** só vê os ficheiros que ela própria cria (permissão `drive.file`), não o resto do Drive.
- **Espaço no servidor:** chega um disco com espaço livre para cerca de 3× o maior vídeo
  (ex.: 30–40 GB para jogos de 10 GB), usado durante o upload e as edições.
- **Internet do servidor:** quem vê um vídeo recebe-o através do servidor. A velocidade de envio
  da internet do servidor conta.
- **Vídeos antigos:** os que já estavam no disco antes de mudar para o Drive continuam a funcionar a partir do disco.

### Configurar (uma vez, ~15 minutos)

1. **Espaço no Drive.** Os 15 GB gratuitos dão para 1–2 jogos. Com o Google One de 2 TB cabem
   cerca de 200 jogos de 10 GB, ou muitos mais se forem comprimidos para 720p.
2. **Criar as credenciais** em <https://console.cloud.google.com>, com a conta Google do clube:
   1. Cria um projeto (ex.: "Videoteca").
   2. Em **APIs e serviços → Biblioteca**, ativa a **Google Drive API**.
   3. Em **Ecrã de consentimento OAuth** (ou "Google Auth Platform"):
      - escolhe o tipo *Externo*, preenche o nome e o email;
      - em *Âmbitos*, adiciona `.../auth/drive.file`;
      - em *Público*, carrega em **Publicar app** ("Em produção").
      Se ficar em modo de teste, a ligação expira ao fim de 7 dias.
   4. Em **Credenciais → Criar credenciais → ID de cliente OAuth**, escolhe o tipo **App para
      computador**. Copia o *ID de cliente* e o *Segredo do cliente*.
3. **Autorizar.** Corre isto num computador com browser e Node.js:
   ```bash
   cd videoteca && npm install
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run drive:auth
   ```
   Abre o link que aparece e entra com a conta do clube. Se aparecer o aviso "A Google não
   verificou esta app", carrega em *Avançado → Continuar*: a app é tua. O terminal mostra 4 linhas.
4. **Colar no `.env`** essas linhas (`STORAGE=drive`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REFRESH_TOKEN`) e reiniciar: `docker compose up -d`.

Para a equipa também ver os vídeos diretamente no Drive, partilha a pasta "Videoteca CDE Camões"
com eles, só com permissão de leitura. Não apagues ficheiros diretamente no Drive: faz isso
na plataforma.

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
| `STORAGE`        | `local`                  | `local` (disco) ou `drive` (Google Drive) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | — | Credenciais do Drive (`npm run drive:auth`) |
| `DRIVE_FOLDER_NAME` | `Videoteca CDE Camões`   | Nome da pasta raiz criada no Drive |

## Cópias de segurança

Tudo o que importa está em `DATA_DIR`. Com `STORAGE=drive`, os vídeos já estão no Drive e só é
preciso copiar a base de dados e as miniaturas. Para copiar com a app a correr:

```bash
sqlite3 data/videoteca.db ".backup data/backup.db"   # base de dados consistente
rsync -a data/videos data/thumbs data/backup.db destino:/backups/videoteca/
```

## API (resumo)

Todas as rotas exigem sessão (cookie), exceto `POST /api/login`.

| Método | Rota | Quem |
|---|---|---|
| `GET` | `/api/games?q=`, `/api/games/:id`, `/api/players`, `/api/players/:id` | todos |
| `POST` | `/api/games` | todos |
| `POST/PATCH/HEAD` | `/api/uploads[/:id]` (tus) | todos |
| `GET` | `/api/videos/:id`, `/stream`, `/download`, `/thumb` | todos |
| `POST` | `/api/videos/:id/edit` `{type: trim\|rotate\|mute\|compress, params}` | admin |
| `POST` | `/api/videos/concat` `{video_ids: [...], title, game_id?}` | admin |
| `PATCH/DELETE` | `/api/videos/:id`, `/api/games/:id`, `/api/players/:id` | admin |
| `POST` | `/api/players`; `PUT /api/videos/:id/players` `{player_ids}` | admin |
| `GET/POST/PATCH/DELETE` | `/api/users` | admin |
| `GET` | `/api/jobs` | todos |
