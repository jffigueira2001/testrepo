import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  videosDir: path.join(dataDir, 'videos'),
  thumbsDir: path.join(dataDir, 'thumbs'),
  dbFile: path.join(dataDir, 'videoteca.db'),
  // Tamanho máximo por ficheiro (GB). Jogos completos em 4K podem passar facilmente os 20 GB.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_GB || 50) * 1024 ** 3,
  // Conta de admin criada no primeiro arranque se ainda não existir nenhum utilizador.
  adminEmail: process.env.ADMIN_EMAIL || 'admin@clube.pt',
  adminPassword: process.env.ADMIN_PASSWORD || 'mudar-esta-password',
  // Duração das sessões (dias).
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  // Atrás de HTTPS (proxy reverso) os cookies devem ser "Secure".
  secureCookies: process.env.SECURE_COOKIES === 'true',
  // Preset do x264 quando é preciso recodificar (ultrafast..veryslow). Mais lento = ficheiros mais pequenos.
  x264Preset: process.env.X264_PRESET || 'veryfast',
  // Nº de proxies reversos à frente da app (ex.: 1 com Caddy/Nginx). 0 = acesso direto.
  trustProxy: Number(process.env.TRUST_PROXY || 0),
};
