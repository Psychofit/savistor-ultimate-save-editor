/** UI-only helpers for rendering bytes. Kept out of `core` since they are
 * presentation concerns, not data logic. */

/** Render a classic offset | hex | ascii hex dump for the first `limit` bytes. */
export function hexDump(bytes: Uint8Array, limit = 4096, bytesPerRow = 16): string {
  const len = Math.min(bytes.length, limit);
  const rows: string[] = [];
  for (let off = 0; off < len; off += bytesPerRow) {
    const slice = bytes.subarray(off, Math.min(off + bytesPerRow, len));
    const offset = off.toString(16).padStart(8, "0");
    let hex = "";
    let ascii = "";
    for (let i = 0; i < bytesPerRow; i++) {
      if (i < slice.length) {
        hex += slice[i].toString(16).padStart(2, "0") + " ";
        const c = slice[i];
        ascii += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
      } else {
        hex += "   ";
        ascii += " ";
      }
      if (i === 7) hex += " ";
    }
    rows.push(`${offset}  ${hex} |${ascii}|`);
  }
  if (bytes.length > len) {
    rows.push(`… ${bytes.length - len} more bytes (truncated for display)`);
  }
  return rows.join("\n");
}

/** Pretty-print JSON if possible; otherwise return the original text unchanged. */
export function tryFormatJson(text: string, indent = 2): { text: string; ok: boolean; error?: string } {
  try {
    const parsed = JSON.parse(text);
    return { text: JSON.stringify(parsed, null, indent), ok: true };
  } catch (e) {
    return { text, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Trigger a browser download of the given bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a plain ArrayBuffer-backed view so the Blob accepts it regardless
  // of how the source bytes were backed (subarray / SharedArrayBuffer).
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Suggest an output filename, marking it as edited to avoid clobbering originals. */
export function suggestOutputName(original: string): string {
  const dot = original.lastIndexOf(".");
  if (dot <= 0) return `${original}.edited`;
  return `${original.slice(0, dot)}.edited${original.slice(dot)}`;
}
