# Live protocol capture (2026-06-22) — the current protocol is ENCRYPTED

This documents a **real packet capture from the live diep.io** (São Paulo FFA,
`wss://sao-…​.diep.io:2001`), taken by hooking `WebSocket` in the browser and
recording every frame. It is the single most important finding so far, because
it changes what is and isn't decodable.

## TL;DR

- The **2017 build in `source/` and the plaintext structure in `CLIENTBOUND.md`
  describe a protocol that is no longer in use.**
- In the **current** build, the packet **type byte is plaintext**, but the
  **body is encrypted** with what looks like a per-connection stream cipher.
- The connection **handshake is still plaintext** (it must be, to bootstrap),
  and it carries the current build id.
- Therefore the validated `clientbound-decoder.js` decodes the *documented*
  (old) protocol correctly, but **cannot decode live packets** until the cipher
  is recovered from the current WASM. That is the next real task.

## Evidence

### 1. Update bodies are statistically random (encrypted)
Shannon entropy of the body (everything after the type byte) of clientbound
`0x00` update packets, measured on live samples:

| packet len | body entropy (bits/byte) |
|------------|--------------------------|
| 4884 | 7.96 |
| 1278 | 7.87 |
| 1278 | 7.85 |
| 1226 | 7.83 |
| 1247 | 7.81 |

Max possible is 8.0. ~7.8–7.96 ⇒ effectively random ⇒ encrypted (or strongly
compressed, but see #2 which rules out plain compression). ASCII ratio ≈ 0.36.

### 2. The type byte is NOT encrypted; the body is — shown on the spawn packet
The serverbound spawn packet has the **same length** as the documented plaintext
spawn (`02` + `"Claude"` + `00` = 8 bytes), but the bytes differ:

```
captured :  02 ae a4 08 56 3c 5f 67
old plain:  02 43 6c 61 75 64 65 00     (type 0x02, name "Claude", null)
XOR      :  00 ed c8 69 23 58 3a 67
```

The first XOR byte is `00` — i.e. the **type byte (0x02) is identical/plaintext**
— while the remaining bytes XOR to a non-constant keystream (`ed c8 69 23 58 3a 67`).
A constant-key XOR would give a repeating byte; this is position-dependent ⇒
**stream cipher**, not simple compression and not a fixed XOR.
(The plaintext is an assumption, but the exact length match + the type byte
cancelling to 0 make it very likely the structure is `type ‖ encrypt(body)`.)

### 3. byte[1] varies like a keystream across updates
First body byte across consecutive `0x00` updates:
`229, 60, 21, 32, 58, 149, 140, 5, 47, 175, 230, 162` — no fixed header, consistent
with a changing keystream / per-packet state.

### 4. The handshake is plaintext (and leaks the build id)
First serverbound packet (`0x00` init) is plaintext ASCII after the type byte —
matches `coder.js`'s `.vu(0).string(BUILD)`:

```
00 31 65 31 33 63 34 39 66 62 30 35 35 31 66 33 31 31 37 64 64 38 32 ...
   1  e  1  3  c  4  9  f  b  0  5  5  1  f  3  1  1  7  d  d  8  2 ...
```

→ current build id begins `1e13c49fb0551f3117dd82093e0d6acfd44a0ee…`.
(The full string was redacted by the capture tool's safety filter; the prefix is
enough to fetch the matching `build_<hash>.wasm.js` for cipher RE.)

### 5. Channel/numbering also changed
Live clientbound type histogram over ~30s:

| type | count | note |
|------|-------|------|
| `0x00` | 6237 | encrypted update (the only update channel now) |
| `0x05` |  472 | echo / heartbeat |
| `0x04` | 1 | one-off |
| `0x07` | 1 | one-off (old "ready"?) |
| `0x08` | 1 | one-off (old "achievements"?) |
| `0xf5` | 1 | one-off outlier |

In the old protocol, raw updates were `0x00` and *compressed* updates were a
separate `0x02`. Now everything arrives on `0x00` (encrypted). `window.cp5`
(the old injector hook) is `undefined` in this build — the codec lives inside
the WASM `Module`, not an exposed JS global.

## Real sample packets (this session; ciphertext, key not recovered)

Clientbound `0x00` updates (first 64 bytes shown), see capture for full frames:
```
len  310: 00 12 16 ce f6 3e 67 01 d5 9c 01 52 1f d1 6c 0d 4a 00 00 ee 7c fe 8c 5e 2a ef 62 89 36 dc 43 5f ...
len  566: 00 02 ab ce 04 3a 86 d2 b8 ab c4 77 3d 57 be c8 09 d9 4a 6a 09 9c 23 3b 9c 01 5c c1 d9 7c 26 c8 ...
len  720: 00 4c c2 f9 c8 16 8d 44 70 3e 91 f5 67 df 73 15 3c 89 2b b2 0b 27 9e 37 ce 64 7b c0 67 6f 36 64 ...
len 1010: 00 53 1f 0c da 7e 55 df 10 42 a4 29 46 bf ea cf 13 0b cd ef cb 9b de 52 25 a5 5e ad aa 58 d0 e9 ...
len 4884: 00 e5 bd e2 b1 66 65 69 b8 dc 64 8c af ec f6 85 1f 65 d6 50 ea 51 3c 0a 61 1a 0e 12 98 ad ee 24 ...
```
Serverbound:
```
init  (0x00): 00 <ascii build hash> ...           (plaintext handshake)
spawn (0x02): 02 ae a4 08 56 3c 5f 67             (encrypted body)
input (0x01): 01 24 73 02 6e 07 f8 b6 db          (encrypted body, 9 bytes)
```

## What this means for the project

1. `clientbound-decoder.js` remains correct **for the documented protocol** and
   its self-test still passes — keep it as the reference for the wire *structure*
   (entity ids, delta varindex, field framing), which the decrypted body almost
   certainly still uses.
2. To decode anything live, the **cipher must be recovered from the current
   build's WASM** (fetch `build_1e13c49…wasm.js` + `.wasm`), specifically:
   - the key/seed derivation from the handshake,
   - the per-packet stream-cipher step applied to bodies.
   This is a substantial, separate reverse-engineering effort.
3. The old `source/` builds are useful for learning the *structure* and the
   stat/class/achievement tables (already extracted), but **not** for the cipher.

## Reproducing the capture

Hook `WebSocket` before the game socket opens, then play one round:
```js
// paste in console BEFORE clicking Play
window.__caps=[]; const O=WebSocket;
WebSocket=function(u,p){const w=p?new O(u,p):new O(u);
  const s=w.send.bind(w); w.send=d=>{const b=d.buffer||d; __caps.push(['out',new Uint8Array(b).slice()]); return s(d);};
  w.addEventListener('message',e=>{ if(e.data instanceof ArrayBuffer) __caps.push(['in',new Uint8Array(e.data).slice()]); });
  return w;}; WebSocket.prototype=O.prototype;
```
Then inspect `__caps` (each entry `[dir, Uint8Array]`).
