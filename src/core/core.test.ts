import { describe, it, expect } from "vitest";
import { gzip } from "pako";
import LZString from "lz-string";
import {
  adler32,
  bytesEqual,
  crc32,
  decodePipeline,
  detect,
  encodePipeline,
  fromHex,
  getCodec,
  looksLikeIni,
  matchProfiles,
  md5,
  parseIni,
  serializeIni,
  sha,
  shannonEntropy,
  toHex,
  utf8Decode,
  utf8Encode,
} from "./index";

describe("bytes", () => {
  it("round-trips hex", () => {
    const b = new Uint8Array([0, 1, 2, 255, 16, 128]);
    expect(toHex(b)).toBe("000102ff1080");
    expect([...fromHex("00 01 02 ff 10 80")]).toEqual([...b]);
  });

  it("measures entropy: zeros low, random high", () => {
    expect(shannonEntropy(new Uint8Array(1000))).toBe(0);
    const rnd = new Uint8Array(4096);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
    expect(shannonEntropy(rnd)).toBeGreaterThan(7.5);
  });
});

describe("base64 codec", () => {
  const b64 = getCodec("base64")!;
  it("matches known vectors", () => {
    expect(utf8Decode(b64.encode(utf8Encode("Man")))).toBe("TWFu");
    expect(utf8Decode(b64.encode(utf8Encode("hello")))).toBe("aGVsbG8=");
    expect(utf8Decode(b64.decode(utf8Encode("aGVsbG8=")))).toBe("hello");
  });
  it("round-trips arbitrary bytes", () => {
    const data = new Uint8Array([0, 255, 13, 10, 200, 42, 7]);
    expect([...b64.decode(b64.encode(data))]).toEqual([...data]);
  });
});

describe("compression codecs round-trip", () => {
  const payload = utf8Encode(JSON.stringify({ gold: 9999, items: ["sword", "shield"] }));
  for (const id of ["gzip", "zlib", "deflate-raw"]) {
    it(id, () => {
      const c = getCodec(id)!;
      expect([...c.decode(c.encode(payload))]).toEqual([...payload]);
    });
  }
});

describe("xor codec", () => {
  it("is symmetric with a text key", () => {
    const c = getCodec("xor")!;
    const data = utf8Encode("the quick brown fox");
    const enc = c.encode(data, { keyText: "key" });
    expect([...enc]).not.toEqual([...data]);
    expect([...c.decode(enc, { keyText: "key" })]).toEqual([...data]);
  });
});

describe("lz-string codec", () => {
  it("round-trips and is compatible with LZString.compressToBase64", () => {
    const c = getCodec("lzstring-base64")!;
    const json = JSON.stringify({ hp: 100, name: "hero" });
    const compressed = LZString.compressToBase64(json);
    const decoded = utf8Decode(c.decode(utf8Encode(compressed)));
    expect(decoded).toBe(json);
    expect([...c.decode(c.encode(utf8Encode(json)))]).toEqual([...utf8Encode(json)]);
  });
});

describe("pipeline", () => {
  it("decodes and re-encodes a base64(gzip(json)) onion losslessly", () => {
    const json = utf8Encode(JSON.stringify({ level: 42 }));
    const steps = [{ codecId: "base64" }, { codecId: "gzip" }];
    // Build the wrapped file with encodePipeline, then peel it with decodePipeline.
    const wrapped = encodePipeline(json, steps);
    expect(wrapped.ok).toBe(true);
    const opened = decodePipeline(wrapped.output, steps);
    expect(opened.ok).toBe(true);
    expect([...opened.output]).toEqual([...json]);
  });

  it("reports the failing step instead of throwing", () => {
    const run = decodePipeline(utf8Encode("not gzip"), [{ codecId: "gzip" }]);
    expect(run.ok).toBe(false);
    expect(run.trace[0].error).toBeTruthy();
  });
});

describe("checksums", () => {
  it("CRC-32 known vector", () => {
    expect(crc32(utf8Encode("123456789")) >>> 0).toBe(0xcbf43926);
  });
  it("Adler-32 known vector", () => {
    expect(adler32(utf8Encode("Wikipedia")) >>> 0).toBe(0x11e60398);
  });
  it("MD5 known vectors", () => {
    expect(toHex(md5(utf8Encode("")))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(toHex(md5(utf8Encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(toHex(md5(utf8Encode("The quick brown fox jumps over the lazy dog")))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
  it("SHA-256 via WebCrypto", async () => {
    const digest = await sha("SHA-256", utf8Encode("abc"));
    expect(toHex(digest)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("detection", () => {
  it("flags gzip by magic", () => {
    const d = detect(gzip(utf8Encode("hello world hello world")));
    expect(d.best?.id).toBe("gzip");
  });
  it("recognizes JSON text", () => {
    const d = detect(utf8Encode('{"a":1,"b":[2,3]}'));
    expect(d.best?.id).toBe("json");
    expect(d.printableText).toBe(true);
  });
  it("flags high-entropy blobs as compressed/encrypted", () => {
    const rnd = new Uint8Array(512);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
    const d = detect(rnd);
    expect(d.likelyCompressedOrEncrypted).toBe(true);
  });
});

describe("Unreal compressed codec", () => {
  const c = getCodec("ue-compressed")!;

  it("round-trips a payload spanning multiple chunks, with the UE tag header", () => {
    const payload = new Uint8Array(300_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
    const wrapped = c.encode(payload, { chunkSize: 131072, blockFormat: "gzip" });
    const dv = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x9e2a83c1); // PACKAGE_FILE_TAG
    expect(bytesEqual(c.decode(wrapped), payload)).toBe(true);
  });

  it("also decodes archives whose blocks are zlib", () => {
    const payload = utf8Encode("hello unreal ".repeat(200));
    const wrapped = c.encode(payload, { blockFormat: "zlib" });
    expect(bytesEqual(c.decode(wrapped), payload)).toBe(true);
  });

  it("rejects non-Unreal data", () => {
    expect(() => c.decode(utf8Encode("not unreal"))).toThrow();
  });
});

describe("INI", () => {
  it("round-trips faithfully including CRLF, comments, blanks and quotes", () => {
    const text = '[Progress]\r\n; a comment\r\nGOLD="5.000000"\r\nNAME=Hero\r\n\r\n';
    expect(serializeIni(parseIni(text))).toBe(text);
  });

  it("edits a quoted value while preserving the quotes", () => {
    const doc = parseIni('[S]\nHP="100"\n');
    const pair = doc.nodes.find((n) => n.type === "pair");
    if (pair && pair.type === "pair") pair.value = "999";
    expect(serializeIni(doc)).toBe('[S]\nHP="999"\n');
  });

  it("recognizes INI vs JSON", () => {
    expect(looksLikeIni("[A]\nx=1\ny=2\n")).toBe(true);
    expect(looksLikeIni('{"a":1,"b":2}')).toBe(false);
  });

  it("detection labels [section]-leading text as INI, not JSON", () => {
    const d = detect(utf8Encode('[Progress]\nGOLD="5"\nHP="100"\n'));
    expect(d.best?.id).toBe("ini");
  });
});

describe("profiles", () => {
  it("matches an RPG Maker style save and opens it to JSON", () => {
    const json = JSON.stringify({ party: [1, 2, 3], gold: 5000 });
    const file = utf8Encode(LZString.compressToBase64(json));
    const suggestions = matchProfiles(file, "file1.rpgsave");
    expect(suggestions[0]?.profile.id).toBe("rpgmaker-mvmz");
    const opened = decodePipeline(file, suggestions[0].profile.pipeline);
    expect(JSON.parse(utf8Decode(opened.output))).toEqual({ party: [1, 2, 3], gold: 5000 });
  });

  it("matches gzip-wrapped JSON", () => {
    const file = gzip(utf8Encode('{"score":12345}'));
    const suggestions = matchProfiles(file, "save.dat");
    expect(suggestions.some((s) => s.profile.id === "gzip-json")).toBe(true);
  });

  it("matches plain JSON", () => {
    const suggestions = matchProfiles(utf8Encode('{"ok":true}'), "save.json");
    expect(suggestions.some((s) => s.profile.id === "plain-json")).toBe(true);
  });
});
