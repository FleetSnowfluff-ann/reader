import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function serve(port = 4173, basePath = '/') {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!pathname.startsWith(basePath)) throw new Error('not found');
      const relative = '/' + pathname.slice(basePath.length);
      const file = path.resolve(root, '.' + (relative.endsWith('/') ? relative + 'index.html' : relative));
      if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error('not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return server.listen(port, '127.0.0.1');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve(Number(process.env.PORT || 4173)).on('listening', () => console.log('Reader server listening on port ' + (process.env.PORT || 4173)));
