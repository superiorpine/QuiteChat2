import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 'ascii'); chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function taggedPng({ width = 2, height = 1, animated = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const metadata = [
    pngChunk('tEXt', Buffer.from('Comment\0PRIVATE-COMMENT-51.5074,-0.1278')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>PRIVATE-XMP-OWNER</x:xmpmeta>')),
    // TIFF little endian IFD with ImageDescription tag = PRIVATE-EXIF-OWNER.
    pngChunk('eXIf', Buffer.concat([
      Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x0e, 0x01, 2, 0, 19, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from('PRIVATE-EXIF-OWNER\0\0'),
    ])),
  ];
  if (animated) metadata.push(pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])));
  // One scanline of two RGBA pixels, used only with normal dimensions for decoding.
  const idat = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), ...metadata, pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]));
}

export function riffChunk(type, bytes) {
  const result = Buffer.alloc(8 + bytes.length + bytes.length % 2);
  result.write(type); result.writeUInt32LE(bytes.length, 4); result.set(bytes, 8);
  return result;
}

export function taggedWav({ seconds = 0.05, sampleRate = 32000 } = {}) {
  const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1); fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4); fmt.writeUInt32LE(sampleRate * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const pcm = Buffer.alloc(Math.ceil(seconds * sampleRate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / sampleRate * Math.PI * 2 * 440) * 5000), i * 2);
  const tags = Buffer.concat([Buffer.from('INFO'), riffChunk('INAM', Buffer.from('PRIVATE-SONG-TITLE\0')), riffChunk('IART', Buffer.from('PRIVATE-RECORDER-NAME\0'))]);
  const payload = Buffer.concat([Buffer.from('WAVE'), riffChunk('fmt ', fmt), riffChunk('LIST', tags), riffChunk('data', pcm)]);
  const result = Buffer.alloc(8 + payload.length); result.write('RIFF'); result.writeUInt32LE(payload.length, 4); result.set(payload, 8);
  return new Uint8Array(result);
}

export function taggedJpeg(baseJpeg) {
  // A real TIFF ImageDescription and GPS IFD (51° 30' 26.64" N, 0° 7' 40.08" W).
  const description = Buffer.from('PRIVATE-EXIF-OWNER\0');
  const tiff = Buffer.alloc(8 + 2 + 24 + 4 + description.length + 2 + 48 + 4 + 48);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x010e, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(description.length, 14); tiff.writeUInt32LE(38, 18);
  const gps = 38 + description.length;
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(gps, 30);
  tiff.set(description, 38); tiff.writeUInt16LE(4, gps);
  const rationalStart = gps + 2 + 48 + 4;
  const tags = [
    { tag: 1, type: 2, count: 2, value: 78 },
    { tag: 2, type: 5, count: 3, value: rationalStart },
    { tag: 3, type: 2, count: 2, value: 87 },
    { tag: 4, type: 5, count: 3, value: rationalStart + 24 },
  ];
  tags.forEach((tag, i) => {
    const p = gps + 2 + i * 12; tiff.writeUInt16LE(tag.tag, p); tiff.writeUInt16LE(tag.type, p + 2); tiff.writeUInt32LE(tag.count, p + 4); tiff.writeUInt32LE(tag.value, p + 8);
  });
  [[51, 1], [30, 1], [2664, 100], [0, 1], [7, 1], [4008, 100]].forEach(([n, den], i) => { tiff.writeUInt32LE(n, rationalStart + i * 8); tiff.writeUInt32LE(den, rationalStart + i * 8 + 4); });
  function segment(marker, data) {
    const out = Buffer.alloc(data.length + 4); out[0] = 255; out[1] = marker; out.writeUInt16BE(data.length + 2, 2); out.set(data, 4); return out;
  }
  const exif = segment(225, Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
  const xmp = segment(225, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>PRIVATE-XMP-JPEG</x:xmpmeta>'));
  const comment = segment(254, Buffer.from('PRIVATE-JPEG-COMMENT'));
  return new Uint8Array(Buffer.concat([Buffer.from(baseJpeg).subarray(0, 2), exif, xmp, comment, Buffer.from(baseJpeg).subarray(2)]));
}

export function mp3Frames(count = 10) {
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, stereo; valid frame boundaries for parser tests.
  // Zero payload intentionally is not presented as a decoder compatibility fixture.
  const result = new Uint8Array(417 * count);
  for (let i = 0; i < count; i++) result.set([255, 251, 144, 0], i * 417);
  return result;
}

export function opusOgg() {
  const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt32LE(48000, 12);
  const packets = [head, Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'binary'), Buffer.from([0xf8, 0xff, 0xfe])];
  const pages = packets.map((packet, sequence) => {
    const page = Buffer.alloc(28 + packet.length); page.write('OggS'); page[5] = sequence === 0 ? 2 : sequence === 2 ? 4 : 0;
    page.writeUInt32LE(12345, 14); page.writeUInt32LE(sequence, 18); page[26] = 1; page[27] = packet.length; page.set(packet, 28);
    // Ogg checksum intentionally omitted: fixture tests bounded structural preflight,
    // not successful decode. Full decode is verified with PCM in browser tests.
    return page;
  });
  return new Uint8Array(Buffer.concat(pages));
}
