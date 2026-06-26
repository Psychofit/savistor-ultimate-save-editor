/**
 * Game profiles. A profile is a named recipe: "this is what this game's save
 * looks like, here's the codec stack to open it, and here's the kind of payload
 * you'll be editing." Profiles power the one-click "open as ..." experience.
 *
 * Design goals:
 *  - Honesty. A profile only claims a match when it can actually decode the file.
 *    We never label a file by extension alone.
 *  - Extensibility. Adding support for a new game is just adding a profile object
 *    to the registry — ideally derived from a couple of real sample saves.
 */

import { looksLikeText, utf8Decode } from "./bytes";
import { looksLikeIni } from "./ini";
import { decodePipeline, PipelineStep } from "./pipeline";

export type PayloadKind = "json" | "text" | "ini" | "binary";

export interface ProfileMatch {
  confidence: number;
  reason: string;
}

export interface GameProfile {
  id: string;
  name: string;
  description: string;
  /** Filename/extension hints, lowercase, including the dot (e.g. ".rpgsave"). */
  extensions: string[];
  /** Codec stack to open the file (decode order, outermost first). */
  pipeline: PipelineStep[];
  /** What the decoded payload is, so the UI can pick the right editor. */
  payloadKind: PayloadKind;
  /** Try to recognize the file. Returns null when it is not this format. */
  match(bytes: Uint8Array, filename?: string): ProfileMatch | null;
}

function ext(filename?: string): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/** Decode through a pipeline and return the payload text iff it parses as JSON. */
function decodesToJson(bytes: Uint8Array, steps: PipelineStep[]): string | null {
  const run = decodePipeline(bytes, steps);
  if (!run.ok) return null;
  let text: string;
  try {
    text = utf8Decode(run.output, true);
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    JSON.parse(trimmed);
    return text;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ RPG Maker MV/MZ */

const rpgMaker: GameProfile = {
  id: "rpgmaker-mvmz",
  name: "RPG Maker MV / MZ",
  description:
    "Save files (.rpgsave / .rmmzsave) are JSON compressed with lz-string and stored as Base64.",
  extensions: [".rpgsave", ".rmmzsave"],
  pipeline: [{ codecId: "lzstring-base64" }],
  payloadKind: "json",
  match(bytes, filename) {
    const json = decodesToJson(bytes, this.pipeline);
    if (!json) return null;
    const hasExt = this.extensions.includes(ext(filename));
    return {
      confidence: hasExt ? 0.97 : 0.85,
      reason: hasExt
        ? "extension matches and lz-string Base64 decodes to JSON"
        : "lz-string Base64 decodes to valid JSON (RPG Maker style)",
    };
  },
};

/* ------------------------------------------------------------- gzip-wrapped JSON */

const gzipJson: GameProfile = {
  id: "gzip-json",
  name: "gzip-compressed JSON",
  description: "A JSON save wrapped in a single gzip stream — common in indie/Unity games.",
  extensions: [".sav", ".save", ".dat", ".json", ".gz"],
  pipeline: [{ codecId: "gzip" }],
  payloadKind: "json",
  match(bytes) {
    if (!(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return null;
    const json = decodesToJson(bytes, this.pipeline);
    if (!json) return null;
    return { confidence: 0.9, reason: "gzip stream that inflates to valid JSON" };
  },
};

/* ----------------------------------------------------------- zlib-wrapped JSON */

const zlibJson: GameProfile = {
  id: "zlib-json",
  name: "zlib-compressed JSON",
  description: "A JSON save wrapped in a zlib (deflate) stream.",
  extensions: [".sav", ".save", ".dat", ".json"],
  pipeline: [{ codecId: "zlib" }],
  payloadKind: "json",
  match(bytes) {
    if (bytes.length < 2 || (bytes[0] & 0x0f) !== 8) return null;
    if (((bytes[0] << 8) | bytes[1]) % 31 !== 0) return null;
    const json = decodesToJson(bytes, this.pipeline);
    if (!json) return null;
    return { confidence: 0.85, reason: "zlib stream that inflates to valid JSON" };
  },
};

/* --------------------------------------------------------------- Base64 JSON */

const base64Json: GameProfile = {
  id: "base64-json",
  name: "Base64-encoded JSON",
  description: "A JSON save stored as a Base64 text blob.",
  extensions: [".sav", ".save", ".dat", ".txt"],
  pipeline: [{ codecId: "base64" }],
  payloadKind: "json",
  match(bytes) {
    if (!looksLikeText(bytes)) return null;
    const text = utf8Decode(bytes.subarray(0, 256)).trim();
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
    const json = decodesToJson(bytes, this.pipeline);
    if (!json) return null;
    return { confidence: 0.8, reason: "Base64 text that decodes to valid JSON" };
  },
};

/* ----------------------------------------------- Unreal compressed save (.sav) */

const unrealCompressed: GameProfile = {
  id: "unreal-compressed",
  name: "Unreal Engine compressed save",
  description:
    "Unreal .sav stored as a chain of compressed chunks (PACKAGE_FILE_TAG). Decodes to the raw inner save bytes — tested on System Shock (2023). Re-chunks & recompresses on save.",
  extensions: [".sav"],
  pipeline: [{ codecId: "ue-compressed", options: { blockFormat: "gzip" } }],
  payloadKind: "binary",
  match(bytes) {
    if (bytes.length < 48) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x9e2a83c1) return null;
    const run = decodePipeline(bytes, this.pipeline);
    if (!run.ok || run.output.length === 0) return null;
    return {
      confidence: 0.95,
      reason: `Unreal compressed-chunk archive → ${run.output.length.toLocaleString()} bytes inner payload`,
    };
  },
};

/* ----------------------------------------------------- INI / key=value text save */

const iniKeyValue: GameProfile = {
  id: "ini-keyvalue",
  name: "INI / key=value text save",
  description:
    "A flat [Section] + KEY=\"value\" text save (common in Unity games such as Hole Dweller). Edit values directly as fields.",
  extensions: [".sav", ".save", ".ini", ".cfg", ".txt"],
  pipeline: [],
  payloadKind: "ini",
  match(bytes) {
    if (!looksLikeText(bytes)) return null;
    let text: string;
    try {
      text = utf8Decode(bytes, true);
    } catch {
      return null;
    }
    if (!looksLikeIni(text)) return null;
    return { confidence: 0.86, reason: "INI-style sections and KEY=value lines" };
  },
};

/* ---------------------------------------------------------------- plain JSON */

const plainJson: GameProfile = {
  id: "plain-json",
  name: "Plain JSON",
  description: "The save is already plain-text JSON; edit it directly.",
  extensions: [".json", ".sav", ".save", ".dat"],
  pipeline: [],
  payloadKind: "json",
  match(bytes) {
    const json = decodesToJson(bytes, []);
    if (!json) return null;
    return { confidence: 0.9, reason: "file is valid JSON text" };
  },
};

/* ---------------------------------------------------------------- registry */

export const PROFILES: GameProfile[] = [
  unrealCompressed,
  rpgMaker,
  gzipJson,
  zlibJson,
  base64Json,
  iniKeyValue,
  plainJson,
];

export interface ProfileSuggestion {
  profile: GameProfile;
  match: ProfileMatch;
}

/** Run every profile and return matches sorted by confidence (best first). */
export function matchProfiles(bytes: Uint8Array, filename?: string): ProfileSuggestion[] {
  const out: ProfileSuggestion[] = [];
  for (const profile of PROFILES) {
    try {
      const m = profile.match(bytes, filename);
      if (m) out.push({ profile, match: m });
    } catch {
      // A profile's matcher must never break detection for the others.
    }
  }
  out.sort((a, b) => b.match.confidence - a.match.confidence);
  return out;
}

export function getProfile(id: string): GameProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}
