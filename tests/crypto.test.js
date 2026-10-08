import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import { ready, generateIdentity, exportPublicKey, importPublicKey, fingerprint, encryptContent, decryptContent, splitContainer, assembleContainer, exportBackup, importBackup, LIMITS, wipe } from '../src/crypto.js';
import { createContact, verifyContact } from '../src/contacts.js';

await ready();
const alice = await generateIdentity(), bob = await generateIdentity(), eve = await generateIdentity();
const utf8 = new TextEncoder();
const decode = new TextDecoder();
const b64 = bytes => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const binary = text => sodium.from_base64(text.slice(4), sodium.base64_variants.URLSAFE_NO_PADDING);
const qc = bytes => `QC1.${b64(bytes)}`;
const concatenate = (...buffers) => { const out = new Uint8Array(buffers.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of buffers) { out.set(b, o); o += b.length; } return out; };
const uint32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const message = text => ({ data: utf8.encode(text), kind: 'text', mime: 'text/plain;charset=utf-8' });

// Authenticated fixtures exercise semantic validation, not only MAC failures.
function malformed({ size = 256, contentSize = 1, kind = 0, mime = 0, final = true, earlyFinal = false, nonzeroPadding = false, reserved = false, envelopeHeaderMismatch = false, envelopeVersionMismatch = false, bytes: supplied } = {}) {
  const magic = new Uint8Array([81, 67, 1, 0]), key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  try {
    const inner = new Uint8Array(size); inner[0] = kind; inner[1] = mime; inner[2] = reserved ? 1 : 0;
    inner.set(uint32(contentSize), 4); inner[8] = 65;
    if (supplied) inner.set(supplied, 8);
    if (nonzeroPadding) inner[size - 1] = 9;
    const envelopeHeader = header.slice(); if (envelopeHeaderMismatch) envelopeHeader[0] ^= 1;
    const envelopeMagic = magic.slice(); if (envelopeVersionMismatch) envelopeMagic[2] = 2;
    const nonce = sodium.randombytes_buf(24);
    const wrapped = sodium.crypto_box_easy(concatenate(envelopeMagic, key, envelopeHeader), nonce, bob.publicKey, alice.secretKey);
    const prefix = concatenate(magic, nonce, header, wrapped), blocks = [];
    for (let offset = 0, i = 0; offset < inner.length; offset += 65536, i++) {
      const isFinal = offset + 65536 >= inner.length;
      const tag = earlyFinal && i === 0 || isFinal && final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      blocks.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, inner.subarray(offset, offset + 65536), concatenate(prefix, alice.publicKey, bob.publicKey, uint32(i)), tag));
    }
    return qc(concatenate(prefix, ...blocks));
  } finally {
    wipe(key);
    sodium.libsodium.HEAPU8.fill(0, state, state + sodium.libsodium._crypto_secretstream_xchacha20poly1305_statebytes());
    sodium.libsodium._free(state);
  }
}

test('independent profiles exchange Unicode text, image bytes and audio bytes', async () => {
  for (const payload of [message('Русский текст, emoji 👩🏽‍💻 🔑, 日本語, e\u0301\n<html>'), { data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), kind: 'image', mime: 'image/png' }, { data: utf8.encode('RIFF\u0000\u0000\u0000\u0000WAVE'), kind: 'audio', mime: 'audio/wav' }]) {
    const encrypted = await encryptContent(payload, alice, bob.publicKey);
    const result = await decryptContent(encrypted, bob, alice.publicKey);
    assert.equal(result.kind, payload.kind); assert.equal(result.mime, payload.mime); assert.deepEqual(result.data, payload.data);
    assert(!encrypted.includes(exportPublicKey(alice.publicKey))); assert(!encrypted.includes(exportPublicKey(bob.publicKey)));
  }
});
test('fresh content key, nonce and ciphertext for identical plaintext', async () => {
  assert.notEqual(await encryptContent(message('same'), alice, bob.publicKey), await encryptContent(message('same'), alice, bob.publicKey));
});
test('public-key import/export, complete fingerprint, invalid points', () => {
  assert.deepEqual(importPublicKey(exportPublicKey(alice.publicKey)), alice.publicKey);
  assert.equal(fingerprint(alice.publicKey).replaceAll(' ', '').length, 64);
  assert.equal(fingerprint(importPublicKey(exportPublicKey(alice.publicKey))), fingerprint(alice.publicKey));
  assert.notEqual(fingerprint(alice.publicKey), fingerprint(bob.publicKey));
  assert.throws(() => importPublicKey(`QCP1.${b64(new Uint8Array(32))}`));
  assert.throws(() => importPublicKey('QCP1.__')); assert.throws(() => importPublicKey('https://example.com/key'));
});
test('wrong recipient and wrong authenticated sender fail', async () => {
  const encrypted = await encryptContent(message('секрет'), alice, bob.publicKey);
  await assert.rejects(decryptContent(encrypted, eve, alice.publicKey));
  await assert.rejects(decryptContent(encrypted, bob, eve.publicKey));
});
test('ordered implicit public-key binding rejects reflection back to the sender', async () => {
  const encrypted = await encryptContent(message('Alice to Bob'), alice, bob.publicKey);
  // crypto_box alone shares the same DH key in both directions. Stream AD binds
  // ordered sender/recipient keys so this cannot be presented as Bob to Alice.
  await assert.rejects(decryptContent(encrypted, alice, bob.publicKey));
});
test('header, nonce, key envelope and encrypted block tampering all fail', async () => {
  const encrypted = await encryptContent(message('секрет'), alice, bob.publicKey);
  for (const position of [0, 2, 4, 28, 51, 52, 100, 127, 128, binary(encrypted).length - 1]) {
    const altered = binary(encrypted); altered[position] ^= 1;
    await assert.rejects(decryptContent(qc(altered), bob, alice.publicKey), `tamper offset ${position}`);
  }
});
test('truncation and extra bytes reject, including complete block truncation', async () => {
  const encrypted = await encryptContent({ data: new Uint8Array(100_000), kind: 'audio', mime: 'audio/wav' }, alice, bob.publicKey);
  const bytes = binary(encrypted);
  for (const length of [bytes.length - 1, bytes.length - 17, 128 + 65553, 128]) await assert.rejects(decryptContent(qc(bytes.subarray(0, length)), bob, alice.publicKey));
  await assert.rejects(decryptContent(qc(concatenate(bytes, new Uint8Array([0]))), bob, alice.publicKey));
  await assert.rejects(decryptContent(qc(concatenate(bytes, bytes.subarray(128, 128 + 65553))), bob, alice.publicKey));
});
test('reordering, duplication and splicing blocks fail', async () => {
  const payload = { data: sodium.randombytes_buf(100_000), kind: 'audio', mime: 'audio/wav' };
  const first = binary(await encryptContent(payload, alice, bob.publicKey));
  const second = binary(await encryptContent(payload, alice, bob.publicKey));
  const swapped = first.slice(), chunk = 65553;
  swapped.set(first.subarray(128 + chunk, 128 + 2 * chunk), 128);
  swapped.set(first.subarray(128, 128 + chunk), 128 + chunk);
  await assert.rejects(decryptContent(qc(swapped), bob, alice.publicKey));
  const duplicated = first.slice(); duplicated.set(first.subarray(128, 128 + chunk), 128 + chunk);
  await assert.rejects(decryptContent(qc(duplicated), bob, alice.publicKey));
  const spliced = first.slice(); spliced.set(second.subarray(128 + chunk, 128 + 2 * chunk), 128 + chunk);
  await assert.rejects(decryptContent(qc(spliced), bob, alice.publicKey));
  const envelopeSpliced = first.slice(); envelopeSpliced.set(second.subarray(4, 128), 4);
  await assert.rejects(decryptContent(qc(envelopeSpliced), bob, alice.publicKey));
});
test('authenticated but malformed streams fail: final tag, binding, padding, lengths and metadata', async () => {
  for (const options of [{ final: false }, { size: 262144, contentSize: 65536, earlyFinal: true }, { envelopeHeaderMismatch: true }, { envelopeVersionMismatch: true }, { nonzeroPadding: true }, { reserved: true }, { size: 4096 }, { contentSize: 0xffffffff }, { kind: 3 }, { mime: 255 }, { kind: 1, mime: 0 }, { bytes: new Uint8Array([255]) }]) {
    await assert.rejects(decryptContent(malformed(options), bob, alice.publicKey), JSON.stringify(options));
  }
  assert.equal(decode.decode((await decryptContent(malformed(), bob, alice.publicKey)).data), 'A');
});
test('padding hides nearby lengths inside the same documented bucket', async () => {
  const a = await encryptContent(message('a'), alice, bob.publicKey), b = await encryptContent(message('a'.repeat(200)), alice, bob.publicKey);
  assert.equal(a.length, b.length);
  const c = await encryptContent(message('a'.repeat(249)), alice, bob.publicKey);
  assert(c.length > a.length);
});
test('multipart grouping, shuffled order, missing/conflicting/mixed sets, checksum', async () => {
  const encrypted = await encryptContent(message('x'.repeat(10_000)), alice, bob.publicKey);
  const parts = splitContainer(encrypted, 1000);
  assert.equal(assembleContainer(parts.toReversed().join('\n\n')), encrypted);
  assert.equal(assembleContainer(parts.concat(parts[0]).join('\n')), encrypted);
  assert.equal(assembleContainer(encrypted.match(/.{1,5}/g).join(' \n')), encrypted);
  assert.deepEqual((await decryptContent(parts.join('\n'), bob, alice.publicKey)).data, utf8.encode('x'.repeat(10_000)));
  assert.throws(() => assembleContainer(parts.slice(1).join('\n')));
  assert.throws(() => assembleContainer(parts.concat(parts[0].slice(0, -1) + (parts[0].endsWith('A') ? 'B' : 'A')).join('\n')));
  const other = splitContainer(await encryptContent(message('x'.repeat(10_000)), alice, bob.publicKey), 1000);
  assert.throws(() => assembleContainer([other[0], ...parts.slice(1)].join('\n')));
  const modified = [...parts]; modified[0] = modified[0].slice(0, -1) + (modified[0].endsWith('A') ? 'B' : 'A');
  assert.throws(() => assembleContainer(modified.join('\n')));
});
test('structure, excessive input, unsupported MIME and invalid UTF-8 rejected', async () => {
  for (const input of ['QC2.AA', 'QC1.AA=', 'QC1.AA<script>', 'QC1.AA\u200b', 'QC1.' + 'A'.repeat(LIMITS.containerInputChars), 'QC1P.aaaaaaaaaaaaaaaaaaaaaa.1.9999.AA']) assert.throws(() => assembleContainer(input));
  await assert.rejects(encryptContent(message('x'.repeat(LIMITS.textBytes + 1)), alice, bob.publicKey));
  await assert.rejects(encryptContent({ data: new Uint8Array(LIMITS.fileBytes + 1), kind: 'image', mime: 'image/png' }, alice, bob.publicKey));
  for (const mime of ['image/svg+xml', 'text/html', 'image/heic', 'application/octet-stream']) await assert.rejects(encryptContent({ data: utf8.encode('<svg/>'), kind: 'image', mime }, alice, bob.publicKey));
  await assert.rejects(encryptContent({ data: new Uint8Array([255]), kind: 'text', mime: 'text/plain' }, alice, bob.publicKey));
  await assert.rejects(encryptContent(message('hi'), { ...alice, secretKey: bob.secretKey }, bob.publicKey));
});
test('backup restores independent keys and verified contacts; incorrect password and tampering fail', async () => {
  const contacts = [verifyContact(createContact('Боб', bob.publicKey))], password = 'Длинная парольная фраза 🔑';
  const backup = await exportBackup(alice, contacts, password);
  assert(backup.startsWith('QCB1.')); assert(!backup.includes('Боб'));
  const restored = await importBackup(backup, password);
  assert.deepEqual(restored.identity, alice); assert.deepEqual(restored.contacts, contacts);
  const encrypted = await encryptContent(message('после восстановления'), bob, alice.publicKey);
  assert.equal(decode.decode((await decryptContent(encrypted, restored.identity, bob.publicKey)).data), 'после восстановления');
  await assert.rejects(importBackup(backup, 'неверная парольная фраза'));
  const altered = sodium.from_base64(backup.slice(5), sodium.base64_variants.URLSAFE_NO_PADDING); altered[altered.length - 1] ^= 1;
  await assert.rejects(importBackup(`QCB1.${b64(altered)}`, password));
  await assert.rejects(exportBackup(alice, contacts, 'short'));
  assert.notEqual(backup, await exportBackup(alice, contacts, password));
});
test('backup rejects malicious KDF costs before password derivation', async () => {
  const header = new Uint8Array(68); header.set([81, 67, 66, 1]); header.set(uint32(0xffffffff), 4); header.set(uint32(0xffffffff), 8);
  await assert.rejects(importBackup(`QCB1.${b64(header)}`, 'достаточно длинный пароль'), /параметры Argon2id/);
  await assert.rejects(importBackup('QCB1.' + 'A'.repeat(LIMITS.backupChars), 'пароль'), /слишком большая/);
});
test('supported maximum file roundtrip stays within container limits', async () => {
  const payload = { data: new Uint8Array(LIMITS.fileBytes), kind: 'audio', mime: 'audio/wav' };
  payload.data[0] = 41; payload.data[payload.data.length - 1] = 43;
  const encrypted = await encryptContent(payload, alice, bob.publicKey);
  assert(encrypted.length < LIMITS.containerChars);
  assert.deepEqual((await decryptContent(encrypted, bob, alice.publicKey)).data, payload.data);
});
test('same authentic container may be replayed; no message history is retained', async () => {
  const encrypted = await encryptContent(message('доставка'), alice, bob.publicKey);
  assert.deepEqual(await decryptContent(encrypted, bob, alice.publicKey), await decryptContent(encrypted, bob, alice.publicKey));
});
