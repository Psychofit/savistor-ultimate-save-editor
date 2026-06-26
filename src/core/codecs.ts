/**
 * Codecs: reversible byte transforms. Save files are very often an onion —
 * base64( gzip( json ) ), or lz-string( json ), or xor( ... ). Each codec knows
 * how to peel one layer (`decode`) and how to put it back exactly (`encode`) so
 * that after editing the inner data we can rebuild a byte-identical wrapper.
 *
 * Everything is bytes-in / bytes-out so codecs compose into a pipeline. Text
 * layers (base64, hex, lz-string) treat their textual side as UTF-8 bytes.
 */

import { gzip, ungzip, inflate, deflate, inflateRaw, deflateRaw } from "pako";
import LZString from "lz-string";
import { fromHex, latin1Decode, latin1Encode, toHex, utf8Decode, utf8Encode } from "./bytes";

export type CodecOptions = Record<string, string | number | undefined>;

export interface CodecParam {
  name: string;
  label: string;
  type: "text" | "hex" | "select";
  default?: string;
  options?: string[];
  placeholder?: string;
}

export interface Codec {
  id: string;
  label: string;
  /** Short description shown in the UI. */
  description: string;
  /** Grouping for the UI: encoding, compression, obfuscation. */
  group: "encoding" | "compression" | "obfuscation";
  /** "Open" direction: peel this layer. */
  decode(input: Uint8Array, opts?: CodecOptions): Uint8Array;
  /** "Close" direction: re-apply this layer when re-saving. */
  encode(input: Uint8Array, opts?: CodecOptions): Uint8Array;
  /** Parameters the user can configure (e.g. an XOR key). */
  params?: CodecParam[];
}

/* ------------------------------------------------------------------ base64 */

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes: Uint8Array, urlSafe = false, pad = true): string {
  const alpha = urlSafe ? B64_STD.slice(0, 62) + "-_" : B64_STD;
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += alpha[b0 >> 2];
    out += alpha[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? alpha[((b1 & 15) << 2) | (b2 >> 6)] : pad ? "=" : "";
    out += i + 2 < len ? alpha[b2 & 63] : pad ? "=" : "";
  }
  return out;
}

function base64Decode(text: string): Uint8Array {
  // Accept both standard and url-safe; ignore whitespace and padding.
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_STD.length; i++) lookup[B64_STD.charCodeAt(i)] = i;
  lookup["-".charCodeAt(0)] = 62;
  lookup["_".charCodeAt(0)] = 63;

  const clean: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const v = lookup[text.charCodeAt(i)];
    if (v >= 0) clean.push(v);
  }
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bitBuf = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < clean.length; i++) {
    bitBuf = (bitBuf << 6) | clean[i];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (bitBuf >> bits) & 0xff;
    }
  }
  return out.subarray(0, oi);
}

const base64Codec: Codec = {
  id: "base64",
  label: "Base64",
  description: "Standard Base64 text encoding (A–Z a–z 0–9 + /).",
  group: "encoding",
  decode: (input) => base64Decode(utf8Decode(input)),
  encode: (input) => utf8Encode(base64Encode(input)),
};

const base64UrlCodec: Codec = {
  id: "base64url",
  label: "Base64 URL-safe",
  description: "URL-safe Base64 (uses - and _, no padding).",
  group: "encoding",
  decode: (input) => base64Decode(utf8Decode(input)),
  encode: (input) => utf8Encode(base64Encode(input, true, false)),
};

/* --------------------------------------------------------------------- hex */

const hexCodec: Codec = {
  id: "hex",
  label: "Hex",
  description: "Hexadecimal text (two chars per byte).",
  group: "encoding",
  decode: (input) => fromHex(utf8Decode(input)),
  encode: (input) => utf8Encode(toHex(input)),
};

/* -------------------------------------------------------------- compression */

const gzipCodec: Codec = {
  id: "gzip",
  label: "gzip",
  description: "gzip stream (RFC 1952). decode = gunzip, encode = gzip.",
  group: "compression",
  decode: (input) => ungzip(input),
  encode: (input) => gzip(input),
};

const zlibCodec: Codec = {
  id: "zlib",
  label: "zlib (deflate)",
  description: "zlib-wrapped DEFLATE (RFC 1950).",
  group: "compression",
  decode: (input) => inflate(input),
  encode: (input) => deflate(input),
};

const deflateRawCodec: Codec = {
  id: "deflate-raw",
  label: "DEFLATE (raw)",
  description: "Raw DEFLATE with no zlib/gzip header (RFC 1951).",
  group: "compression",
  decode: (input) => inflateRaw(input),
  encode: (input) => deflateRaw(input),
};

/* -------------------------------------------------------------- obfuscation */

function parseKey(opts: CodecOptions | undefined): Uint8Array {
  const keyHex = opts?.keyHex as string | undefined;
  const keyText = opts?.keyText as string | undefined;
  if (keyHex && keyHex.trim()) return fromHex(keyHex);
  if (keyText && keyText.length) return utf8Encode(keyText);
  throw new Error("XOR codec needs a key (hex or text)");
}

const xorCodec: Codec = {
  id: "xor",
  label: "XOR (repeating key)",
  description: "XOR every byte with a repeating key. Symmetric: decode == encode.",
  group: "obfuscation",
  params: [
    { name: "keyText", label: "Key (text)", type: "text", placeholder: "e.g. secret" },
    { name: "keyHex", label: "Key (hex)", type: "hex", placeholder: "e.g. DE AD BE EF" },
  ],
  decode: (input, opts) => xorBytes(input, parseKey(opts)),
  encode: (input, opts) => xorBytes(input, parseKey(opts)),
};

function xorBytes(input: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length === 0) return input.slice();
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] ^ key[i % key.length];
  return out;
}

/* --------------------------------------------------------------- lz-string */

// lz-string operates on JS strings. For pipeline composability we treat the
// compressed side as UTF-8 text bytes and the decompressed side as UTF-8 bytes.
function makeLzCodec(
  id: string,
  label: string,
  description: string,
  decompress: (s: string) => string | null,
  compress: (s: string) => string,
): Codec {
  return {
    id,
    label,
    description,
    group: "compression",
    decode: (input) => {
      const result = decompress(latin1Decode(input));
      if (result == null) throw new Error(`${label}: input is not valid lz-string data`);
      return utf8Encode(result);
    },
    encode: (input) => latin1Encode(compress(utf8Decode(input))),
  };
}

const lzBase64Codec = makeLzCodec(
  "lzstring-base64",
  "lz-string (Base64)",
  "lz-string compressToBase64 — used by RPG Maker MV/MZ .rpgsave files.",
  LZString.decompressFromBase64,
  LZString.compressToBase64,
);

const lzUriCodec = makeLzCodec(
  "lzstring-uri",
  "lz-string (URI)",
  "lz-string compressToEncodedURIComponent.",
  LZString.decompressFromEncodedURIComponent,
  LZString.compressToEncodedURIComponent,
);

const lzUtf16Codec = makeLzCodec(
  "lzstring-utf16",
  "lz-string (UTF-16)",
  "lz-string compressToUTF16.",
  LZString.decompressFromUTF16,
  LZString.compressToUTF16,
);

const lzRawCodec = makeLzCodec(
  "lzstring-raw",
  "lz-string (raw)",
  "lz-string compress/decompress (raw UTF-16 output).",
  LZString.decompress,
  LZString.compress,
);

/* ---------------------------------------------------------------- registry */

export const CODECS: Codec[] = [
  base64Codec,
  base64UrlCodec,
  hexCodec,
  gzipCodec,
  zlibCodec,
  deflateRawCodec,
  xorCodec,
  lzBase64Codec,
  lzUriCodec,
  lzUtf16Codec,
  lzRawCodec,
];

const CODEC_BY_ID = new Map(CODECS.map((c) => [c.id, c]));

export function getCodec(id: string): Codec | undefined {
  return CODEC_BY_ID.get(id);
}
