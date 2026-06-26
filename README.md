# Savistor — Ultimate Save Editor

A genuinely **format-aware** editor for game save files (`.sav`, `.save`, `.dat`,
`.json`, `.rpgsave`, …). It runs **entirely in your browser** — your saves are
never uploaded anywhere.

Most "online save editors" lie about what they support: they show a JSON box and
hope your file happens to be plain JSON. Real saves usually aren't — they're
Base64, gzip/zlib, lz-string, XOR-obfuscated, or a stack of those, often with a
checksum the game verifies on load. Savistor is built around that reality.

## What it actually does

- **Looks at the bytes, not the extension.** Magic-number sniffing + Shannon
  entropy tell you whether a file is JSON, a known container, or "high-entropy →
  probably compressed or encrypted."
- **A reversible transform pipeline.** Stack codecs to *peel* a file open and
  the exact reverse to *rebuild* it on save:
  - Encoding: Base64, Base64 URL-safe, Hex
  - Compression: gzip, zlib (deflate), raw DEFLATE, lz-string (Base64 / URI /
    UTF-16 / raw)
  - Obfuscation: XOR with a repeating key (text or hex)
- **Edit as Text/JSON or Hex.** JSON validation + pretty-print; a raw hex mode
  for binary payloads.
- **Checksums for re-saving.** CRC-32, Adler-32, MD5 (pure JS) and SHA-1/256/384/512
  (Web Crypto), with little/big-endian encodings — so when a game stores a
  checksum you can recompute and patch it.
- **Game profiles.** One-click "open as…" recipes that bundle the right codec
  stack. A profile only claims a match when it can *actually decode* the file.

### Profiles shipped today

| Profile | Recipe |
| --- | --- |
| RPG Maker MV / MZ (`.rpgsave` / `.rmmzsave`) | lz-string Base64 → JSON |
| gzip-compressed JSON | gzip → JSON |
| zlib-compressed JSON | zlib → JSON |
| Base64-encoded JSON | Base64 → JSON |
| Plain JSON | (none) |

## What it does **not** do (yet) — the honest part

- It does **not** magically understand every game. If a save is encrypted with a
  key baked into the game binary, you need that key (use the XOR layer, or a
  future decrypt codec) — no tool can edit truly-encrypted data without it.
- It does **not** ship per-game field editors ("set Strength to 99") except via
  the profiles above. Those are added from **real sample saves** — see below.
- Engine-specific binary serializations (Unity `BinaryFormatter`, Unreal `GVAS`
  property trees, protobuf without a schema) are **detected/flagged** but not
  yet fully parsed.

If a tool tells you it supports "all `.sav` files," it's guessing. Savistor tells
you what it can prove about *your* file.

## Architecture

```
src/
  core/            pure, DOM-free library (works in browser, worker, tests)
    bytes.ts       Uint8Array/hex/text helpers, entropy, text sniffing
    detect.ts      magic-number + entropy format detection
    codecs.ts      reversible codecs (encode/decode) + registry
    pipeline.ts    stack codecs; decode forward, encode in reverse
    checksums.ts   CRC32 / Adler32 / MD5 / SHA-*
    profiles.ts    game profiles (match + codec recipe) + registry
  ui/              React presentation layer (consumes core)
  App.tsx          open → inspect → pipeline → edit → rebuild → download
```

The split is deliberate: the **core has no UI dependencies**, so the same logic
can back a future CLI or batch tool.

## Adding support for a new game

You said you'd send a couple of real saves — that's exactly the input a profile
needs. The workflow:

1. Drop the save into Savistor and read the **Inspector**: is it text? high
   entropy? a known magic number?
2. In the **Transform pipeline**, add layers until the payload becomes readable
   (e.g. `Base64` then `gzip`, or `lz-string (Base64)`). The order shown is the
   "open" order.
3. Once it opens to JSON/text, codify it as a profile in `src/core/profiles.ts`:

   ```ts
   const myGame: GameProfile = {
     id: "my-game",
     name: "My Game",
     description: "Saves are gzip-compressed JSON.",
     extensions: [".sav"],
     pipeline: [{ codecId: "gzip" }],
     payloadKind: "json",
     match(bytes, filename) {
       const json = decodesToJson(bytes, this.pipeline);
       if (!json) return null;
       return { confidence: 0.9, reason: "gzip stream inflates to JSON" };
     },
   };
   ```

4. Add a round-trip test in `src/core/core.test.ts` using the sample.

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # vitest: codec/checksum/detection/profile round-trips
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

### Deploy

`npm run build` emits a static site in `dist/` that can be hosted anywhere. The
included `.github/workflows/deploy.yml` publishes it to **GitHub Pages** on every
push to `main` — set Settings → Pages → Source to "GitHub Actions" to enable it.

### Privacy & security

- 100% client-side. There is no backend; nothing is uploaded.
- `npm audit` reports advisories in the **dev toolchain** (esbuild's dev server,
  via Vite/Vitest). They affect local development only, not the static build
  shipped to users.

## License

MIT — see [LICENSE](./LICENSE).
