import { useCallback, useMemo, useRef, useState } from "react";
import {
  detect,
  fromHex,
  getProfile,
  matchProfiles,
  toHex,
  utf8Decode,
  utf8Encode,
  formatSize,
} from "./core";
import { PipelineStep, decodePipeline, encodePipeline } from "./core/pipeline";
import { Checksums, HexPreview, Inspector, PipelineEditor } from "./ui/components";
import { downloadBytes, suggestOutputName, tryFormatJson } from "./ui/format";

type EditMode = "text" | "hex";

interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

/** Render payload bytes into the textarea string for a given edit mode. */
function render(bytes: Uint8Array, mode: EditMode): string {
  if (mode === "hex") return toHex(bytes, " ").replace(/((?:[0-9a-f]{2} ){16})/g, "$1\n");
  return utf8Decode(bytes);
}

/** Parse the textarea string back into payload bytes. May throw for bad hex. */
function parse(text: string, mode: EditMode): Uint8Array {
  return mode === "hex" ? fromHex(text) : utf8Encode(text);
}

export function App() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>();
  const [editMode, setEditMode] = useState<EditMode>("text");
  const [editedText, setEditedText] = useState("");
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Detection + profile suggestions for the loaded file.
  const detection = useMemo(() => (file ? detect(file.bytes) : null), [file]);
  const suggestions = useMemo(
    () => (file ? matchProfiles(file.bytes, file.name) : []),
    [file],
  );

  // Decode the file through the current pipeline to get the editable payload.
  const decodeRun = useMemo(
    () => (file ? decodePipeline(file.bytes, steps) : null),
    [file, steps],
  );

  /** Reset the editor buffer from a freshly decoded payload. */
  const resetEditor = useCallback((payload: Uint8Array, mode: EditMode) => {
    setEditedText(render(payload, mode));
    setEditMode(mode);
  }, []);

  const loadBytes = useCallback(
    (name: string, bytes: Uint8Array) => {
      setExportStatus(null);
      const det = detect(bytes);
      const matches = matchProfiles(bytes, name);
      const best = matches[0];
      setFile({ name, bytes });
      if (best && best.match.confidence >= 0.8) {
        const mode: EditMode = best.profile.payloadKind === "binary" ? "hex" : "text";
        const decoded = decodePipeline(bytes, best.profile.pipeline);
        setSteps(best.profile.pipeline);
        setActiveProfileId(best.profile.id);
        resetEditor(decoded.ok ? decoded.output : bytes, mode);
      } else {
        const mode: EditMode = det.printableText ? "text" : "hex";
        setSteps([]);
        setActiveProfileId(undefined);
        resetEditor(bytes, mode);
      }
    },
    [resetEditor],
  );

  const openFile = useCallback(
    async (f: File) => loadBytes(f.name, new Uint8Array(await f.arrayBuffer())),
    [loadBytes],
  );

  // --- pipeline / profile actions -------------------------------------------

  const applyProfile = (id: string) => {
    if (!file) return;
    const profile = getProfile(id);
    if (!profile) return;
    const decoded = decodePipeline(file.bytes, profile.pipeline);
    setSteps(profile.pipeline);
    setActiveProfileId(id);
    resetEditor(
      decoded.ok ? decoded.output : file.bytes,
      profile.payloadKind === "binary" ? "hex" : "text",
    );
  };

  const changeSteps = (next: PipelineStep[]) => {
    if (!file) return;
    setSteps(next);
    setActiveProfileId(undefined);
    const decoded = decodePipeline(file.bytes, next);
    if (decoded.ok) resetEditor(decoded.output, editMode);
  };

  const appendCodec = (codecId: string) => changeSteps([...steps, { codecId, options: {} }]);

  // --- editor ----------------------------------------------------------------

  const switchMode = (mode: EditMode) => {
    if (mode === editMode) return;
    try {
      const bytes = parse(editedText, editMode);
      setEditedText(render(bytes, mode));
      setEditMode(mode);
    } catch (e) {
      setExportStatus(`Cannot switch view: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Current edited payload as bytes (null when the hex is currently unpar. valid).
  const editedBytes = useMemo(() => {
    try {
      return parse(editedText, editMode);
    } catch {
      return null;
    }
  }, [editedText, editMode]);

  const jsonStatus = useMemo(() => {
    if (editMode !== "text") return null;
    const t = editedText.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    const res = tryFormatJson(editedText);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }, [editedText, editMode]);

  const formatJson = () => {
    const res = tryFormatJson(editedText);
    if (res.ok) setEditedText(res.text);
    else setExportStatus(`Invalid JSON: ${res.error}`);
  };

  const doExport = () => {
    if (!file) return;
    let payload: Uint8Array;
    try {
      payload = parse(editedText, editMode);
    } catch (e) {
      setExportStatus(`Cannot encode: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const run = encodePipeline(payload, steps);
    if (!run.ok) {
      const failed = run.trace.find((t) => !t.ok);
      setExportStatus(`Pipeline encode failed at ${failed?.codecId}: ${failed?.error}`);
      return;
    }
    const outName = suggestOutputName(file.name);
    downloadBytes(run.output, outName);
    setExportStatus(
      `Saved ${outName} — ${formatSize(run.output.length)} (original ${formatSize(file.bytes.length)}).`,
    );
  };

  // --- drag & drop -----------------------------------------------------------

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void openFile(f);
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div>
          <h1>Savistor</h1>
          <p className="tagline">
            Honest, format-aware save editor. Everything runs in your browser — your files never
            leave this device.
          </p>
        </div>
        <div className="actions">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0])}
          />
          <button onClick={() => fileInputRef.current?.click()}>Open save file…</button>
        </div>
      </header>

      {dragging && <div className="drop-overlay">Drop the save file to open</div>}

      {!file || !detection ? (
        <main className="empty">
          <div className="drop-hint">
            <h2>Open a save file to begin</h2>
            <p>
              Drag &amp; drop a <code>.sav</code>, <code>.save</code>, <code>.dat</code>,{" "}
              <code>.json</code>, <code>.rpgsave</code> … or click <em>Open save file…</em>
            </p>
            <p className="muted">
              Savistor inspects the actual bytes (not the extension), suggests how the file is
              wrapped, lets you peel the layers, edit the data, and rebuild a byte-faithful file —
              recomputing checksums where needed.
            </p>
          </div>
        </main>
      ) : (
        <main className="grid">
          <div className="col">
            <section className="panel filemeta">
              <h2>{file.name}</h2>
              {activeProfileId && (
                <span className="tag good">opened as {getProfile(activeProfileId)?.name}</span>
              )}
            </section>

            <Inspector
              detection={detection}
              suggestions={suggestions}
              activeProfileId={activeProfileId}
              onApplyProfile={applyProfile}
              onApplyCodec={appendCodec}
            />

            <PipelineEditor steps={steps} onChange={changeSteps} />

            {decodeRun && !decodeRun.ok && (
              <section className="panel error">
                <h2>Pipeline error</h2>
                <p>
                  Failed at step{" "}
                  <code>{decodeRun.trace.find((t) => !t.ok)?.codecId}</code>:{" "}
                  {decodeRun.trace.find((t) => !t.ok)?.error}
                </p>
                <p className="muted small">
                  The bytes don't match this layer. Remove it or pick a different codec.
                </p>
              </section>
            )}

            {editedBytes && <Checksums bytes={editedBytes} label="current payload" />}
            <HexPreview bytes={file.bytes} title="Original file" />
          </div>

          <div className="col">
            <section className="panel editor">
              <div className="editor-head">
                <h2>Payload editor</h2>
                <div className="modes">
                  <button
                    className={editMode === "text" ? "active" : ""}
                    onClick={() => switchMode("text")}
                  >
                    Text / JSON
                  </button>
                  <button
                    className={editMode === "hex" ? "active" : ""}
                    onClick={() => switchMode("hex")}
                  >
                    Hex
                  </button>
                  {editMode === "text" && (
                    <button onClick={formatJson} title="Pretty-print JSON">
                      Format JSON
                    </button>
                  )}
                </div>
              </div>

              {jsonStatus && (
                <p className={jsonStatus.ok ? "status good" : "status bad"}>
                  {jsonStatus.ok ? "Valid JSON" : `Invalid JSON: ${jsonStatus.error}`}
                </p>
              )}
              {editMode === "hex" && editedBytes === null && (
                <p className="status bad">Hex is not parseable yet.</p>
              )}

              <textarea
                className={editMode === "hex" ? "code hex-edit" : "code"}
                spellCheck={false}
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
              />

              <div className="export">
                <button className="primary" onClick={doExport}>
                  Rebuild &amp; download
                </button>
                {exportStatus && <span className="status-msg">{exportStatus}</span>}
              </div>
            </section>
          </div>
        </main>
      )}

      <footer className="footer">
        <span>
          Savistor · client-side save editor · no upload, no tracking. Found a format we don't
          handle? A profile can be added from two sample saves.
        </span>
      </footer>
    </div>
  );
}
