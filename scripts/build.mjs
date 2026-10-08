import { serviceWorkerSource } from './service-worker.mjs';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';
import { readdir, readFile, writeFile, mkdir, rm, cp, stat } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
if (dirname(outdir) !== root || relative(root, outdir) !== 'dist') throw new Error('Unsafe output path');

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in build inputs');
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

const packageData = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceHash = createHash('sha256');
const inputs = ['index.html', 'package.json', 'package-lock.json'];
for (const directory of ['src', 'scripts', 'public']) {
  inputs.push(...(await files(resolve(root, directory))).map(path => relative(root, path).split(sep).join('/')));
}
for (const path of inputs.sort()) sourceHash.update(path).update('\0').update(await readFile(resolve(root, path))).update('\0');
const version = `${packageData.version}+${sourceHash.digest('hex').slice(0, 16)}`;

await rm(outdir, { recursive: true, force: true });
await mkdir(resolve(outdir, 'assets'), { recursive: true });
const entryPoints = { app: resolve(root, 'src/app.js'), 'crypto-worker': resolve(root, 'src/crypto-worker.js') };
for (const name of ['media-worker', 'recording-worklet']) {
  if (await stat(resolve(root, `src/${name}.js`)).catch(() => null)) entryPoints[name] = resolve(root, `src/${name}.js`);
}
await build({
  absWorkingDir: root,
  entryPoints,
  outdir: resolve(outdir, 'assets'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  define: { __BUILD_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
await cp(resolve(root, 'public'), outdir, { recursive: true });
const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replaceAll('__BUILD_VERSION__', version);
await writeFile(resolve(outdir, 'index.html'), html);
await writeFile(resolve(outdir, '.nojekyll'), '');
await writeFile(resolve(outdir, 'build.json'), `${JSON.stringify({ version }, null, 2)}\n`);

// Only these build artifacts may enter Cache Storage. No runtime input is added.
const assets = [];
for (const path of await files(outdir)) {
  const name = relative(outdir, path).split(sep).join('/');
  const bytes = await readFile(path);
  assets.push({ path: name, hash: createHash('sha256').update(bytes).digest('base64') });
}
const worker = serviceWorkerSource({ version, assets });
await writeFile(resolve(outdir, 'sw.js'), worker);
console.log(`QuietChat ${version}: ${assets.length} verified static assets in dist/`);
