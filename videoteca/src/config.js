import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  // Com STORAGE=local guarda aqui os vídeos; com STORAGE=drive é só espaço de trabalho temporário.
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
  // Onde ficam os vídeos finais: 'local' (disco do servidor) ou 'drive' (Google Drive).
  storage: process.env.STORAGE === 'drive' ? 'drive' : 'local',
  drive: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    // Pasta raiz no Drive (criada automaticamente se não for indicada).
    rootFolderId: process.env.DRIVE_FOLDER_ID || '',
    rootFolderName: process.env.DRIVE_FOLDER_NAME || 'Videoteca CDE Camões',
    // Tamanho de cada bloco no envio para o Drive (MB, múltiplo de 0.25).
    chunkMb: Number(process.env.DRIVE_CHUNK_MB || 64),
    // Configuráveis só para testes.
    apiBase: process.env.DRIVE_API_BASE || 'https://www.googleapis.com',
    uploadBase: process.env.DRIVE_UPLOAD_BASE || 'https://www.googleapis.com',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  },
};

if (config.storage === 'drive') {
  const missing = ['clientId', 'clientSecret', 'refreshToken'].filter((k) => !config.drive[k]);
  if (missing.length) {
    console.error('STORAGE=drive requer GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN (ver README: "Guardar os vídeos no Google Drive").');
    process.exit(1);
  }
}
