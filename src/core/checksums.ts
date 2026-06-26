/**
 * Checksums & hashes. Many games store a checksum of the save payload and refuse
 * to load the file if it doesn't match. After editing, the editor must recompute
 * the right value and patch it back in. We provide the common ones used by save
 * formats: CRC32 (IEEE), Adler32, MD5, and SHA-* via WebCrypto.
 */

import { toHex } from "./bytes";

/* -------------------------------------------------------------------- CRC32 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32/IEEE (the variant used by zip, PNG, gzip, and most game saves). */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ Adler32 */

export function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  // Process in blocks so the running sums never overflow a double.
  while (i < bytes.length) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/* ---------------------------------------------------------------------- MD5 */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  }
  return k;
})();

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** Pure-JS MD5. Returns the 16-byte digest. */
export function md5(input: Uint8Array): Uint8Array {
  const lenBits = input.length * 8;
  // Padded length: original + 1 (0x80) + zeros, congruent to 56 mod 64, + 8 len.
  const paddedLen = ((input.length + 8) >> 6 << 6) + 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(input);
  msg[input.length] = 0x80;
  // 64-bit little-endian length in bits (low word then high word).
  const lo = lenBits >>> 0;
  const hi = Math.floor(lenBits / 2 ** 32) >>> 0;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, lo, true);
  dv.setUint32(paddedLen - 4, hi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(chunk + j * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

/* ---------------------------------------------------------------------- SHA */

export type ShaAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

/** SHA-1/256/384/512 via the Web Crypto API (async). */
export async function sha(algorithm: ShaAlgorithm, bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view so a subarray's offset/length
  // (or a SharedArrayBuffer backing) can't trip up subtle.digest.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest(algorithm, copy);
  return new Uint8Array(digest);
}

/* -------------------------------------------------------- UI-facing helpers */

export interface ChecksumResult {
  id: string;
  label: string;
  hex: string;
  /** For 32-bit checksums, also expose the numeric value and endian encodings. */
  uint32?: number;
  uint32leHex?: string;
  uint32beHex?: string;
}

function u32ToHex(value: number, little: boolean): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, little);
  return toHex(b);
}

/** Compute all synchronous checksums at once for display. */
export function computeChecksums(bytes: Uint8Array): ChecksumResult[] {
  const crc = crc32(bytes);
  const adler = adler32(bytes);
  return [
    {
      id: "crc32",
      label: "CRC-32",
      hex: u32ToHex(crc, false),
      uint32: crc,
      uint32leHex: u32ToHex(crc, true),
      uint32beHex: u32ToHex(crc, false),
    },
    {
      id: "adler32",
      label: "Adler-32",
      hex: u32ToHex(adler, false),
      uint32: adler,
      uint32leHex: u32ToHex(adler, true),
      uint32beHex: u32ToHex(adler, false),
    },
    { id: "md5", label: "MD5", hex: toHex(md5(bytes)) },
  ];
}
