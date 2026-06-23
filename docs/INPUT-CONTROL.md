# diep.io input control (recovered + dual-agent verified)

Synthetic DOM events are IGNORED (the game gates input on `isTrusted`). Control must
go through the game's own WASM input path. Two independent agents (bundle + WAT)
converged on the same mechanism.

## Drive input via WASM exports (cleanest — bypasses isTrusted)
The bundle forwards real input to named wasm exports (captured at `window.__wasmExports`
by diep-mem-reader):

| action | export | call | args |
|--------|--------|------|------|
| aim | `__wasmExports.va` (`_cpp_set_mouse_pos`) | `va(x, y)` | screen pixels × devicePixelRatio (top-left origin); WASM projects to world via the camera |
| key/button | `__wasmExports.ua` (`_cpp_set_keybind_state`) | `ua(code, 1\|0)` | code = keyCode; **W87 A65 S83 D68**, stats `'1'..'8'`=49..56; **FIRE = mouse button 0**, right=2 |
| wheel | `__wasmExports.wa` (`_cpp_add_mouse_wheel`) | `wa(n)` | scroll ticks |
| spawn | `__wasmExports.ta` (`_cpp_spawn_player`) | `ta(namePtr)` | heap ptr to name string |

Bundle evidence (`analysis/current/index-5a8b07a6.js`): export binding @175994
(`Et=...ua, _t=...va, At=...wa`); wrappers @153834; listeners @~277281; keyCode map
@178295; DPR scale `Dd`/`zd` @179646.

## Equivalent input-state memory (write each frame; same effect)
WAT evidence (`analysis/current/diep.wat`):
- mouse aim X (screen) = i32 global **560456**; Y = **560460** (PLAIN). Writers: func 1582
  @1274411, func 1265 @710621. The per-frame builder (inlined in func 1298 @~919480,
  opcode `0x01`, coords ×16 zigzag varuints) reads them via getters func 530/529.
- aim-mode byte **560528** (0=mouse, 1=gamepad/auto-aim) — keep 0 for mouse aim.
- movement: NOT a single flag word — rebuilt each frame from a **key-state hashtable at
  560468/560472** (func 93); bitfield {up=2,left=4,down=8,right=16}. Use `ua()` to set it.
- fire: latches **561233** (i8 button-down), **561232** (i16 click), autofire **560660** (i8);
  combined by func 531 into flag bit0.

So: prefer the **exports** (`ua`/`va`) — they populate the hashtable/latches correctly. Raw
memory writes to 560456/560460 also steer aim, but movement/fire are easier via `ua()`.

## ⚠️ The movement gate — `560772` (why `ua()` can look like a no-op)
**LIVE-VALIDATED (2026, Sandbox):** with `i32@560772=0` then `ua(68,1)` held ~800ms, the player
world X (`f32@591660`) moved **242.8 → 418.2 (dx=+175.4, dy=0.0)** — clean rightward movement.
Movement is solved end-to-end. Workflow `diep-movement-re` (verify phase, WAT-evidenced) settled
why `ua(W/A/S/D, 1)` once appeared to do nothing while aim/fire worked:

- `ua(code,state)` = func 1583 = `_cpp_set_keybind_state` **does write correctly** — it stores
  `state` into the held-key node (offset 12) inside the hashmap @560468, exactly where func 93
  reads it (`i32.load8_u offset=12 & 1`). It is **idempotent + persistent**: one `ua(87,1)` stays
  held until `ua(87,0)`; no per-frame re-press needed.
- `func 1298` builds the move bitfield from `call 93`: **W87→2, A65→4, S83→8, D68→16** (arrows
  38/37/40/39 as fallbacks), CONFIRMED at WAT L919247-919330.
- **THE CATCH:** each of those reads is guarded by `i32.const 560772 i32.load br_if` — when the
  **text-input gate i32@560772 != 0**, func 1298 branches past **ALL** WASD reads. A focused
  chat/name box (or an unfocused/automated tab) can leave it set. **Fix: write `560772 = 0` every
  tick** before relying on movement. Aim/fire are unaffected because 560456/560460/560660 are plain
  globals read unconditionally — which is exactly why they worked when movement didn't.
- A second gate (func 115, cached @561232 valid@561233) diverts func 1298 to a UI/overlay path when
  a menu is open — so test in normal play, tank spawned, canvas focused.
- REFUTED dead-ends (do not implement): the "reset_keys race / map wipe" theory — export `ka`
  (func 1258) is **never called** anywhere in the bundle and its arm flag @560480 inits to 0; the
  map never gets wiped.

Minimal proof (paste in console, spawned, in Sandbox):
```js
const ex=window.__wasmExports, dv=new DataView(window.__wasmMem.buffer);
dv.setInt32(560772,0,true); dv.setUint8(560528,0);           // open gate + mouse aim
const x0=dv.getFloat32(591660,true); ex.ua(68,1);            // hold D (right)
setTimeout(()=>{const x1=dv.getFloat32(591660,true); ex.ua(68,0);
  console.log('dx=',(x1-x0).toFixed(1), Math.abs(x1-x0)>0.5?'MOVED ✅':'no move ❌');},800);
```

## Used by
`userscripts/diep-octobot.user.js` (autonomous Sandbox bot: read entities → aim/move/fire
via these exports). Sandbox / private use only.
