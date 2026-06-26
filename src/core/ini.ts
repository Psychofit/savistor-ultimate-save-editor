/**
 * A faithful INI / key=value parser. Many Unity (and other) games store saves as
 * a flat `[Section]` + `KEY="value"` text file (e.g. Hole Dweller). We parse it
 * into editable nodes while preserving line order, comments, blank lines, the
 * original end-of-line style, and whether each value was quoted — so serializing
 * an unedited document reproduces the input byte-for-byte.
 */

export interface IniPair {
  type: "pair";
  section: string;
  key: string;
  value: string;
  /** Whether the value was wrapped in double quotes in the source. */
  quoted: boolean;
}

export interface IniSection {
  type: "section";
  name: string;
}

export interface IniRaw {
  type: "raw";
  text: string;
}

export type IniNode = IniPair | IniSection | IniRaw;

export interface IniDoc {
  eol: string;
  nodes: IniNode[];
}

export function parseIni(text: string): IniDoc {
  const eol = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const nodes: IniNode[] = [];
  let section = "";
  for (const line of lines) {
    const trimmed = line.trim();
    const sec = /^\[(.*)\]$/.exec(trimmed);
    if (sec) {
      section = sec[1];
      nodes.push({ type: "section", name: sec[1] });
      continue;
    }
    const eq = line.indexOf("=");
    const isComment = trimmed.startsWith(";") || trimmed.startsWith("#");
    if (trimmed.length > 0 && !isComment && eq >= 0) {
      const key = line.slice(0, eq);
      let value = line.slice(eq + 1);
      let quoted = false;
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        quoted = true;
        value = value.slice(1, -1);
      }
      nodes.push({ type: "pair", section, key, value, quoted });
    } else {
      nodes.push({ type: "raw", text: line });
    }
  }
  return { eol, nodes };
}

export function serializeIni(doc: IniDoc): string {
  const out = doc.nodes.map((n) => {
    if (n.type === "section") return `[${n.name}]`;
    if (n.type === "raw") return n.text;
    return `${n.key}=${n.quoted ? `"${n.value}"` : n.value}`;
  });
  return out.join(doc.eol);
}

/** True if the text is plausibly INI / key=value (a section header or mostly pairs). */
export function looksLikeIni(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 40);
  if (lines.length === 0) return false;
  let structural = 0;
  for (const l of lines) {
    if (/^\[.+\]$/.test(l)) structural++;
    else if (/^[\w.\- ]+=/.test(l)) structural++;
    else if (l.startsWith(";") || l.startsWith("#")) structural++;
  }
  return structural / lines.length > 0.7;
}
