import { test, expect } from '@playwright/test';
import { taggedPng, taggedWav } from '../media-fixtures.js';

async function open(page) {
  await page.goto('./');
  await expect(page.locator('#offline-status')).toHaveText('Офлайн готов');
  await page.reload();
  await expect(page.locator('#offline-status')).toHaveText('Офлайн готов');
}
async function generate(page) {
  await page.locator('[data-page=keys]').click();
  await page.locator('#generate-key').click();
  await expect(page.locator('#key-status')).toHaveText('Ключи разблокированы');
  return page.locator('#my-public').inputValue();
}
async function addContact(page, key, name) {
  await page.locator('[data-page=contacts]').click();
  await page.locator('#contact-name').fill(name);
  await page.locator('#contact-key').fill(key);
  await page.locator('#contact-add').click();
  await expect(page.locator('#contacts-list .contact-card').last()).toBeVisible();
  await page.getByRole('button', { name: 'Я сверил полный отпечаток' }).last().click();
  await expect(page.locator('#contacts-list .verified').last()).toHaveText('Проверен');
}
test('two independent profiles: Unicode, full authentication, tamper, parts, no content networking/persistence', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const alice = await a.newPage(), bob = await b.newPage();
  const errors = [];
  for (const page of [alice, bob]) { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); await open(page); }
  if (process.env.CAPTURE_UI) await alice.screenshot({ path: '.tmp/quietchat-desktop.png', fullPage: true });
  const aliceKey = await generate(alice), bobKey = await generate(bob);
  expect(aliceKey).not.toBe(bobKey);
  await addContact(alice, bobKey, 'Боб'); await addContact(bob, aliceKey, 'Алиса');
  // Both have a fully verified offline cache before operating on content.
  await a.setOffline(true); await b.setOffline(true);
  const requests = [];
  for (const page of [alice, bob]) page.on('request', r => { if (!r.url().startsWith('blob:')) requests.push(r.url()); });
  await alice.locator('[data-page=encrypt]').click(); await alice.locator('#recipient').selectOption({ label: 'Боб' });
  const secret = 'Привет, мир 👋🏽🔐\n<script>globalThis.pwned=true</script> & <img src=https://example.invalid/secret>';
  await alice.locator('#plain-text').fill(secret); await alice.locator('#encrypt').click();
  await expect(alice.locator('#cipher-result')).toBeVisible(); const cipher = await alice.locator('#cipher-output').inputValue(); expect(cipher).toMatch(/^QC1\./);
  await alice.locator('#split-cipher').click(); await expect(alice.locator('#parts-output')).toBeVisible(); const parts = await alice.locator('#parts-output').inputValue();
  await bob.locator('[data-page=decrypt]').click(); await bob.locator('#sender').selectOption({ label: 'Алиса' });
  await bob.locator('#cipher-input').fill(parts); await bob.locator('#decrypt').click(); await expect(bob.locator('#decrypted-view')).toHaveText(secret);
  expect(await bob.evaluate(() => globalThis.pwned)).toBeUndefined(); expect(await bob.locator('#decrypted-view img, #decrypted-view script').count()).toBe(0);
  await bob.locator('#cipher-input').fill(cipher.slice(0, 180) + (cipher[180] === 'A' ? 'B' : 'A') + cipher.slice(181));
  await bob.locator('#decrypt').click(); await expect(bob.locator('#notice')).toHaveClass(/error/); await expect(bob.locator('#decrypted-result')).toBeHidden();
  for (const page of [alice, bob]) {
    const storage = await page.evaluate(async () => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), db: await indexedDB.databases(), keys: await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => r.url))) }));
    expect(storage.local).toEqual([]); expect(storage.session).toEqual([]); expect(storage.db).toEqual([]);
    expect(JSON.stringify(storage)).not.toContain(secret); expect(storage.keys.flat().every(url => url.startsWith('http://127.0.0.1:4173/QuietChat/'))).toBe(true);
  }
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  await alice.locator('#lock').click(); await expect(alice.locator('#plain-text')).toHaveValue(''); await expect(alice.locator('#my-public')).toHaveValue(''); await expect(alice.locator('#contact-count')).toHaveText('0');
  await a.close(); await b.close();
});

test('encrypted local vault survives reload, wrong password rejected, verification resets on key replacement', async ({ page }) => {
  await open(page); const own = await generate(page); await addContact(page, own, 'Проверка');
  await page.locator('[data-page=keys]').click();
  await page.locator('#backup-password').fill('длинная секретная фраза 123'); await page.locator('#backup-confirm').fill('длинная секретная фраза 123'); await page.locator('#vault-save').click();
  await expect(page.locator('#vault-status')).toContainText('есть зашифрованная');
  const stored = await page.evaluate(() => localStorage.getItem('quietchat.vault.v1'));
  expect(stored).not.toContain('Проверка'); expect(stored).not.toContain('секретная'); expect(stored).not.toContain(own);
  await expect(page.locator('#backup-password')).toHaveValue('');
  await page.reload(); await page.locator('[data-page=keys]').click(); await page.locator('#backup-password').fill('неправильный пароль 123'); await page.locator('#vault-unlock').click(); await expect(page.locator('#notice')).toHaveClass(/error/);
  await page.locator('#backup-password').fill('длинная секретная фраза 123'); await page.locator('#vault-unlock').click(); await expect(page.locator('#my-public')).toHaveValue(own);
  await expect(page.locator('#contact-count')).toHaveText('1');
  await page.locator('#lock').click(); const next = await generate(page); expect(next).not.toBe(own);
  await addContact(page, own, 'Старый ключ');
  await page.locator('#contacts-list summary').click(); await page.locator('#contacts-list textarea').fill(next); await page.getByRole('button', { name: 'Заменить и сбросить проверку' }).click();
  await expect(page.locator('#contacts-list .tag')).toHaveText('Не проверен');
  await page.locator('[data-page=encrypt]').click(); expect(await page.locator('#recipient option').count()).toBe(1);
});

test('offline subpath reload and mobile layout, background/idle locks', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page); await context.setOffline(true); await page.reload(); await expect(page.locator('#offline-status')).toHaveText('Офлайн готов');
  if (process.env.CAPTURE_UI) await page.screenshot({ path: '.tmp/quietchat-mobile.png', fullPage: true });
  await generate(page); await page.locator('[data-page=encrypt]').click(); await page.locator('#plain-text').fill('приватный черновик');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#key-status')).toHaveText('Ключи заблокированы'); await expect(page.locator('#plain-text')).toHaveValue('');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await generate(page);
  await page.clock.install(); await page.clock.fastForward(301000);
  await expect(page.locator('#key-status')).toHaveText('Ключи заблокированы');
});

test('image and audio exchange through the complete UI between independent profiles while offline', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  for (const context of [a, b]) await context.addInitScript(() => {
    // Test-only access to synthetic blobs, without relaxing the production CSP.
    window.testBlobs = new Map(); const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.testBlobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { window.testBlobs.delete(url); revoke(url); };
  });
  const alice = await a.newPage(), bob = await b.newPage();
  await open(alice); await open(bob);
  const ak = await generate(alice), bk = await generate(bob);
  await addContact(alice, bk, 'Боб'); await addContact(bob, ak, 'Алиса');
  await a.setOffline(true); await b.setOffline(true);
  const nonCached = [];
  for (const context of [a, b]) context.on('response', response => { if (response.url().startsWith('http') && !response.fromServiceWorker()) nonCached.push(response.url()); });
  await alice.locator('[data-page=encrypt]').click(); await alice.locator('#recipient').selectOption({ label: 'Боб' });
  await bob.locator('[data-page=decrypt]').click(); await bob.locator('#sender').selectOption({ label: 'Алиса' });
  for (const [kind, mime, bytes, selector] of [['image', 'image/png', taggedPng(), 'img'], ['audio', 'audio/wav', taggedWav(), 'audio']]) {
    await alice.locator(`[data-kind=${kind}]`).click();
    await alice.locator('#media-file').setInputFiles({ name: 'private-original', mimeType: mime, buffer: Buffer.from(bytes) });
    await expect(alice.locator(`#prepared-preview ${selector}`)).toBeVisible();
    const prepared = await alice.locator(`#prepared-preview ${selector}`).evaluate(async node => Array.from(new Uint8Array(await window.testBlobs.get(node.src).arrayBuffer())));
    expect(Buffer.from(prepared).toString('latin1')).not.toContain('PRIVATE-');
    const previous = await alice.locator('#cipher-output').inputValue(); await alice.locator('#encrypt').click();
    await expect(alice.locator('#cipher-output')).not.toHaveValue(previous);
    await bob.locator('#cipher-input').fill(await alice.locator('#cipher-output').inputValue()); await bob.locator('#decrypt').click();
    await expect(bob.locator(`#decrypted-view ${selector}`)).toBeVisible();
    const restored = await bob.locator(`#decrypted-view ${selector}`).evaluate(async node => Array.from(new Uint8Array(await window.testBlobs.get(node.src).arrayBuffer())));
    expect(restored).toEqual(prepared);
    if (kind === 'image') await expect.poll(() => bob.locator('#decrypted-view img').evaluate(img => img.naturalWidth)).toBe(2);
    else { await expect.poll(() => bob.locator('#decrypted-view audio').evaluate(audio => audio.readyState)).toBeGreaterThan(0); await bob.locator('#decrypted-view audio').evaluate(audio => audio.play()); }
  }
  expect(nonCached).toEqual([]);
  await bob.locator('#lock').click(); expect(await bob.locator('audio').count()).toBe(0);
  await a.close(); await b.close();
});

test('exported backup file restores keys and contacts only after explicit password action', async ({ page }) => {
  await open(page); const key = await generate(page); await addContact(page, key, 'Локальный тест');
  await page.locator('[data-page=keys]').click(); await page.locator('#backup-password').fill('резервная фраза 12345'); await page.locator('#backup-confirm').fill('резервная фраза 12345');
  const downloadReady = page.waitForEvent('download'); await page.locator('#backup-export').click(); const download = await downloadReady;
  const path = await download.path(); await page.locator('#lock').click(); await page.locator('#backup-file').setInputFiles(path);
  await expect(page.locator('#backup-import')).toBeVisible(); await expect(page.locator('#key-status')).toHaveText('Ключи заблокированы');
  await page.locator('#backup-password').fill('резервная фраза 12345'); await page.locator('#backup-import').click(); await expect(page.locator('#my-public')).toHaveValue(key); await expect(page.locator('#contact-count')).toHaveText('1');
});
