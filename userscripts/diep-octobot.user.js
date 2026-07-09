// ==UserScript==
// @name         Diep OctoBot (aggressive sandbox bot)
// @description  Autonomous aggressive bot for diep.io SANDBOX duels with an on-screen control
//              panel (no console needed). Reads every entity from WASM memory and DRIVES the
//              tank (aim / move / fire) through the game's own WASM input exports. Plays a full
//              level-1->45 duel: auto-spawn, auto-allocate stats to the build, auto-evolve the
//              tank tree. Modes: 'fallen' (Booster rammer) and 'overlord' (drone turret).
//              For private Sandbox use only. SELF-CONTAINED (captures WASM itself).
// @version      0.16
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
 *   ▶ FALLEN   — Play at level 1 + Booster build + auto-evolve + ON (rammer)
 *   ▶ OVERLORD — Play at level 1 + Overlord build + auto-evolve + ON (drones)
 *   ⚔ ON/OFF   — toggle the brain (same as pressing B)
 *   🧪 mover   — movement self-test (drives right 0.8s, reports dx/dy)
 *   📡 base    — re-scan the entity-store base (arena switch)
 *   🔍 diag    — dump candidate containers + nearest entities to the console
 * The status rows update live; the log shows what the bot is doing.
 * Builds (stat order 1..8 = Regen/MaxHP/BodyDmg/BulletSpd/Pen/BulletDmg/Reload/MoveSpd):
 *   fallen(Booster): 7 MoveSpd, 7 BulletDmg, 7 Pen, 7 Reload, rest BulletSpd
 *   overlord:        7 Reload, 7 BulletDmg, 7 Pen, 7 BulletSpd, rest MoveSpd
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

  const VERSION = '0.16'

  // ================= CANVAS-2D PERCEPTION (build-independent) =================
  // diep renders in JS via getContext('2d') (no WebGL, no WASM canvas ops). Every entity is drawn
  // translated to its screen center, so the current transform's translation at draw time == the
  // entity's screen pixel. We hook the 2D context, collect draw points per frame, and cluster nearby
  // points into entities. This needs ZERO memory offsets — immune to game-version changes (the whole
  // reason the memory approach kept failing: the local diep.wat is an older build).
  const DRAW = { frame: [], acc: [], w: 0, h: 0, fps: 0, _fc: 0, _t: 0 }
  ;(function hookCanvas2D() {
    try {
      const C = W.CanvasRenderingContext2D && W.CanvasRenderingContext2D.prototype
      if (!C || C.__octoHooked) return
      C.__octoHooked = true
      // cache the main (largest) canvas — querySelectorAll on every fill would tank performance
      let _mc = null, _mcT = 0
      const mainCanvas = () => { const now = performance.now(); if (!_mc || now - _mcT > 600) { let best = null; for (const c of document.querySelectorAll('canvas')) if (c.width > 200 && (!best || c.width * c.height > best.width * best.height)) best = c; _mc = best; _mcT = now } return _mc }
      const isMain = ctx => ctx.canvas === mainCanvas()
      // record a draw point (entity centre = current transform translation). Only fills — the grid
      // and outlines use stroke() (skipped) so they don't pollute the entity clusters.
      const rec = ctx => { try { const t = ctx.getTransform(); const e = t.e, f = t.f; if (Number.isFinite(e) && Number.isFinite(f)) DRAW.acc.push(e, f) } catch (x) {} }
      const boundary = ctx => {
        try {
          DRAW.frame = DRAW.acc; DRAW.acc = []
          DRAW.w = ctx.canvas.width; DRAW.h = ctx.canvas.height
          DRAW._fc++; const now = performance.now(); if (now - DRAW._t > 1000) { DRAW.fps = DRAW._fc; DRAW._fc = 0; DRAW._t = now }
        } catch (x) {}
      }
      const oFill = C.fill; if (oFill) C.fill = function () { if (isMain(this)) rec(this); return oFill.apply(this, arguments) }
      // a full-canvas fillRect (background) or clearRect marks the start of a new frame
      const oFR = C.fillRect; if (oFR) C.fillRect = function (x, y, w, h) { if (isMain(this)) { if (w >= this.canvas.width * 0.8 && h >= this.canvas.height * 0.8) boundary(this); else rec(this) } return oFR.apply(this, arguments) }
      const oClear = C.clearRect; if (oClear) C.clearRect = function (x, y, w, h) { if (isMain(this) && w >= this.canvas.width * 0.8) boundary(this); return oClear.apply(this, arguments) }
      console.log('%c[octobot] canvas 2D hooked — percepção pelo renderizador', 'color:#0f0')
    } catch (e) { console.warn('[octobot] canvas hook falhou', e) }
  })()
  // cluster this-frame draw points into entities (screen device px). n = # draws (size/complexity hint)
  function screenEnts() {
    const p = DRAW.frame, R = 22, R2 = R * R, cl = []
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i], y = p[i + 1]
      let m = null
      for (let k = 0; k < cl.length; k++) { const dx = cl[k].x - x, dy = cl[k].y - y; if (dx * dx + dy * dy < R2) { m = cl[k]; break } }
      if (m) { m.x = (m.x * m.n + x) / (m.n + 1); m.y = (m.y * m.n + y) / (m.n + 1); m.n++ }
      else cl.push({ x, y, n: 1 })
    }
    return cl
  }

  // WASD keycodes (func 1298: 87->up/2, 65->left/4, 83->down/8, 68->right/16)
  const KEY = { up: 87, left: 65, down: 83, right: 68 }
  // stat keys '1'..'8' = keyCodes 49..56. diep stat order:
  //   1 Regen(49) 2 MaxHP(50) 3 BodyDmg(51) 4 BulletSpd(52) 5 Penetration(53) 6 BulletDmg(54)
  //   7 Reload(55) 8 MoveSpd(56).  Priority-first: fill each to 7 in order, remainder to the last.
  const BUILDS = {
    // Booster ("fallen"): 7 MoveSpd, 7 BulletDmg, 7 Penetration, 7 Reload, rest BulletSpd
    fallen:   [56, 54, 53, 55, 52],
    // Overlord: 7 Reload, 7 BulletDmg, 7 Penetration, 7 BulletSpd, rest MoveSpd
    overlord: [55, 54, 53, 52, 56],
  }
  const TREE = {
    fallen:   'Flank Guard → Tri-Angle → BOOSTER',
    overlord: 'Sniper → Overseer → OVERLORD',
  }
  // Auto-evolve (RE-verified: class tree bundle line 29; upgrade-available flag u8@621205 =
  // isShowingTankUpgrades mirror; NO keycode/export selects tanks -> it's a canvas mouse click
  // hit-tested by WASM at the mouse pos). Icon column is top-left; slot = which icon to click each
  // tier. fallen: Tank->FlankGuard(slot3)->TriAngle(slot0)->Booster(slot0). overlord:
  // Tank->Sniper(slot1)->Overseer(slot1)->Overlord(slot0).
  const EVO_SLOTS = { fallen: [3, 0, 0], overlord: [1, 1, 0] }
  const UP_FLAG = 621205

  const bot = {
    on: false,
    MODE: 'fallen',        // 'fallen' (Booster rammer) | 'overlord' (drone orbit turret)
    FIRE: true,
    PREFER_PLAYERS: true,  // hunt the enemy tank when within aggroRange, else farm shapes to level
    aggroRange: 1600,      // hunt the player within this (world units); beyond it, farm to grow
    keepDist: 230, tooClose: 130, farmFire: 900,
    retreatHP: 0.20,
    strafeGain: 0.85, strafeFlip: 55,
    deadzone: 0.10,
    AIM_ZOOM: true, AIM_SCALE: 1.0,
    AUTO_STATS: true,      // continuously spend stat points in the build order as levels arrive
    AUTO_EVOLVE: true,     // auto-take tank upgrades toward the target tank (Booster/Overlord)
    DEBUG: true,           // draw the bot's perception (self/target/entities) over the game canvas
    // upgrade-icon calibration (CSS px from top-left; ×dpr applied internally). Tune live if the
    // bot detects "UPGRADE DISPONÍVEL" but doesn't evolve.
    evoX: 40, evoY0: 120, evoDY: 78, evoClickMs: 90,
    // internals
    _held: { up: false, down: false, left: false, right: false },
    _dv4: new DataView(new ArrayBuffer(4)),
    _strafeDir: 1, _strafeT: 0, _frame: 0, _target: null, _self: null,
    _ticks: 0, _rate: 0, _warnedSlow: 0, _deadTicks: 0,
    _entCount: 0, _tankCount: 0,
    _allocSeq: [], _allocI: 0, _evoStage: 0, _evoWasUp: false, _tdist: 0, _ents: [], _inGame: false,
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
  let BASE = 0, BASE_SRC = 'none', SELF_NODE = 0, FRAME = 'world', _dryScans = 0
  const liveNode = nd => ok(nd) && u16(nd + 116) !== 6875
  // Locate SELF robustly by the CAMERA ANCHOR. The local camera world pos is f32@591660/591664
  // (validated to track the player). SELF = the alive, named, unowned tank whose decoded position
  // best matches that anchor in EITHER frame (world: pos≈anchor, or camera-relative: pos≈0).
  // Garbage/dead nodes decode to huge values and are rejected by the error bound. This replaced a
  // camera-id match that failed live (base read 'registry?' with a garbage self -> target ~1e14u).
  function scanBase(b) {
    if (!ok(b + 7196)) return { n: 0, selfNode: 0, err: Infinity }
    const cxw = camX(), cyw = camY()
    let n = 0, selfNode = 0, bestErr = Infinity
    try {
      for (let pr = 0; pr < 16384; pr++) {
        if (!((u8(b + 796 + (pr >> 3)) >> (pr & 7)) & 1)) continue
        const pg = u32(b + 6940 + ((pr >> 8) << 2)); if (!ok(pg)) continue
        const nd = (pg + (pr & 255) * 224) >>> 0; if (!liveNode(nd)) continue
        n++
        const R = u32(nd + 172), H = u32(nd + 176); if (!ok(R) || !ok(H)) continue
        const hp = f32(H + 48); if (!(hp > 0.01 && hp <= 1.02)) continue
        if (!ok(u32(nd + 168)) || isOwned(nd)) continue              // alive named unowned = a tank
        const ox = decode(u32(R + 144)), oy = decode(u32(R + 164))
        if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue
        const err = Math.min(Math.hypot(ox - cxw, oy - cyw), Math.hypot(ox, oy))
        if (err < bestErr) { bestErr = err; selfNode = nd }
      }
    } catch (e) {}
    if (bestErr > 4000) selfNode = 0                                 // no plausible self here
    return { n, selfNode, err: bestErr }
  }
  function regCandidates() {
    const seen = new Set([STATIC_BASE]), cands = []
    for (let i = 0; i < 65536 && cands.length < 96; i++) {
      const c = u32(REG + i * 4); if (!ok(c)) continue
      const b = (c + 12) >>> 0
      if (!seen.has(b)) { seen.add(b); cands.push(b) }
    }
    return cands
  }
  function findBase() {
    // pick the container whose best self-candidate matches the camera anchor most closely
    const st = scanBase(STATIC_BASE)
    let best = st.selfNode ? STATIC_BASE : 0, bestErr = st.selfNode ? st.err : Infinity, bestN = st.n
    let src = st.selfNode ? 'static+self' : ''
    const cands = regCandidates()
    for (const b of cands) { const r = scanBase(b); if (r.selfNode && r.err < bestErr) { bestErr = r.err; best = b; bestN = r.n; src = 'registry+self' } }
    if (best) { BASE = best; BASE_SRC = src; return bestN }
    // no plausible self anywhere (dead/loading) -> fall back to the richest container
    let fb = STATIC_BASE, fbn = st.n
    for (const b of cands) { const r = scanBase(b); if (r.n > fbn) { fbn = r.n; fb = b } }
    BASE = fb; BASE_SRC = (fb === STATIC_BASE ? 'static?' : 'registry?')
    return fbn
  }

  // ---- GROUND-TRUTH self/container by MOTION (no address guessing) ----
  // Press D briefly (verified to move the player: 591660 changed +143). SELF is the tank node whose
  // decoded position moves consistently with that: in a WORLD frame self moves ~moveAmt while others
  // stay; in a CAMERA-RELATIVE frame self stays ~0 while others shift ~moveAmt. Lock that node + its
  // container. This bypasses every layout assumption (which container / camera addr / coord frame).
  const _sleep = ms => new Promise(r => setTimeout(r, ms))
  function _wideNodes() {
    const nodes = [], seen = new Set()
    for (const b of [STATIC_BASE, ...regCandidates()]) {
      if (!ok(b + 7196)) continue
      for (let pr = 0; pr < 16384; pr++) {
        if (!((u8(b + 796 + (pr >> 3)) >> (pr & 7)) & 1)) continue
        const pg = u32(b + 6940 + ((pr >> 8) << 2)); if (!ok(pg)) continue
        const nd = (pg + (pr & 255) * 224) >>> 0; if (!liveNode(nd) || seen.has(nd)) continue
        const R = u32(nd + 172); if (!ok(R)) continue
        seen.add(nd); nodes.push({ b, node: nd, R })
      }
    }
    return nodes
  }
  async function calibrate() {
    if (!ready()) { uiLog('calibrar: sem memória', '#f66'); return false }
    gates()
    uiLog('calibrando (movendo p/ te achar)…', '#9ad')
    const nodes = _wideNodes()
    if (!nodes.length) { uiLog('calibrar: 0 nós vivos', '#f66'); return false }
    const rd = o => { const x = decode(u32(o.R + 144)), y = decode(u32(o.R + 164)); return [x, y] }
    const p0 = nodes.map(rd), cx0 = camX(), cy0 = camY()
    move('right', true); await _sleep(500)
    const cx1 = camX(), cy1 = camY(); move('right', false)
    const moveAmt = Math.hypot(cx1 - cx0, cy1 - cy0)
    if (moveAmt < 8) { uiLog('calibrar FALHOU: tanque não moveu (janela em foco? vivo?)', '#f66'); return false }
    const p1 = nodes.map(rd)
    const del = nodes.map((o, i) => {
      const a = p0[i], b = p1[i]
      return (Number.isFinite(a[0]) && Number.isFinite(b[0])) ? Math.hypot(b[0] - a[0], b[1] - a[1]) : -1
    })
    const movers = del.filter(d => d > moveAmt * 0.6 && d < moveAmt * 1.6).length
    const camRel = movers > nodes.length * 0.25
    FRAME = camRel ? 'camrel' : 'world'
    let self = null, bestFit = Infinity
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i].node, d = del[i]; if (d < 0) continue
      const H = u32(nd + 176), hp = ok(H) ? f32(H + 48) : NaN
      if (!(ok(u32(nd + 168)) && !isOwned(nd) && hp > 0.01 && hp <= 1.02)) continue   // a tank
      const fit = camRel ? d : Math.abs(d - moveAmt)     // camrel self~0 ; world self~moveAmt
      if (fit < bestFit) { bestFit = fit; self = nodes[i] }
    }
    if (!self || bestFit > moveAmt * 0.7) { uiLog('calibrar: self não distinguível (fit ' + Math.round(bestFit) + '/' + Math.round(moveAmt) + ')', '#fa0'); return false }
    SELF_NODE = self.node; BASE = self.b; BASE_SRC = 'calibrado'
    uiLog('CALIBRADO ✔ base=' + BASE + ' frame=' + FRAME + ' (moveu ' + Math.round(moveAmt) + ')', '#6f6')
    return true
  }
  bot.calibrate = calibrate
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
      const H = u32(node + 176)
      let hp = NaN; if (ok(H)) { const r = f32(H + 48); if (Number.isFinite(r)) hp = Math.max(0, Math.min(1, r)) }
      const named = ok(u32(node + 168)), owned = isOwned(node)
      // ox,oy are raw decoded render coords (NOT camera-relative here). Distances/aim are computed
      // RELATIVE TO SELF at use-time, so the absolute frame doesn't matter.
      out.push({
        node, R, ox: rx, oy: ry, hp, _d: 0,
        named, owned,
        tank: named && !owned && hp > 0,   // real live tank; excludes projectiles/shapes/garbage
      })
    }
    if (!out.length) { if (++_dryScans >= 15) { _dryScans = 0; findBase() } } else _dryScans = 0
    return out
  }
  // "in game" = the renderer is drawing entities; drives alloc/evolve guards
  function selfDead() { return !bot._inGame }
  // SELF = the motion-calibrated node (ground truth). If it's gone (died/reused), drop it and try
  // the camera-anchor heuristic as a fallback (works only if the coord frame matches).
  function findSelf(es) {
    if (SELF_NODE) {
      for (const e of es) if (e.node === SELF_NODE) return (Number.isFinite(e.hp) && e.hp > 0) ? e : (SELF_NODE = 0, null)
      SELF_NODE = 0   // calibrated node no longer live
    }
    const cxw = camX(), cyw = camY()
    let self = null, bestErr = Infinity
    for (const e of es) {
      if (!e.tank) continue
      const err = Math.min(Math.hypot(e.ox - cxw, e.oy - cyw), Math.hypot(e.ox, e.oy))
      if (err < bestErr) { bestErr = err; self = e }
    }
    return bestErr < 4000 ? self : null
  }

  function selfHealth() {
    const s = bot._self; if (!s) return 1
    const H = u32(s.node + 176); if (!ok(H)) return 1
    const r = f32(H + 48); return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1
  }

  // ---- auto-evolve: click the tank-upgrade icon toward the target tank ----
  const upgradeUp = () => { try { return u8(UP_FLAG) !== 0 } catch (e) { return false } }
  function clickUpgradeIcon(n) {
    const d = (window.devicePixelRatio || 1)
    const px = Math.round(bot.evoX * d), py = Math.round((bot.evoY0 + n * bot.evoDY) * d)
    aimPx(px, py)                                  // va: move the cursor onto icon N (device px)
    // selection is a canvas click hit-tested by WASM. Drive it two safe ways (never touch the
    // 561232/561233 control-scheme cache): a real DOM mouse event on the canvas + an autofire pulse.
    try {
      const cv = document.querySelector('canvas')
      if (cv) { const cx = px / d, cy = py / d
        for (const type of ['mousemove', 'mousedown', 'mouseup'])
          cv.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: cy, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true })) }
    } catch (e) {}
    try { setU8(FIRE_BYTE, 1); setTimeout(() => { try { setU8(FIRE_BYTE, 0) } catch (e) {} }, bot.evoClickMs) } catch (e) {}
  }
  function evolveTick() {
    if (!bot.AUTO_EVOLVE || !bot.on || !ready() || selfDead()) return
    const up = upgradeUp()
    if (up && bot._evoStage < 3) {
      if (i32(G_TEXT) !== 0) setI32(G_TEXT, 0)         // keep movement gate open (panel doesn't block it)
      const slots = EVO_SLOTS[bot.MODE] || EVO_SLOTS.fallen
      clickUpgradeIcon(slots[bot._evoStage] | 0)
    }
    if (bot._evoWasUp && !up) { bot._evoStage++; uiLog('evoluiu! etapa ' + bot._evoStage + '/3', '#6f6') }
    bot._evoWasUp = up
  }
  // live calibration: when the upgrade panel is up, diepBot.evoTest(slot) clicks that icon; tune
  // diepBot.evoX / evoY0 / evoDY until the panel closes (upgrade taken).
  bot.evoTest = function (n) { uiLog('evoTest slot ' + (n | 0) + ' @(' + Math.round(bot.evoX) + ',' + Math.round(bot.evoY0 + (n | 0) * bot.evoDY) + ')', '#9ad'); clickUpgradeIcon(n | 0) }
  function pickTarget(es, self) {
    if (!self) return null
    const sx = self.ox, sy = self.oy
    const cands = es.filter(e => e !== self && !e.owned)
    for (const e of cands) e._d = Math.hypot(e.ox - sx, e.oy - sy)   // distance FROM SELF
    const near = cands.filter(e => e._d > 30)
    if (!near.length) return null
    // hunt the nearest enemy tank within aggro range; else farm the nearest shape (to level 1->45)
    const tanks = near.filter(e => e.tank && e._d < bot.aggroRange)
    const pool = (bot.PREFER_PLAYERS && tanks.length) ? tanks : near
    pool.sort((a, b) => a._d - b._d)
    return pool[0]
  }
  function refresh(t) {
    if (!t || !ok(t.R)) return
    const rx = decode(u32(t.R + 144)), ry = decode(u32(t.R + 164))
    if (Number.isFinite(rx) && Number.isFinite(ry)) { t.ox = rx; t.oy = ry }
  }

  // ---- filter render clusters down to real targets (screen device px) ----
  // Excludes: self (centre, camera follows the player), the minimap (bottom-right), the score/level
  // bars (bottom), and the extreme edges. n = number of draws in the cluster (tanks draw body+barrels
  // +outline => higher n than shapes/bullets).
  function candidates(ents, cw, ch, cx, cy) {
    const selfR = Math.min(cw, ch) * 0.055, m = 6
    return ents.filter(e => {
      const d = Math.hypot(e.x - cx, e.y - cy)
      if (d < selfR) return false
      if (e.x < m || e.y < m || e.x > cw - m || e.y > ch - m) return false
      if (e.x > cw * 0.78 && e.y > ch * 0.70) return false     // minimap
      if (e.y > ch * 0.86) return false                        // score/level bars
      return true
    })
  }

  // ---- one tick: perceive via canvas, drive via WASM inputs ----
  function tick() {
    bot._ticks++
    if (!bot.on || !ready()) return
    gates()
    if (upgradeUp()) { stopMove(); return }   // let auto-evolve click the panel

    let cw = DRAW.w || i32(602700), ch = DRAW.h || i32(602704)
    if (!(cw > 0 && ch > 0)) { const cv = document.querySelector('canvas'); cw = cv ? cv.width : window.innerWidth; ch = cv ? cv.height : window.innerHeight }
    const cx = cw / 2, cy = ch / 2

    const ents = screenEnts()
    bot._ents = ents; bot._entCount = ents.length
    const cand = candidates(ents, cw, ch, cx, cy)
    bot._tankCount = cand.filter(e => e.n >= 4).length
    bot._inGame = ents.length > 2

    if (!cand.length) {
      stopMove(); fire(false); bot._target = null; bot._deadTicks++
      if (bot._deadTicks % 150 === 1 && ents.length < 3) bot.spawn()   // likely dead/menu -> Play
      return
    }
    bot._deadTicks = 0

    // target: prefer complex clusters (tanks) near centre; else nearest anything (farm shapes)
    cand.forEach(e => { e._d = Math.hypot(e.x - cx, e.y - cy) })
    const tanks = cand.filter(e => e.n >= 4 && e._d < 700)
    const pool = (bot.PREFER_PLAYERS && tanks.length) ? tanks : cand
    pool.sort((a, b) => a._d - b._d)
    const t = pool[0]; bot._target = t; bot._tdist = t._d
    const rx = t.x - cx, ry = t.y - cy, d = Math.hypot(rx, ry) || 1, ux = rx / d, uy = ry / d

    aimPx(t.x, t.y)   // t is already screen device px == va()'s coordinate space

    if (bot.MODE === 'fallen') { fire(bot.FIRE); moveVec(ux, uy); return }   // ram: aim + thrust + drive in

    // overlord/turret: fire + orbit at range
    fire(bot.FIRE)
    let mx = 0, my = 0
    if (d > 300) { mx += ux; my += uy } else if (d < 170) { mx -= ux; my -= uy }
    if (++bot._strafeT > bot.strafeFlip) { bot._strafeT = 0; bot._strafeDir *= -1 }
    mx += -uy * bot.strafeGain * bot._strafeDir; my += ux * bot.strafeGain * bot._strafeDir
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
      target: t ? { dist: Math.round(t._d), tank: t.tank } : null,
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
  // dump every candidate container + the nearest entities of the chosen one (F12 console)
  bot.diag = function () {
    if (!ready()) { uiLog('não pronto', '#f66'); return }
    console.log('[diag] cam(591660/664)=(' + camX().toFixed(0) + ',' + camY().toFixed(0) + ') | SELF_NODE=' + SELF_NODE + ' FRAME=' + FRAME + ' BASE=' + BASE + ' ' + BASE_SRC + ' | wideNodes=' + _wideNodes().length)
    const rows = [{ base: STATIC_BASE, src: 'static', ...scanBase(STATIC_BASE) }]
    for (const b of regCandidates()) { const r = scanBase(b); if (r.n > 0) rows.push({ base: b, src: 'reg', ...r }) }
    console.log('%c[diag] containers candidatos (self=contém você):', 'color:#0ff'); console.table(rows)
    findBase()
    console.log('[diag] USANDO base', BASE, BASE_SRC)
    const es = entities(); const self = findSelf(es)
    const sx = self ? self.ox : 0, sy = self ? self.oy : 0
    console.log('[diag] self node=', self ? self.node : null, 'hp=', self ? +self.hp.toFixed(2) : null, 'pos=(' + Math.round(sx) + ',' + Math.round(sy) + ')')
    console.table(es.map(e => ({ ...e, d: Math.hypot(e.ox - sx, e.oy - sy) })).sort((a, c) => a.d - c.d).slice(0, 15).map(e => ({
      distFromSelf: Math.round(e.d), tank: e.tank, named: e.named, owned: e.owned,
      hp: +(e.hp || 0).toFixed(2), ox: Math.round(e.ox), oy: Math.round(e.oy),
    })))
    uiLog('diag no console (F12): ' + rows.length + ' containers, self ' + (self ? 'OK' : 'NÃO ACHADO'), '#9ad')
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
  // continuous stat allocation: build a priority sequence (each stat 7x, in order) and press one
  // key per allocTick; the game gives 1 point per level so points fill in priority as they arrive.
  function setBuild(order) {
    order = order || BUILDS[bot.MODE] || BUILDS.fallen
    const seq = []; for (const k of order) for (let i = 0; i < 7; i++) seq.push(k)
    bot._allocSeq = seq; bot._allocI = 0
  }
  function allocTick() {
    if (!bot.AUTO_STATS || !bot._allocSeq.length || !ready() || selfDead()) return
    const k = bot._allocSeq[bot._allocI % bot._allocSeq.length]; bot._allocI++
    try { E().ua(k, 1); E().ua(k, 0) } catch (e) {}
  }
  bot.maxStats = function (order) { setBuild(order) }   // (re)sets the build; the alloc loop spends
  bot.maxLevel = function () {   // sandbox cheat (optional; NOT used in a 1->45 duel)
    if (!clickByText('Max Level')) { clickByText('Sandbox|Cheat'); setTimeout(() => { if (!clickByText('Max Level')) uiLog('Max Level não achado — abra o frasco e clique', '#fa0') }, 200) }
  }
  bot.start = async function (mode) {
    if (mode) bot.MODE = mode
    if (!ready()) { uiLog('mem não capturada — recarregue (F5) e tente de novo', '#f66'); return }
    uiLog('start ' + bot.MODE + ': Play (nível 1)…')
    bot._evoStage = 0; bot._evoWasUp = false
    bot.spawn(); await sleep(1400)
    setBuild()                                  // continuous stat allocation for this build
    uiLog('jogando 1→45 (percepção canvas): upa stats + evolui. Árvore: ' + TREE[bot.MODE], '#0ff')
    bot.on = true
    uiLog('BOT ON — jogando (' + bot.MODE + ')', '#f0f')
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
    title.innerHTML = '<b style="color:#f6f">🤖 OctoBot v' + VERSION + '</b>'
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
    UI.rows.evo = row('evolução')
    UI.rows.loop = row('loop')
    UI.rows.st = row('estado')

    const btns1 = document.createElement('div'); btns1.style.cssText = 'display:flex;margin-top:5px'
    btns1.append(
      mkBtn('▶ FALLEN', '#a1206e', () => bot.start('fallen'), 'Play nível 1 + upa build Booster + evolui + ON (rammer)'),
      mkBtn('▶ OVERLORD', '#20a16e', () => bot.start('overlord'), 'Play nível 1 + upa build Overlord + evolui + ON (drones)'),
    )
    const btns2 = document.createElement('div'); btns2.style.cssText = 'display:flex'
    btns2.append(
      mkBtn('⚔ ON/OFF', '#444a99', () => {
        bot.on = !bot.on
        if (!bot.on) { stopMove(); fire(false) }
        uiLog(bot.on ? 'BOT ON — caçando (' + bot.MODE + ')' : 'BOT OFF', bot.on ? '#f0f' : '#ccc')
      }, 'liga/desliga o cérebro (tecla B)'),
      mkBtn('🎯 calib', '#7a5c1e', () => bot.calibrate(), 'acha VOCÊ por movimento (ground truth) — use se ficar parado'),
      mkBtn('📡 base', '#1e6a7a', () => { const n = findBase(); uiLog('rescan: ' + n + ' entid. @ ' + BASE + ' (' + BASE_SRC + ')', n ? '#6f6' : '#f66') }, 're-descobre a lista de entidades'),
      mkBtn('🔍 diag', '#6a1e6a', () => bot.diag(), 'lista containers + entidades no console (F12)'),
      mkBtn('👁 debug', '#3a5a2a', () => { bot.DEBUG = !bot.DEBUG; uiLog('overlay ' + (bot.DEBUG ? 'ON' : 'OFF'), '#9ad') }, 'desenha o que o bot vê sobre o jogo'),
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
    // idle: perceive from the render stream so the panel + overlay are truthful before ON
    let cw = DRAW.w || 1, ch = DRAW.h || 1
    if (!bot.on) {
      const es = screenEnts(); bot._ents = es; bot._entCount = es.length
      const cand = candidates(es, cw, ch, cw / 2, ch / 2)
      bot._tankCount = cand.filter(e => e.n >= 4).length
      bot._inGame = es.length > 2
      cand.forEach(e => { e._d = Math.hypot(e.x - cw / 2, e.y - ch / 2) })
      cand.sort((a, b) => a._d - b._d); bot._target = cand[0] || null
    }
    setRow(UI.rows.base, 'render ' + DRAW.w + '×' + DRAW.h + ' @' + DRAW.fps + 'fps', DRAW.w ? '#6f6' : '#f66')
    setRow(UI.rows.ents, bot._entCount + ' · ' + (bot._tankCount || 0) + ' tanque(s)', bot._entCount ? '#6f6' : '#fa0')
    setRow(UI.rows.self, bot._inGame ? 'no jogo (centro)' : 'fora/menu', bot._inGame ? '#6f6' : '#fa0')
    const t = bot._target
    setRow(UI.rows.tgt, t ? Math.round(t._d) + 'px ' + (t.n >= 4 ? '(tanque)' : '(shape)') : 'nenhum', t ? (t.n >= 4 ? '#f6f' : '#fd6') : '#888')
    const up = upgradeUp()
    setRow(UI.rows.evo, up ? '⚡ UPGRADE DISPONÍVEL' : 'etapa ' + bot._evoStage + '/3', up ? '#ff5' : '#8fb')
    setRow(UI.rows.loop, bot._rate + ' t/s', bot._rate >= 15 ? '#6f6' : '#fa0')
    setRow(UI.rows.st, (bot.on ? 'CAÇANDO' : 'parado') + ' · ' + bot.MODE, bot.on ? '#f0f' : '#aaa')
  }
  setInterval(uiRefresh, 500)

  // ---- visual debug overlay: draw the bot's perception ON the game (dots should sit on sprites) ----
  let _ov = null, _ovc = null
  function overlay() {
    if (!document.body) return
    if (!_ov) {
      _ov = document.createElement('canvas'); _ov.id = '__octobot_overlay'
      _ov.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483646'
      document.body.appendChild(_ov); _ovc = _ov.getContext('2d')
    }
    const g = _ovc, W2 = window.innerWidth, H2 = window.innerHeight
    if (_ov.width !== W2) _ov.width = W2
    if (_ov.height !== H2) _ov.height = H2
    g.clearRect(0, 0, W2, H2)
    if (!bot.DEBUG) return
    const dp = (window.devicePixelRatio || 1)   // device px (canvas) -> CSS px (overlay)
    const cx = W2 / 2, cy = H2 / 2
    if (!ready() || !DRAW.w) {
      g.fillStyle = '#f66'; g.font = 'bold 14px monospace'
      g.fillText('octobot: ' + (!ready() ? 'sem memória' : 'sem draws do canvas ainda'), 12, H2 - 16); return
    }
    const es = bot._ents || [], selfR = Math.min(DRAW.w, DRAW.h) * 0.055
    for (const e of es) {
      const x = e.x / dp, y = e.y / dp
      const dc = Math.hypot(e.x - DRAW.w / 2, e.y - DRAW.h / 2)
      if (dc < selfR) continue                    // that's self (centre); drawn below
      g.beginPath(); g.arc(x, y, e.n >= 4 ? 9 : 5, 0, 7)
      g.fillStyle = e.n >= 4 ? 'rgba(0,210,255,.85)' : 'rgba(170,170,170,.6)'
      g.fill()
    }
    const t = bot._target
    if (t) {
      const x = t.x / dp, y = t.y / dp
      g.strokeStyle = 'rgba(255,0,255,.7)'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke()
      g.strokeStyle = '#f0f'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 17, 0, 7); g.stroke()
    }
    g.strokeStyle = '#0f0'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 15, 0, 7); g.stroke()   // self = centre
    // HUD
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(8, H2 - 74, 470, 64)
    g.font = 'bold 12px monospace'; g.fillStyle = '#7f7'
    g.fillText('percepção CANVAS (sem offsets de memória) · VERDE=você ROSA=alvo', 14, H2 - 54)
    g.fillStyle = '#8cf'; g.fillText('as bolinhas caem nos sprites reais? azul=tanque cinza=shape', 14, H2 - 40)
    g.fillStyle = '#fff'
    g.fillText('mode ' + bot.MODE + ' · alvo ' + (t ? Math.round(t._d) + 'px ' + (t.n >= 4 ? 'TANQUE' : 'shape') : '—') +
      ' · evo ' + bot._evoStage + '/3 · ' + (bot.on ? 'ON' : 'OFF'), 14, H2 - 24)
    g.fillText('draws/frame ' + (((DRAW.frame || []).length / 2) | 0) + ' · clusters ' + es.length +
      ' · fps ' + DRAW.fps + ' · canvas ' + DRAW.w + '×' + DRAW.h, 14, H2 - 10)
  }

  // ---- tick loop: Worker-driven so it keeps running when the tab is backgrounded ----
  let _lastTick = 0
  function tickGuard() { const n = performance.now(); if (n - _lastTick < 30) return; _lastTick = n; try { tick() } catch (e) {} }
  try {
    const wsrc = 'setInterval(function(){postMessage(0)},40)'
    const wk = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' })))
    wk.onmessage = tickGuard
  } catch (e) { /* CSP — fall back to timers below */ }
  setInterval(tickGuard, 50)
  ;(function raf() { tickGuard(); try { overlay() } catch (e) {} requestAnimationFrame(raf) })()
  setInterval(allocTick, 110)     // continuous stat allocation (spends points in build priority)
  setInterval(evolveTick, 260)    // auto-evolve when a tank-upgrade panel is up
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
  console.log('%c[octobot v0.16] loaded — percepção via CANVAS (renderizador), sem offsets de memória', 'color:#f0f;font-weight:bold')
})()
