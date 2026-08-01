import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DOCS_DIR } from './config.mjs';

const port = Number(process.env.PORT || 4173);
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const decoded = decodeURIComponent(url.pathname);
    let target = path.resolve(DOCS_DIR, `.${decoded}`);
    if (!target.startsWith(path.resolve(DOCS_DIR))) throw new Error('Invalid path');
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) target = path.join(target, 'index.html');
    const finalStat = await fs.stat(target).catch(() => null);
    if (!finalStat?.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Forge archive preview: http://127.0.0.1:${port}/`);
});

