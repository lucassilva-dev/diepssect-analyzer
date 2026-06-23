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

## Used by
`userscripts/diep-octobot.user.js` (autonomous Sandbox bot: read entities → aim/move/fire
via these exports). Sandbox / private use only.
