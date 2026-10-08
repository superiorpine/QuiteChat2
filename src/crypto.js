import sodium from 'libsodium-wrappers-sumo';
import { LIMITS } from './limits.js';
import { validateContacts } from './contacts.js';

export { LIMITS };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = new Uint8Array([81, 67, 1, 0]);
const BACKUP_MAGIC = new Uint8Array([81, 67, 66, 1]);
const PREFIX_BYTES = 128;
const INNER_BYTES = 8;
const CHUNK = LIMITS.chunkBytes;
const MAX_PADDED = 8 * 1024 * 1024 + 262_144;
const MAX_BINARY = PREFIX_BYTES + MAX_PADDED + Math.ceil(MAX_PADDED / CHUNK) * 17;
const MIME = ['text/plain;charset=utf-8', 'image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/flac'];
const KINDS = ['text', 'image', 'audio'];
export const BACKUP_PARAMETERS = Object.freeze({ algorithm: 'argon2id13', opsLimit: 3, memLimit: 67_108_864 });

export async function ready() { await sodium.ready; }
export function wipe(...values) {
  for (const value of values) if (value instanceof Uint8Array) value.fill(0);
}
function freeStreamState(state) {
  // Pinned libsodium-wrappers 0.8.4 exposes a heap address and does not free it.
  // Zero and release this allocation even when authentication fails midway.
  if (typeof state === 'number') {
    sodium.libsodium.HEAPU8.fill(0, state, state + sodium.libsodium._crypto_secretstream_xchacha20poly1305_statebytes());
    sodium.libsodium._free(state);
  }
}
function fail(message = 'Контейнер повреждён, ключи неверны или отправитель не совпадает.') { throw new Error(message); }
function bytes(value, length) {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) fail('Неверный формат ключа или данных.');
  return value;
}
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
function equal(a, b) { return a.length === b.length && sodium.memcmp(a, b); }
function b64(value) { return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING); }
function unb64(value, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail('Неверное или слишком большое Base64url-представление.');
  let decoded;
  try { decoded = sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING); } catch { fail(); }
  if (decoded.length > maximum || b64(decoded) !== value) fail();
  return decoded;
}
function u32(value) { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value, false); return result; }
function read32(value, offset) { return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset, false); }
function paddedSize(size) {
  const interval = size <= 1024 ? 256 : size <= 65_536 ? 4096 : 262_144;
  return Math.ceil(size / interval) * interval;
}
function validIdentity(identity) {
  bytes(identity?.secretKey, 32); bytes(identity?.publicKey, 32);
  if (!equal(sodium.crypto_scalarmult_base(identity.secretKey), identity.publicKey)) fail('Пара ключей не совпадает.');
}
function validatePublicKey(key) {
  bytes(key, 32);
  // crypto_scalarmult rejects small-order Curve25519 points, including zero.
  const probe = new Uint8Array(32); probe[0] = 8;
  let shared;
  try { shared = sodium.crypto_scalarmult(probe, key); } catch { fail('Недопустимый открытый ключ.'); }
  finally { wipe(probe, shared); }
  return key;
}
function mimeIndex(kind, mime) {
  if (mime === 'text/plain' && kind === 'text') mime = MIME[0];
  const index = MIME.indexOf(mime);
  if (index < 0 || !KINDS.includes(kind) || (kind === 'text' ? index !== 0 : !mime.startsWith(`${kind}/`))) fail('Неподдерживаемый тип содержимого.');
  return index;
}
function validateContent(data, kind, mime) {
  bytes(data);
  mimeIndex(kind, mime);
  if (data.length > (kind === 'text' ? LIMITS.textBytes : LIMITS.fileBytes)) fail('Превышен допустимый размер содержимого.');
  if (kind === 'text') { try { decoder.decode(data); } catch { fail('Текст должен быть корректным UTF-8.'); } }
}

export async function generateIdentity() {
  await ready();
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}
export function exportPublicKey(key) { validatePublicKey(key); return `QCP1.${b64(key)}`; }
export function importPublicKey(text) {
  if (typeof text !== 'string' || text.length > 256) fail('Неверный открытый ключ.');
  const compact = text.replace(/[\t\r\n ]/g, '');
  if (!compact.startsWith('QCP1.')) fail('Ожидается открытый ключ QCP1.');
  return validatePublicKey(unb64(compact.slice(5), 32));
}
export function fingerprint(key) {
  validatePublicKey(key);
  const digest = sodium.crypto_generichash(32, concat(encoder.encode('QuietChat public key fingerprint v1\0'), key));
  return sodium.to_hex(digest).toUpperCase().match(/.{4}/g).join(' ');
}

export async function encryptContent({ data, kind, mime }, identity, recipientPublicKey, onProgress = () => {}) {
  await ready(); validIdentity(identity); validatePublicKey(recipientPublicKey); validateContent(data, kind, mime);
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const padded = new Uint8Array(paddedSize(INNER_BYTES + data.length));
  let envelopePlain, state;
  try {
    padded[0] = KINDS.indexOf(kind); padded[1] = mimeIndex(kind, mime);
    padded.set(u32(data.length), 4); padded.set(data, INNER_BYTES);
    const initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    state = initialized.state;
    const header = initialized.header;
    envelopePlain = concat(MAGIC, key, header);
    const wrapped = sodium.crypto_box_easy(envelopePlain, nonce, recipientPublicKey, identity.secretKey);
    const prefix = concat(MAGIC, nonce, header, wrapped);
    const output = new Uint8Array(PREFIX_BYTES + padded.length + Math.ceil(padded.length / CHUNK) * sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
    output.set(prefix);
    let written = PREFIX_BYTES;
    for (let offset = 0, index = 0; offset < padded.length; offset += CHUNK, index++) {
      const final = offset + CHUNK >= padded.length;
      const block = sodium.crypto_secretstream_xchacha20poly1305_push(state, padded.subarray(offset, offset + CHUNK), concat(prefix, identity.publicKey, recipientPublicKey, u32(index)), final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
      output.set(block, written); written += block.length;
      onProgress(Math.min(1, (offset + CHUNK) / padded.length));
    }
    return `QC1.${b64(output)}`;
  } finally { wipe(key, padded, envelopePlain); freeStreamState(state); }
}

export async function decryptContent(container, identity, senderPublicKey, onProgress = () => {}) {
  await ready(); validIdentity(identity); validatePublicKey(senderPublicKey);
  const canonical = assembleContainer(container);
  const input = unb64(canonical.slice(4), MAX_BINARY);
  if (input.length < PREFIX_BYTES + 256 + 17 || !equal(input.subarray(0, 4), MAGIC)) fail();
  const prefix = input.subarray(0, PREFIX_BYTES);
  const streamHeader = prefix.subarray(28, 52);
  const ciphertextLength = input.length - PREFIX_BYTES;
  const blocks = Math.ceil(ciphertextLength / (CHUNK + 17));
  const plainLength = ciphertextLength - blocks * 17;
  if (plainLength < 256 || plainLength > MAX_PADDED || paddedSize(plainLength) !== plainLength || ciphertextLength % (CHUNK + 17) < 17 && ciphertextLength % (CHUNK + 17) !== 0) fail();
  let envelope, plaintext, key, state;
  try {
    try { envelope = sodium.crypto_box_open_easy(prefix.subarray(52), prefix.subarray(4, 28), senderPublicKey, identity.secretKey); } catch { fail(); }
    if (!envelope || envelope.length !== 60 || !equal(envelope.subarray(0, 4), MAGIC) || !equal(envelope.subarray(36), streamHeader)) fail();
    key = envelope.slice(4, 36);
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
    plaintext = new Uint8Array(plainLength);
    let written = 0;
    for (let offset = PREFIX_BYTES, index = 0; offset < input.length; offset += CHUNK + 17, index++) {
      const end = Math.min(input.length, offset + CHUNK + 17);
      let pulled;
      try { pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, input.subarray(offset, end), concat(prefix, senderPublicKey, identity.publicKey, u32(index))); } catch { fail(); }
      if (!pulled) fail();
      const expected = end === input.length ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      if (pulled.tag !== expected || written + pulled.message.length > plaintext.length) { wipe(pulled.message); fail(); }
      plaintext.set(pulled.message, written); written += pulled.message.length; wipe(pulled.message);
      onProgress((index + 1) / blocks);
    }
    if (written !== plaintext.length || plaintext[2] !== 0 || plaintext[3] !== 0) fail();
    const kind = KINDS[plaintext[0]], mime = MIME[plaintext[1]], size = read32(plaintext, 4);
    if (!kind || !mime || size > (kind === 'text' ? LIMITS.textBytes : LIMITS.fileBytes) || size + INNER_BYTES > plaintext.length || paddedSize(size + INNER_BYTES) !== plaintext.length) fail();
    for (let i = size + INNER_BYTES; i < plaintext.length; i++) if (plaintext[i] !== 0) fail();
    validateContent(plaintext.subarray(INNER_BYTES, size + INNER_BYTES), kind, mime);
    return { data: plaintext.slice(INNER_BYTES, size + INNER_BYTES), kind, mime };
  } finally { wipe(envelope, key, plaintext); freeStreamState(state); }
}

function checksum(text) { return b64(sodium.crypto_generichash(16, encoder.encode(text))); }
export function splitContainer(text, partSize = 4000) {
  const canonical = assembleContainer(text);
  if (!Number.isSafeInteger(partSize) || partSize < 256 || partSize > 65_536) fail('Размер части должен быть от 256 до 65536 символов.');
  const payload = canonical.slice(4), count = Math.ceil(payload.length / partSize);
  if (count > LIMITS.maxParts) fail('Слишком много частей; увеличьте размер части.');
  const set = checksum(canonical), parts = [];
  for (let i = 0; i < count; i++) parts.push(`QC1P.${set}.${i + 1}.${count}.${payload.slice(i * partSize, (i + 1) * partSize)}`);
  return parts;
}
export function assembleContainer(input) {
  if (typeof input !== 'string' || input.length > LIMITS.containerInputChars) fail('Контейнер слишком большой.');
  const compact = input.replace(/[\t\r\n ]/g, '');
  if (compact.startsWith('QC1.')) {
    if (compact.length > LIMITS.containerChars || !/^QC1\.[A-Za-z0-9_-]+$/.test(compact)) fail('Неверный контейнер QC1.');
    return compact;
  }
  if (!compact.startsWith('QC1P.')) fail('Ожидается QC1 или набор частей QC1P.');
  const records = compact.split('QC1P.').slice(1);
  if (!records.length || records.length > LIMITS.maxParts) fail('Неверное количество частей.');
  let set, total; const parts = new Map();
  for (const record of records) {
    const match = /^([A-Za-z0-9_-]{22})\.([1-9][0-9]{0,3})\.([1-9][0-9]{0,3})\.([A-Za-z0-9_-]+)$/.exec(record);
    if (!match) fail('Неверный заголовок части.');
    const [, id, sequence, number, payload] = match, index = Number(sequence), count = Number(number);
    if (count > LIMITS.maxParts || index > count || payload.length > 65_536) fail('Неверные границы частей.');
    if (set !== undefined && (set !== id || total !== count)) fail('Перемешаны части разных наборов.');
    set = id; total = count;
    if (parts.has(index) && parts.get(index) !== payload) fail('Конфликтующие части контейнера.');
    parts.set(index, payload);
  }
  if (parts.size !== total) fail(`Набор неполный: получено ${parts.size} из ${total} частей.`);
  const canonical = `QC1.${Array.from({ length: total }, (_, i) => parts.get(i + 1)).join('')}`;
  if (canonical.length > LIMITS.containerChars || checksum(canonical) !== set) fail('Контрольная сумма частей не совпадает.');
  return canonical;
}

function passwordBytes(password, creating) {
  if (typeof password !== 'string') fail('Введите парольную фразу.');
  const encoded = encoder.encode(password);
  if (encoded.length > LIMITS.passwordBytes || (creating ? [...password].length < 12 : encoded.length === 0)) { wipe(encoded); fail('Парольная фраза: минимум 12 символов, максимум 1024 байта UTF-8.'); }
  return encoded;
}
function derive(password, salt) {
  return sodium.crypto_pwhash(32, password, salt, BACKUP_PARAMETERS.opsLimit, BACKUP_PARAMETERS.memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
}
export async function exportBackup(identity, contacts, password) {
  await ready(); validIdentity(identity); const safeContacts = validateContacts(contacts);
  const pass = passwordBytes(password, true), salt = sodium.randombytes_buf(16), nonce = sodium.randombytes_buf(24);
  let key, plain;
  try {
    // The exact fixed header is authenticated, including derivation parameters.
    const header = concat(BACKUP_MAGIC, u32(3), u32(67_108_864), salt, nonce);
    key = derive(pass, salt);
    plain = encoder.encode(JSON.stringify({ v: 1, publicKey: exportPublicKey(identity.publicKey), secretKey: b64(identity.secretKey), contacts: safeContacts }));
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, header, null, nonce, key);
    const result = `QCB1.${b64(concat(header, encrypted))}`;
    if (result.length > LIMITS.backupChars) fail('Резервная копия слишком большая.');
    return result;
  } finally { wipe(pass, key, plain); }
}
export async function importBackup(text, password) {
  await ready();
  if (typeof text !== 'string' || text.length > LIMITS.backupChars) fail('Резервная копия слишком большая.');
  const canonical = text.replace(/[\t\r\n ]/g, '');
  if (!canonical.startsWith('QCB1.')) fail('Ожидается резервная копия QCB1.');
  const input = unb64(canonical.slice(5), LIMITS.backupChars * 3 / 4);
  if (input.length < 52 + 16 || !equal(input.subarray(0, 4), BACKUP_MAGIC)) fail('Неверный формат резервной копии.');
  if (read32(input, 4) !== 3 || read32(input, 8) !== 67_108_864) fail('Неподдерживаемые параметры Argon2id. Допустимы только 64 МиБ и 3 прохода.');
  const pass = passwordBytes(password, false); let key, plaintext, secretKey;
  try {
    key = derive(pass, input.subarray(12, 28));
    try { plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, input.subarray(52), input.subarray(0, 52), input.subarray(28, 52), key); }
    catch { fail('Неверная парольная фраза или повреждённая резервная копия.'); }
    let parsed;
    try { parsed = JSON.parse(decoder.decode(plaintext)); } catch { fail('Неверное содержимое резервной копии.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'contacts,publicKey,secretKey,v' || parsed.v !== 1) fail('Неверная структура резервной копии.');
    secretKey = unb64(parsed.secretKey, 32);
    const identity = { publicKey: importPublicKey(parsed.publicKey), secretKey };
    validIdentity(identity);
    const contacts = validateContacts(parsed.contacts);
    secretKey = undefined;
    return { identity, contacts };
  } finally { wipe(pass, key, plaintext, secretKey); }
}
