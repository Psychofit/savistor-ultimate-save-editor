import { useEffect, useMemo, useState } from "react";
import {
  CODECS,
  Codec,
  Detection,
  ProfileSuggestion,
  computeChecksums,
  formatSize,
  getCodec,
  sha,
  toHex,
} from "../core";
import { PipelineStep } from "../core/pipeline";
import { hexDump } from "./format";

/* ------------------------------------------------------------- Inspector */

export function Inspector(props: {
  detection: Detection;
  suggestions: ProfileSuggestion[];
  activeProfileId?: string;
  onApplyProfile: (id: string) => void;
  onApplyCodec: (codecId: string) => void;
}) {
  const { detection, suggestions } = props;
  return (
    <section className="panel">
      <h2>Inspector</h2>
      <div className="kv">
        <span>Size</span>
        <span>{formatSize(detection.size)} ({detection.size} bytes)</span>
        <span>Entropy</span>
        <span>
          {detection.entropy.toFixed(3)} bits/byte{" "}
          {detection.likelyCompressedOrEncrypted && (
            <span className="tag warn">likely compressed / encrypted</span>
          )}
        </span>
        <span>Text?</span>
        <span>{detection.printableText ? "printable UTF-8" : "binary"}</span>
      </div>

      <h3>What this looks like</h3>
      <ul className="guesses">
        {detection.guesses.map((g) => (
          <li key={g.id}>
            <span className="guess-label">{g.label}</span>
            <span className="bar" style={{ width: `${Math.round(g.confidence * 100)}%` }} />
            <span className="muted">{g.reason}</span>
            {g.suggestedCodec && (
              <button className="mini" onClick={() => props.onApplyCodec(g.suggestedCodec!)}>
                + {g.suggestedCodec}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h3>Game profiles</h3>
      {suggestions.length === 0 ? (
        <p className="muted">
          No known game profile matched. Use the transform pipeline below to peel the file
          manually — or send a sample so a profile can be added.
        </p>
      ) : (
        <ul className="profiles">
          {suggestions.map((s) => (
            <li key={s.profile.id} className={s.profile.id === props.activeProfileId ? "active" : ""}>
              <div>
                <strong>{s.profile.name}</strong>{" "}
                <span className="tag">{Math.round(s.match.confidence * 100)}%</span>
                <div className="muted">{s.profile.description}</div>
                <div className="muted small">{s.match.reason}</div>
              </div>
              <button onClick={() => props.onApplyProfile(s.profile.id)}>Open as this</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------- PipelineEditor */

export function PipelineEditor(props: {
  steps: PipelineStep[];
  onChange: (steps: PipelineStep[]) => void;
}) {
  const { steps, onChange } = props;
  const [toAdd, setToAdd] = useState(CODECS[0].id);

  const update = (i: number, next: PipelineStep) => {
    const copy = steps.slice();
    copy[i] = next;
    onChange(copy);
  };
  const remove = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  const add = () => onChange([...steps, { codecId: toAdd, options: {} }]);

  return (
    <section className="panel">
      <h2>Transform pipeline</h2>
      <p className="muted small">
        Layers are applied top→bottom to <em>open</em> the file, and reversed to <em>re-save</em>.
        Example: a file that is Base64 of gzip of JSON → add <code>Base64</code> then{" "}
        <code>gzip</code>.
      </p>

      {steps.length === 0 && <p className="muted">No layers — editing the file as-is.</p>}

      <ol className="steps">
        {steps.map((step, i) => {
          const codec = getCodec(step.codecId);
          return (
            <li key={i}>
              <div className="step-head">
                <span className="step-num">{i + 1}</span>
                <strong>{codec?.label ?? step.codecId}</strong>
                <span className="muted small">{codec?.description}</span>
                <span className="spacer" />
                <button className="mini" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button className="mini" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>
                  ↓
                </button>
                <button className="mini danger" onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
              {codec?.params && (
                <div className="params">
                  {codec.params.map((p) => (
                    <label key={p.name}>
                      {p.label}
                      <input
                        type="text"
                        placeholder={p.placeholder}
                        value={(step.options?.[p.name] as string) ?? ""}
                        onChange={(e) =>
                          update(i, {
                            ...step,
                            options: { ...step.options, [p.name]: e.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="add-step">
        <select value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
          {(["encoding", "compression", "obfuscation"] as const).map((group) => (
            <optgroup key={group} label={group}>
              {CODECS.filter((c) => c.group === group).map((c: Codec) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button onClick={add}>+ Add layer</button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Checksums */

export function Checksums(props: { bytes: Uint8Array; label: string }) {
  const sync = useMemo(() => computeChecksums(props.bytes), [props.bytes]);
  const [sha256, setSha256] = useState<string>("…");

  useEffect(() => {
    let alive = true;
    sha("SHA-256", props.bytes).then((d) => alive && setSha256(toHex(d)));
    return () => {
      alive = false;
    };
  }, [props.bytes]);

  return (
    <section className="panel">
      <h2>Checksums — {props.label}</h2>
      <p className="muted small">
        If the game validates a stored checksum, recompute it here after editing and patch it into
        the file via the hex view.
      </p>
      <table className="checksums">
        <tbody>
          {sync.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td className="mono">{c.hex}</td>
              <td className="muted small">
                {c.uint32 !== undefined && (
                  <>
                    LE {c.uint32leHex} · BE {c.uint32beHex}
                  </>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td>SHA-256</td>
            <td className="mono small">{sha256}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------ HexPreview */

export function HexPreview(props: { bytes: Uint8Array; title: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const dump = useMemo(
    () => (open ? hexDump(props.bytes, props.limit ?? 2048) : ""),
    [props.bytes, open, props.limit],
  );
  return (
    <section className="panel">
      <h2>
        <button className="link" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} {props.title} (read-only hex)
        </button>
      </h2>
      {open && <pre className="hex">{dump}</pre>}
    </section>
  );
}
