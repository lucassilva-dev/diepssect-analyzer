// ==UserScript==
// @name         Diep OctoBot (aggressive sandbox bot)
// @description  Autonomous aggressive bot for diep.io SANDBOX duels. Reads every entity from
//              WASM memory and DRIVES the tank (aim / move / fire) through the game's own WASM
//              input exports. Modes: 'fallen' (Booster rammer that hunts the player) and 'octo'
//              (turret/orbit shooter). For private Sandbox use only. Needs diep-mem-reader.
// @version      0.5
// @namespace    *://diep.io/
// @match        *://diep.io/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * REQUIRES: diep-mem-reader.user.js installed (Tampermonkey Sandbox Mode = "Raw") — it captures
 *   window.__wasmMem and window.__wasmExports.
 *
 * DUEL SETUP (the bot needs its OWN tank — two clients on the same party link):
 *   Window A (you)  : your sandbox tab. Leave the bot OFF here.
 *   Window B (bot)  : same party link in a second window. Spawn, then run diepBot.start('fallen').
 *   Keep BOTH windows VISIBLE side by side — Chrome freezes rAF and throttles timers to 1/s in
 *   background tabs, which turns the bot into a statue. (v0.5 adds a Worker-based tick loop that
 *   survives backgrounding, but side-by-side is still the reliable way.)
 *
 * CONTROL (all LIVE-VALIDATED):
 *   - AIM  : __wasmExports.va(px,py) (= _cpp_set_mouse_pos; screen device px, top-left origin).
 *   - FIRE : mem byte 560660 = 1/0 (autofire latch). For Booster this doubles as THRUST — the
 *            rear barrels' recoil pushes the tank toward the mouse.
 *   - MOVE : __wasmExports.ua(keyCode, 1|0). W87 A65 S83 D68. Gate: i32@560772 must be 0
 *            (func 1298 skips ALL WASD reads otherwise) — forced 0 every tick.
 *
 * MODES:
 *   'fallen' — Fallen-Booster-style rammer: locks onto the PLAYER tank (u32[node+168]!=0 =>
 *              has a name component => player), aims AT it, holds fire (recoil thrust) and
 *              drives into it. Flees (aim+thrust away) below retreatHP. Build: body dmg/HP/speed.
 *   'octo'   — orbiting turret: nearest target, circle-strafe, keep distance, shoot.
 *
 * USAGE: sandbox -> spawn -> console:  diepBot.start('fallen')
 *   Clicks Play, Max Level, allocates stats (mode build), runs a movement self-test, then turns
 *   ON. Click the tank tree yourself in the grace window:
 *     fallen: Flank Guard -> Tri-Angle -> Booster       octo: Twin -> Quad Tank -> Octo Tank
 *   Toggle: B  |  Diagnostics: diepBot.status()  |  Prove move: diepBot.moveTest()
 */

;(() => {
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  if (W.__octobotInstalled) return
  W.__octobotInstalled = true

  // WASD keycodes (func 1298: 87->up/2, 65->left/4, 83->down/8, 68->right/16)
  const KEY = { up: 87, left: 65, down: 83, right: 68 }
  // stat keys '1'..'8' = 49..56. Build orders (priority-first; 8 presses each):
  const BUILDS = {
    fallen: [51, 50, 56, 49, 55],  // 3 Body Dmg, 2 Max HP, 8 Move Spd, 1 Regen, 7 Reload
    octo:   [54, 55, 53, 52, 56],  // 6 Bullet Dmg, 7 Reload, 5 Pen, 4 Bullet Spd, 8 Move Spd
  }

  const bot = {
    on: false,
    MODE: 'fallen',        // 'fallen' (rammer, hunts the player) | 'octo' (orbit turret)
    FIRE: true,
    PREFER_PLAYERS: true,  // lock onto player tanks (u32[node+168]!=0) when any is on screen
    LEAD: false,           // lead aim by target velocity (offsets unverified; opt-in)
    // geometry (world units; render coords are camera-relative world units)
    keepDist: 230,         // octo: orbit range
    tooClose: 130,         // octo: back off inside this
    farmFire: 900,         // octo: fire only within this range (fallen always fires = thrust)
    retreatHP: 0.20,       // flee below this health ratio
    strafeGain: 0.85, strafeFlip: 55,
    leadFactor: 6,
    deadzone: 0.10,        // normalized move threshold
    AIM_ZOOM: true,        // scale aim offset by live zoom decode(u32@591572)
    AIM_SCALE: 1.0,
    // internals
    _held: { up: false, down: false, left: false, right: false },
    _dv4: new DataView(new ArrayBuffer(4)),
    _strafeDir: 1, _strafeT: 0, _frame: 0, _target: null, _self: null,
    _ticks: 0, _rate: 0, _warnedSlow: 0,
  }
  W.diepBot = bot

  const E = () => W.__wasmExports
  const ready = () => W.__wasmMem && E() && typeof E().va === 'function' && typeof E().ua === 'function'

  // cached DataView (rebuild only on buffer growth; per-read alloc was the old OOM)
  let _buf = null, _dv = null, _len = 0
  const DV = () => { const b = W.__wasmMem.buffer; if (b !== _buf) { _buf = b; _dv = new DataView(b); _len = b.byteLength } return _dv }
  const u8 = a => DV().getUint8(a >>> 0), u16 = a => DV().getUint16(a >>> 0, true)
  const u32 = a => DV().getUint32(a >>> 0, true), i32 = a => DV().getInt32(a >>> 0, true)
  const f32 = a => DV().getFloat32(a >>> 0, true)
  const setU8 = (a, v) => DV().setUint8(a >>> 0, v)
  const setI32 = (a, v) => DV().setInt32(a >>> 0, v, true)
  const ok = p => { p >>>= 0; DV(); return p > 0 && p < _len - 256 }

  // obfuscated-f32 decode (verbatim func 82; self-check decode(749705847)==0)
  function decode(v) {
    v >>>= 0; const h = v >>> 16, t = v >>> 24
    const b2 = ((((v + Math.imul(h, -82)) | 0) + 64) ^ 169) & 0xFF
    const mid = ((((h << 8) - (t << 14)) | 0) + 20736) & 0xFF00
    const b0 = (t + 208) & 0xFF
    const b3 = (((((Math.imul(v, 125)) + (v >>> 8)) | 0) - 71) ^ 110) & 0xFF
    const p = (((b3 << 24) | (b2 << 16) | mid | b0) ^ 252) >>> 0
    bot._dv4.setUint32(0, p, true); return bot._dv4.getFloat32(0, true)
  }

  // ---- input primitives ----
  const G_TEXT = 560772, G_AIMMODE = 560528, FIRE_BYTE = 560660
  function gates() { try { if (i32(G_TEXT) !== 0) setI32(G_TEXT, 0); if (u8(G_AIMMODE) !== 0) setU8(G_AIMMODE, 0) } catch (e) {} }
  function move(dir, want) {
    const k = KEY[dir]; want = !!want
    if (bot._held[dir] !== want) { try { E().ua(k, want ? 1 : 0) } catch (e) {} bot._held[dir] = want }
  }
  function setMove(d) { move('up', d.up); move('down', d.down); move('left', d.left); move('right', d.right) }
  function stopMove() { setMove({ up: false, down: false, left: false, right: false }) }
  function fire(on) { try { setU8(FIRE_BYTE, on ? 1 : 0) } catch (e) {} }
  function aimPx(px, py) { try { E().va(px | 0, py | 0) } catch (e) {} }
  // move toward a normalized direction (mx,my), camera-relative axes (+x right, +y down)
  function moveVec(mx, my) {
    const dz = bot.deadzone
    setMove({ right: mx > dz, left: mx < -dz, down: my > dz, up: my < -dz })
  }

  // ---- camera + zoom ----
  const camX = () => f32(591660), camY = () => f32(591664)
  function zoom() { if (!bot.AIM_ZOOM) return 1; const z = decode(u32(591572)); return (Number.isFinite(z) && z > 0 && z < 100) ? z : 1 }

  // ---- enumerate entities (validated hashmap chain) ----
  const WORLD = 582904, base = WORLD + 1120, bm = base + 796
  function entities() {
    const out = []
    for (let probe = 0; probe < 16384 && out.length < 400; probe++) {
      if (!((u8(bm + (probe >> 3)) >> (probe & 7)) & 1)) continue
      const page = u32(base + 6940 + ((probe >> 8) << 2)); if (!ok(page)) continue
      const node = (page + (probe & 255) * 224) >>> 0; if (!ok(node) || u16(node + 116) !== 6954) continue
      const R = u32(node + 172); if (!ok(R)) continue
      const rx = decode(u32(R + 144)), ry = decode(u32(R + 164))
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue
      const vx = f32(R + 132), vy = f32(R + 172)
      out.push({
        node, R, ox: rx, oy: ry,
        vx: Number.isFinite(vx) ? vx : 0, vy: Number.isFinite(vy) ? vy : 0,
        dist: Math.hypot(rx, ry),
        isPlayer: ok(u32(node + 168)),   // name/identity component present => player tank
      })
    }
    return out
  }
  function findSelf(es) { let best = null; for (const e of es) if (e.dist < 60 && (!best || e.dist < best.dist)) best = e; return best }
  function selfHealth() {
    const s = bot._self; if (!s) return 1
    const H = u32(s.node + 176); if (!ok(H)) return 1
    const r = f32(H + 48); return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1
  }
  function pickTarget(es, self) {
    const cands = es.filter(e => e !== self && e.dist > 40)
    if (!cands.length) return null
    const players = cands.filter(e => e.isPlayer)
    const pool = (bot.PREFER_PLAYERS && players.length) ? players : cands
    pool.sort((a, b) => a.dist - b.dist)
    return pool[0]
  }
  function refresh(t) {
    if (!t || !ok(t.R)) return
    const rx = decode(u32(t.R + 144)), ry = decode(u32(t.R + 164))
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return
    t.ox = rx; t.oy = ry; t.dist = Math.hypot(rx, ry)
    t.vx = f32(t.R + 132); t.vy = f32(t.R + 172)
  }

  // ---- one tick ----
  function tick() {
    bot._ticks++
    if (!bot.on || !ready()) return
    gates()

    if ((bot._frame++ & 3) === 0) {
      const es = entities()
      bot._self = findSelf(es)
      bot._target = pickTarget(es, bot._self)
    } else refresh(bot._target)
    const t = bot._target
    if (!t) { stopMove(); fire(false); return }

    const cv = document.querySelector('canvas')
    const cw = cv ? cv.width : window.innerWidth, ch = cv ? cv.height : window.innerHeight
    const z = zoom() * bot.AIM_SCALE
    const d = t.dist || 1, ux = t.ox / d, uy = t.oy / d
    const fleeing = selfHealth() < bot.retreatHP

    if (bot.MODE === 'fallen') {
      // ===== Fallen Booster: ram the target. Firing = rear-barrel recoil thrust toward the mouse.
      if (fleeing) {
        aimPx(cw / 2 - t.ox * z, ch / 2 - t.oy * z)   // aim AWAY -> thrust boosts the escape
        fire(true)
        moveVec(-ux, -uy)
      } else {
        let ax = t.ox, ay = t.oy
        if (bot.LEAD) { ax += t.vx * bot.leadFactor; ay += t.vy * bot.leadFactor }
        aimPx(cw / 2 + ax * z, ch / 2 + ay * z)        // aim AT the player = thrust INTO the ram
        fire(bot.FIRE)
        moveVec(ux, uy)                                // full chase, no keep-distance
      }
      return
    }

    // ===== octo: orbiting turret =====
    aimPx(cw / 2 + t.ox * z, ch / 2 + t.oy * z)
    fire(bot.FIRE && t.dist < bot.farmFire)
    let mx = 0, my = 0
    if (fleeing) { mx = -ux; my = -uy }
    else {
      if (d > bot.keepDist) { mx += ux; my += uy }
      else if (d < bot.tooClose) { mx -= ux; my -= uy }
      if (++bot._strafeT > bot.strafeFlip) { bot._strafeT = 0; bot._strafeDir *= -1 }
      mx += -uy * bot.strafeGain * bot._strafeDir
      my += ux * bot.strafeGain * bot._strafeDir
    }
    moveVec(mx, my)
  }

  // ---- diagnostics ----
  bot.status = function () {
    const r = ready()
    const s = { ready: r, on: bot.on, mode: bot.MODE, ticksPerSec: bot._rate }
    if (!r) { s.problem = 'wasm exports not captured — diep-mem-reader installed? Sandbox Mode=Raw? Reload.'; console.table(s); return s }
    const es = entities(); const self = findSelf(es); const t = pickTarget(es, self)
    Object.assign(s, {
      entities: es.length, players: es.filter(e => e.isPlayer).length,
      camera: [+camX().toFixed(0), +camY().toFixed(0)], zoom: +zoom().toFixed(3),
      textGate_560772: i32(G_TEXT), selfFound: !!self, selfHealth: +selfHealth().toFixed(2),
      target: t ? { dist: +t.dist.toFixed(0), off: [+t.ox.toFixed(0), +t.oy.toFixed(0)], isPlayer: t.isPlayer } : null,
      decodeSelfCheck: decode(749705847) === 0,
    })
    console.table(s); return s
  }
  bot.moveTest = function (dir = 'right') {
    if (!ready()) { console.warn('[octobot] not ready'); return }
    gates()
    const x0 = camX(), y0 = camY()
    console.log('[octobot] moveTest', dir, 'BEFORE', x0.toFixed(1), y0.toFixed(1), 'gate560772=', i32(G_TEXT))
    move(dir, true)
    setTimeout(() => {
      const x1 = camX(), y1 = camY(); move(dir, false)
      const moved = Math.hypot(x1 - x0, y1 - y0) > 0.5
      console.log('%c[octobot] moveTest ' + (moved ? 'PASS' : 'FAIL') + ' dx=' + (x1 - x0).toFixed(1) + ' dy=' + (y1 - y0).toFixed(1),
        'color:' + (moved ? '#0f0' : '#f33') + ';font-weight:bold')
      if (!moved) console.log('[octobot] no move -> spawned? window visible? 560772==0? not in a menu? Try diepBot.status().')
    }, 800)
  }

  // ---- loadout helpers (Sandbox menu/cheats are DOM) ----
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  function clickByText(txt) {
    const re = new RegExp(txt, 'i')
    const els = [...document.querySelectorAll('button,div,span,a')]
      .filter(e => e.offsetParent !== null && re.test((e.textContent || '').trim()) && (e.textContent || '').length < 40)
    els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)
    if (els[0]) { els[0].click(); return true }
    return false
  }
  bot.spawn = function () { if (!clickByText('^Play')) console.warn('[octobot] Play button not found — click Play manually') }
  bot.maxStats = function (order) {
    order = order || BUILDS[bot.MODE] || BUILDS.octo
    const q = []; for (const k of order) for (let i = 0; i < 8; i++) q.push(k)   // priority-first
    const id = setInterval(() => {
      const k = q.shift(); if (k == null) return clearInterval(id)
      try { E().ua(k, 1); E().ua(k, 0) } catch (e) {}
    }, 60)
  }
  bot.maxLevel = function () {
    if (!clickByText('Max Level')) { clickByText('Sandbox|Cheat'); setTimeout(() => { if (!clickByText('Max Level')) console.warn('[octobot] Max Level not found — open the flask panel and click it'); }, 200) }
  }
  bot.start = async function (mode) {
    if (mode) bot.MODE = mode
    bot.spawn(); await sleep(1300)
    bot.maxLevel(); await sleep(900)
    bot.maxStats(); await sleep(400)
    const tree = bot.MODE === 'fallen' ? 'Flank Guard -> Tri-Angle -> BOOSTER' : 'Twin -> Quad Tank -> OCTO TANK'
    console.log('%c[octobot] spawned + maxed (' + bot.MODE + ' build). Click the tank tree: ' + tree, 'color:#0ff')
    bot.moveTest('right')
    setTimeout(() => { bot.on = true; console.log('%c[octobot] ON — hunting (' + bot.MODE + '). B toggles, diepBot.status() inspects.', 'color:#f0f;font-weight:bold') }, 6000)
  }

  // ---- tick loop: Worker-driven so it keeps running when the tab is backgrounded ----
  // Chrome freezes rAF and throttles main-thread timers to >=1s in background tabs; a dedicated
  // Worker's setInterval is not throttled, and its postMessage wakes the main thread promptly.
  let _lastTick = 0
  function tickGuard() { const n = performance.now(); if (n - _lastTick < 30) return; _lastTick = n; try { tick() } catch (e) {} }
  try {
    const wsrc = 'setInterval(function(){postMessage(0)},40)'
    const wk = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' })))
    wk.onmessage = tickGuard
  } catch (e) { console.warn('[octobot] Worker loop blocked (CSP?) — falling back to timers; keep this window VISIBLE') }
  setInterval(tickGuard, 50)                                        // fallback (throttled in bg)
  ;(function raf() { tickGuard(); requestAnimationFrame(raf) })()   // smoothness when visible
  setInterval(() => {
    bot._rate = bot._ticks / 2; bot._ticks = 0
    if (bot.on && bot._rate < 15 && Date.now() - bot._warnedSlow > 10000) {
      bot._warnedSlow = Date.now()
      console.warn('[octobot] only ' + bot._rate + ' ticks/s — window is backgrounded/throttled. Keep it VISIBLE (side by side).')
    }
  }, 2000)

  W.addEventListener('keydown', e => {
    if (e.key === 'b' || e.key === 'B') {
      bot.on = !bot.on
      if (!bot.on) { stopMove(); fire(false) }
      console.log('%c[octobot] ' + (bot.on ? 'ON — hunting (' + bot.MODE + ')' : 'OFF'), 'color:#f0f;font-weight:bold')
    }
  })
  console.log('%c[octobot v0.5] loaded. Sandbox -> spawn -> diepBot.start(\'fallen\') (Booster rammer) or diepBot.start(\'octo\'). B toggles.',
    'color:#f0f;font-weight:bold')
})()
