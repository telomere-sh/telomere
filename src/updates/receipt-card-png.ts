import { deflateSync } from 'node:zlib';
import type { SharedReceipt } from './receipt-links.js';

const WIDTH = 1200, HEIGHT = 630, CHANNELS = 3;
const PAPER = [240, 238, 233] as const, INK = [25, 25, 25] as const, ORANGE = [252, 93, 36] as const;
type Color = readonly [number, number, number];
// Original 5×7 bitmap glyphs: seven rows, each encoded as five horizontal bits.
// Labels, atomic decimal amounts, hashes and ISO UTC timestamps need ASCII only.
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  ' ': [0,0,0,0,0,0,0],
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [15,16,16,16,16,16,15],
  D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [15,16,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [31,4,4,4,4,4,31],
  J: [7,2,2,2,18,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,25,25,21,19,19,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17],
  S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14],
  V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,21,10], X: [17,17,10,4,10,17,17],
  Y: [17,17,10,4,4,4,4], Z: [31,1,2,4,8,16,31],
  '0': [14,17,19,21,25,17,14], '1': [4,12,4,4,4,4,14], '2': [14,17,1,2,4,8,31],
  '3': [30,1,1,14,1,1,30], '4': [2,6,10,18,31,2,2], '5': [31,16,16,30,1,1,30],
  '6': [14,16,16,30,17,17,14], '7': [31,1,2,4,8,8,8], '8': [14,17,17,14,17,17,14],
  '9': [14,17,17,15,1,1,14], '.': [0,0,0,0,0,12,12], ':': [0,12,12,0,12,12,0],
  '-': [0,0,0,31,0,0,0], '/': [1,2,2,4,8,8,16], '?': [14,17,1,2,4,0,4],
};
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type: 'IHDR' | 'IDAT' | 'IEND', data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 4, 'ascii'); bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < 8 + data.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 255]! ^ (crc >>> 8);
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return bytes;
}
function amount(value: string): string {
  if (!/^(0|[1-9][0-9]{0,27})$/.test(value)) throw new Error('Invalid shared amount');
  const atomic = BigInt(value);
  return `${atomic / 1000000n}.${(atomic % 1000000n).toString().padStart(6, '0')} USDC`;
}

/** Fixed-size RGB PNG; no browser, font files, remote URLs, or raster dependency. */
export function renderReceiptCardPng(receipt: SharedReceipt): Buffer {
  const summary = receipt.summary;
  if (![summary.runId, summary.receiptHash, summary.settlementTxHash].every(value => /^0x[0-9a-f]{64}$/i.test(value))
    || !Number.isSafeInteger(summary.billableSeconds) || summary.billableSeconds < 0 || summary.billableSeconds > 120
    || !Number.isSafeInteger(summary.chainId) || summary.chainId < 1) throw new Error('Invalid shared summary');
  const checkedAt = new Date(receipt.asOf).toISOString();
  // One unfiltered RGB scanline per row. Fixed dimensions bound both allocation
  // and zlib input size regardless of the caller's data.
  const stride = WIDTH * CHANNELS + 1, pixels = Buffer.alloc(HEIGHT * stride);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const offset = y * stride + 1 + x * CHANNELS;
    pixels[offset] = PAPER[0]; pixels[offset + 1] = PAPER[1]; pixels[offset + 2] = PAPER[2];
  }
  const rectangle = (left: number, top: number, width: number, height: number, color: Color): void => {
    for (let y = Math.max(0, top); y < Math.min(HEIGHT, top + height); y++) {
      for (let x = Math.max(0, left); x < Math.min(WIDTH, left + width); x++) {
        const offset = y * stride + 1 + x * CHANNELS;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
    }
  };
  const line = (value: string, top: number, scale: number): void => {
    const text = value.toUpperCase();
    // Fail rather than clip an identifier or amount. Current longest hash row is
    // 71 characters at scale 2 (852 px), inside the 1024 px text region.
    if (text.length * 6 * scale > 1024) throw new Error('Shared card text exceeds its fixed line');
    for (let index = 0; index < text.length; index++) {
      const glyph = GLYPHS[text[index]!] ?? GLYPHS['?']!;
      for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
        if (glyph[row]! & (1 << (4 - column))) rectangle(88 + index * 6 * scale + column * scale, top + row * scale, scale, scale, INK);
      }
    }
  };
  rectangle(48, 48, 8, 534, ORANGE);
  line('TELOMERE / SHARED RECEIPT', 62, 4);
  line('CANONICAL SETTLEMENT VERIFIED', 114, 3);
  rectangle(88, 154, 1024, 2, ORANGE);
  line(`CHARGED ${amount(summary.charged)}`, 180, 3);
  line(`REFUND ${amount(summary.refund)}`, 224, 3);
  line(`CEILING ${amount(summary.ceiling)}`, 268, 3);
  line(`BILLABLE SECONDS ${summary.billableSeconds} / CHAIN ${summary.chainId}`, 324, 2);
  line(`RUN ${summary.runId}`, 374, 2);
  line(`HASH ${summary.receiptHash}`, 414, 2);
  line(`TX ${summary.settlementTxHash}`, 454, 2);
  line(`CHECKED ${checkedAt}`, 510, 2);
  line('OWNER OPT-IN / CURRENT CANONICAL CHECK', 558, 2);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
