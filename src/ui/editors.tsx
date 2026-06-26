import { memo, useCallback, useMemo, useRef, useState } from "react";
import { fromHex, parseIni, serializeIni, toHex, utf8Decode, utf8Encode } from "../core";
import { downloadBytes, hexDump, tryFormatJson } from "./format";

/** Render bytes as a grouped, line-wrapped hex string for editing. */
function toEditableHex(bytes: Uint8Array): string {
  return toHex(bytes, " ").replace(/((?:[0-9a-f]{2} ){16})/g, "$1\n");
}

/* --------------------------------------------------------------- TextEditor */

/** Free text / JSON editor. Holds its own draft; pushes bytes up on every edit.
 * Remount (via a `key` on the parent) re-seeds it from a freshly decoded payload. */
export function TextEditor(props: { initial: Uint8Array; onBytes: (b: Uint8Array) => void }) {
  const [text, setText] = useState(() => utf8Decode(props.initial));
  const json = useMemo(() => {
    const t = text.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    return tryFormatJson(text);
  }, [text]);

  const set = (next: string) => {
    setText(next);
    props.onBytes(utf8Encode(next));
  };

  return (
    <>
      <div className="editor-subbar">
        {json && (
          <span className={json.ok ? "status good" : "status bad"}>
            {json.ok ? "Valid JSON" : `Invalid JSON: ${json.error}`}
          </span>
        )}
        <span className="spacer" />
        {json && (
          <button
            className="mini"
            disabled={!json.ok}
            onClick={() => json.ok && set(tryFormatJson(text).text)}
          >
            Format JSON
          </button>
        )}
      </div>
      <textarea className="code" spellCheck={false} value={text} onChange={(e) => set(e.target.value)} />
    </>
  );
}

/* ---------------------------------------------------------------- HexEditor */

/** Editable hex view for small binary payloads. */
export function HexEditor(props: { initial: Uint8Array; onBytes: (b: Uint8Array) => void }) {
  const [text, setText] = useState(() => toEditableHex(props.initial));
  const [error, setError] = useState<string | null>(null);

  const set = (next: string) => {
    setText(next);
    try {
      props.onBytes(fromHex(next));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {error && <p className="status bad">{error}</p>}
      <textarea
        className="code hex-edit"
        spellCheck={false}
        value={text}
        onChange={(e) => set(e.target.value)}
      />
    </>
  );
}

/* ---------------------------------------------------------------- IniEditor */

const IniPairRow = memo(function IniPairRow(props: {
  index: number;
  keyName: string;
  value: string;
  onUpdate: (index: number, value: string) => void;
}) {
  return (
    <label className="ini-pair">
      <span className="ini-key" title={props.keyName}>
        {props.keyName}
      </span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onUpdate(props.index, e.target.value)}
      />
    </label>
  );
});

/** Structured key/value editor for INI saves. Controlled by the payload bytes;
 * edits re-serialize the whole document so non-edited lines stay byte-faithful. */
export function IniEditor(props: { value: Uint8Array; onBytes: (b: Uint8Array) => void }) {
  const text = utf8Decode(props.value);
  const doc = useMemo(() => parseIni(text), [text]);
  const [filter, setFilter] = useState("");

  // Keep the latest doc / callback in refs so the row update handler can have a
  // stable identity — memoized rows then skip re-rendering on each keystroke.
  const docRef = useRef(doc);
  docRef.current = doc;
  const onBytesRef = useRef(props.onBytes);
  onBytesRef.current = props.onBytes;
  const stableUpdate = useCallback((index: number, value: string) => {
    const d = docRef.current;
    const nodes = d.nodes.map((n, i) => (i === index && n.type === "pair" ? { ...n, value } : n));
    onBytesRef.current(utf8Encode(serializeIni({ ...d, nodes })));
  }, []);

  const needle = filter.trim().toLowerCase();
  const pairCount = doc.nodes.filter((n) => n.type === "pair").length;

  return (
    <div className="ini-editor">
      <div className="editor-subbar">
        <input
          type="text"
          placeholder={`Filter ${pairCount} keys…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <div className="ini-fields">
        {doc.nodes.map((n, i) => {
          if (n.type === "section") {
            return (
              <h4 key={i} className="ini-section">
                [{n.name}]
              </h4>
            );
          }
          if (n.type !== "pair") return null;
          if (needle && !n.key.toLowerCase().includes(needle)) return null;
          return (
            <IniPairRow key={i} index={i} keyName={n.key} value={n.value} onUpdate={stableUpdate} />
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- BinaryEditor */

interface SearchHit {
  offset: number;
  context: string;
}

/** Tools for large binary payloads (e.g. a multi-MB decompressed Unreal save)
 * that are impractical to render fully as hex: preview, string search, and
 * patch-at-offset, plus export/import of the raw inner bytes. */
export function BinaryEditor(props: { value: Uint8Array; onBytes: (b: Uint8Array) => void }) {
  const { value } = props;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [patchOffset, setPatchOffset] = useState("");
  const [patchHex, setPatchHex] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => hexDump(value, 4096), [value]);

  const runSearch = () => {
    const needle = utf8Encode(query);
    if (needle.length === 0) {
      setHits(null);
      return;
    }
    const found: SearchHit[] = [];
    for (let i = 0; i + needle.length <= value.length && found.length < 100; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (value[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const ctxStart = Math.max(0, i - 8);
        const ctxEnd = Math.min(value.length, i + needle.length + 8);
        let ctx = "";
        for (let k = ctxStart; k < ctxEnd; k++) {
          const c = value[k];
          ctx += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
        }
        found.push({ offset: i, context: ctx });
        i += needle.length - 1;
      }
    }
    setHits(found);
  };

  const applyPatch = () => {
    const off = patchOffset.trim().startsWith("0x")
      ? parseInt(patchOffset.trim(), 16)
      : parseInt(patchOffset.trim(), 10);
    if (!Number.isFinite(off) || off < 0) {
      setMsg("Invalid offset");
      return;
    }
    let patch: Uint8Array;
    try {
      patch = fromHex(patchHex);
    } catch (e) {
      setMsg(`Invalid hex: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (off + patch.length > value.length) {
      setMsg(`Patch exceeds payload (offset ${off} + ${patch.length} > ${value.length})`);
      return;
    }
    const next = value.slice();
    next.set(patch, off);
    props.onBytes(next);
    setMsg(`Patched ${patch.length} byte(s) at offset ${off}.`);
  };

  const onImport = async (file: File) => {
    props.onBytes(new Uint8Array(await file.arrayBuffer()));
    setMsg(`Replaced inner payload with ${file.name}.`);
  };

  return (
    <div className="binary-editor">
      <p className="muted small">
        This payload is {value.length.toLocaleString()} bytes — too large to edit as one hex blob.
        Search for a value, patch specific offsets, or export the decompressed payload to edit in a
        dedicated hex editor and re-import it. "Rebuild &amp; download" then re-wraps it.
      </p>

      <div className="bin-tools">
        <div className="bin-row">
          <input
            type="text"
            placeholder="Find ASCII text…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            style={{ flex: 1 }}
          />
          <button onClick={runSearch}>Search</button>
        </div>
        {hits && (
          <div className="bin-hits">
            {hits.length === 0 ? (
              <span className="muted small">No matches.</span>
            ) : (
              <>
                <span className="muted small">
                  {hits.length}
                  {hits.length === 100 ? "+ (capped)" : ""} match(es):
                </span>
                <ul>
                  {hits.map((h, i) => (
                    <li key={i}>
                      <button
                        className="link mono"
                        onClick={() => setPatchOffset("0x" + h.offset.toString(16))}
                        title="Use this offset in the patch tool"
                      >
                        0x{h.offset.toString(16)}
                      </button>{" "}
                      <span className="muted small mono">{h.context}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="bin-row">
          <input
            type="text"
            placeholder="Offset (dec or 0x…)"
            value={patchOffset}
            onChange={(e) => setPatchOffset(e.target.value)}
          />
          <input
            type="text"
            placeholder="Bytes (hex), e.g. 64 00 00 00"
            value={patchHex}
            onChange={(e) => setPatchHex(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={applyPatch}>Patch</button>
        </div>

        <div className="bin-row">
          <button onClick={() => downloadBytes(value, "payload.bin")}>Export decompressed</button>
          <input
            ref={importRef}
            type="file"
            hidden
            onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])}
          />
          <button onClick={() => importRef.current?.click()}>Import edited payload…</button>
          {msg && <span className="status-msg">{msg}</span>}
        </div>
      </div>

      <h3>First 4 KB (read-only)</h3>
      <pre className="hex">{preview}</pre>
    </div>
  );
}
