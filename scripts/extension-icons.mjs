import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
// Original, code-drawn mark: a navy play triangle on a pale blue tile.
export function extensionIcon(size) {
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const color = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const u = (x + (sx + .5) / 4) / size, v = (y + (sy + .5) / 4) / size;
      const dx = Math.max(.22 - u, 0, u - .78), dy = Math.max(.22 - v, 0, v - .78);
      if (dx * dx + dy * dy > .20 * .20) continue;
      const play = u >= .36 && u <= .73 && Math.abs(v - .5) <= (.73 - u) * .65;
      const rgb = play ? [30, 64, 105] : [211, 229, 250];
      for (let c = 0; c < 3; c++) color[c] += rgb[c];
      color[3]++;
    }
    const offset = y * (1 + size * 4) + 1 + x * 4;
    for (let c = 0; c < 3; c++) rows[offset + c] = color[3] ? Math.round(color[c] / color[3]) : 0;
    rows[offset + 3] = Math.round(color[3] / 16 * 255);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
