/**
 * Format detection. The hard truth about save files is that the extension
 * (.sav/.save/.dat) tells you almost nothing — the bytes do. This module sniffs
 * magic numbers, measures entropy, and probes for text/JSON/base64 so the UI can
 * suggest *what the file actually is* instead of guessing from the name.
 *
 * Detection never mutates data and never throws; it returns ranked guesses.
 */

import { looksLikeText, shannonEntropy, utf8Decode } from "./bytes";

export interface FormatGuess {
  /** Stable id, e.g. "gzip", "json", "zlib". */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** 0..1 rough confidence. */
  confidence: number;
  /** One-line explanation of *why* we think so. */
  reason: string;
  /**
   * Optional codec id (see codecs registry) that the UI can offer as a first
   * transform step to "open" this layer.
   */
  suggestedCodec?: string;
}

export interface Detection {
  size: number;
  entropy: number;
  /** High entropy strongly implies compression or encryption. */
  likelyCompressedOrEncrypted: boolean;
  printableText: boolean;
  guesses: FormatGuess[];
  /** Convenience: the first/highest-confidence guess, if any. */
  best?: FormatGuess;
}

interface Signature {
  id: string;
  label: string;
  magic: number[];
  reason: string;
  suggestedCodec?: string;
}

// Magic-number signatures for containers commonly wrapping save data.
const SIGNATURES: Signature[] = [
  { id: "gzip", label: "gzip stream", magic: [0x1f, 0x8b], reason: "starts with gzip magic 1F 8B", suggestedCodec: "gzip" },
  { id: "zip", label: "ZIP / PK archive", magic: [0x50, 0x4b, 0x03, 0x04], reason: "starts with PK\\x03\\x04 (local file header)" },
  { id: "zip-empty", label: "ZIP archive (empty)", magic: [0x50, 0x4b, 0x05, 0x06], reason: "starts with PK\\x05\\x06 (end of central dir)" },
  { id: "png", label: "PNG image", magic: [0x89, 0x50, 0x4e, 0x47], reason: "PNG signature" },
  { id: "sqlite", label: "SQLite database", magic: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], reason: "starts with 'SQLite' header" },
  { id: "lz4", label: "LZ4 frame", magic: [0x04, 0x22, 0x4d, 0x18], reason: "LZ4 frame magic" },
  { id: "zstd", label: "Zstandard stream", magic: [0x28, 0xb5, 0x2f, 0xfd], reason: "Zstandard magic" },
  { id: "bzip2", label: "bzip2 stream", magic: [0x42, 0x5a, 0x68], reason: "starts with 'BZh'" },
  // Unreal Engine GVAS save (.sav) — text "GVAS" header.
  { id: "unreal-gvas", label: "Unreal Engine save (GVAS)", magic: [0x47, 0x56, 0x41, 0x53], reason: "starts with 'GVAS' (Unreal SaveGame)" },
];

/** Detect a zlib stream by its header constraints rather than a fixed magic. */
function isZlib(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const cmf = bytes[0];
  const flg = bytes[1];
  const cm = cmf & 0x0f; // compression method, 8 = deflate
  if (cm !== 8) return false;
  return ((cmf << 8) | flg) % 31 === 0;
}

export function detect(bytes: Uint8Array): Detection {
  const entropy = shannonEntropy(bytes);
  const printableText = looksLikeText(bytes);
  const guesses: FormatGuess[] = [];

  // 1) Fixed magic signatures.
  for (const sig of SIGNATURES) {
    if (sig.magic.length === 0) continue;
    if (bytes.length < sig.magic.length) continue;
    let match = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (bytes[i] !== sig.magic[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      guesses.push({
        id: sig.id,
        label: sig.label,
        confidence: 0.97,
        reason: sig.reason,
        suggestedCodec: sig.suggestedCodec,
      });
    }
  }

  // 2) zlib (header-constrained, not a literal magic).
  if (isZlib(bytes) && !guesses.some((g) => g.id === "gzip")) {
    guesses.push({
      id: "zlib",
      label: "zlib (deflate) stream",
      confidence: 0.8,
      reason: "valid zlib header (CM=8, checksum mod 31)",
      suggestedCodec: "zlib",
    });
  }

  // 3) Text-based formats.
  if (printableText) {
    const text = utf8Decode(bytes.subarray(0, 65536)).trim();
    const firstChar = text[0];
    if (tryJson(text)) {
      guesses.push({ id: "json", label: "JSON text", confidence: 0.95, reason: "parses as JSON" });
    } else if (looksLikeKeyValueIni(text)) {
      guesses.push({
        id: "ini",
        label: "INI / key=value text",
        confidence: 0.75,
        reason: "INI-style sections and key=value lines",
      });
    } else if (firstChar === "{" || firstChar === "[") {
      guesses.push({
        id: "json",
        label: "JSON text",
        confidence: 0.6,
        reason: "starts with { or [ (JSON-like) but does not fully parse",
      });
    } else if (firstChar === "<") {
      guesses.push({ id: "xml", label: "XML / HTML text", confidence: 0.7, reason: "starts with '<'" });
    } else if (looksLikeBase64(text)) {
      guesses.push({
        id: "base64",
        label: "Base64 text",
        confidence: 0.65,
        reason: "only base64 characters; likely an encoded inner payload",
        suggestedCodec: "base64",
      });
    } else if (looksLikeKeyValueIni(text)) {
      guesses.push({ id: "ini", label: "INI / key=value text", confidence: 0.6, reason: "key=value lines" });
    } else {
      guesses.push({ id: "text", label: "Plain text", confidence: 0.5, reason: "printable UTF-8 text" });
    }
  }

  // 4) Entropy-based fallback when nothing else matched.
  const likelyCompressedOrEncrypted = entropy > 7.4 && bytes.length >= 64;
  if (guesses.length === 0) {
    if (likelyCompressedOrEncrypted) {
      guesses.push({
        id: "high-entropy",
        label: "Compressed or encrypted blob",
        confidence: 0.6,
        reason: `entropy ${entropy.toFixed(2)} bits/byte — no known header, likely compressed or encrypted`,
      });
    } else {
      guesses.push({
        id: "binary",
        label: "Unknown binary",
        confidence: 0.4,
        reason: `entropy ${entropy.toFixed(2)} bits/byte — structured binary with no recognized header`,
      });
    }
  }

  guesses.sort((a, b) => b.confidence - a.confidence);

  return {
    size: bytes.length,
    entropy,
    likelyCompressedOrEncrypted,
    printableText,
    guesses,
    best: guesses[0],
  };
}

function tryJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeBase64(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (t.length < 16 || t.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

function looksLikeKeyValueIni(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return false;
  const kv = lines.filter((l) => /^\s*[\w.\- ]+\s*[=:]/.test(l) || /^\s*\[.+\]\s*$/.test(l));
  return kv.length / lines.length > 0.6;
}
