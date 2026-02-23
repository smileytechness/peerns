// Generates minimal solid-color PNG icons for the PWA manifest.
// Run once: node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(typeStr, data) {
  const type = Buffer.from(typeStr, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([type, d])));
  return Buffer.concat([len, type, d, crcBuf]);
}
function makePNG(w, h, r, g, b) {
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no interlace
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      row[1 + x*3] = r; row[2 + x*3] = g; row[3 + x*3] = b;
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
// Blue brand color: #1f6feb
writeFileSync('public/icon-192.png', makePNG(192, 192, 0x1f, 0x6f, 0xeb));
writeFileSync('public/icon-512.png', makePNG(512, 512, 0x1f, 0x6f, 0xeb));
console.log('✓ public/icon-192.png');
console.log('✓ public/icon-512.png');
