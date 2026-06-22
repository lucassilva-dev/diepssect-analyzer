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

## Discovered fields (confirmed)

**Player render-position struct** — located via move-diff + isolated-float filter,
then confirmed by directional watch (X tracks left/right, Y tracks up/down).
Example session absolute base = `0x906xx` (591660); re-anchor each load.

| Field | Offset (rel. to base) | Type | Evidence | Confidence |
|-------|-----------------------|------|----------|------------|
| X position | +0 | f32 | +right / −left; stable on up/down | ✓ |
| Y position | +4 | f32 | −up / +down; stable on left/right | ✓ |
| const A | +8 | f32 | constant (~2592) — spawn/target? | ◐ |
| const B | +12 | f32 | constant (~1960) — spawn/target? | ◐ |
| X copy | +16 | f32 | mirrors X (render interpolation) | ✓ |
| ? | +20 | f32 | varies (~1000) | ? |
| velocity? | +24 | f32 | varies a lot on move | ◐ |
| Y copy | +28 | f32 | mirrors Y | ✓ |

So this is the **interpolated render position** (current + target copies). Health
and the authoritative entity array are still TBD (next: find the array stride to
enumerate all entities).

Live read: `mem.f32(591660)` = X, `mem.f32(591664)` = Y.

### Update: 591660 is a STABLE GLOBAL (self/camera), not an array element
Confirmed across two independent sessions (different players) that the self
position sits at the **same absolute offset 591660/591664** — i.e. it's a
statically-allocated singleton (camera/self), not heap-allocated. Reliable anchor:
scan for the one offset where `f32(o)==f32(o+16)` and `f32(o+4)==f32(o+28)` with
`|x|,|y| > 50` → returns exactly `591660`. Read the live player x,y there.

### Entity array: what it is NOT (ruled out)
Scanning the heap for `(x,y)` pairs near the player found clusters at ~1.13M and
~1.64M with stride 32, but a dump shows these are **render vertex buffers**:
3 identical copies of a position (stride 32) followed by constant `u32` attribute
words (`0xFA0007E7`, `0x624D5C58`, `0xE43A07F3` — packed color/UV). Not the logic
array. The logic array has entities at **varied** positions (not all ≈ the tank).

Also ruled out: region ~`0x21000` (135168) looked dense in arena-range pairs but
a dump shows a **sorted ascending lookup table** (1,1,2,2,3,…,173 as f32), not
entity positions — a false positive of the density heuristic.

### Key insight: positions are NOT stored as adjacent (x,y) float pairs
A full-heap scan for any `(x,y)` pair matching the player's live position
(within ±40) returns **only 591660** (the self/camera global). There is no
second adjacent-float copy — so the logic entity array almost certainly stores
positions as a **structure-of-arrays** (a contiguous array of all X's, separate
from all Y's) or in a quantized/encoded form, not as interleaved `x,y` structs.
Next attempts should scan for the player's **single X value** sitting inside an
array of other varied arena-range floats (the X column), then find the parallel
Y column at a fixed array-width offset.

**Lead found:** scanning for the player's X value returns only 3 offsets — the
self struct (591660), its render copy (591676), and **`238864`**, where the X
sits **isolated, surrounded by zeros** (no adjacent Y). `238864` is the prime
candidate for the **authoritative X in an SoA entity array**; the matching Y
column should hold the player's Y at a fixed stride away. Next: with the tank
**held still** (no drift), scan for the player's Y value and find the one whose
offset is a clean fixed distance from 238864 → that distance = the SoA array
width, which then lets every entity's (X[i], Y[i]) be read.

### Second lead: region ~`0x164xxx` (1462272)
The 2nd-densest arena-pair region. A scan for the player's Y value landed here
(1462316), and a dump shows **per-record clusters of 4 varied coordinate floats**
(e.g. `-342,-232,274,164`) separated by ~176-byte gaps of mostly zeros, and the
values are **dynamic**. This is the most entity-array-like structure found so far
(could be the visible-entity list or the minimap-marker array — values are small
hundreds, possibly screen/minimap-relative, not world coords). To confirm: in
Sandbox, **spawn or destroy a single shape** and watch which ~176-byte record
appears/disappears here → that pins the array, its stride, and the field meaning.
Note: across sessions the earlier `238864` X-candidate did NOT reproduce (it was
transient), and a same-session scan found **no** plain-f32 copy of the player's X
besides 591660/591676 — reinforcing that entity positions are not stored as plain
world-(x,y) f32 matching the render value.

### Tooling limitation observed
Full-heap `mem.snap()` (a 17.5 MB copy) intermittently throws
`RangeError: Array buffer allocation failed` in a backgrounded/automated tab
under game load. Differential scanning needs either a foreground tab with memory
headroom, or a lighter snapshot (copy only a target region, or store per-word
hashes instead of a full byte copy).

### Plan to find the logic entity array (next session)
1. In **Sandbox** (controlled, few entities): spawn or destroy a shape and
   snapshot-diff to catch the array region that gains/loses an element.
2. Or scan heap windows for the one with the most **distinct** valid arena `(x,y)`
   pairs at a regular stride (logic array = varied positions; render = clustered).
3. Once a candidate entity is found, dump its struct, find the stride to the next
   entity, then read base+len to enumerate all (position, then health/type/angle
   by the same diff method).

(Offsets are relative to the struct base, which is stable within a session but
its absolute address changes per load — always re-anchor via a move-diff scan.)

## Notes
- The heap only grows; snapshot offsets stay valid within a session. Re-create
  the `Uint8Array` view (`mem.heap()`) after any growth — the helpers do this.
- Floats for arena coordinates are large (hundreds–thousands); health/maxHealth
  are smaller positives; angles are ~[-π, π]. Use `range` filters to cut noise.
- Keep the game tab in the FOREGROUND while scanning — a backgrounded/automated
  tab throttles and can freeze under heavy full-heap scans.
