import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Static architectural regressions. These are deliberately not a claim that
// regex scanning proves noninterference, nor a substitute for browser tests.
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const names = (await readdir(new URL('src/', root))).filter(name => name.endsWith('.js'));
const modules = await Promise.all(names.map(async name => ({ name, source: await read(`src/${name}`) })));
const byName = Object.fromEntries(modules.map(({ name, source }) => [name, source]));
byName.serviceWorker = await read('scripts/service-worker.mjs');
const html = await read('index.html');
const build = await read('scripts/build.mjs');

test('content modules contain no explicit network, telemetry, logging or dynamic code sinks', () => {
  for (const { name, source } of modules) {
    assert.doesNotMatch(source, /\b(?:fetch|eval)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|WebTransport|Function)\b|\bsendBeacon\s*\(|\bconsole\s*\./, name);
    assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|document\s*\.\s*write\s*\(/, name);
    assert.doesNotMatch(source, /\b(?:location|history)\s*\.\s*(?:hash|search|href|assign|replace|pushState|replaceState)\b/, name);
    assert.doesNotMatch(source, /\bMath\s*\.\s*random\s*\(/, name);
    assert.doesNotMatch(source, /(?:https?:)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i, `${name}: no remote resource URLs`);
  }
});

test('only an explicitly encrypted vault may be written to browser storage', () => {
  for (const { name, source } of modules) {
    assert.doesNotMatch(source, /\b(?:indexedDB|sessionStorage)\b|\bcaches\s*\./, name);
    if (name !== 'app.js') assert.doesNotMatch(source, /\blocalStorage\b|document\s*\.\s*cookie/, name);
  }
  const app = byName['app.js'];
  const writes = [...app.matchAll(/localStorage\s*\.\s*setItem\s*\(([^;]+)\)/g)].map(match => match[1]);
  assert.equal(writes.length, 1, 'one explicit opt-in persistence path');
  assert.match(writes[0], /^VAULT_KEY, backup$/);
  assert.match(app, /backup\s*=\s*await\s+rpc\('backup'/);
  assert.match(app, /if\s*\(id\s*===\s*'vault-save'\)/);
  assert.doesNotMatch(app, /localStorage\s*\[|document\s*\.\s*cookie|\blocalStorage\s*\.\s*[^.(;]+\s*=/);
});

test('secret identity is confined to crypto worker; lock destroys it and clears UI memory', () => {
  const app = byName['app.js'], worker = byName['crypto-worker.js'];
  assert.doesNotMatch(app, /libsodium|import\s+.*from\s+['"].*crypto\.js|\.secretKey|\.privateKey/);
  assert.match(worker, /let\s+identity\s*=\s*null/);
  assert.match(worker, /publicKey:\s*exportPublicKey\(identity\.publicKey\)/);
  assert.doesNotMatch(worker, /postMessage\([^;]*(?:identity|secretKey|password)/);
  const lock = app.slice(app.indexOf('function lock('), app.indexOf('function setIdentity('));
  assert.match(lock, /worker\?\.terminate\(\)/);
  assert.match(lock, /operation\?\.abort\(\)/);
  assert.match(lock, /recorder\?\.cancel\(\)/);
  assert.match(lock, /clearPrepared\(\)/); assert.match(lock, /clearDecrypted\(\)/);
  assert.match(lock, /releaseUrls\(\)/); assert.match(lock, /contacts\s*=\s*\[\]/);
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.match(app, /addEventListener\('pagehide'/);
});

test('CSP and document allow only bundled local resources and safe media', () => {
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  assert(content, 'CSP meta must exist');
  const policy = new Map(content.split(';').map(rule => { const [directive, ...values] = rule.trim().split(/\s+/); return [directive, values]; }));
  for (const directive of ['default-src', 'object-src', 'base-uri', 'form-action']) assert.deepEqual(policy.get(directive), ["'none'"]);
  assert.deepEqual(policy.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(policy.get('worker-src'), ["'self'"]);
  assert.deepEqual(policy.get('media-src'), ['blob:']);
  assert.deepEqual(policy.get('img-src'), ["'self'", 'blob:']);
  assert.doesNotMatch(html, /\son[a-z]+\s*=|<iframe\b|<object\b|<embed\b|<form\b|(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  assert.match(html, /<meta\s+name="referrer"\s+content="no-referrer"/);
  for (const field of ['plain-text', 'cipher-input', 'contact-key']) {
    const element = html.match(new RegExp(`<textarea[^>]*id="${field}"[^>]*>`))?.[0];
    assert(element, field); assert.match(element, /spellcheck="false"/); assert.match(element, /autocorrect="off"/); assert.match(element, /autocapitalize="off"/);
  }
});

test('cache build has fixed artifact allowlist and never activates updates in an open session', () => {
  // Source generation is inspected here; runtime cache/offline behavior is
  // covered by Playwright separately.
  const serviceWorker = byName.serviceWorker;
  const withoutComments = serviceWorker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /\bskipWaiting\s*\(/);
  assert.match(serviceWorker, /event\.data\.version === VERSION/);
  assert.match(serviceWorker, /if \(ready\) await self\.clients\.claim\(\)/);
  assert.match(byName['app.js'], /if \(!mustBeReady\(\)\) return/);
  assert.match(serviceWorker, /const\s+ASSETS\s*=/);
  assert.match(serviceWorker, /BY_URL\.get\(key\)/);
  assert.match(serviceWorker, /if\s*\(!asset\)\s*return/);
  assert.match(serviceWorker, /request\.method\s*!==\s*'GET'/);
  assert.match(serviceWorker, /url\.search\s*\|\|\s*url\.hash/);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^;]*event\.data/);
  assert.match(serviceWorker, /integrity:\s*'sha256-'/);
  assert.match(serviceWorker, /verifiedCache\(\)/);
});

test('production dependency graph is pinned and manifest stays within repository subpath', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(packageJson.dependencies), ['libsodium-wrappers-sumo']);
  for (const version of Object.values({ ...packageJson.dependencies, ...packageJson.devDependencies })) assert.match(version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(lock.packages[''].dependencies['libsodium-wrappers-sumo'], packageJson.dependencies['libsodium-wrappers-sumo']);
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.match(icon.src, /^\.\//);
});
