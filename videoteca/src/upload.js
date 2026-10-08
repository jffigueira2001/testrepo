import path from 'node:path';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { db } from './db.js';
import { config } from './config.js';
import { userFromCookieHeader } from './auth.js';
import { enqueueJob } from './media.js';

/**
 * Uploads retomáveis (protocolo tus): o browser envia o vídeo em blocos e, se a ligação cair
 * ou o separador for fechado, o upload continua de onde parou. Essencial para ficheiros de vários GB.
 */
export const tusServer = new Server({
  path: '/api/uploads',
  datastore: new FileStore({ directory: config.uploadsDir, expirationPeriodInMilliseconds: 7 * 86400_000 }),
  maxSize: config.maxUploadBytes,
  respectForwardedHeaders: config.trustProxy > 0,
  relativeLocation: true,

  async onIncomingRequest(req) {
    const user = userFromCookieHeader(req.headers.get('cookie'));
    if (!user) throw { status_code: 401, body: 'Sessão expirada. Faz login novamente.\n' };
    if (user.role !== 'admin') throw { status_code: 403, body: 'Apenas administradores podem carregar vídeos.\n' };
  },

  async onUploadCreate(_req, upload) {
    const gameId = Number(upload.metadata?.gameId);
    if (!gameId || !db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) {
      throw { status_code: 400, body: 'Jogo inválido: escolhe o jogo antes de carregar.\n' };
    }
    return {};
  },

  async onUploadFinish(req, upload) {
    const user = userFromCookieHeader(req.headers.get('cookie'));
    const meta = upload.metadata || {};
    const originalName = meta.filename || 'video';
    const title = (meta.title || '').trim() || path.parse(originalName).name;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO videos (game_id, title, original_name, status, source_path, size, uploaded_by)
      VALUES (?, ?, ?, 'processing', ?, ?, ?)`)
      .run(Number(meta.gameId), title, originalName, path.join(config.uploadsDir, upload.id),
        upload.size || 0, user?.id ?? null);
    enqueueJob(Number(lastInsertRowid), 'ingest', {}, user?.id ?? null);
    return {};
  },
});

tusServer.on(EVENTS.POST_TERMINATE, (_req, _res, id) => console.log(`[upload] cancelado ${id}`));

// Limpa uploads incompletos abandonados há mais de 7 dias.
setInterval(() => tusServer.cleanUpExpiredUploads().catch(() => {}), 6 * 3600_000).unref();
