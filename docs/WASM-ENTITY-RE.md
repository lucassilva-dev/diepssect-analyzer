# Static RE of diep.wasm — entity collection pointer chain (VERIFIED)

Recovered by a multi-agent static analysis of `analysis/current/diep.wat` (42 MB),
then adversarially re-verified against the WAT. Live reader: `scripts/entity-reader.js`.
Confidence ~0.85 on the structure; two items still need a live move-diff (noted).

## The pointer chain (every load-bearing claim re-checked in the WAT)

```
WORLD (fixed)         = 582904
  func 99 @63345: Meyers singleton; after lazy-init guard on byte 592088 + call 58,
  RETURNS i32.const 582904. It's the address-OF the world object (no deref).

CONTAINER             = WORLD + 1108         (entity manager sub-object)
  func 789 @485725 reaches it via param0+1108 (call 293 dtor / call 266 ctor).
INNER BASE            = WORLD + 1120         (= CONTAINER+12; 12-byte header)
  used identically by func 528 (render) and func 774 (stats).
```

### Authoritative store — id→entity hashmap (SOLID, recommended for full enumeration)
```
registry  = fixed global mem 467744          (2048-slot pointer ring;
                                              ctor func 266 @101412, idx global 291772 &2047)
func 77 @11287 (lookup):
  idx       = (deobf(id.time) & 0xFFFF) << 2
  container = u32[467744 + idx]               (null => miss => "desync" log)
  base      = container + 12
  probe     = deobf(id.counter)
  occupied  = ( u32[base + 796 + ((probe>>3)&8188)] >> (probe&31) ) & 1   (bitmap @+796)
  if occupied: node = func186(base, probe)
func 186 @85222 (pager):
  page = u32[base + 6940 + ((probe>>8)<<2)]    (page directory @+6940; 57344-byte pages)
  node = page + (probe & 255) * 224            (STRIDE = 224, 256 nodes/page)
  node validation key @ node+116 must match deobf(id)  (func 77 @11340)
```

### Per-frame visible set — render vector (simpler, but partial)
```
base  = WORLD + 1120
begin = u32[base + 676],  end = u32[base + 680]      (std::vector member pair)
for slot in begin..end step 4:
  ref  = u32[slot]
  node = ref + 64                                    (func 528: i32.const -64 i32.sub)
  renderable = u32[node + 172] ; color = u32[node + 156]
```
NOTE (verifier correction): func 528 is **not** an iteration loop — it only touches the
first slot — but `{+676 begin, +680 end}` is a genuine vector member pair, so walking it
in JS is valid. The earlier "six vector triples at 640..700" claim was **unsubstantiated**
and dropped.

## Entity node (224 bytes) — confirmed fields
| offset | field | notes |
|--------|-------|-------|
| +64 | id-ref base | refs point here; id 2-tuple at +4 (time u16) / +8 (counter u16), obfuscated |
| +96 | container backptr | set by pager from base+748 (NOT a camera link) |
| +112/+120 | bookkeeping | pager store16 (scratch-key ptr / obfuscated) |
| +116 | node validation key | u16, seed 6954, checked by func 77 |
| +124 | parent id-ref | func 225 @91572: load+124, +22, call 77 |
| +156 | style/color id | u32 obfuscated (func 528 fill color) |
| +172 | renderable component ptr | live interpolated x/y is **inside this component** |
| +176 | health component ptr | **UNCONFIRMED** (func 1298 didn't load it as claimed) |

Per-frame tallies (container-relative, read by stats func 774 @480110):
`live=+756, created=+7196, updated=+7200, destroyed=+7204`.
Globals `602700/602704` are world **WIDTH/HEIGHT**, not counters.

## Still open (resolve live)
1. **Exact x/y offset** on the renderable component (node+172) is not pinned in the
   WAT (position is interpolated via func 82). `entity-reader.js` probes candidate
   component offsets `[8,88,120,128,152]` and picks the first world-coord-looking
   pair; lock it down by move-diff (move the player, see which entity-component f32
   pair tracks, cross-check vs the self-camera mirror at mem 591660/591664).
2. **Health** component (node+176) unconfirmed — read defensively (NaN if bad ptr).

## How to use
1. Install `userscripts/diep-mem-reader.user.js` (Sandbox Mode = Raw), spawn.
2. Paste `scripts/entity-reader.js` in the console → returns `{method, count, sample}`
   and sets `window.__entities`. Method A (render vector) first, Method B (hashmap
   full scan) as fallback / for the complete store.

## LIVE VALIDATION (2026, Sandbox) — the chain WORKS
Ran the recovered chain against live memory (diep-mem-reader probe):
- `WORLD = 582904` confirmed; registry scan found **1 container at slot 3 =
  584012 = exactly WORLD+1108** (the predicted CONTAINER). ✅
- Occupancy bitmap (base+796) had **16 set bits → 16 entities**; the pager
  (`node = page + (probe&255)*224`) resolved all 16 nodes, every one with
  **node+116 == 6954** (the seeded validation key func 77 checks). ✅
- IDs read at node+64+4/+8; renderable component ptr at node+172 valid for ~14/16.
- The render vector (WORLD+1120 +676/+680) had only **1** element live (it's the
  "single visible slot" the verifier flagged) — so the **hashmap full-scan is the
  correct enumeration method**, as predicted.

So: **entity enumeration is solved and validated** — `entity-reader.js` method B
lists every entity node from memory, no cipher and no heavy scan.

### Position/health are OBFUSCATED (next layer)
Reading the entity's stored x/y as a plain f32 yields tiny/normalized values, not
world coords, and none matched the live self-camera mirror (591660/591664). This
matches the WAT note that positions go through `f32.reinterpret_i32` + a
deobfuscation in func 82. So per-entity position/health/color are stored
**obfuscated** (same theme as the network cipher) and need a deobfuscation pass to
decode. A move-diff to isolate the field is hampered in Sandbox by constant ambient
shape motion; do it on a controlled single moving entity, or RE func 82's transform.
The plain player x/y remains available via the self mirror at 591660/591664.

## Provenance
Workflow `diep-entity-re`: 6 parallel finders → synthesis → adversarial verify →
recipe. 9 agents, ~520K tokens, 188 tool-uses. The verify phase caught and corrected
3 overclaims (no-loop in func 528, the 640..700 vectors, health@176) — the chain above
is the post-verification, evidence-backed version.
