import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const dir = dirname(fileURLToPath(import.meta.url));
await mkdir(dir, { recursive: true });
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, checksum]);
}
const width = 640, height = 480;
const pixels = Buffer.alloc(height * (width * 4 + 1));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    pixels[offset] = Math.round(55 + 100 * x / width);
    pixels[offset + 1] = Math.round(100 + 90 * y / height);
    pixels[offset + 2] = x > 130 && x < 510 && y > 100 && y < 390 ? 245 : 165;
    pixels[offset + 3] = 255;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
await writeFile(join(dir, 'sample.png'), png);
for (let i = 1; i <= 2; i++) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let j = 1; j <= i + 1; j++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 48, y: 650, width: 499, height: 130, color: rgb(0.84, 0.90, 1) });
    page.drawText(`Filefit PDF ${i} / page ${j}`, { x: 65, y: 710, size: 28, font, color: rgb(0.12, 0.24, 0.55) });
    page.drawText(`Submission sample document ${j}`, { x: 65, y: 610, size: 15, font });
  }
  await writeFile(join(dir, `sample-${i}.pdf`), await doc.save());
}
console.log('Created sample image and PDFs');
