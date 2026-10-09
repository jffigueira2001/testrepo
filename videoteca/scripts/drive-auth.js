// Liga a videoteca à conta Google do clube (corre uma vez, num computador com browser).
// Uso: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run drive:auth
import http from 'node:http';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Define GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (ver README: "Guardar os vídeos no Google Drive").');
  process.exit(1);
}

// drive: acesso ao Drive para ler os vídeos que pões na pasta (ex.: "Camões") e guardar lá os novos.
// Com DRIVE_SCOPE=drive.file a app só vê o que ela própria cria (sem importação da pasta).
const SCOPE = `https://www.googleapis.com/auth/${process.env.DRIVE_SCOPE || 'drive'}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri());
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end(url.searchParams.get('error') || 'Sem código.'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Falhou: ${JSON.stringify(data)}`);
    console.error('Falhou:', data);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Feito! Podes fechar esta janela e voltar ao terminal.');
    console.log('\nAcrescenta isto ao ficheiro .env da videoteca:\n');
    console.log('STORAGE=drive');
    console.log(`GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
    console.log('DRIVE_FOLDER_ID=<id da pasta, ex.: "Camões" — a última parte do endereço da pasta no Drive>\n');
  }
  server.close();
});

const redirectUri = () => `http://127.0.0.1:${server.address().port}`;

server.listen(0, '127.0.0.1', () => {
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
  });
  console.log('Abre este link no browser e entra com a conta Google do clube:\n');
  console.log(auth.toString());
});
