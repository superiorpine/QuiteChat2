import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { taggedPng, taggedJpeg, taggedWav } from '../media-fixtures.js';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

let harness;
test.beforeAll(async () => {
  const built = await build({ entryPoints: ['src/media.js'], bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser' });
  harness = built.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.route('**/assets/test-media.js', (route) => route.fulfill({ contentType: 'text/javascript', body: harness }));
  await page.goto('./');
  await page.evaluate(async () => { window.testMedia = await import('./assets/test-media.js'); });
});

test('real canvas conversion removes PNG text/XMP/EXIF and retains actual pixels', async ({ page }) => {
  const output = await page.evaluate(async (bytes) => {
    const prepared = await window.testMedia.prepareImage(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const bitmap = await createImageBitmap(new Blob([prepared.data], { type: prepared.mime }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const pixels = Array.from(ctx.getImageData(0, 0, 2, 1).data); bitmap.close();
    return { bytes: Array.from(prepared.data), kind: prepared.kind, mime: prepared.mime, pixels };
  }, Array.from(taggedPng()));
  expect(output.mime).toBe('image/png'); expect(output.kind).toBe('image');
  expect(output.pixels).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  const text = Buffer.from(output.bytes).toString('latin1');
  for (const marker of ['PRIVATE-', 'tEXt', 'iTXt', 'eXIf', 'XMP']) expect(text).not.toContain(marker);
});

test('JPEG with known EXIF owner/GPS, XMP and comment becomes a pixels-only PNG', async ({ page }) => {
  const baseJpeg = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 2;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#33aa77'; ctx.fillRect(0, 0, 3, 2);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const fixture = taggedJpeg(baseJpeg);
  expect(Buffer.from(fixture).toString('latin1')).toContain('PRIVATE-EXIF-OWNER');
  const output = await page.evaluate(async (bytes) => {
    const result = await window.testMedia.prepareImage(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    return { bytes: Array.from(result.data), info: window.testMedia.validateMedia(result.data, result.kind, result.mime) };
  }, Array.from(fixture));
  expect(output.info).toEqual({ mime: 'image/png', width: 3, height: 2 });
  const text = Buffer.from(output.bytes).toString('latin1');
  for (const marker of ['PRIVATE-', 'Exif', 'eXIf', 'iTXt', 'tEXt', 'xmpmeta']) expect(text).not.toContain(marker);
});

test('real audio decode/reencode removes WAV INFO title/artist and produces playable PCM', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const output = await window.testMedia.prepareAudio(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
    const info = window.testMedia.validateMedia(output.data, 'audio', output.mime);
    const context = new OfflineAudioContext(1, 1, 32000);
    const decoded = await context.decodeAudioData(output.data.buffer.slice(0));
    const peak = decoded.getChannelData(0).reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
    return { bytes: Array.from(output.data), mime: output.mime, info, peak, playable: document.createElement('audio').canPlayType('audio/wav') };
  }, Array.from(taggedWav()));
  expect(result.mime).toBe('audio/wav'); expect(result.info.sampleRate).toBe(32000); expect(result.info.bits).toBe(16);
  expect(result.info.duration).toBeCloseTo(0.05); expect(result.peak).toBeGreaterThan(0.1); expect(result.playable).not.toBe('');
  const text = Buffer.from(result.bytes).toString('latin1');
  for (const marker of ['PRIVATE-', 'LIST', 'INAM', 'IART']) expect(text).not.toContain(marker);
});

test('default never accepts active SVG, a metadata bomb or oversized raster; original is explicit', async ({ page }) => {
  const result = await page.evaluate(async ({ png, huge }) => {
    const reject = async (bytes) => {
      try { await window.testMedia.prepareImage(new Blob([new Uint8Array(bytes)], { type: 'image/png' })); return false; } catch { return true; }
    };
    const original = await window.testMedia.prepareImage(new Blob([new Uint8Array(png)]), { original: true });
    const fake = await reject(Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
    return { original: Array.from(original.data), fake, huge: await reject(huge) };
  }, { png: Array.from(taggedPng()), huge: Array.from(taggedPng({ width: 5000, height: 5000 })) });
  expect(result.original).toEqual(Array.from(taggedPng())); expect(result.fake).toBe(true); expect(result.huge).toBe(true);
});

test('aborting local media work never delivers a private or original result', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const abort = new AbortController();
    const pending = window.testMedia.prepareImage(new Blob([new Uint8Array(bytes)]), { signal: abort.signal }); abort.abort();
    try { await pending; return 'unexpected success'; } catch (error) { return error.name; }
  }, Array.from(taggedPng()));
  expect(result).toBe('AbortError');
});

test('explicit PCM recorder stops microphone tracks, returns WAV, and cancel discards data', async ({ page }) => {
  await page.evaluate(async () => {
    window.captureState = { ready: 0, errors: [], tracks: [] };
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await real(...args); window.captureState.tracks.push(...stream.getTracks()); return stream;
    };
    window.testRecorder = window.testMedia.createRecorder({
      onReady: (result) => { window.captureState.ready++; window.captureState.info = window.testMedia.validateMedia(result.data, result.kind, result.mime); result.data.fill(0); },
      onError: (error) => window.captureState.errors.push(error.message),
      onProgress: (value) => { window.captureState.progress = value; },
    });
    await window.testRecorder.start();
  });
  await expect.poll(() => page.evaluate(() => window.testRecorder.state)).toBe('recording');
  await expect.poll(() => page.evaluate(() => window.captureState.progress || 0)).toBeGreaterThan(0);
  await page.evaluate(() => window.testRecorder.stop());
  await expect.poll(() => page.evaluate(() => window.captureState.ready)).toBe(1);
  expect(await page.evaluate(() => window.captureState.errors)).toEqual([]);
  expect(await page.evaluate(() => window.captureState.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.captureState.info.mime)).toBe('audio/wav');
  await page.evaluate(async () => { await window.testRecorder.start(); window.testRecorder.cancel(); });
  expect(await page.evaluate(() => window.testRecorder.state)).toBe('idle');
  expect(await page.evaluate(() => window.captureState.ready)).toBe(1);
  expect(await page.evaluate(() => window.captureState.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
});
