// All parsing is local. MIME supplied by a file or container is never authoritative.
export const MEDIA_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  pixels: 12_000_000,
  dimension: 8192,
  audioSeconds: 60,
  audioChannels: 2,
  audioRate: 32000,
  compressedBytes: 4 * 1024 * 1024,
});

const fail = (message) => { throw new Error(message); };
const ascii = (b, p, n) => { if (n > 128) fail('Слишком длинное поле формата.'); return String.fromCharCode(...b.subarray(p, p + n)); };
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const checkAbort = (signal) => { if (signal?.aborted) throw new DOMException('Операция отменена.', 'AbortError'); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const matches = (b, p, a) => a.every((v, i) => b[p + i] === v);

function bytesCheck(data) {
  if (!(data instanceof Uint8Array) || data.length < 12 || data.length > MEDIA_LIMITS.fileBytes)
    fail('Файл пуст, повреждён или больше 8 МиБ.');
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MEDIA_LIMITS.dimension || height > MEDIA_LIMITS.dimension || width * height > MEDIA_LIMITS.pixels)
    fail('Изображение слишком большое: максимум 12 млн пикселей и 8192 пикселя по стороне.');
}

function pngChunks(b) {
  const d = view(b); let p = 8; const chunks = [];
  while (p < b.length) {
    if (p + 12 > b.length) fail('Повреждённый PNG.');
    const length = d.getUint32(p); const type = ascii(b, p + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || length > b.length - p - 12) fail('Повреждённый PNG.');
    chunks.push({ type, start: p, end: p + length + 12, length });
    if (chunks.length > 65536) fail('Слишком много блоков PNG.');
    p += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || p !== b.length) fail('Лишние данные после PNG.');
      return chunks;
    }
  }
  fail('У PNG отсутствует конец файла.');
}

export function inspectImage(b) {
  bytesCheck(b);
  const d = view(b);
  if (matches(b, 0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    const chunks = pngChunks(b);
    if (chunks[0].type !== 'IHDR' || chunks[0].length !== 13 || chunks.filter((c) => c.type === 'IHDR').length !== 1 ||
        !chunks.some((c) => c.type === 'IDAT' && c.length > 0)) fail('Неверная структура PNG.');
    if (chunks.some((c) => c.type === 'acTL' || c.type === 'fcTL' || c.type === 'fdAT'))
      fail('Анимированные PNG не поддерживаются. Сохраните отдельный кадр.');
    const width = d.getUint32(16); const height = d.getUint32(20);
    dimensions(width, height);
    const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[b[25]]?.includes(b[24]) || b[26] !== 0 || b[27] !== 0 || b[28] > 1) fail('Неподдерживаемый PNG.');
    return { mime: 'image/png', width, height };
  }
  if (b[0] === 255 && b[1] === 216) {
    if (b[b.length - 2] !== 255 || b[b.length - 1] !== 217) fail('JPEG усечён или содержит лишние данные.');
    let p = 2; let result;
    while (p + 4 <= b.length) {
      if (b[p++] !== 255) fail('Повреждённые маркеры JPEG.');
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 218) break;
      if (marker === 216 || marker === 217 || marker === 0 || (marker >= 208 && marker <= 215)) fail('Повреждённый JPEG.');
      if (p + 2 > b.length) fail('Повреждённый JPEG.');
      const n = d.getUint16(p);
      if (n < 2 || n > b.length - p) fail('Повреждённый JPEG.');
      if ([192, 193, 194].includes(marker)) {
        if (result || n < 8 || b[p + 2] !== 8 || ![1, 3, 4].includes(b[p + 7])) fail('Неподдерживаемый JPEG.');
        const width = d.getUint16(p + 5); const height = d.getUint16(p + 3);
        dimensions(width, height); result = { mime: 'image/jpeg', width, height };
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) fail('Этот вариант JPEG не поддерживается.');
      p += n;
    }
    if (!result) fail('Не найдены размеры JPEG.');
    return result;
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    if (d.getUint32(4, true) !== b.length - 8) fail('Повреждённый WebP.');
    let p = 12; let result; let canvas;
    const u24 = (i) => b[i] + b[i + 1] * 256 + b[i + 2] * 65536;
    while (p + 8 <= b.length) {
      const type = ascii(b, p, 4); const n = d.getUint32(p + 4, true); const q = p + 8;
      if (n > b.length - q) fail('Повреждённый WebP.');
      if (type === 'ANIM' || type === 'ANMF') fail('Анимированный WebP не поддерживается. Сохраните отдельный кадр.');
      if (type === 'VP8X') {
        if (n !== 10 || (b[q] & 2)) fail('Анимированный или повреждённый WebP.');
        canvas = { width: u24(q + 4) + 1, height: u24(q + 7) + 1 };
        dimensions(canvas.width, canvas.height);
      }
      let size;
      if (type === 'VP8 ') {
        if (n < 10 || (b[q] & 1) || !matches(b, q + 3, [157, 1, 42])) fail('Неверный WebP VP8.');
        size = { width: d.getUint16(q + 6, true) & 16383, height: d.getUint16(q + 8, true) & 16383 };
      } else if (type === 'VP8L') {
        if (n < 5 || b[q] !== 47 || (b[q + 4] >> 5) !== 0) fail('Неверный WebP VP8L.');
        const packed = d.getUint32(q + 1, true);
        size = { width: (packed & 16383) + 1, height: ((packed >>> 14) & 16383) + 1 };
      }
      if (size) {
        if (result) fail('Несколько изображений в одном WebP не поддерживаются.');
        dimensions(size.width, size.height); result = { mime: 'image/webp', ...size };
      }
      p = q + n + (n % 2);
    }
    if (p !== b.length || !result || (canvas && (canvas.width !== result.width || canvas.height !== result.height)))
      fail('Повреждённая структура WebP.');
    return result;
  }
  fail('Поддерживаются только PNG, JPEG и неподвижный WebP. HEIC, SVG и HTML не обрабатываются.');
}

// Canvas already excludes source metadata. This allowlist additionally removes optional
// chunks emitted by browser encoders; the remaining PNG is only dimensions and pixels.
export function stripPngMetadata(b) {
  const info = inspectImage(b);
  if (info.mime !== 'image/png') fail('Ожидалась приватная копия PNG.');
  const chunks = pngChunks(b).filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type));
  // Browser canvas outputs truecolour PNG. Dropping PLTE from indexed input is unsafe.
  if (![2, 6].includes(b[25])) fail('Ожидался полноцветный PNG от локального кодировщика.');
  const out = new Uint8Array(8 + chunks.reduce((n, c) => n + c.end - c.start, 0));
  out.set(b.subarray(0, 8)); let p = 8;
  for (const c of chunks) { out.set(b.subarray(c.start, c.end), p); p += c.end - c.start; }
  return out;
}

function audioBounds(info) {
  if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MEDIA_LIMITS.audioSeconds + 0.05)
    fail('Аудио должно быть не длиннее 60 секунд.');
  if (!Number.isInteger(info.channels) || info.channels < 1 || info.channels > MEDIA_LIMITS.audioChannels ||
      !Number.isFinite(info.sampleRate) || info.sampleRate < 8000 || info.sampleRate > 96000)
    fail('Поддерживается аудио с 1–2 каналами и частотой 8–96 кГц.');
  return info;
}

function inspectWav(b) {
  const d = view(b);
  if (d.getUint32(4, true) !== b.length - 8) fail('Повреждённый WAV: размер RIFF не совпадает.');
  let p = 12; let format; let data;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4); const n = d.getUint32(p + 4, true); const q = p + 8;
    if (n > b.length - q) fail('Повреждённый WAV.');
    if (type === 'fmt ') {
      if (format || n < 16) fail('Неверный WAV fmt.');
      const codec = d.getUint16(q, true); const channels = d.getUint16(q + 2, true);
      const sampleRate = d.getUint32(q + 4, true); const byteRate = d.getUint32(q + 8, true);
      const block = d.getUint16(q + 12, true); const bits = d.getUint16(q + 14, true);
      if (!((codec === 1 && [8, 16, 24, 32].includes(bits)) || (codec === 3 && bits === 32)) ||
          channels < 1 || channels > 2 || block !== channels * bits / 8 || byteRate !== sampleRate * block)
        fail('Поддерживается обычный PCM WAV (8/16/24/32 бит) или float32 WAV, до двух каналов.');
      format = { codec, channels, sampleRate, bits, block };
    }
    if (type === 'data') { if (data) fail('Несколько data-блоков WAV не поддерживаются.'); data = { offset: q, length: n }; }
    p = q + n + (n % 2);
  }
  if (p !== b.length || !format || !data || data.length % format.block) fail('Повреждённая структура WAV.');
  return audioBounds({ mime: 'audio/wav', ...format, ...data, duration: data.length / format.block / format.sampleRate });
}

function inspectMp3(b) {
  let p = 0; let end = b.length; let duration = 0; let channels = 0; let sampleRate = 0; let frames = 0;
  if (ascii(b, 0, 3) === 'ID3') {
    if (b[3] < 2 || b[3] > 4 || b.subarray(6, 10).some((v) => v & 128)) fail('Неверный ID3.');
    const n = b[6] * 2097152 + b[7] * 16384 + b[8] * 128 + b[9];
    p = 10 + n + (b[3] === 4 && (b[5] & 16) ? 10 : 0);
    if (p >= end) fail('Нет аудио после ID3.');
  }
  if (end >= 128 && ascii(b, end - 128, 3) === 'TAG') end -= 128;
  const high = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const low = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  while (p + 4 <= end) {
    if (b[p] !== 255 || (b[p + 1] & 224) !== 224) fail('Повреждённые MP3-кадры или неподдерживаемые теги.');
    const version = (b[p + 1] >>> 3) & 3; const layer = (b[p + 1] >>> 1) & 3;
    const bitrate = (b[p + 2] >>> 4) & 15; const rate = (b[p + 2] >>> 2) & 3;
    if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) fail('Поддерживается обычный MP3 Layer III.');
    const hz = [44100, 48000, 32000][rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const ch = b[p + 3] >>> 6 === 3 ? 1 : 2;
    if (frames && (hz !== sampleRate || ch !== channels)) fail('Изменение параметров MP3 внутри файла не поддерживается.');
    sampleRate = hz; channels = ch;
    const n = Math.floor((version === 3 ? 144000 : 72000) * (version === 3 ? high : low)[bitrate] / hz) + ((b[p + 2] >>> 1) & 1);
    if (n < 4 || p + n > end) fail('Усечённый MP3.');
    duration += (version === 3 ? 1152 : 576) / hz;
    if (duration > MEDIA_LIMITS.audioSeconds + 0.05 || ++frames > 10000) fail('Аудио длиннее 60 секунд.');
    p += n;
  }
  if (p !== end || frames === 0) fail('Повреждённый MP3.');
  return audioBounds({ mime: 'audio/mpeg', duration, channels, sampleRate });
}

function opusSamples(packet) {
  if (!packet.length) fail('Пустой пакет Opus.');
  const config = packet[0] >>> 3; const code = packet[0] & 3;
  const frame = config >= 16 ? [120, 240, 480, 960][config & 3] : config >= 12 ? [480, 960][config & 1] : [480, 960, 1920, 2880][config & 3];
  const count = code === 0 ? 1 : code < 3 ? 2 : packet.length >= 2 ? packet[1] & 63 : 0;
  if (!count || frame * count > 5760) fail('Повреждённая длительность пакета Opus.');
  return frame * count;
}

function opusHead(packet) {
  if (packet.length < 19 || ascii(packet, 0, 8) !== 'OpusHead' || packet[8] !== 1 || packet[18] !== 0 || ![1, 2].includes(packet[9]))
    fail('Поддерживается Opus с одним или двумя каналами без сложной раскладки.');
  return packet[9];
}

function inspectOgg(b) {
  const d = view(b); let p = 0; let serial; let sequence = 0; let pending = []; let pendingSize = 0;
  let packets = 0; let channels; let samples = 0; let eos = false;
  while (p + 27 <= b.length) {
    if (eos || ascii(b, p, 4) !== 'OggS' || b[p + 4] !== 0) fail('Повреждённый Ogg.');
    const flags = b[p + 5]; const sid = d.getUint32(p + 14, true); const seq = d.getUint32(p + 18, true); const count = b[p + 26];
    if (flags & ~7 || seq !== sequence++ || (serial !== undefined && serial !== sid) || !!(flags & 1) !== !!pendingSize ||
        (p === 0 ? !(flags & 2) : !!(flags & 2))) fail('Смешанные, усечённые или переставленные страницы Ogg.');
    serial = sid;
    if (p + 27 + count > b.length) fail('Усечённый Ogg.');
    let q = p + 27 + count;
    for (let i = 0; i < count; i++) {
      const n = b[p + 27 + i];
      if (q + n > b.length || pendingSize + n > 256 * 1024) fail('Повреждённый или слишком большой пакет Ogg.');
      pending.push(b.subarray(q, q + n)); pendingSize += n; q += n;
      if (n < 255) {
        const packet = new Uint8Array(pendingSize); let w = 0;
        for (const part of pending) { packet.set(part, w); w += part.length; }
        if (packets === 0) channels = opusHead(packet);
        else if (packets === 1) { if (ascii(packet, 0, 8) !== 'OpusTags') fail('Нет заголовка тегов Opus.'); }
        else samples += opusSamples(packet);
        packet.fill(0); pending = []; pendingSize = 0; packets++;
        if (samples > (MEDIA_LIMITS.audioSeconds + 0.05) * 48000 || packets > 25000) fail('Аудио длиннее 60 секунд.');
      }
    }
    eos = !!(flags & 4); p = q;
  }
  if (p !== b.length || !eos || pendingSize || packets < 3) fail('Ogg усечён или не завершён.');
  return audioBounds({ mime: 'audio/ogg', duration: samples / 48000, channels, sampleRate: 48000 });
}

function vint(b, p, isId = false) {
  if (p >= b.length || !b[p]) fail('Повреждённый WebM.');
  let length = 1; let mask = 128;
  while (!(b[p] & mask)) { mask >>>= 1; length++; }
  if (length > (isId ? 4 : 8) || p + length > b.length) fail('Повреждённый WebM.');
  let value = isId ? b[p] : b[p] & (mask - 1); let unknown = !isId && value === mask - 1;
  for (let i = 1; i < length; i++) { value = value * 256 + b[p + i]; unknown &&= b[p + i] === 255; }
  if (!unknown && !Number.isSafeInteger(value)) fail('Чрезмерный размер WebM.');
  return { value, length, unknown };
}

function inspectWebm(b) {
  let elements = 0; let channels = 0; let samples = 0; let tracks = 0; let codec = ''; let trackNumber = 0; let scale = 1_000_000;
  let maxTimestamp = 0; let clusterTime = 0; let blocks = 0;
  const readUint = (p, n) => { if (n < 1 || n > 6) fail('Неверное целое WebM.'); let x = 0; for (let i = 0; i < n; i++) x = x * 256 + b[p + i]; return x; };
  const block = (p, end) => {
    const track = vint(b, p); p += track.length;
    if (!trackNumber || track.value !== trackNumber || end - p < 4) fail('Неподдерживаемая дорожка WebM.');
    const timestamp = view(b).getInt16(p); const flags = b[p + 2]; p += 3;
    if (flags & 6) fail('WebM с упакованными пакетами (lacing) не поддерживается.');
    samples += opusSamples(b.subarray(p, end));
    maxTimestamp = Math.max(maxTimestamp, clusterTime + timestamp);
    if (samples > (MEDIA_LIMITS.audioSeconds + 0.05) * 48000 || ++blocks > 25000) fail('Аудио длиннее 60 секунд.');
  };
  const containers = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);
  function walk(start, end, depth = 0) {
    if (depth > 6) fail('Чрезмерная вложенность WebM.');
    let p = start;
    while (p < end) {
      if (++elements > 100000) fail('Слишком много элементов WebM.');
      const id = vint(b, p, true); p += id.length;
      const size = vint(b, p); p += size.length;
      if (size.unknown && ![0x18538067, 0x1f43b675].includes(id.value)) fail('Неограниченный элемент WebM.');
      const stop = size.unknown ? end : p + size.value;
      if (stop > end || stop < p) fail('Усечённый WebM.');
      if (id.value === 0xae && ++tracks > 1) fail('Разрешена одна аудиодорожка WebM.');
      if (id.value === 0x83 && readUint(p, stop - p) !== 2) fail('Видео в WebM не поддерживается.');
      if (id.value === 0xd7) trackNumber = readUint(p, stop - p);
      if (id.value === 0x86) { codec = ascii(b, p, stop - p); if (codec !== 'A_OPUS') fail('В WebM поддерживается только Opus.'); }
      if (id.value === 0x63a2) channels = opusHead(b.subarray(p, stop));
      if (id.value === 0x2ad7b1) { scale = readUint(p, stop - p); if (scale < 1 || scale > 1_000_000_000) fail('Неверный масштаб времени WebM.'); }
      if (id.value === 0xe7) clusterTime = readUint(p, stop - p);
      if (id.value === 0xa3 || id.value === 0xa1) block(p, stop);
      if (containers.has(id.value)) walk(p, stop, depth + 1);
      p = stop;
    }
  }
  walk(0, b.length);
  if (tracks !== 1 || codec !== 'A_OPUS' || !blocks || maxTimestamp * scale / 1e9 > MEDIA_LIMITS.audioSeconds + 0.05)
    fail('Неподдерживаемый или слишком длинный WebM.');
  return audioBounds({ mime: 'audio/webm', duration: samples / 48000, channels, sampleRate: 48000 });
}

function inspectMp4(b) {
  const d = view(b); let count = 0; let tracks = 0; let info;
  function boxes(start, end) {
    const result = []; let p = start;
    while (p < end) {
      if (++count > 100000 || p + 8 > end) fail('Повреждённые блоки MP4.');
      const n = d.getUint32(p); const type = ascii(b, p + 4, 4);
      if (n < 8 || n > end - p) fail('MP4 с расширенными/неограниченными размерами не поддерживается.');
      result.push({ type, start: p + 8, end: p + n }); p += n;
    }
    return result;
  }
  function one(list, type) {
    const found = list.filter((x) => x.type === type);
    if (found.length !== 1) fail(`Неоднозначная структура MP4 (${type}).`);
    return found[0];
  }
  function children(box) { return boxes(box.start, box.end); }
  const top = boxes(0, b.length);
  if (top.some((x) => x.type === 'moof')) fail('Фрагментированный MP4 не поддерживается. Используйте PCM WAV.');
  const moov = one(top, 'moov'); one(top, 'mdat');
  for (const trak of children(moov).filter((x) => x.type === 'trak')) {
    if (++tracks > 1) fail('Разрешена одна аудиодорожка MP4.');
    const mdia = children(one(children(trak), 'mdia'));
    const hdlr = one(mdia, 'hdlr'); const mdhd = one(mdia, 'mdhd');
    if (hdlr.end - hdlr.start < 12 || ascii(b, hdlr.start + 8, 4) !== 'soun') fail('MP4 должен содержать только звук.');
    const md = mdhd.start; const version = b[md];
    if (version > 1 || mdhd.end - md < (version === 1 ? 32 : 20)) fail('Неверная временная шкала MP4.');
    const scale = d.getUint32(md + (version === 1 ? 20 : 12));
    if (!scale || scale > 96000) fail('Неподдерживаемая временная шкала MP4.');
    const minf = children(one(mdia, 'minf'));
    const dinf = children(one(minf, 'dinf')); const dref = one(dinf, 'dref');
    if (dref.end - dref.start < 8 || d.getUint32(dref.start + 4) !== 1) fail('Неоднозначный источник аудио MP4.');
    const refs = boxes(dref.start + 8, dref.end); const local = one(refs, 'url ');
    if (local.end - local.start !== 4 || d.getUint32(local.start) !== 1) fail('MP4 со ссылкой на внешний ресурс запрещён.');
    const stbl = children(one(minf, 'stbl'));
    const stsd = one(stbl, 'stsd'); const stts = one(stbl, 'stts'); const stsz = one(stbl, 'stsz');
    if (stsd.end - stsd.start < 44 || d.getUint32(stsd.start + 4) !== 1) fail('Неверное описание дорожки MP4.');
    const entries = boxes(stsd.start + 8, stsd.end); const entry = one(entries, 'mp4a');
    if (entry.end - entry.start < 28 || d.getUint16(entry.start + 8) !== 0) fail('Поддерживается обычный AAC MP4.');
    const channels = d.getUint16(entry.start + 16); const sampleRate = d.getUint32(entry.start + 24) >>> 16;
    if (d.getUint16(entry.start + 6) !== 1) fail('Внешний источник данных MP4 запрещён.');
    const esds = one(boxes(entry.start + 28, entry.end), 'esds');
    if (esds.end - esds.start < 6 || d.getUint32(esds.start) !== 0) fail('Неверные параметры AAC.');
    function descriptor(p, end, tag) {
      if (p >= end || b[p++] !== tag) fail('Неподдерживаемые параметры AAC.');
      let n = 0; let i = 0; let part;
      do {
        if (p >= end || ++i > 4) fail('Повреждённый дескриптор AAC.');
        part = b[p++]; n = n * 128 + (part & 127);
      } while (part & 128);
      if (n > end - p) fail('Усечённый дескриптор AAC.');
      return { start: p, end: p + n };
    }
    const es = descriptor(esds.start + 4, esds.end, 3);
    if (es.end - es.start < 3 || (b[es.start + 2] & 224)) fail('Зависимые и внешние AAC-потоки запрещены.');
    const decoder = descriptor(es.start + 3, es.end, 4);
    if (decoder.end - decoder.start < 13 || b[decoder.start] !== 0x40 || b[decoder.start + 1] !== 0x15)
      fail('В MP4 поддерживается только AAC-LC.');
    const config = descriptor(decoder.start + 13, decoder.end, 5);
    if (config.end - config.start !== 2) fail('Расширения AAC не поддерживаются; используйте PCM WAV.');
    const configBits = d.getUint16(config.start); const objectType = configBits >>> 11;
    const configRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000][(configBits >>> 7) & 15];
    const configChannels = (configBits >>> 3) & 15;
    if (objectType !== 2 || (configBits & 7) || configRate !== sampleRate || configChannels !== channels)
      fail('Поддерживается AAC-LC без расширений, с согласованными параметрами дорожки.');
    if (stts.end - stts.start < 8 || stsz.end - stsz.start < 12) fail('Повреждённые таблицы MP4.');
    const rows = d.getUint32(stts.start + 4);
    if (!rows || rows > 10000 || stts.end - stts.start !== 8 + rows * 8) fail('Неверная таблица времени MP4.');
    let durationUnits = 0; let samples = 0;
    for (let i = 0; i < rows; i++) {
      const at = stts.start + 8 + i * 8; const n = d.getUint32(at); const delta = d.getUint32(at + 4);
      if (!n || !delta) fail('Нулевая длительность MP4.');
      samples += n; durationUnits += n * delta;
      if (samples > 12000 || !Number.isSafeInteger(durationUnits)) fail('Слишком много пакетов MP4.');
    }
    const sampleCount = d.getUint32(stsz.start + 8); const fixedSize = d.getUint32(stsz.start + 4);
    if (sampleCount !== samples || stsz.end - stsz.start !== 12 + (fixedSize ? 0 : sampleCount * 4)) fail('Несогласованные таблицы MP4.');
    // Only the 1024-sample AAC-LC configuration above is admitted. Do not rely
    // solely on timestamps, which could understate the actual decoded length.
    if (samples * 1024 / sampleRate > MEDIA_LIMITS.audioSeconds + 0.05) fail('AAC длиннее 60 секунд.');
    info = audioBounds({ mime: 'audio/mp4', duration: durationUnits / scale, channels, sampleRate });
  }
  if (!info || tracks !== 1) fail('Нет поддерживаемой аудиодорожки MP4.');
  return info;
}

export function inspectAudio(b) {
  bytesCheck(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return inspectWav(b);
  if (b.length > MEDIA_LIMITS.compressedBytes) fail('Сжатое аудио ограничено 4 МиБ; PCM WAV — 8 МиБ.');
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)) return inspectMp3(b);
  if (ascii(b, 0, 4) === 'OggS') return inspectOgg(b);
  if (matches(b, 0, [26, 69, 223, 163])) return inspectWebm(b);
  if (ascii(b, 4, 4) === 'ftyp') return inspectMp4(b);
  fail('Поддерживаются PCM WAV, MP3, Ogg Opus, WebM Opus и обычный аудио MP4/AAC. Формат определяется по содержимому.');
}

export function validateMedia(data, kind, mime) {
  if (kind !== 'image' && kind !== 'audio') fail('Неизвестный тип медиа.');
  const info = kind === 'image' ? inspectImage(data) : inspectAudio(data);
  if (mime !== info.mime) fail('Заявленный MIME не совпадает с фактическим форматом файла.');
  return info;
}

async function readFile(file, signal) {
  checkAbort(signal);
  if (!(file instanceof Blob) || file.size < 12 || file.size > MEDIA_LIMITS.fileBytes) fail('Выберите файл размером от 12 байт до 8 МиБ.');
  const b = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) { b.fill(0); checkAbort(signal); }
  return b;
}

function workerJob(message, transfer, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module' });
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true; worker.terminate(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('Операция отменена.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.onerror = () => finish(new Error('Локальная обработка не удалась. Исходник не будет использован вместо приватной копии.'));
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) { onProgress?.(data.progress); return; }
      finish(data.error ? new Error(data.error) : null, data.result);
    };
    worker.postMessage(message, transfer);
  });
}

export async function rasterizeImage(data, info) {
  const blob = new Blob([data], { type: info.mime });
  let bitmap; let objectUrl; let canvas;
  try {
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    else {
      if (typeof document === 'undefined') fail('Локальный декодировщик изображения недоступен.');
      objectUrl = URL.createObjectURL(blob);
      bitmap = new Image(); bitmap.src = objectUrl;
      await bitmap.decode();
    }
    const width = bitmap.width; const height = bitmap.height;
    dimensions(width, height);
    if (width * height !== info.width * info.height) fail('Размеры декодированного изображения не совпадают с заголовком.');
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) fail('Не удалось создать приватную копию изображения.');
    ctx.drawImage(bitmap, 0, 0);
    const encoded = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!encoded || encoded.size > MEDIA_LIMITS.fileBytes) fail('Приватный PNG больше 8 МиБ. Уменьшите изображение и попробуйте снова.');
    const raw = new Uint8Array(await encoded.arrayBuffer());
    try { return stripPngMetadata(raw); } finally { raw.fill(0); }
  } finally {
    bitmap?.close?.(); if (bitmap?.src) bitmap.src = '';
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

export async function prepareImage(file, { original = false, signal, onProgress } = {}) {
  let data = await readFile(file, signal);
  try {
    const info = inspectImage(data); onProgress?.(0.1); checkAbort(signal);
    if (original) { const result = { data, kind: 'image', mime: info.mime }; data = null; onProgress?.(1); return result; }
    let result;
    if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
      result = await workerJob({ type: 'image', data, info }, [data.buffer], signal, onProgress);
    } else {
      await tick(); checkAbort(signal); result = await rasterizeImage(data, info);
    }
    if (signal?.aborted) { result.fill(0); checkAbort(signal); }
    validateMedia(result, 'image', 'image/png'); onProgress?.(1);
    return { data: result, kind: 'image', mime: 'image/png' };
  } finally { if (data?.byteLength) data.fill(0); }
}

export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2 ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) fail('Неверные параметры PCM.');
  const samples = channels[0].length;
  if (!samples || samples / sampleRate > MEDIA_LIMITS.audioSeconds + 0.05 || channels.some((c) => !(c instanceof Float32Array) || c.length !== samples))
    fail('Неверная длина PCM или аудио длиннее 60 секунд.');
  const size = samples * channels.length * 2;
  if (44 + size > MEDIA_LIMITS.fileBytes) fail('PCM WAV больше 8 МиБ.');
  const b = new Uint8Array(44 + size); const d = view(b);
  const put = (p, s) => { for (let i = 0; i < s.length; i++) b[p + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); d.setUint32(4, 36 + size, true); put(8, 'WAVE'); put(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, channels.length, true);
  d.setUint32(24, sampleRate, true); d.setUint32(28, sampleRate * channels.length * 2, true);
  d.setUint16(32, channels.length * 2, true); d.setUint16(34, 16, true); put(36, 'data'); d.setUint32(40, size, true);
  let p = 44;
  for (let i = 0; i < samples; i++) for (const channel of channels) {
    const v = Number.isFinite(channel[i]) ? Math.max(-1, Math.min(1, channel[i])) : 0;
    d.setInt16(p, Math.round(v * (v < 0 ? 32768 : 32767)), true); p += 2;
  }
  return b;
}

export async function prepareAudio(file, { original = false, signal, onProgress } = {}) {
  let data = await readFile(file, signal); let context; let decoded; let channels;
  try {
    const info = inspectAudio(data); onProgress?.(0.1); checkAbort(signal);
    if (original) { const result = { data, kind: 'audio', mime: info.mime }; data = null; onProgress?.(1); return result; }
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Offline) fail('Браузер не поддерживает локальную подготовку аудио. Используйте актуальный браузер или подготовьте PCM WAV отдельно.');
    // Offline context uses no microphone and no output device. Decoding resamples to 32 kHz.
    context = new Offline(2, 1, MEDIA_LIMITS.audioRate);
    decoded = await context.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    checkAbort(signal);
    audioBounds({ duration: decoded.duration, channels: decoded.numberOfChannels, sampleRate: decoded.sampleRate });
    if (decoded.sampleRate !== MEDIA_LIMITS.audioRate) fail('Браузер не выполнил локальное преобразование частоты аудио.');
    onProgress?.(0.7);
    channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => new Float32Array(decoded.getChannelData(i)));
    let result;
    if (typeof Worker === 'function') result = await workerJob({ type: 'wav', channels, sampleRate: decoded.sampleRate }, channels.map((c) => c.buffer), signal, onProgress);
    else { await tick(); checkAbort(signal); result = encodeWav(channels, decoded.sampleRate); }
    if (signal?.aborted) { result.fill(0); checkAbort(signal); }
    validateMedia(result, 'audio', 'audio/wav'); onProgress?.(1);
    return { data: result, kind: 'audio', mime: 'audio/wav' };
  } catch (error) {
    if (error.name === 'EncodingError' || error.name === 'NotSupportedError') fail('Браузер не смог декодировать аудио. Приватная копия не создана; исходник не используется автоматически. Попробуйте PCM WAV.');
    throw error;
  } finally {
    if (data?.byteLength) data.fill(0);
    channels?.forEach((c) => { if (c.byteLength) c.fill(0); });
    if (decoded) for (let i = 0; i < decoded.numberOfChannels; i++) decoded.getChannelData(i).fill(0);
    context = null; decoded = null;
  }
}

export function createRecorder({ onState, onReady, onError, onProgress } = {}) {
  let context; let stream; let source; let node; let timer; let chunks = []; let samples = 0; let state = 'idle'; let generation = 0;
  let controller;
  const notify = (value) => { state = value; onState?.(value); };
  const release = () => {
    clearTimeout(timer); timer = undefined;
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    source?.disconnect(); source = undefined;
    if (node) { node.port.onmessage = null; node.port.postMessage({ type: 'cancel' }); node.disconnect(); node = undefined; }
    const previous = context; context = undefined;
    if (previous && previous.state !== 'closed') void previous.close().catch(() => {});
  };
  const clearChunks = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; samples = 0; };
  function cancel() { generation++; controller?.abort(); release(); clearChunks(); notify('idle'); }
  async function finish(id) {
    if (id !== generation || state !== 'recording') return;
    const rate = context.sampleRate; release(); notify('processing');
    controller = new AbortController();
    let joined; let result;
    try {
      if (!samples) fail('Запись слишком короткая.');
      joined = new Float32Array(samples); let p = 0;
      for (const chunk of chunks) { joined.set(chunk, p); p += chunk.length; }
      clearChunks(); onProgress?.(0.75);
      if (typeof Worker === 'function') result = await workerJob({ type: 'wav', channels: [joined], sampleRate: rate }, [joined.buffer], controller.signal, onProgress);
      else result = encodeWav([joined], rate);
      if (id !== generation) { result.fill(0); return; }
      validateMedia(result, 'audio', 'audio/wav'); onProgress?.(1); notify('idle');
      onReady?.({ data: result, kind: 'audio', mime: 'audio/wav' }); result = undefined;
    } catch (error) {
      if (id === generation) { notify('idle'); if (error.name !== 'AbortError') onError?.(error); }
    } finally { if (joined?.byteLength) joined.fill(0); result?.fill(0); }
  }
  async function start() {
    if (state !== 'idle') return;
    const id = ++generation; notify('starting');
    try {
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio || !globalThis.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia)
        fail('В этом браузере недоступна безопасная локальная запись. Нужны HTTPS и AudioWorklet; можно выбрать готовый PCM WAV.');
      context = new Audio({ sampleRate: MEDIA_LIMITS.audioRate });
      // Resume starts in the explicit click handler before awaiting microphone permission.
      await context.resume();
      if (id !== generation) return;
      if (!context.audioWorklet || context.sampleRate < 8000 || context.sampleRate > 48000)
        fail('Этот браузер не поддерживает выбранный режим PCM-записи.');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (id !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      await context.audioWorklet.addModule(new URL('./recording-worklet.js', import.meta.url));
      if (id !== generation) return;
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, 'quietchat-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maxSamples: Math.floor(context.sampleRate * MEDIA_LIMITS.audioSeconds) } });
      node.port.onmessage = ({ data }) => {
        if (id !== generation || state !== 'recording') { data.samples?.fill(0); return; }
        if (data.samples instanceof Float32Array) {
          if (samples + data.samples.length > context.sampleRate * MEDIA_LIMITS.audioSeconds) { data.samples.fill(0); cancel(); onError?.(new Error('Превышен предел записи.')); return; }
          chunks.push(data.samples); samples += data.samples.length; onProgress?.(samples / (context.sampleRate * MEDIA_LIMITS.audioSeconds));
        }
        if (data.done) void finish(id);
      };
      source.connect(node); node.connect(context.destination); notify('recording');
      timer = setTimeout(() => { if (id === generation) stop(); }, MEDIA_LIMITS.audioSeconds * 1000);
    } catch (error) {
      if (id === generation) { release(); clearChunks(); notify('idle'); onError?.(error); }
    }
  }
  function stop() {
    if (state !== 'recording') { if (state === 'starting') cancel(); return; }
    // Stop physical microphone immediately; the processor flushes already captured PCM.
    stream?.getTracks().forEach((track) => track.stop());
    node?.port.postMessage({ type: 'stop' });
    clearTimeout(timer);
    // A browser can suspend its audio thread; never leave UI/key lifetime waiting for it.
    const id = generation; timer = setTimeout(() => void finish(id), 500);
  }
  return { start, stop, cancel, get isRecording() { return state === 'recording'; }, get state() { return state; } };
}
