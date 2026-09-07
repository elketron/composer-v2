// Generates the app icons (build/icon.png 512px, build/icon.ico, and the
// resources icon.png) without image-tooling: the composer diamond logo is
// rasterized per pixel and encoded as PNG with node's zlib. Run:
//   node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- Tiny PNG encoder (RGBA, filter 0) ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- The logo: composer's diamond on a dark rounded tile ----
const BG = [22, 22, 24];
const TILE = [238, 238, 240];
const ACCENT = [138, 130, 204]; // --accent-soft

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const half = size * 0.27; // diamond half-diagonal
  const stroke = size * 0.045;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x - center;
      const py = y - center;
      const cornerX = Math.abs(px) + Math.abs(py); // diamond distance
      // Rounded-tile mask (half-size h, corner radius r).
      const h = size * 0.48;
      const r = size * 0.12;
      const tileDx = Math.max(Math.abs(px) - (h - r), 0);
      const tileDy = Math.max(Math.abs(py) - (h - r), 0);
      const insideTile = Math.hypot(tileDx, tileDy) <= r;
      let color;
      let alpha;
      if (!insideTile) {
        color = BG;
        alpha = 0;
      } else {
        const ring = Math.abs(cornerX - half);
        if (ring <= stroke) {
          color = ACCENT;
        } else if (cornerX <= half * 0.45) {
          color = TILE; // small solid diamond core
        } else {
          color = BG;
        }
        alpha = 255;
      }
      const at = (y * size + x) * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

// ---- ICO wrapper (PNG-compressed entries are valid on Vista+) ----
function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 = 0
  entry[1] = 0; // height 256 = 0
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // data offset
  return Buffer.concat([header, entry, png]);
}

const build = join(root, 'build');
mkdirSync(build, { recursive: true });

const png256 = makeIcon(256);
const png512 = makeIcon(512);
writeFileSync(join(build, 'icon.png'), png512);
writeFileSync(join(build, 'icon.ico'), makeIco(png256));
mkdirSync(join(root, 'build', 'resources'), { recursive: true });
writeFileSync(join(build, 'resources', 'icon.png'), png512);
console.log(`icons written to ${build}`);
