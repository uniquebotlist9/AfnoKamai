// Builds /favicon.ico (multi-size, PNG-compressed entries) from assets/icon-512.png.
// Run: node scripts/make-favicon.cjs   — requires assets/icon-512.png to exist.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon-512.png');
const OUT = path.join(ROOT, 'favicon.ico');

// ── minimal PNG decoder (8-bit RGBA/RGB/palette, non-interlaced) ────────
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8, w, h, bitDepth, colorType, idat = [], palette = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      line[i] = v;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      let r, g, b2, al = 255;
      if (colorType === 6) { r = line[x * 4]; g = line[x * 4 + 1]; b2 = line[x * 4 + 2]; al = line[x * 4 + 3]; }
      else if (colorType === 2) { r = line[x * 3]; g = line[x * 3 + 1]; b2 = line[x * 3 + 2]; }
      else if (colorType === 3) { const p = line[x] * 3; r = palette[p]; g = palette[p + 1]; b2 = palette[p + 2]; }
      else { r = g = b2 = line[x]; }
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b2; out[o + 3] = al;
    }
  }
  return { w, h, data: out };
}

function resize(src, size) {
  const dst = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y + 0.5) * src.h / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.w - 1, Math.floor((x + 0.5) * src.w / size));
      const s = (sy * src.w + sx) * 4, d = (y * size + x) * 4;
      dst[d] = src.data[s]; dst[d + 1] = src.data[s + 1];
      dst[d + 2] = src.data[s + 2]; dst[d + 3] = src.data[s + 3];
    }
  }
  return { w: size, h: size, data: dst };
}

// ── PNG encoder (RGBA, filter 0) ────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = img.w * 4;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const src = decodePNG(fs.readFileSync(SRC));
const sizes = [16, 32, 48, 64];
const images = sizes.map((s) => ({ size: s, png: encodePNG(resize(src, s)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const entries = [];
for (const im of images) {
  const e = Buffer.alloc(16);
  e[0] = im.size === 256 ? 0 : im.size;
  e[1] = im.size === 256 ? 0 : im.size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(im.png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += im.png.length;
  entries.push(e);
}
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
console.log('wrote favicon.ico', fs.statSync(OUT).size, 'bytes');
