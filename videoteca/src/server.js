import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadUser, requireAuth, ensureAdmin } from './auth.js';
import { api } from './api.js';
import { tusServer } from './upload.js';
import { startQueue } from './media.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(loadUser);

// Uploads retomáveis (tus). Tem de vir antes de qualquer parser de corpo.
app.all(['/api/uploads', '/api/uploads/*rest'], requireAuth, (req, res) => tusServer.handle(req, res));

app.use('/api', api);

app.use('/vendor/tus.min.js', (_req, res) =>
  res.sendFile(path.join(root, 'node_modules/tus-js-client/dist/tus.min.js')));
app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));
// SPA: qualquer outra rota devolve a aplicação.
app.get('/*rest', (_req, res) => res.sendFile(path.join(root, 'public/index.html')));

ensureAdmin();
startQueue();

app.listen(config.port, () => {
  console.log(`Videoteca a correr em http://localhost:${config.port} (dados em ${config.dataDir})`);
});
