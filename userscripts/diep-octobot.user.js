// ==UserScript==
// @name         Diep OctoBot (aggressive sandbox bot)
// @description  Autonomous aggressive bot for diep.io SANDBOX duels with an on-screen control
//              panel (no console needed). Reads every entity from WASM memory and DRIVES the
//              tank (aim / move / fire) through the game's own WASM input exports. Modes:
//              'fallen' (Booster rammer that hunts the player) and 'octo' (orbit turret).
//              For private Sandbox use only. SELF-CONTAINED (captures WASM itself; the separate
//              diep-mem-reader is optional).
// @version      0.9
// @namespace    *://diep.io/
// @match        *://diep.io/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * SETUP: install THIS script only. Tampermonkey Sandbox Mode must be "Raw" (Settings -> config
 * mode Advanced -> Sandbox Mode -> Raw) so the document-start WASM hook wins the race against
 * diep's bundle. If the panel shows "memória: NÃO capturada", that's the fix; then reload (F5).
 *
 * UI: a draggable panel appears top-right on diep.io. Buttons:
 *   ▶ FALLEN  — turnkey Booster rammer duel bot (spawn -> max level -> ram build -> ON)
 *   ▶ OCTO    — turnkey orbit-turret bot
 *   ⚔ ON/OFF  — toggle the brain (same as pressing B)
 *   🧪 mover  — movement self-test (drives right 0.8s, reports dx/dy)
 *   📡 base   — re-scan the entity-store base (arena switch)
 * The status rows (memória/base/entidades/eu/alvo/loop) update live; the log shows what the
 * bot is doing. Click the tank tree yourself when asked (fallen: Flank Guard -> Tri-Angle ->
 * Booster; octo: Twin -> Quad Tank -> Octo Tank).
 *
 * DUEL SETUP: two windows on the same party link, SIDE BY SIDE (both visible).
 *   Window A (you): play normally, leave the bot OFF.
 *   Window B (bot): press ▶ FALLEN on the panel.
 *
 * CONTROL (all LIVE-VALIDATED): aim = __wasmExports.va(px,py); fire = mem byte 560660;
 * move = __wasmExports.ua(87/65/83/68, 1|0) with text-gate i32@560772 forced 0 each tick.
 * ENTITIES (verified via adversarial WAT workflows): per-arena container discovered through
 * the registry ring @467744 (base=container+12); node liveness = occupancy bitmap + generation
 * u16@node+116 != 6875; renderable ptr @node+172 (pos = decode(+144/+164), camera-relative);
 * health ratio @ (node+176)+48; named actor (player/boss) = u32[node+168] != 0; self = camera
 * object from vector @BASE+676 (raw u16 id match; u16(cam+68)==6875 means DEAD -> auto respawn).
 */

;(() => {
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  if (W.__octobotInstalled) return
  W.__octobotInstalled = true

  // ---- self-contained WASM capture (no separate mem-reader needed) ----
  // Hook WASM instantiation at document-start so we grab the game's linear memory + exports the
  // moment the bundle creates its instance. NEEDS Tampermonkey Sandbox Mode = "Raw" so this runs
  // before diep's bundle instantiates; otherwise the hook loses the race and nothing is captured
  // (the panel then shows "memória: NÃO capturada" with the fix). Sets W.__wasmMem / __wasmExports
  // — the same globals diep-mem-reader used, so both can coexist.
  ;(function captureWasm() {
    try {
      const WA = W.WebAssembly; if (!WA) return
      const grab = res => {
        try {
          const inst = res && (res.instance || res)
          if (inst && inst.exports && !W.__wasmMem) {
            const ex = inst.exports
            const m = (ex.memory instanceof WA.Memory && ex.memory) || Object.values(ex).find(x => x instanceof WA.Memory)
            if (m && m.buffer) {
              W.__wasmExports = ex; W.__wasmMem = m
              try { console.log('%c[octobot] WASM capturada:', 'color:#0f0', m.buffer.byteLength, 'bytes,', Object.keys(ex).length, 'exports') } catch (e) {}
            }
          }
        } catch (e) {}
        return res
      }
      const oI = WA.instantiate
      WA.instantiate = function (a, b) { const p = oI.call(this, a, b); return (p && p.then) ? p.then(grab) : p }
      if (WA.instantiateStreaming) { const oS = WA.instantiateStreaming; WA.instantiateStreaming = function (a, b) { return oS.call(this, a, b).then(grab) } }
      const OI = WA.Instance
      const Wd = function (m, i) { const inst = new OI(m, i); grab(inst); return inst }
      Wd.prototype = OI.prototype; WA.Instance = Wd
    } catch (e) {}
  })()

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
    PREFER_PLAYERS: true,  // lock onto named actors first (players/bosses: u32[node+168]!=0)
    keepDist: 230, tooClose: 130, farmFire: 900,
    retreatHP: 0.20,
    strafeGain: 0.85, strafeFlip: 55,
    deadzone: 0.10,
    AIM_ZOOM: true, AIM_SCALE: 1.0,
    // internals
    _held: { up: false, down: false, left: false, right: false },
    _dv4: new DataView(new ArrayBuffer(4)),
    _strafeDir: 1, _strafeT: 0, _frame: 0, _target: null, _self: null,
    _ticks: 0, _rate: 0, _warnedSlow: 0, _deadTicks: 0,
    _entCount: 0, _tankCount: 0,
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
  function moveVec(mx, my) {
    const dz = bot.deadzone
    setMove({ right: mx > dz, left: mx < -dz, down: my > dz, up: my < -dz })
  }

  const camX = () => f32(591660), camY = () => f32(591664)
  function zoom() { if (!bot.AIM_ZOOM) return 1; const z = decode(u32(591572)); return (Number.isFinite(z) && z > 0 && z < 100) ? z : 1 }

  // ---- entity store base — DISCOVERED, not hardcoded ----
  // The live entity container is PER-ARENA (heap container registered in the id->container ring
  // @467744). Hardcoding the static base made the bot see 0 entities in fresh arenas. We score
  // every candidate base (container+12) by live-bitmap nodes and adopt the best; re-scan if dry.
  // Node liveness: bitmap bit + generation u16@node+116 != 6875 (gen-0 = never used; the old
  // ===6954 check meant generation==1 and silently dropped reused slots).
  const WORLD = 582904, STATIC_BASE = WORLD + 1120, REG = 467744
  let BASE = 0, BASE_SRC = 'none', _dryScans = 0
  const liveNode = nd => ok(nd) && u16(nd + 116) !== 6875
  function countBase(b) {
    if (!ok(b + 7196)) return 0
    let n = 0
    try {
      for (let pr = 0; pr < 16384; pr++) {
        if (!((u8(b + 796 + (pr >> 3)) >> (pr & 7)) & 1)) continue
        const pg = u32(b + 6940 + ((pr >> 8) << 2)); if (!ok(pg)) continue
        if (liveNode((pg + (pr & 255) * 224) >>> 0)) n++
      }
    } catch (e) {}
    return n
  }
  function findBase() {
    const seen = new Set([STATIC_BASE]), cands = [STATIC_BASE]
    for (let i = 0; i < 65536 && cands.length < 64; i++) {
      const c = u32(REG + i * 4); if (!ok(c)) continue
      const b = (c + 12) >>> 0
      if (!seen.has(b)) { seen.add(b); cands.push(b) }
    }
    let best = 0, bestN = 0
    for (const b of cands) { const n = countBase(b); if (n > bestN) { bestN = n; best = b } }
    if (best) { BASE = best; BASE_SRC = (best === STATIC_BASE ? 'static' : 'registry') }
    return bestN
  }
  // owner test (CONFIRMED, funcs 151/161/224): relations component @node+124 holds the spawner's
  // id-tuple at +8..+18 with validity byte @+20; null tuple = (24603,_,6875,_,30379). An entity
  // WITH a valid non-null owner is a projectile/drone/trap (never a target for the rammer). A tank
  // or a shape has NO owner. So: tank = named && !owned ; projectile = owned.
  const NULL_W = 24603, NULL_G = 6875, NULL_I = 30379
  function isOwned(node) {
    const rel = u32(node + 124); if (!ok(rel)) return false
    if (!u8(rel + 20)) return false
    if (u16(rel + 8) === NULL_W && u16(rel + 12) === NULL_G && u16(rel + 16) === NULL_I) return false
    return true
  }
  function entities() {
    const out = []
    if (!BASE && !findBase()) return out
    for (let probe = 0; probe < 16384 && out.length < 400; probe++) {
      if (!((u8(BASE + 796 + (probe >> 3)) >> (probe & 7)) & 1)) continue
      const page = u32(BASE + 6940 + ((probe >> 8) << 2)); if (!ok(page)) continue
      const node = (page + (probe & 255) * 224) >>> 0; if (!liveNode(node)) continue
      const R = u32(node + 172); if (!ok(R)) continue
      const rx = decode(u32(R + 144)), ry = decode(u32(R + 164))
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue
      const named = ok(u32(node + 168)), owned = isOwned(node)
      out.push({
        node, R, ox: rx, oy: ry, dist: Math.hypot(rx, ry),
        named, owned,
        tank: named && !owned,   // real tank (player or named AI); excludes projectiles/shapes
      })
    }
    if (!out.length) { if (++_dryScans >= 15) { _dryScans = 0; findBase() } } else _dryScans = 0
    return out
  }
  // self = the node the local camera follows (raw u16 id match on the camera object from the
  // vector @BASE+676; verified func-77 path). u16(cam+68)==6875 => the local tank is DEAD.
  function cameraObj() {
    const beg = u32(BASE + 676), end = u32(BASE + 680)
    if (!ok(beg) || beg === end) return 0
    const cam = u32(beg)
    return ok(cam) ? cam : 0
  }
  function selfDead() { if (!BASE) return false; const c = cameraObj(); return c ? u16(c + 68) === 6875 : false }
  function findSelf(es) {
    const c = cameraObj()
    if (c) {
      const g = u16(c + 68), k = u16(c + 72)
      for (const e of es) if (u16(e.node + 116) === g && u16(e.node + 120) === k) return e
    }
    let best = null
    for (const e of es) if (e.dist < 60 && (!best || e.dist < best.dist)) best = e
    return best
  }

  function selfHealth() {
    const s = bot._self; if (!s) return 1
    const H = u32(s.node + 176); if (!ok(H)) return 1
    const r = f32(H + 48); return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1
  }
  function pickTarget(es, self) {
    // never target projectiles/drones (owned); never target self
    const cands = es.filter(e => e !== self && e.dist > 40 && !e.owned)
    if (!cands.length) return null
    const tanks = cands.filter(e => e.tank)   // real enemy tanks (you, in a 1v1)
    const pool = (bot.PREFER_PLAYERS && tanks.length) ? tanks : cands
    pool.sort((a, b) => a.dist - b.dist)
    return pool[0]
  }
  function refresh(t) {
    if (!t || !ok(t.R)) return
    const rx = decode(u32(t.R + 144)), ry = decode(u32(t.R + 164))
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return
    t.ox = rx; t.oy = ry; t.dist = Math.hypot(rx, ry)
  }

  // ---- one tick ----
  function tick() {
    bot._ticks++
    if (!bot.on || !ready()) return
    gates()

    // dead? stop everything and try to respawn every ~2s (camera gen == 6875 => no tank)
    if (selfDead()) {
      stopMove(); fire(false)
      bot._deadTicks++
      if (bot._deadTicks % 60 === 1) { uiLog('morri — respawnando…', '#fa0'); bot.spawn() }
      return
    }
    bot._deadTicks = 0

    if ((bot._frame++ & 3) === 0) {
      const es = entities()
      bot._entCount = es.length
      bot._tankCount = es.filter(e => e.tank).length
      bot._self = findSelf(es)
      bot._target = pickTarget(es, bot._self)
    } else refresh(bot._target)
    const t = bot._target
    if (!t) { stopMove(); fire(false); return }

    let cw = i32(602700), ch = i32(602704)             // canvas device px (verified globals)
    if (!(cw > 0 && ch > 0)) { const cv = document.querySelector('canvas'); cw = cv ? cv.width : window.innerWidth; ch = cv ? cv.height : window.innerHeight }
    const z = zoom() * bot.AIM_SCALE
    const d = t.dist || 1, ux = t.ox / d, uy = t.oy / d
    const fleeing = selfHealth() < bot.retreatHP

    if (bot.MODE === 'fallen') {
      // Fallen Booster: ram the target. Firing = rear-barrel recoil thrust toward the mouse.
      if (fleeing) {
        aimPx(cw / 2 - t.ox * z, ch / 2 - t.oy * z)   // aim AWAY -> thrust boosts the escape
        fire(true)
        moveVec(-ux, -uy)
      } else {
        aimPx(cw / 2 + t.ox * z, ch / 2 + t.oy * z)   // aim AT the target = thrust INTO the ram
        fire(bot.FIRE)
        moveVec(ux, uy)
      }
      return
    }

    // octo: orbiting turret
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

  // ---- diagnostics (console versions kept for power users) ----
  bot.status = function () {
    const r = ready()
    const s = { ready: r, on: bot.on, mode: bot.MODE, ticksPerSec: bot._rate }
    if (!r) { s.problem = 'wasm exports not captured — diep-mem-reader installed? Sandbox Mode=Raw? Reload.'; console.table(s); return s }
    const es = entities(); const self = findSelf(es); const t = pickTarget(es, self)
    Object.assign(s, {
      base: BASE, baseSrc: BASE_SRC, dead: selfDead(),
      entities: es.length, tanks: es.filter(e => e.tank).length,
      camera: [+camX().toFixed(0), +camY().toFixed(0)], zoom: +zoom().toFixed(3),
      textGate_560772: i32(G_TEXT), selfFound: !!self, selfHealth: +selfHealth().toFixed(2),
      target: t ? { dist: +t.dist.toFixed(0), off: [+t.ox.toFixed(0), +t.oy.toFixed(0)], tank: t.tank } : null,
      decodeSelfCheck: decode(749705847) === 0,
    })
    console.table(s); return s
  }
  bot.moveTest = function (dir = 'right') {
    if (!ready()) { uiLog('não pronto — mem não capturada', '#f66'); return }
    gates()
    const x0 = camX(), y0 = camY()
    uiLog('teste de movimento (' + dir + ')…', '#9ad')
    move(dir, true)
    setTimeout(() => {
      const x1 = camX(), y1 = camY(); move(dir, false)
      const moved = Math.hypot(x1 - x0, y1 - y0) > 0.5
      uiLog('movimento: ' + (moved ? 'OK ✔ dx=' + (x1 - x0).toFixed(0) : 'FALHOU ✖ (spawnado? janela visível?)'),
        moved ? '#6f6' : '#f66')
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
  bot.spawn = function () { if (!clickByText('^Play')) uiLog('botão Play não achado — clique Play', '#fa0') }
  bot.maxStats = function (order) {
    order = order || BUILDS[bot.MODE] || BUILDS.octo
    const q = []; for (const k of order) for (let i = 0; i < 8; i++) q.push(k)
    const id = setInterval(() => {
      const k = q.shift(); if (k == null) return clearInterval(id)
      try { E().ua(k, 1); E().ua(k, 0) } catch (e) {}
    }, 60)
  }
  bot.maxLevel = function () {
    if (!clickByText('Max Level')) { clickByText('Sandbox|Cheat'); setTimeout(() => { if (!clickByText('Max Level')) uiLog('Max Level não achado — abra o frasco e clique', '#fa0') }, 200) }
  }
  bot.start = async function (mode) {
    if (mode) bot.MODE = mode
    if (!ready()) { uiLog('mem não capturada — recarregue (F5) e tente de novo', '#f66'); return }
    uiLog('start ' + bot.MODE + ': spawn…')
    bot.spawn(); await sleep(1300)
    bot.maxLevel(); await sleep(900)
    bot.maxStats(); await sleep(400)
    const tree = bot.MODE === 'fallen' ? 'Flank Guard → Tri-Angle → BOOSTER' : 'Twin → Quad → OCTO TANK'
    uiLog('CLIQUE a árvore: ' + tree, '#0ff')
    bot.moveTest('right')
    setTimeout(() => { bot.on = true; uiLog('BOT ON — caçando (' + bot.MODE + ')', '#f0f') }, 6000)
  }

  // ================= UI PANEL (no console needed) =================
  const UI = { root: null, body: null, logEl: null, rows: {}, lines: [], min: false }
  function uiLog(msg, color) {
    const t = new Date().toTimeString().slice(0, 8)
    UI.lines.push('<div style="color:' + (color || '#ccc') + '">[' + t + '] ' + msg + '</div>')
    if (UI.lines.length > 7) UI.lines.shift()
    if (UI.logEl) UI.logEl.innerHTML = UI.lines.join('')
    try { console.log('[octobot] ' + msg) } catch (e) {}
  }
  function setRow(el, txt, color) { if (el) { el.textContent = txt; el.style.color = color || '#eee' } }
  function mkBtn(label, bg, fn, title) {
    const b = document.createElement('button')
    b.textContent = label
    if (title) b.title = title
    b.setAttribute('tabindex', '-1')
    b.style.cssText = 'flex:1;margin:2px;padding:6px 2px;background:' + bg + ';color:#fff;border:0;border-radius:6px;font:bold 11px monospace;cursor:pointer;'
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); try { fn() } catch (err) { uiLog('erro: ' + err.message, '#f66') } b.blur() })
    return b
  }
  function buildUI() {
    if (UI.root || !document.body) return
    const P = document.createElement('div')
    P.id = '__octobot_panel'
    P.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:236px;' +
      'background:rgba(8,8,18,.92);color:#eee;font:11px/1.5 monospace;border:1px solid #b0b;' +
      'border-radius:10px;padding:7px 9px;user-select:none;box-shadow:0 4px 18px rgba(0,0,0,.5)'
    // keep panel interactions away from the game's global listeners
    for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup'])
      P.addEventListener(ev, e => e.stopPropagation())

    const head = document.createElement('div')
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:move;margin-bottom:4px'
    const title = document.createElement('span')
    title.innerHTML = '<b style="color:#f6f">🤖 OctoBot v0.7</b>'
    const minB = document.createElement('span')
    minB.textContent = '—'
    minB.style.cssText = 'cursor:pointer;padding:0 6px;color:#aaa;font-weight:bold'
    minB.addEventListener('click', e => { e.stopPropagation(); UI.min = !UI.min; UI.body.style.display = UI.min ? 'none' : 'block'; minB.textContent = UI.min ? '□' : '—' })
    head.append(title, minB)

    // drag
    let drag = null
    head.addEventListener('mousedown', e => { drag = { x: e.clientX - P.offsetLeft, y: e.clientY - P.offsetTop }; e.preventDefault() })
    window.addEventListener('mousemove', e => { if (drag) { P.style.left = (e.clientX - drag.x) + 'px'; P.style.top = (e.clientY - drag.y) + 'px'; P.style.right = 'auto' } })
    window.addEventListener('mouseup', () => { drag = null })

    const body = document.createElement('div')
    UI.body = body
    const row = (label) => {
      const r = document.createElement('div')
      r.style.cssText = 'display:flex;justify-content:space-between'
      const l = document.createElement('span'); l.textContent = label; l.style.color = '#8af'
      const v = document.createElement('span'); v.textContent = '—'
      r.append(l, v); body.appendChild(r); return v
    }
    UI.rows.mem = row('memória')
    UI.rows.base = row('base')
    UI.rows.ents = row('entidades')
    UI.rows.self = row('eu')
    UI.rows.tgt = row('alvo')
    UI.rows.loop = row('loop')
    UI.rows.st = row('estado')

    const btns1 = document.createElement('div'); btns1.style.cssText = 'display:flex;margin-top:5px'
    btns1.append(
      mkBtn('▶ FALLEN', '#a1206e', () => bot.start('fallen'), 'spawn + max + build rammer + ON (clique a árvore até Booster)'),
      mkBtn('▶ OCTO', '#20a16e', () => bot.start('octo'), 'spawn + max + build atirador + ON (árvore até Octo)'),
    )
    const btns2 = document.createElement('div'); btns2.style.cssText = 'display:flex'
    btns2.append(
      mkBtn('⚔ ON/OFF', '#444a99', () => {
        bot.on = !bot.on
        if (!bot.on) { stopMove(); fire(false) }
        uiLog(bot.on ? 'BOT ON — caçando (' + bot.MODE + ')' : 'BOT OFF', bot.on ? '#f0f' : '#ccc')
      }, 'liga/desliga o cérebro (tecla B)'),
      mkBtn('🧪 mover', '#7a5c1e', () => bot.moveTest(), 'anda pra direita 0.8s e mede'),
      mkBtn('📡 base', '#1e6a7a', () => { const n = findBase(); uiLog('rescan: ' + n + ' entidades @ ' + BASE + ' (' + BASE_SRC + ')', n ? '#6f6' : '#f66') }, 're-descobre a lista de entidades'),
    )
    const setup = document.createElement('div')
    setup.style.cssText = 'margin-top:6px;padding:6px 7px;background:#3a0d0d;border:1px solid #b44;border-radius:6px;color:#fbb;display:none;font-size:10px;line-height:1.45'
    setup.innerHTML = '⚠ <b style="color:#f88">memória não capturada</b> — o bot não lê o jogo.<br>' +
      '<b>1.</b> ícone Tampermonkey → <b>Painel de controle</b><br>' +
      '<b>2.</b> aba <b>Configurações</b> → "Modo de config" = <b>Avançado</b><br>' +
      '<b>3.</b> role até <b>Modo Sandbox</b> → escolha <b>Raw</b><br>' +
      '<b>4.</b> confirme que <i>Diep OctoBot</i> está <b>ligado</b><br>' +
      '<b>5.</b> volte ao diep.io e <b>recarregue (F5)</b>'
    UI.setup = setup

    const log = document.createElement('div')
    log.style.cssText = 'margin-top:5px;border-top:1px solid #334;padding-top:4px;max-height:110px;overflow:hidden;word-break:break-word'
    UI.logEl = log

    body.append(setup, btns1, btns2, log)
    P.append(head, body)
    document.body.appendChild(P)
    UI.root = P
    uiLog('painel pronto. Abra o Sandbox e clique ▶ FALLEN.', '#6f6')
  }
  // build as soon as body exists (we run at document-start)
  const uiBoot = setInterval(() => { if (document.body) { clearInterval(uiBoot); try { buildUI() } catch (e) {} } }, 300)

  function uiRefresh() {
    if (!UI.root || UI.min) return
    const r = ready()
    setRow(UI.rows.mem, r ? 'capturada ✔' : 'NÃO capturada', r ? '#6f6' : '#f66')
    if (UI.setup) UI.setup.style.display = r ? 'none' : 'block'
    if (!r) { setRow(UI.rows.st, 'aguardando heap…', '#fa0'); return }
    // light scan while idle so the panel is truthful before the bot is on
    if (!bot.on) {
      const es = entities()
      bot._entCount = es.length
      bot._tankCount = es.filter(e => e.tank).length
      bot._self = findSelf(es)
      bot._target = pickTarget(es, bot._self)
    }
    setRow(UI.rows.base, BASE ? BASE + ' (' + BASE_SRC + ')' : 'não achada', BASE ? '#6f6' : '#f66')
    setRow(UI.rows.ents, bot._entCount + ' · ' + (bot._tankCount || 0) + ' tanque(s)', bot._entCount ? '#6f6' : '#f66')
    const dead = selfDead()
    setRow(UI.rows.self, dead ? 'MORTO' : (bot._self ? 'vivo · HP ' + Math.round(selfHealth() * 100) + '%' : '—'), dead ? '#f66' : '#6f6')
    const t = bot._target
    setRow(UI.rows.tgt, t ? Math.round(t.dist) + 'u ' + (t.tank ? '(tanque!)' : '(shape)') : 'nenhum', t ? (t.tank ? '#f6f' : '#fd6') : '#888')
    setRow(UI.rows.loop, bot._rate + ' t/s', bot._rate >= 15 ? '#6f6' : '#fa0')
    setRow(UI.rows.st, (bot.on ? 'CAÇANDO' : 'parado') + ' · ' + bot.MODE, bot.on ? '#f0f' : '#aaa')
  }
  setInterval(uiRefresh, 500)

  // ---- tick loop: Worker-driven so it keeps running when the tab is backgrounded ----
  let _lastTick = 0
  function tickGuard() { const n = performance.now(); if (n - _lastTick < 30) return; _lastTick = n; try { tick() } catch (e) {} }
  try {
    const wsrc = 'setInterval(function(){postMessage(0)},40)'
    const wk = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' })))
    wk.onmessage = tickGuard
  } catch (e) { /* CSP — fall back to timers below */ }
  setInterval(tickGuard, 50)
  ;(function raf() { tickGuard(); requestAnimationFrame(raf) })()
  setInterval(() => {
    bot._rate = Math.round(bot._ticks / 2); bot._ticks = 0
    if (bot.on && bot._rate < 15 && Date.now() - bot._warnedSlow > 10000) {
      bot._warnedSlow = Date.now()
      uiLog('só ' + bot._rate + ' t/s — deixe esta janela VISÍVEL', '#fa0')
    }
  }, 2000)

  W.addEventListener('keydown', e => {
    if (e.key === 'b' || e.key === 'B') {
      bot.on = !bot.on
      if (!bot.on) { stopMove(); fire(false) }
      uiLog(bot.on ? 'BOT ON — caçando (' + bot.MODE + ')' : 'BOT OFF', bot.on ? '#f0f' : '#ccc')
    }
  })
  console.log('%c[octobot v0.9] loaded — alvo por dono (tanque real) + captura própria + painel.', 'color:#f0f;font-weight:bold')
})()
