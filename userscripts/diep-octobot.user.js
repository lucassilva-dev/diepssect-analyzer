// ==UserScript==
// @name         Diep OctoBot (aggressive sandbox bot)
// @description  Autonomous aggressive bot for diep.io SANDBOX duels. Reads all entities from
//              WASM memory and drives the tank (aim/move/fire) via the game's own WASM input
//              exports. For private Sandbox use only (you vs the bot). Requires diep-mem-reader.
// @version      0.1
// @namespace    *://diep.io/
// @match        *://diep.io/
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * REQUIRES: diep-mem-reader.user.js installed (Sandbox Mode = Raw) — it captures
 *   window.__wasmMem and window.__wasmExports and window.mem.
 *
 * HOW CONTROL WORKS (recovered + dual-agent-verified from diep.wat / bundle):
 *   - Aim : __wasmExports.va(screenX*dpr, screenY*dpr)   (= _cpp_set_mouse_pos; screen pixels)
 *   - Keys: __wasmExports.ua(keyCode, 1|0)               (= _cpp_set_keybind_state)
 *           W=87 A=65 S=83 D=68 ; FIRE = mouse button 0 ; numbers '1'..'8' = 49..56
 *   - Calling these exports BYPASSES the isTrusted check (synthetic DOM events are ignored).
 *   - Entity world pos = decode(render+144/+164) + camera(591660/591664); decode is the
 *     verified byte-permuting affine+XOR (sentinel decode(749705847)==0).
 *
 * USAGE: install, open a SANDBOX, spawn. Press  B  to toggle the bot on/off.
 *   Loadout helpers (run once from console or via keys): diepBot.maxStatsOcto()
 *   Calibrate aim once if shots miss: diepBot.AIM_SCALE (see notes).
 */

;(() => {
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  if (W.__octobotInstalled) return
  W.__octobotInstalled = true

  const KEY = { W: 87, A: 65, S: 83, D: 68, FIRE: 0 }

  const bot = {
    on: false,
    AIM_SCALE: 1.0,      // screen-pixel per render-unit; calibrate live if aim is off
    FIRE: true,
    CHASE: true,
    STRAFE: true,
    targetDeadzone: 12,  // render units; ignore target jitter inside this
    _heldKeys: new Set(),
    _dv: new DataView(new ArrayBuffer(4)),
  }
  W.diepBot = bot

  const ready = () => W.__wasmExports && W.__wasmMem && typeof W.__wasmExports.va === 'function'
  const E = () => W.__wasmExports
  const dpr = () => (window.devicePixelRatio || 1)

  // ---- input primitives (via wasm exports) ----
  function aimScreen(px, py) { try { E().va(px * dpr(), py * dpr()) } catch (e) {} }
  function key(code, down) {
    try {
      E().ua(code, down ? 1 : 0)
      if (down) bot._heldKeys.add(code); else bot._heldKeys.delete(code)
    } catch (e) {}
  }
  function releaseAll() { for (const k of [...bot._heldKeys]) key(k, false); }

  // ---- memory + decode ----
  const heap = () => new Uint8Array(W.__wasmMem.buffer)
  const dvm = () => new DataView(W.__wasmMem.buffer)
  const u8 = a => dvm().getUint8(a >>> 0), u16 = a => dvm().getUint16(a >>> 0, true)
  const u32 = a => dvm().getUint32(a >>> 0, true), f32 = a => dvm().getFloat32(a >>> 0, true)
  const HEAPLEN = () => W.__wasmMem.buffer.byteLength
  const ok = p => { p >>>= 0; return p > 0 && p < HEAPLEN() - 256 }
  function decode(v) {
    v >>>= 0; const h = v >>> 16, t = v >>> 24
    const b2 = ((((v + Math.imul(h, -82)) | 0) - (-64)) ^ 169) & 0xFF
    const mid = ((((h << 8) - (t << 14)) | 0) + 20736) & 0xFF00
    const b0 = (t + 208) & 0xFF
    const b3 = (((((Math.imul(v, 125)) + (v >>> 8)) | 0) - 71) ^ 110) & 0xFF
    const p = (((b3 << 24) | (b2 << 16) | mid | b0) ^ 252) >>> 0
    bot._dv.setUint32(0, p, true); return bot._dv.getFloat32(0, true)
  }

  // ---- enumerate entities (validated hashmap chain) ----
  const WORLD = 582904, base = WORLD + 1120, bm = base + 796
  function entities() {
    const out = []
    for (let probe = 0; probe < 65536 && out.length < 600; probe++) {
      if (!((u8(bm + (probe >> 3)) >> (probe & 7)) & 1)) continue
      const page = u32(base + 6940 + ((probe >> 8) << 2)); if (!ok(page)) continue
      const node = (page + (probe & 255) * 224) >>> 0; if (!ok(node) || u16(node + 116) !== 6954) continue
      const R = u32(node + 172); if (!ok(R)) continue
      const sx = decode(u32(R + 144)), sy = decode(u32(R + 164)), type = u32(R + 176) >>> 0
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue
      out.push({ node, sx, sy, type, dist: Math.hypot(sx, sy) })
    }
    return out
  }

  // ---- target: nearest non-self entity (self sits at screen ~0,0). Prefer the largest
  //      cluster / a non-shape. In a 1v1 sandbox the user's tank is the main other entity. ----
  function pickTarget() {
    const es = entities()
    // self/camera-attached entities sit at render ~ (0,0); skip them
    const cands = es.filter(e => e.dist > 40)
    if (!cands.length) return null
    cands.sort((a, b) => a.dist - b.dist)
    return cands[0]
  }

  // ---- one bot tick ----
  let strafeDir = 1, strafeT = 0
  function tick() {
    if (!bot.on || !ready()) return
    const t = pickTarget()
    if (!t) { releaseAll(); if (bot.FIRE) key(KEY.FIRE, false); return }

    // AIM: target render coords are camera-relative; screen pixel = center + render*scale
    const cv = document.querySelector('canvas')
    const cw = cv ? cv.width : window.innerWidth, ch = cv ? cv.height : window.innerHeight
    const px = cw / 2 + t.sx * bot.AIM_SCALE
    const py = ch / 2 + t.sy * bot.AIM_SCALE
    aimScreen(px / dpr(), py / dpr())   // aimScreen multiplies by dpr; keep raw pixel

    // FIRE
    if (bot.FIRE) key(KEY.FIRE, true)

    // MOVE: chase toward target with a circle-strafe
    if (bot.CHASE) {
      const dz = bot.targetDeadzone
      // base chase direction (render +Y is down, +X is right)
      let wantX = t.sx, wantY = t.sy
      if (bot.STRAFE) {
        // add a perpendicular component to circle the enemy
        if (++strafeT > 40) { strafeT = 0; strafeDir *= -1 }
        wantX += -t.sy * 0.7 * strafeDir
        wantY += t.sx * 0.7 * strafeDir
      }
      key(KEY.D, wantX > dz); key(KEY.A, wantX < -dz)
      key(KEY.S, wantY > dz); key(KEY.W, wantY < -dz)
    }
  }

  // ---- loadout helpers ----
  bot.maxStatsOcto = function () {
    // Octo Tank path: Tank -> Triplet/Quad... the simplest reliable route is Max Level (sandbox)
    // then upgrade to Octo via the tank-upgrade UI. Stat keys '1'..'8' = keyCodes 49..56.
    // Max out the 8 stats by pressing each number key several times.
    let i = 0
    const id = setInterval(() => {
      for (let k = 49; k <= 56; k++) { key(k, true); key(k, false) }
      if (++i > 8) clearInterval(id)
    }, 120)
    console.log('[octobot] hammering stat keys 1..8 (run sandbox Max Level + pick Octo Tank in the UI)')
  }

  // ---- main loop + toggle ----
  function loop() { try { tick() } catch (e) {} requestAnimationFrame(loop) }
  requestAnimationFrame(loop)

  // toggle with B (uses a REAL keydown listener on our side, fine — it's our own UI key)
  W.addEventListener('keydown', e => {
    if (e.key === 'b' || e.key === 'B') {
      bot.on = !bot.on
      if (!bot.on) { releaseAll(); key(KEY.FIRE, false) }
      console.log('%c[octobot] ' + (bot.on ? 'ON — attacking' : 'OFF'), 'color:#f0f;font-weight:bold')
    }
  })

  console.log('%c[octobot v0.1] loaded. Open Sandbox, spawn, press B to toggle. diepBot for config.',
    'color:#f0f;font-weight:bold')
})()
