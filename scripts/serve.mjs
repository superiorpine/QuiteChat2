import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, extname, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
function option(name, fallback) {
  const direct = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const port = Number(option('port', '4173'));
const base = option('base', '/');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535');
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('Base must be / or /RepositoryName/');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const canonicalRoot = await realpath(root);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base) || pathname.includes('\\') || pathname.includes('\0')) { response.writeHead(404).end(); return; }
    const local = pathname.slice(base.length) || 'index.html';
    const path = resolve(root, local);
    const inside = relative(root, path);
    if (inside.startsWith(`..${sep}`) || inside === '..' || resolve(root, inside) !== path) { response.writeHead(404).end(); return; }
    const canonical = await realpath(path);
    if (!canonical.startsWith(canonicalRoot + sep) || !(await stat(canonical)).isFile()) { response.writeHead(404).end(); return; }
    const bytes = await readFile(canonical);
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.setHeader('Content-Length', bytes.length);
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404).end(); }
});
// Loopback only; no request logging and no uploaded/posted content handling.
server.listen(port, '127.0.0.1', () => console.log(`QuietChat preview: http://127.0.0.1:${port}${base}`));
