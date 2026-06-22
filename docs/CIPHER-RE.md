# Attacking the current cipher — status & attack paths

Goal: recover the per-connection cipher so live `0x00` update packets can be
decoded. This documents what was established and the two viable paths forward.

## Artifacts (re-downloadable; gitignored due to size)

Current build `1e13c49fb0551f3117dd82093e0d6acfd44a0eee`:

| file | URL | size |
|------|-----|------|
| JS bundle | `https://diep.io/assets/index-5a8b07a6.js` | 621 KB |
| WASM | `https://diep.io/diep.wasm` | 4.7 MB |
| WAT (disasm) | `wabt: readWasm → toText` | 42.7 MB |

Disassemble: `cd analysis && npm i wabt && node` →
`require('wabt')().then(w=>{const m=w.readWasm(fs.readFileSync('current/diep.wasm'),{readDebugNames:true});m.applyNames();fs.writeFileSync('current/diep.wat',m.toText({}))})`

## Established facts

1. **The cipher is entirely inside `diep.wasm`.** The JS bundle's WebSocket
   handler passes raw bytes both ways with no transform:
   ```js
   n.onmessage = function(e){ const t = new Uint8Array(e.data); a(1, t, t.length); };
   // send shim: HEAP-copy then socket.send(subarray) — no crypto in JS
   ```
   So encrypt/decrypt happens in the C++/WASM after recv / before send.

2. **WASM surface:** 1544 functions, 46 imports (module `"a"`, the JS shims:
   WebSocket create/send/recv-poll/malloc/…), 50 exports (minified single
   letters; `U:memory` is the linear memory).

3. **The type byte is plaintext; bodies are enciphered with a per-connection
   keystream** (proven in `PROTOCOL-LIVE.md` / `extracted/live-capture-keystream.md`).
   Known-plaintext keystream recovered from an all-`A` nickname:
   `7c 42 0d 65 c6 71 0d 38 9f 01 ca b4 ae` (outbound, spawn position).

4. **Handshake seed is server packet `0xf5` (39 bytes).** The cipher engages
   only after it arrives. Key derives from this seed (+ possibly the client
   token, which we did not persist).

## Static recon leads (in the WAT)

- `i32.const 245` (the `0xf5` type) occurs only **4×**. Two are integer-parsing
  range checks (`(b-58)&255 ≤/> 245`, near `-48`='0' — printf/scanf, not cipher).
- Function **#1245** (huge, ~25k lines, 214 calls) builds **byte tables in
  memory** with sequential constant stores, e.g. descending
  `…247→off351, 246→350, 245→349, 244→348, 243→347…`, in **two regions** (~off
  349 and ~669). Sequential-identity byte fills in two ~256–340 B tables are the
  signature of a **substitution cipher (forward + inverse S-box)**. This is the
  prime static lead for the cipher tables, though #1245 mixes in other logic.
- `i32.const 255` masking appears 1053× (pervasive byte ops); `i32.const 256`
  84× (candidate S-box loops).

## Two paths forward

### Path A — finish static RE (slow, uncertain)
Trace from the recv shim (import that delivers `[1, ptr, len]`) to the function
that reads that buffer and transforms it byte-by-byte; cross-check the transform
against the known keystream above. Pin down #1245's table build + the seed→table
shuffle. Realistically multi-session work on a stripped 4.7 MB module.

### Path B — dynamic dump (tractable, RECOMMENDED)
The decrypted packets and the cipher tables both live in WASM linear memory at
runtime. Instead of reconstructing the algorithm:
- **B1 (decode game state):** read already-decoded entities straight from WASM
  memory — exactly what this repo's `dpma/` tooling does via pointers. No cipher
  needed to get game state.
- **B2 (dump cipher tables):** after the handshake, snapshot the two ~256-byte
  substitution tables from `Module` memory (anchored by #1245's offsets), then
  apply them offline to the captured ciphertext. Validate against the known
  keystream `7c 42 0d …`.
Both use a browser hook on `window.Module`/`HEAPU8` and are far more reliable
than static recovery.

## Recommendation
Pursue **Path B** to actually decode traffic now; keep the #1245 static lead as
the reference if a from-scratch cipher spec is later wanted.
