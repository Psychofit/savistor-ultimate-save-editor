import { useCallback, useMemo, useRef, useState } from "react";
import {
  PayloadKind,
  detect,
  formatSize,
  getProfile,
  looksLikeIni,
  matchProfiles,
  utf8Decode,
} from "./core";
import { PipelineStep, decodePipeline, encodePipeline } from "./core/pipeline";
import { Checksums, HexPreview, Inspector, PipelineEditor } from "./ui/components";
import { BinaryEditor, HexEditor, IniEditor, TextEditor } from "./ui/editors";
import { downloadBytes, suggestOutputName } from "./ui/format";

type View = "text" | "ini" | "hex" | "binary";
const LARGE = 256 * 1024;

interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

const VIEW_LABELS: Record<View, string> = {
  text: "Text / JSON",
  ini: "Fields (INI)",
  hex: "Hex",
  binary: "Binary tools",
};

/** Decide which editor views make sense for a payload, and the default one. */
function computeViews(payload: Uint8Array, kind?: PayloadKind): { views: View[]; view: View } {
  const textLike = detect(payload).printableText;
  const sample = textLike ? utf8Decode(payload.subarray(0, 65536)) : "";
  const iniLike = textLike && (kind === "ini" || looksLikeIni(sample));
  const small = payload.length <= LARGE;

  const views: View[] = [];
  if (small || textLike) views.push("text");
  if (iniLike) views.push("ini");
  if (small) views.push("hex");
  if (!small) views.push("binary");
  if (views.length === 0) views.push("hex");

  let view: View;
  if (kind === "binary") view = small ? "hex" : "binary";
  else if (iniLike) view = "ini";
  else if (kind === "json" || kind === "text" || textLike) view = "text";
  else view = small ? "hex" : "binary";
  if (!views.includes(view)) view = views[0];

  return { views, view };
}

export function App() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>();
  const [payload, setPayload] = useState<Uint8Array>(new Uint8Array());
  const [views, setViews] = useState<View[]>([]);
  const [view, setView] = useState<View>("text");
  const [decodeKey, setDecodeKey] = useState(0);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detection = useMemo(() => (file ? detect(file.bytes) : null), [file]);
  const suggestions = useMemo(
    () => (file ? matchProfiles(file.bytes, file.name) : []),
    [file],
  );

  /** Run a pipeline against source bytes and reset the editor to the result. */
  const applyPipeline = useCallback(
    (source: Uint8Array, nextSteps: PipelineStep[], kind?: PayloadKind, profileId?: string) => {
      const run = decodePipeline(source, nextSteps);
      const payloadBytes = run.ok ? run.output : source;
      const failed = run.trace.find((t) => !t.ok);
      const { views: vs, view: v } = computeViews(payloadBytes, run.ok ? kind : undefined);
      setSteps(nextSteps);
      setActiveProfileId(profileId);
      setPayload(payloadBytes);
      setViews(vs);
      setView(v);
      setPipelineError(run.ok ? null : `${failed?.codecId}: ${failed?.error}`);
      setDecodeKey((k) => k + 1);
      setExportStatus(null);
    },
    [],
  );

  const loadBytes = useCallback(
    (name: string, bytes: Uint8Array) => {
      setFile({ name, bytes });
      const best = matchProfiles(bytes, name)[0];
      if (best && best.match.confidence >= 0.8) {
        applyPipeline(bytes, best.profile.pipeline, best.profile.payloadKind, best.profile.id);
      } else {
        applyPipeline(bytes, [], undefined, undefined);
      }
    },
    [applyPipeline],
  );

  const openFile = useCallback(
    async (f: File) => loadBytes(f.name, new Uint8Array(await f.arrayBuffer())),
    [loadBytes],
  );

  const applyProfile = (id: string) => {
    if (!file) return;
    const profile = getProfile(id);
    if (!profile) return;
    applyPipeline(file.bytes, profile.pipeline, profile.payloadKind, id);
  };

  const changeSteps = (next: PipelineStep[]) => {
    if (!file) return;
    applyPipeline(file.bytes, next, undefined, undefined);
  };

  const appendCodec = (codecId: string) => changeSteps([...steps, { codecId, options: {} }]);

  const onPayloadBytes = useCallback((b: Uint8Array) => setPayload(b), []);

  const switchView = (v: View) => {
    if (v === view) return;
    setView(v);
    setDecodeKey((k) => k + 1); // remount editor so it re-seeds from current payload
  };

  const doExport = () => {
    if (!file) return;
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

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void openFile(f);
  };

  const editorKey = `${decodeKey}:${view}`;

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

            {pipelineError && (
              <section className="panel error">
                <h2>Pipeline error</h2>
                <p>
                  Failed at <code>{pipelineError}</code>
                </p>
                <p className="muted small">
                  The bytes don't match this layer. Remove it or pick a different codec. Showing the
                  un-decoded bytes below.
                </p>
              </section>
            )}

            <Checksums bytes={payload} label="current payload" />
            <HexPreview bytes={file.bytes} title="Original file" />
          </div>

          <div className="col">
            <section className="panel editor">
              <div className="editor-head">
                <h2>Payload editor</h2>
                <div className="modes">
                  {views.map((v) => (
                    <button
                      key={v}
                      className={view === v ? "active" : ""}
                      onClick={() => switchView(v)}
                    >
                      {VIEW_LABELS[v]}
                    </button>
                  ))}
                </div>
              </div>

              <p className="muted small">
                Payload: {formatSize(payload.length)} ({payload.length.toLocaleString()} bytes)
              </p>

              {view === "text" && (
                <TextEditor key={editorKey} initial={payload} onBytes={onPayloadBytes} />
              )}
              {view === "hex" && (
                <HexEditor key={editorKey} initial={payload} onBytes={onPayloadBytes} />
              )}
              {view === "ini" && (
                <IniEditor key={editorKey} value={payload} onBytes={onPayloadBytes} />
              )}
              {view === "binary" && (
                <BinaryEditor key={editorKey} value={payload} onBytes={onPayloadBytes} />
              )}

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
