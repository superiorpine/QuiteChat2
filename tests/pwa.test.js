import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { serviceWorkerSource } from '../scripts/service-worker.mjs';

const SCOPE = 'https://example.test/QuietChat/';
const VERSION = '1.0.0+test';
const fixture = new Map([
  ['index.html', '<!doctype html><title>QuietChat test</title>'],
  ['assets/app.js', '/* synthetic static code */'],
  ['assets/crypto-worker.js', '/* synthetic worker */'],
  ['manifest.webmanifest', '{"start_url":"./"}'],
]);
const assets = [...fixture].map(([path, body]) => ({ path, hash: createHash('sha256').update(body).digest('base64') }));

function harness({ scope = SCOPE, network = new Map(fixture) } = {}) {
  const listeners = new Map();
  const storage = new Map();
  const requests = [];
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  const caches = {
    has: async name => storage.has(name),
    keys: async () => [...storage.keys()],
    delete: async name => storage.delete(name),
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(key) { return entries.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async put(key, value) { entries.set(typeof key === 'string' ? key : key.url, value.clone()); },
        async delete(key) { return entries.delete(typeof key === 'string' ? key : key.url); },
      };
    },
  };
  const context = vm.createContext({
    self: {
      registration: { scope },
      location: { origin: new URL(scope).origin },
      addEventListener: (type, handler) => listeners.set(type, handler),
      skipWaiting: async () => { skipWaitingCalls++; },
      clients: { claim: async () => { claimCalls++; } },
    },
    caches, crypto: webcrypto, URL, Request, Response, Uint8Array,
    btoa: input => Buffer.from(input, 'binary').toString('base64'),
    async fetch(request) {
      requests.push(request);
      assert.equal(request.method, 'GET');
      assert.equal(request.cache, 'reload');
      assert.equal(request.credentials, 'same-origin');
      assert.match(request.integrity, /^sha256-/);
      const path = request.url.slice(scope.length);
      if (!network.has(path)) throw new Error('Offline');
      return new Response(network.get(path));
    },
  });
  vm.runInContext(serviceWorkerSource({ version: VERSION, assets }), context);
  const cacheName = `quietchat-static:${scope}:${VERSION}`;
  async function fire(type, fields = {}) {
    const pending = [];
    let response;
    listeners.get(type)({ ...fields, waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
    await Promise.all(pending);
    return response;
  }
  async function message(type) {
    let answer;
    await fire('message', { data: { type }, ports: [{ postMessage: value => { answer = JSON.parse(JSON.stringify(value)); } }] });
    return answer;
  }
  return { fire, message, storage, caches, requests, network, cacheName, scope, activity: () => ({ skipWaitingCalls, claimCalls }) };
}

test('PWA confirms readiness only after every allowlisted asset has been verified', async () => {
  const h = harness();
  assert.deepEqual(await h.message('VERIFY_CACHE'), { ready: false, version: VERSION });
  await h.fire('install');
  assert.equal(h.requests.length, assets.length);
  assert.deepEqual(await h.message('VERIFY_CACHE'), { ready: true, version: VERSION });
  const cache = await h.caches.open(h.cacheName);
  await cache.delete(SCOPE + 'assets/app.js');
  assert.deepEqual(await h.message('VERIFY_CACHE'), { ready: false, version: VERSION });
});

test('first-visit control requires the matching build, its full cache and an in-scope client', async () => {
  const h = harness();
  const send = (version, url) => h.fire('message', { data: { type: 'CLAIM_VERIFIED_BUILD', version }, source: { url }, ports: [{ postMessage() {} }] });
  await send(VERSION, SCOPE); assert.equal(h.activity().claimCalls, 0);
  await h.fire('install');
  await send('different', SCOPE); await send(VERSION, 'https://other.test/'); assert.equal(h.activity().claimCalls, 0);
  await send(VERSION, SCOPE); assert.equal(h.activity().claimCalls, 1); assert.equal(h.activity().skipWaitingCalls, 0);
});

test('PWA rejects an incomplete or corrupted installation and removes partial cache', async () => {
  for (const mode of ['missing', 'modified']) {
    const h = harness();
    if (mode === 'missing') h.network.delete('assets/crypto-worker.js');
    else h.network.set('assets/crypto-worker.js', 'newer or corrupted code');
    await assert.rejects(h.fire('install'));
    assert.equal(h.storage.has(h.cacheName), false);
    assert.equal((await h.message('VERIFY_CACHE')).ready, false);
  }
});

test('PWA serves the same verified app offline from a GitHub Pages subpath', async () => {
  const h = harness();
  await h.fire('install');
  h.network.clear();
  h.requests.length = 0;
  for (const path of ['', 'index.html', 'assets/app.js', 'assets/crypto-worker.js']) {
    const response = await h.fire('fetch', { request: new Request(SCOPE + path) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fixture.get(path || 'index.html'));
  }
  assert.equal(h.requests.length, 0);
});

test('PWA never intercepts or caches runtime content, query strings, POST, or another origin', async () => {
  const h = harness();
  await h.fire('install');
  const before = h.storage.get(h.cacheName).size;
  h.requests.length = 0;
  for (const request of [
    new Request(SCOPE + 'message.txt'),
    new Request(SCOPE + 'index.html?private=test'),
    new Request('https://elsewhere.test/index.html'),
    new Request(SCOPE + 'index.html', { method: 'POST', body: 'test-only synthetic plaintext' }),
  ]) assert.equal(await h.fire('fetch', { request }), undefined);
  assert.equal(h.requests.length, 0);
  assert.equal(h.storage.get(h.cacheName).size, before);
});

test('PWA detects cache corruption and repairs only the exact build asset', async () => {
  const h = harness();
  await h.fire('install');
  const cache = await h.caches.open(h.cacheName);
  await cache.put(SCOPE + 'assets/app.js', new Response('corrupted'));
  assert.equal((await h.message('VERIFY_CACHE')).ready, false);
  let response = await h.fire('fetch', { request: new Request(SCOPE + 'assets/app.js') });
  assert.equal(await response.text(), fixture.get('assets/app.js'));
  assert.equal((await h.message('VERIFY_CACHE')).ready, true);
  await cache.delete(SCOPE + 'assets/app.js');
  h.network.set('assets/app.js', 'different new build');
  response = await h.fire('fetch', { request: new Request(SCOPE + 'assets/app.js') });
  assert.equal(response.status, 503);
  assert.equal(await cache.match(SCOPE + 'assets/app.js'), undefined);
  assert.equal((await h.message('VERIFY_CACHE')).ready, false);
});

test('PWA never forces an update into open sessions, including ACTIVATE_UPDATE', async () => {
  const h = harness();
  await h.fire('install');
  await h.fire('activate');
  assert.deepEqual(await h.message('ACTIVATE_UPDATE'), { ready: false, requiresClose: true, version: VERSION });
  assert.deepEqual(h.activity(), { skipWaitingCalls: 0, claimCalls: 0 });
});

test('PWA activation removes only old caches of its own scope', async () => {
  const h = harness();
  const ownOld = `quietchat-static:${SCOPE}:old`;
  const otherScope = 'quietchat-static:https://example.test/AnotherProject/:old';
  await h.caches.open(ownOld);
  await h.caches.open(otherScope);
  await h.caches.open('unrelated-cache');
  await h.fire('install');
  await h.fire('activate');
  assert.equal(h.storage.has(ownOld), false);
  assert.equal(h.storage.has(otherScope), true);
  assert.equal(h.storage.has('unrelated-cache'), true);
  assert.equal(h.storage.has(h.cacheName), true);
});
