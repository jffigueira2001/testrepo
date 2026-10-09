// Imitação mínima da API do Google Drive v3 usada pela videoteca (só para testes).
import http from 'node:http';

export function startFakeDrive() {
  const files = new Map(); // id -> { id, name, mimeType, parents, trashed, data }
  const sessions = new Map(); // sid -> { meta, size, chunks: Buffer[], received }
  let seq = 0;
  const stats = { chunkPuts: 0, rangeGets: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/token') return json(200, { access_token: 'tok', expires_in: 3600 });

    const sess = url.pathname.match(/^\/session\/(\w+)$/);
    if (sess && req.method === 'PUT') {
      const s = sessions.get(sess[1]);
      const m = String(req.headers['content-range']).match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (m) {
        stats.chunkPuts++;
        if (Number(m[1]) !== s.received) return json(400, { error: { message: 'offset errado' } });
        s.chunks.push(body);
        s.received += body.length;
      }
      if (s.received < s.size) { res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}` } : {}); return res.end(); }
      const id = `f${++seq}`;
      files.set(id, { id, name: s.meta.name, mimeType: 'video/mp4', parents: s.meta.parents, trashed: false, data: Buffer.concat(s.chunks) });
      return json(200, { id });
    }

    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: { message: 'sem auth' } });

    if (url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
      const sid = `s${++seq}`;
      sessions.set(sid, { meta: JSON.parse(body), size: Number(req.headers['x-upload-content-length']), chunks: [], received: 0 });
      res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session/${sid}` });
      return res.end();
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const m = String(url.searchParams.get('q')).match(/'([^']+)' in parents and trashed = false/);
      if (!m) return json(400, { error: { message: 'q não suportado' } });
      const list = [...files.values()].filter((f) => f.parents?.includes(m[1]) && !f.trashed)
        .map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.data ? String(f.data.length) : undefined }));
      return json(200, { files: list });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body);
      const id = `d${++seq}`;
      files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || ['root'], trashed: false });
      return json(200, { id });
    }
    const one = url.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
    if (one) {
      const f = files.get(one[1]);
      if (!f) return json(404, { error: { message: 'File not found' } });
      if (req.method === 'PATCH') {
        const meta = body.length ? JSON.parse(body) : {};
        if (meta.name !== undefined) f.name = meta.name;
        if (meta.trashed !== undefined) f.trashed = meta.trashed;
        const rm = url.searchParams.get('removeParents');
        if (rm) f.parents = f.parents.filter((p) => !rm.split(',').includes(p));
        const add = url.searchParams.get('addParents');
        if (add) f.parents.push(add);
        return json(200, { id: f.id, parents: f.parents });
      }
      if (url.searchParams.get('alt') === 'media') {
        const total = f.data.length;
        const m = String(req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
        if (!m) { res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4' }); return res.end(f.data); }
        stats.rangeGets++;
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= total) { res.writeHead(416); return res.end(); }
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Type': 'video/mp4' });
        return res.end(f.data.subarray(start, end + 1));
      }
      return json(200, { id: f.id, name: f.name, parents: f.parents, trashed: f.trashed, size: String(f.data?.length || 0) });
    }
    json(404, { error: { message: `rota desconhecida ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, files, stats, close: () => server.close(),
    /** Simula um ficheiro/pasta posto diretamente no Drive pelo utilizador (sem passar pela plataforma). */
    add({ name, parent = 'root', data = null, mimeType }) {
      const id = `u${++seq}`;
      files.set(id, { id, name, parents: [parent], trashed: false, data,
        mimeType: mimeType || (data ? 'video/mp4' : 'application/vnd.google-apps.folder') });
      return id;
    },
    /** Caminho legível de um ficheiro: "Videoteca Andebol/Seniores/2026-10-08 vs ABC/x.mp4" */
    pathOf(id) {
      const parts = [];
      for (let f = files.get(id); f; f = files.get(f.parents?.[0])) parts.unshift(f.name);
      return parts.join('/');
    },
  })));
}
