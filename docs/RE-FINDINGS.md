# Reverse Engineering Findings (verified)

This file records only findings that are **grounded in a concrete source** —
either the real codec (`diep-bot/coder.js`), the hand-verified `CLIENTBOUND.md`,
or strings/data extracted directly from the WASM memory image in `source/`.
Anything speculative is labelled as such.

## Build provenance

- Memory image: `source/build_16c5a0cc9e22f4a8dd6aff32e1ad70e056f530f5.mem`
- Toolchain string in image: `emscripten 1.37.9` → this is an **old build (~2017)**.
- The image self-reports `Last updated: March 9th`.
- ⚠️ The README notes diep shuffles memory layout & protocol every update.
  Treat structure here as real but **possibly stale vs the live game**. The
  *shapes* (encodings, packet framing) are stable; specific indices may drift.

## WebSocket transport (from ASM_CONST glue in the .mem)

The browser↔WASM bridge is fully visible in the embedded JS constants:

```js
// open: stored in cp5.sockets[]   (this is the `cp5` the diep-pl injector hooks)
var ws = new WebSocket(UTF8ToString($0)); ws.binaryType = "arraybuffer";
// receive: raw bytes copied straight into WASM heap, parsed in WASM
ws.onmessage = function(e){ var view = new Uint8Array(e.data);
  var ptr = _malloc(view.length); writeArrayToMemory(view, ptr);
  ws.events.push([1, ptr, view.length]); _cp5_check_ws(); };
// send: HEAP8.subarray($1, $1+$2)
```

Implications, confirmed:
- All packet **parsing happens inside the WASM**, not in JS — so the field
  type table lives in the WASM, not in readable JS.
- `cp5.sockets` is the correct hook point for capture/injection (matches the
  `cp5` export the `diep-pl` / DPMA injectors already grab).

## Clientbound 0x00 (update) packet — structure CONFIRMED

The decoder in [`scripts/clientbound-decoder.js`](../scripts/clientbound-decoder.js)
parses the worked example in `CLIENTBOUND.md` **cleanly (0 bytes left over)** and
its structure is independently corroborated by debug strings found in the WASM:

| WASM debug string (from .mem) | Confirms |
|---|---|
| `Entities: %d/%d/%d/%d total/created/updated/destroyed` | update packet has created / updated / destroyed sections |
| `Possible desync, server asked us to remove an entity that we don't know about <%d, %d>` | entity id is a **2-tuple `<time, counter>`** (matches `ei = vu:vu`) |
| `Desync, hash for entity %d differs: %d %d` | client keeps a per-entity hash (anti-tamper / sync check) |

Verified encoding details:
- **Entity id** = `vu(time) vu(counter)`, rendered `time:counter`.
- **Field index** is **delta-encoded**: each field carries `varindex = vu() XOR 1`,
  added to a running index that starts at 0; a delta that decodes to `0`
  terminates the field list. (So `00`→delta +1, `01`→terminator.)
- **Field type is NOT in the packet.** The value bytes follow the index with no
  tag. You must already know each field's type to know its length — an unknown
  field **halts** parsing (the decoder reports this rather than guessing).

### Known doc inconsistency (resolved as "ambiguous")
`CLIENTBOUND.md` disagrees with itself on indices 1/2/3: its field *table* says
`1=angle, 2=x, 3=y`, but its worked *example* labels the identical delta
sequence `x, y, angle`. The **indices** (1,2,3) and their **type** (`vi`) are
unambiguous; the human **label** is a known conflict to settle with a live
capture or by reading the WASM render code.

## Clientbound 0x08 (achievements) — DECODED via embedded table

The client embeds the **entire achievement list as JSON** in its data section.
Extracted verbatim to [`docs/extracted/achievements.json`](extracted/achievements.json)
(50 achievements) via [`scripts/extract-from-mem.js`](../scripts/extract-from-mem.js).

This means packet 0x08 does not need to carry achievement *definitions* — the
client already has them. The packet references achievements **by their index
into this client-side list** (0–49 for this build), which is why it was only
"Structured" before: the table was unknown. Now it is recovered.

The achievement conditions also leak two canonical id tables (see below).

## Canonical id tables (ground truth for this build)

Derived from `statUpgraded`/`classChange` achievement conditions
(`docs/extracted/stat-ids.json`, `docs/extracted/class-ids.json`):

**Stat ids** (serverbound packet `03` "upgrade stat" uses these):
| id | stat | id | stat |
|----|------|----|------|
| 0 | Movement Speed | 4 | Bullet Speed |
| 1 | Reload | 5 | Body Damage |
| 2 | Bullet Damage | 6 | Max Health |
| 3 | Bullet Penetration | 7 | Health Regen |

This matches `StatTable` in `diep-bot/main.js` exactly — confirming the bot's
ordering is correct (the bot then XORs `SHUFFLER.STAT` per build on top).

**Class (tank) ids** (serverbound packet `04` "upgrade tank" uses these):
`1=Twin, 3=Triple Shot, 4=Quad Tank, 6=Sniper, 7=Machine Gun, 8=Flank Guard,
9=Tri-Angle, 10=Destroyer, 11=Overseer, 13=Twin Flank, 15=Assassin, 19=Hunter,
20=Gunner, 31=Trapper, 36=Smasher, 41=Auto 3` (partial — only classes that have
an achievement appear; full list is the `TankTable` index in `main.js`).
These line up with `TankTable`'s positions, confirming that table too.

## C++ architecture hint

Assertion strings embed real source paths, e.g.
`/root/d/shared/systems/AchievementSystem.cpp`, confirming an ECS-style
`shared/systems/*` layout. More paths may surface in other `.mem`/`.wat` files
and can map the server/client shared code.

## What is still open

- Full **field index → type** table (needed to decode arbitrary fields past the
  known ones). This is the ETAPA 2 target inside the `.wat`/`.wasm.c`; partially
  blocked by the build being old + wasm2c stripping symbols (`f1234` names).
- Human labels for fields 1/2/3 (doc conflict above).
- Packet `0x06` serverbound (still Unknown).
- The exact server→client achievement-unlock packet 0x08 wire layout (we have
  the table it indexes into; need a live capture to confirm the index encoding).
