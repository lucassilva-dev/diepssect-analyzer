# Static RE of diep.wasm — locating the entity collection (in progress)

Goal: find the entity-collection pointer + struct layout from `diep.wasm` so the
live reader can enumerate all entities with a tiny targeted read (no heavy heap
scans). Fully offline; no browser needed.

## Method
The client logs debug strings about entities. Their data-section addresses anchor
the entity-management code. Found via `analysis/current/find-data-addr.js`
(parses the wasm data segments):

| string | mem addr |
|--------|----------|
| `Entities: %d/%d/%d/%d total/created/updated/destroyed` | 13496 |
| `Possible desync, server asked us to remove an entity … <%d, %d>` | 15947 |
| `…differs…` (entity hash desync) | 9856 |

## Functions located (current build, via the WAT)
- **func 774** — the entity **stats/debug** function. Formats `"Entities:
  %d/%d/%d/%d"` (snprintf via call 98), reading per-frame counters from globals
  **602700**, **602704** (consecutive i32 counters) and a f64 at **603648**
  (time/scale). The 4 counts total/created/updated/destroyed are written to a
  stack buffer at offsets 80/84/88/92 before formatting.
- **func 789** — the **remove-entity** handler that logs "Possible desync …"
  (string 15947 via call 291). It looks the entity up through its **param 0**
  (the "this"/world context pointer), not a fixed global — i.e. entities are
  accessed as `world->collection`, confirming an **ECS** layout with a global
  world pointer.

## What remains
The entity collection is reached via a **world/game object** passed as a
parameter. To get a concrete pointer to enumerate from:
1. Find the **global holding the world pointer** (trace a caller of 774/789, or
   the global the main loop loads before calling them).
2. From the world struct, find the **entity collection** field (begin/end/cap of
   a vector, or a hash-map of id→entity — the desync log "we don't know about
   <id>" implies a map keyed by entity id).
3. Recover the **entity struct layout** (position, health, type) — cross-check
   against the live self-position semantics already known.
4. Validate live: read `world ptr → collection → entity[i]` with a small targeted
   read (no full-heap scan → no tab freeze).

## Status
Real progress: entity-management code and the ECS architecture are located, plus
the global stat counters (602700/602704/603648). Extracting the validated
collection pointer + struct layout is the next focused step — a few more levels
of WAT tracing from func 774/789's callers to the world-pointer global.
