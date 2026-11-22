// Serves the demo job pages in ../demo at http://127.0.0.1:8080 (no dependencies).
// Open http://127.0.0.1:8080/ in Chrome, then use Job Fellow on the page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Demo pages: http://127.0.0.1:${port}/`));
