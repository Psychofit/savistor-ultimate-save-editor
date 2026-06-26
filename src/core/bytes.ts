/**
 * Low-level byte helpers shared across the core. Everything in `core` operates
 * on `Uint8Array` as the canonical representation of "raw save bytes", and on
 * `string` for textual/JSON views. These helpers are environment-agnostic (no
 * DOM, no Node Buffer) so the core can run in a browser, a worker, or tests.
 */

const textEncoder = new TextEncoder();

/** UTF-8 encode a string to bytes. */
export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * Decode bytes as UTF-8 text. `fatal` controls whether invalid sequences throw
 * (useful when probing whether a blob is really text).
 */
export function utf8Decode(bytes: Uint8Array, fatal = false): string {
  return new TextDecoder("utf-8", { fatal }).decode(bytes);
}

/** Decode bytes as Latin-1 (each byte → one code point). Never throws. */
export function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Latin-1 encode a string (code points 0..255) back to bytes. */
export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Lowercase hex string (no separators) for the given bytes. */
export function toHex(bytes: Uint8Array, separator = ""): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
    if (separator && i < bytes.length - 1) out += separator;
  }
  return out;
}

/** Parse a hex string (ignoring whitespace and common separators) into bytes. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) {
    throw new Error("Hex string has an odd number of nibbles");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Concatenate several byte arrays into one. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** True if `bytes` begins with the given prefix. */
export function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** Byte-for-byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Heuristic: does this blob look like printable text rather than binary?
 * We require it to be valid UTF-8 and to contain very few control bytes.
 */
export function looksLikeText(bytes: Uint8Array, sampleSize = 4096): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, sampleSize);
  try {
    utf8Decode(sample, true);
  } catch {
    return false;
  }
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    // Allow tab (9), LF (10), CR (13). Anything else below 0x20 is "control".
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  return control / sample.length < 0.02;
}

/**
 * Shannon entropy in bits/byte (0..8). Values near 8 strongly suggest the data
 * is compressed or encrypted; low values suggest text or structured binary.
 */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Format a byte count as a short human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
