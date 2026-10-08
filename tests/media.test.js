import test from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_LIMITS, inspectImage, inspectAudio, validateMedia, stripPngMetadata, encodeWav, prepareImage, prepareAudio } from '../src/media.js';
import { taggedPng, taggedWav, mp3Frames, opusOgg } from './media-fixtures.js';

test('PNG dimensions and MIME come from bytes; declared MIME must match on decryption', () => {
  const png = taggedPng();
  assert.deepEqual(inspectImage(png), { mime: 'image/png', width: 2, height: 1 });
  assert.throws(() => validateMedia(png, 'image', 'image/jpeg'), /MIME/);
  assert.throws(() => validateMedia(png, 'audio', 'image/png'));
});

test('private PNG allowlist removes known textual, XMP and EXIF tags, keeping compressed pixels', () => {
  const png = taggedPng(); const before = Buffer.from(png).toString('latin1');
  for (const tag of ['PRIVATE-COMMENT', 'PRIVATE-XMP-OWNER', 'PRIVATE-EXIF-OWNER']) assert.ok(before.includes(tag));
  const clean = stripPngMetadata(png); const after = Buffer.from(clean).toString('latin1');
  for (const tag of ['PRIVATE-COMMENT', 'PRIVATE-XMP-OWNER', 'PRIVATE-EXIF-OWNER', 'tEXt', 'iTXt', 'eXIf']) assert.ok(!after.includes(tag));
  assert.deepEqual(inspectImage(clean), { mime: 'image/png', width: 2, height: 1 });
  const chunks = []; const d = new DataView(clean.buffer);
  for (let p = 8; p < clean.length;) { chunks.push(Buffer.from(clean.subarray(p + 4, p + 8)).toString()); p += 12 + d.getUint32(p); }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
});

test('SVG, HTML, fake PNG, unsupported HEIC and empty input fail before decoding', () => {
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html><img src="https://example.invalid/secret"></html>', 'not actually a PNG', '\0\0\0\x18ftypheic\0\0\0\0']) {
    assert.throws(() => inspectImage(new TextEncoder().encode(text)));
  }
  assert.throws(() => inspectImage(new Uint8Array()));
});

test('pixel, dimension and file limits, animation, malformed lengths and trailing data fail early', () => {
  assert.throws(() => inspectImage(taggedPng({ width: 4000, height: 4000 })), /12 млн/);
  assert.throws(() => inspectImage(taggedPng({ width: 8193, height: 1 })), /12 млн/);
  assert.throws(() => inspectImage(taggedPng({ animated: true })), /Анимированные/);
  const tooLarge = new Uint8Array(MEDIA_LIMITS.fileBytes + 1); assert.throws(() => inspectImage(tooLarge), /8 МиБ/);
  const broken = taggedPng(); new DataView(broken.buffer).setUint32(33, 0xffffffff); assert.throws(() => inspectImage(broken), /Повреждённый/);
  const extra = new Uint8Array(taggedPng().length + 1); extra.set(taggedPng()); assert.throws(() => inspectImage(extra), /Лишние/);
  assert.throws(() => inspectImage(taggedPng().subarray(0, -1)));
});

test('WAV preflight finds PCM structure independent of INFO title/artist tags', () => {
  const wav = taggedWav(); const info = inspectAudio(wav);
  assert.equal(info.mime, 'audio/wav'); assert.equal(info.channels, 1); assert.equal(info.sampleRate, 32000); assert.equal(info.duration, 0.05);
  assert.ok(Buffer.from(wav).includes(Buffer.from('PRIVATE-SONG-TITLE')));
  assert.throws(() => validateMedia(wav, 'audio', 'audio/mp4'), /MIME/);
});

test('PCM WAV encoder emits only fmt and data, preserves sample ordering and clamps NaN', () => {
  const wav = encodeWav([new Float32Array([-1, 0, 1, NaN]), new Float32Array([1, 0.5, -0.5, Infinity])], 32000);
  const info = inspectAudio(wav); assert.equal(info.channels, 2); assert.equal(info.bits, 16); assert.equal(info.length, 16);
  assert.equal(Buffer.from(wav.subarray(12, 16)).toString(), 'fmt ');
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString(), 'data');
  const d = new DataView(wav.buffer);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => d.getInt16(44 + i * 2, true)), [-32768, 32767, 0, 16384, 32767, -16384, 0, 0]);
  assert.throws(() => encodeWav([new Float32Array(1), new Float32Array(2)], 32000), /длина/);
});

test('WAV unreasonable duration, channels, sample rate and inconsistent sizes fail before decoder', () => {
  assert.throws(() => inspectAudio(taggedWav({ seconds: 61 })), /60 секунд/);
  const wav = taggedWav(); new DataView(wav.buffer).setUint32(4, wav.length); assert.throws(() => inspectAudio(wav), /RIFF/);
  const rate = taggedWav(); const d = new DataView(rate.buffer); d.setUint32(24, 1, true); d.setUint32(28, 2, true); assert.throws(() => inspectAudio(rate), /60 секунд|кГц/);
  const mismatch = taggedWav(); new DataView(mismatch.buffer).setUint16(32, 4, true); assert.throws(() => inspectAudio(mismatch), /PCM/);
});

test('MP3 duration is counted from every frame, not ID3 or declared duration', () => {
  const mp3 = mp3Frames(); const info = inspectAudio(mp3);
  assert.equal(info.mime, 'audio/mpeg'); assert.ok(Math.abs(info.duration - 10 * 1152 / 44100) < 1e-9);
  assert.throws(() => inspectAudio(mp3Frames(2300)), /60 секунд/);
  assert.throws(() => inspectAudio(mp3.subarray(0, -1)), /MP3/);
  const broken = mp3.slice(); broken[417] = 0; assert.throws(() => inspectAudio(broken), /MP3/);
});

test('Ogg Opus durations come from packet TOCs; missing end, mixed stream and reordered page fail', () => {
  const ogg = opusOgg(); const info = inspectAudio(ogg);
  assert.equal(info.mime, 'audio/ogg'); assert.equal(info.duration, 0.02);
  const missingEnd = ogg.slice(); missingEnd[47 + 44 + 5] = 0; assert.throws(() => inspectAudio(missingEnd), /завершён/);
  const mixed = ogg.slice(); new DataView(mixed.buffer).setUint32(47 + 14, 987, true); assert.throws(() => inspectAudio(mixed), /Смешанные/);
  const reordered = ogg.slice(); new DataView(reordered.buffer).setUint32(47 + 18, 2, true); assert.throws(() => inspectAudio(reordered), /Смешанные/);
});

test('original mode is explicit, preserves bytes and derives MIME from actual contents', async () => {
  const png = taggedPng(); const output = await prepareImage(new Blob([png], { type: 'text/html' }), { original: true });
  assert.equal(output.mime, 'image/png'); assert.deepEqual(output.data, png);
  const wav = taggedWav(); const audio = await prepareAudio(new Blob([wav], { type: 'image/png' }), { original: true });
  assert.equal(audio.mime, 'audio/wav'); assert.deepEqual(audio.data, wav);
  output.data.fill(0); audio.data.fill(0);
});

test('unsupported local decoder never silently returns original; abort prevents processing', async () => {
  await assert.rejects(prepareImage(new Blob([taggedPng()])), /декодировщик/);
  await assert.rejects(prepareAudio(new Blob([taggedWav()])), /локальную подготовку/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(prepareImage(new Blob([taggedPng()]), { signal: abort.signal }), { name: 'AbortError' });
  await assert.rejects(prepareAudio(new Blob([taggedWav()]), { signal: abort.signal }), { name: 'AbortError' });
});
