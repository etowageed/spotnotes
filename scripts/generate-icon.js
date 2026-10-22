'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generateStickyNotePng(size = 128) {
  const rawRows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x += 1) {
      const idx = 1 + x * 4;
      const margin = Math.round(size * 0.08);
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
      if (!inside) {
        row[idx] = 0;
        row[idx + 1] = 0;
        row[idx + 2] = 0;
        row[idx + 3] = 0;
        continue;
      }

      const border = Math.max(2, Math.round(size * 0.03));
      const isBorder =
        x < margin + border ||
        x >= size - margin - border ||
        y < margin + border ||
        y >= size - margin - border;

      const headerBottom = margin + Math.round((size - margin * 2) * 0.22);
      const isHeader = y < headerBottom;

      const lineXStart = margin + Math.round(size * 0.16);
      const lineXEnd1 = size - margin - Math.round(size * 0.16);
      const lineXEnd2 = size - margin - Math.round(size * 0.28);
      const lineThick = Math.max(2, Math.round(size * 0.035));
      const yLine1 = margin + Math.round((size - margin * 2) * 0.44);
      const yLine2 = margin + Math.round((size - margin * 2) * 0.62);
      const yLine3 = margin + Math.round((size - margin * 2) * 0.80);

      const onLine1 = x >= lineXStart && x <= lineXEnd1 && Math.abs(y - yLine1) <= lineThick / 2;
      const onLine2 = x >= lineXStart && x <= lineXEnd1 && Math.abs(y - yLine2) <= lineThick / 2;
      const onLine3 = x >= lineXStart && x <= lineXEnd2 && Math.abs(y - yLine3) <= lineThick / 2;

      if (isBorder) {
        row[idx] = 0xde;
        row[idx + 1] = 0xc9;
        row[idx + 2] = 0x58;
        row[idx + 3] = 0xff;
      } else if (isHeader) {
        row[idx] = 0xf5;
        row[idx + 1] = 0xec;
        row[idx + 2] = 0x8b;
        row[idx + 3] = 0xff;
      } else if (onLine1 || onLine2 || onLine3) {
        row[idx] = 0x6c;
        row[idx + 1] = 0x66;
        row[idx + 2] = 0x48;
        row[idx + 3] = 0xff;
      } else {
        row[idx] = 0xff;
        row[idx + 1] = 0xf9;
        row[idx + 2] = 0xb1;
        row[idx + 3] = 0xff;
      }
    }
    rawRows.push(row);
  }

  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, generateStickyNotePng(128));
console.log(`Generated ${outPath}`);
