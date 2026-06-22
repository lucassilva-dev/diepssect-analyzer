# Memory map of the current diep.io build (work in progress)

Goal: read the decoded game state (player, entities, arena) straight from the
WASM heap, bypassing the network cipher. Tool: `userscripts/diep-mem-reader.user.js`
(provides `window.mem` with scan/diff/watch primitives).

This is the **dpma approach re-derived for the current build** — the old
`dpma/src` offsets (0x10a58, 0x10a7c, …) are from a 2017 build and do not apply.

## Method (Cheat-Engine style, all in JS)

The reliable way to locate a field is **differential scanning**: change one
known quantity in-game and diff the heap to see which address changed.

### A. Player X/Y position (move-diff)
1. Spawn (idle, mouse centered so the tank doesn't auto-move).
2. `A = mem.snap()`
3. Move RIGHT for ~1s (hold D), stop.
4. `B = mem.snap()`
5. `cand = mem.diffF32(A,B,{range:[-1e7,1e7], minDelta:5, maxDelta:5000})`
   → X position increased; many noise hits too.
6. Move right again → `C = mem.snap()`; `cand2 = mem.diffF32(B,C,{...})`.
7. Intersect: `X = cand.filter(o => cand2.includes(o))`. Repeat until 1–3 remain.
8. Confirm: move and watch `mem.f32(X)` track the tank. Y is typically the
   adjacent float (X±4 or within the same struct); verify with a vertical move.

### B. Health (damage-diff)
1. Note current health; `A = mem.snap()`.
2. Take damage (ram a shape) so health drops; `B = mem.snap()`.
3. `mem.diffF32(A,B,{range:[0,1e6], maxDelta:1e5})` → health + maxHealth + score…
4. Narrow with `mem.scanF32(knownHealthValue, 0.5)` if the HUD shows a number.

### C. From a known field → the entity struct → all entities
- Once X is found, the player **entity struct** is the bytes around X. Dump it:
  `mem.struct(structBase, 32)` and eyeball u32/f32 columns (pointers vs floats).
- Entities live in a contiguous array (a C++ `vector`). Find the **stride** by
  locating two entities (e.g. your tank + a shape) and subtracting their bases.
- Find the array **base pointer + length**: scan `mem.scanU32(structBase)` to find
  who points at the array; nearby is the length. Then enumerate
  `for i in 0..len: read entity at base + i*stride`.

## Anchors already found (session-dependent, re-find each run)
- Player nickname bytes appear in the heap (e.g. searching `41 41 …` for an
  all-`A` name returned hits near ~2.96M). The tank's name field sits inside or
  next to its entity struct — a useful secondary anchor to cross-check the
  move-diff result.
- The embedded **achievements JSON** is readable in the heap (proves we read
  decoded data); not game state but a good "is the heap captured?" sanity check
  (`mem.find('7b 22 6e 61 6d 65')` → `{"name`).

## Discovered fields (fill in as confirmed)

| Field | Offset within entity struct | Type | How confirmed | Confidence |
|-------|-----------------------------|------|---------------|------------|
| X position | TBD | f32 | move-diff | — |
| Y position | TBD | f32 | move-diff | — |
| Health | TBD | f32 | damage-diff | — |
| … | | | | |

(Offsets are relative to the entity struct base, which is stable within a
session but its absolute address changes per load — always re-anchor via a scan.)

## Notes
- The heap only grows; snapshot offsets stay valid within a session. Re-create
  the `Uint8Array` view (`mem.heap()`) after any growth — the helpers do this.
- Floats for arena coordinates are large (hundreds–thousands); health/maxHealth
  are smaller positives; angles are ~[-π, π]. Use `range` filters to cut noise.
- Keep the game tab in the FOREGROUND while scanning — a backgrounded/automated
  tab throttles and can freeze under heavy full-heap scans.
