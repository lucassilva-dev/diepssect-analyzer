// ==UserScript==
// @name         Diep OctoBot (aggressive sandbox bot)
// @description  Autonomous aggressive bot for diep.io SANDBOX duels. Reads every entity from
//              WASM memory and DRIVES the tank (aim / move / fire) through the game's own WASM
//              input exports. For private Sandbox use only (you vs the bot). Needs diep-mem-reader.
// @version      0.4
// @namespace    *://diep.io/
// @match        *://diep.io/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * REQUIRES: diep-mem-reader.user.js installed (Tampermonkey Sandbox Mode = "Raw") — it captures
 *   window.__wasmMem and window.__wasmExports.
 *
 * CONTROL — all three primitives are RE-verified against diep.wat AND/OR live:
 *   - AIM  : __wasmExports.va(screenXpx, screenYpx)  (= _cpp_set_mouse_pos; writes 560456/560460).
 *            Aim-mode byte 560528 must be 0 (mouse). LIVE-VERIFIED.
 *   - FIRE : memory byte 560660 = 1/0 (autofire latch; plain global read every frame). LIVE-VERIFIED.
 *   - MOVE : __wasmExports.ua(keyCode, 1|0)  (= _cpp_set_keybind_state). W=87 A=65 S=83 D=68.
 *            ua writes the held-key hashmap @560468 at the exact node byte func 93 reads, and
 *            func 1298 ORs the movement bits (W->2,A->4,S->8,D->16) every frame.  *** The catch ***:
 *            func 1298 SKIPS all WASD reads when the text-input gate i32@560772 != 0 (br_if). So we
 *            force 560772 = 0 every tick. ua is idempotent + persistent (no per-frame re-press needed).
 *            (This is why the earlier "ua doesn't move" test failed — the gate, not the mechanism.)
 *
 * Entity world pos = decode(render+144 / +164) on the renderable component (node+172); decode is the
 *   verified byte-permuting affine+XOR (self-check decode(749705847)==0). Coords are camera-relative
 *   (offset from screen centre, world units); aim = centre + offset*zoom (direction is scale-robust).
 *
 * USAGE (turnkey): open a SANDBOX, spawn, then in the console:
 *     diepBot.start()           // Play -> Max Level -> max stats -> self-tests move -> bot ON
 *   Manual toggle anytime: press  B .   Live status/diagnostics:  diepBot.status()
 *   Prove movement on demand:  diepBot.moveTest()   ('right' for ~0.8s, reports dx/dy)
 *   Tunables on the diepBot object (see DEFAULTS below). If aim points the wrong way, set
 *   diepBot.WORLD_COORDS = true. If chase looks mirrored, flip diepBot.STRAFE off to check chase.
 */

;(() => {
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  if (W.__octobotInstalled) return
  W.__octobotInstalled = true

  // ---- WASD keycodes (confirmed in func 1298: 87->up/2, 65->left/4, 83->down/8, 68->right/16) ----
  const KEY = { up: 87, left: 65, down: 83, right: 68 }

  const bot = {
    on: false,
    // behaviour
    FIRE: true,
    CHASE: true,
    STRAFE: true,          // circle-strafe the target (this is also the primary dodge)
    LEAD: false,           // lead aim using target velocity (offsets less certain; opt-in)
    PREFER_PLAYERS: false,  // prefer enemy tanks over shapes as target (uses node+168!=0; opt-in)
    // geometry / tuning (world units; camera-relative render units ~= world units)
    keepDist: 230,         // try to orbit the enemy at ~this range
    tooClose: 130,         // back off if closer than this
    farmFire: 900,         // fire if any target within this range
    retreatHP: 0.28,       // flee when self health ratio drops below this
    strafeGain: 0.85,      // strength of the perpendicular (orbit) component
    strafeFlip: 55,        // ticks between strafe-direction flips
    leadFactor: 6,         // velocity*leadFactor added to aim when LEAD
    deadzone: 0.22,        // normalized move threshold (avoid jitter)
    // coordinate model
    WORLD_COORDS: false,   // false: R+144/164 are camera-relative (default). true: absolute world.
    AIM_ZOOM: true,        // scale aim offset by live zoom (decode(u32@591572)); direction is robust either way
    AIM_SCALE: 1.0,        // extra manual aim scale if ever needed
    // internals
    _held: { up: false, down: false, left: false, right: false },
    _dv4: new DataView(new ArrayBuffer(4)),
    _strafeDir: 1, _strafeT: 0, _frame: 0, _target: null, _self: null,
  }
  W.diepBot = bot

  const E = () => W.__wasmExports
  const ready = () => W.__wasmMem && E() && typeof E().va === 'function' && typeof E().ua === 'function'

  // ---- cached DataView: rebuild only when the wasm buffer grows (per-read alloc = the old OOM) ----
  let _buf = null, _dv = null, _len = 0
  const DV = () => { const b = W.__wasmMem.buffer; if (b !== _buf) { _buf = b; _dv = new DataView(b); _len = b.byteLength } return _dv }
  const u8 = a => DV().getUint8(a >>> 0), u16 = a => DV().getUint16(a >>> 0, true)
  const u32 = a => DV().getUint32(a >>> 0, true), i32 = a => DV().getInt32(a >>> 0, true)
  const f32 = a => DV().getFloat32(a >>> 0, true)
  const setU8 = (a, v) => DV().setUint8(a >>> 0, v)
  const setI32 = (a, v) => DV().setInt32(a >>> 0, v, true)
  const ok = p => { p >>>= 0; DV(); return p > 0 && p < _len - 256 }

  // ---- obfuscated-f32 decode (verbatim from func 82; self-check decode(749705847)==0) ----
  function decode(v) {
    v >>>= 0; const h = v >>> 16, t = v >>> 24
    const b2 = ((((v + Math.imul(h, -82)) | 0) - (-64)) ^ 169) & 0xFF
    const mid = ((((h << 8) - (t << 14)) | 0) + 20736) & 0xFF00
    const b0 = (t + 208) & 0xFF
    const b3 = (((((Math.imul(v, 125)) + (v >>> 8)) | 0) - 71) ^ 110) & 0xFF
    const p = (((b3 << 24) | (b2 << 16) | mid | b0) ^ 252) >>> 0
    bot._dv4.setUint32(0, p, true); return bot._dv4.getFloat32(0, true)
  }

  // ---- input primitives ----
  const G_TEXT = 560772, G_AIMMODE = 560528, FIRE_BYTE = 560660
  // keep the movement reads reachable (560772==0) and aim in mouse mode (560528==0)
  function gates() { try { if (i32(G_TEXT) !== 0) setI32(G_TEXT, 0); if (u8(G_AIMMODE) !== 0) setU8(G_AIMMODE, 0) } catch (e) {} }
  function move(dir, want) {
    const k = KEY[dir]; want = !!want
    if (bot._held[dir] !== want) { try { E().ua(k, want ? 1 : 0) } catch (e) {} bot._held[dir] = want }
  }
  function setMove(d) { move('up', d.up); move('down', d.down); move('left', d.left); move('right', d.right) }
  function stopMove() { setMove({ up: false, down: false, left: false, right: false }) }
  function fire(on) { try { setU8(FIRE_BYTE, on ? 1 : 0) } catch (e) {} }
  function aimPx(px, py) { try { E().va(px | 0, py | 0) } catch (e) {} }

  // ---- camera + zoom ----
  const camX = () => f32(591660), camY = () => f32(591664)
  function zoom() { if (!bot.AIM_ZOOM) return 1; const z = decode(u32(591572)); return (Number.isFinite(z) && z > 0 && z < 100) ? z : 1 }

  // ---- enumerate entities (validated hashmap chain) ----
  // Returns {node, R, ox, oy (camera-relative offset, world units), vx, vy, dist, isPlayer}
  const WORLD = 582904, base = WORLD + 1120, bm = base + 796
  function entities() {
    const out = []
    const cx = camX(), cy = camY(), rel = !bot.WORLD_COORDS
    for (let probe = 0; probe < 16384 && out.length < 400; probe++) {
      if (!((u8(bm + (probe >> 3)) >> (probe & 7)) & 1)) continue
      const page = u32(base + 6940 + ((probe >> 8) << 2)); if (!ok(page)) continue
      const node = (page + (probe & 255) * 224) >>> 0; if (!ok(node) || u16(node + 116) !== 6954) continue
      const R = u32(node + 172); if (!ok(R)) continue
      const rx = decode(u32(R + 144)), ry = decode(u32(R + 164))
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue
      const ox = rel ? rx : (rx - cx), oy = rel ? ry : (ry - cy)
      const vx = f32(R + 132), vy = f32(R + 172)   // plain f32 velocity (opt-in lead/dodge)
      out.push({
        node, R, ox, oy,
        vx: Number.isFinite(vx) ? vx : 0, vy: Number.isFinite(vy) ? vy : 0,
        dist: Math.hypot(ox, oy),
        isPlayer: ok(u32(node + 168)),   // name/identity component present -> a player tank (opt-in heuristic)
      })
    }
    return out
  }

  // self = the entity sitting at the camera centre (camera-relative ~ origin)
  function findSelf(es) { let best = null; for (const e of es) if (e.dist < 60 && (!best || e.dist < best.dist)) best = e; return best }

  function selfHealth() {
    const s = bot._self; if (!s) return 1
    const H = u32(s.node + 176); if (!ok(H)) return 1
    const r = f32(H + 48); return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1
  }

  // target = nearest non-self entity; optionally prefer enemy player tanks
  function pickTarget(es, self) {
    let cands = es.filter(e => e !== self && e.dist > 40)
    if (!cands.length) return null
    if (bot.PREFER_PLAYERS) {
      const players = cands.filter(e => e.isPlayer)
      if (players.length) cands = players
    }
    cands.sort((a, b) => a.dist - b.dist)
    return cands[0]
  }

  // refresh one entity's live position cheaply (no full scan)
  function refresh(t) {
    if (!t || !ok(t.R)) return
    const cx = camX(), cy = camY(), rel = !bot.WORLD_COORDS
    const rx = decode(u32(t.R + 144)), ry = decode(u32(t.R + 164))
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return
    t.ox = rel ? rx : (rx - cx); t.oy = rel ? ry : (ry - cy); t.dist = Math.hypot(t.ox, t.oy)
    t.vx = f32(t.R + 132); t.vy = f32(t.R + 172)
  }

  // ---- one tick ----
  function tick() {
    if (!bot.on || !ready()) return
    gates()

    // heavy enumeration every 4th frame; cheap refresh of the held target in between
    if ((bot._frame++ & 3) === 0) {
      const es = entities()
      bot._self = findSelf(es)
      bot._target = pickTarget(es, bot._self)
    } else {
      refresh(bot._target)
    }
    const t = bot._target
    if (!t) { stopMove(); fire(false); return }

    const cv = document.querySelector('canvas')
    const cw = cv ? cv.width : window.innerWidth, ch = cv ? cv.height : window.innerHeight
    const z = zoom() * bot.AIM_SCALE

    // ----- AIM (optionally lead) -----
    let ax = t.ox, ay = t.oy
    if (bot.LEAD) { ax += t.vx * bot.leadFactor; ay += t.vy * bot.leadFactor }
    aimPx(cw / 2 + ax * z, ch / 2 + ay * z)

    // ----- FIRE -----
    fire(bot.FIRE && t.dist < bot.farmFire)

    // ----- MOVE (chase + circle-strafe, with kite + retreat) -----
    if (bot.CHASE) {
      const d = t.dist || 1, ux = t.ox / d, uy = t.oy / d
      let mx = 0, my = 0
      const fleeing = selfHealth() < bot.retreatHP
      if (fleeing) { mx = -ux; my = -uy }                       // run from the enemy
      else {
        if (d > bot.keepDist) { mx += ux; my += uy }            // approach
        else if (d < bot.tooClose) { mx -= ux; my -= uy }       // kite back
        if (bot.STRAFE) {
          if (++bot._strafeT > bot.strafeFlip) { bot._strafeT = 0; bot._strafeDir *= -1 }
          mx += -uy * bot.strafeGain * bot._strafeDir
          my += ux * bot.strafeGain * bot._strafeDir
        }
      }
      const dz = bot.deadzone
      setMove({ right: mx > dz, left: mx < -dz, down: my > dz, up: my < -dz })
    } else stopMove()
  }

  // ---- diagnostics ----
  bot.status = function () {
    const r = ready()
    const s = { ready: r, on: bot.on }
    if (!r) { s.problem = 'wasm exports not captured — is diep-mem-reader installed with Sandbox Mode=Raw? Reload the tab.'; console.table(s); return s }
    const es = entities(); const self = findSelf(es); const t = pickTarget(es, self)
    Object.assign(s, {
      entities: es.length,
      camera: [+camX().toFixed(0), +camY().toFixed(0)],
      zoom: +zoom().toFixed(3),
      textGate_560772: i32(G_TEXT), aimMode_560528: u8(G_AIMMODE),
      selfFound: !!self, selfHealth: +selfHealth().toFixed(2),
      target: t ? { dist: +t.dist.toFixed(0), off: [+t.ox.toFixed(0), +t.oy.toFixed(0)], isPlayer: t.isPlayer } : null,
      decodeSelfCheck: decode(749705847) === 0,
    })
    console.table(s); return s
  }

  // prove movement: hold one direction ~0.8s, report player-position delta
  bot.moveTest = function (dir = 'right') {
    if (!ready()) { console.warn('[octobot] not ready'); return }
    gates()
    const x0 = camX(), y0 = camY()
    console.log('[octobot] moveTest', dir, 'BEFORE pos=', x0.toFixed(1), y0.toFixed(1), 'gate560772=', i32(G_TEXT))
    move(dir, true)
    setTimeout(() => {
      const x1 = camX(), y1 = camY(); move(dir, false)
      const dx = x1 - x0, dy = y1 - y0, moved = Math.hypot(dx, dy) > 0.5
      console.log('%c[octobot] moveTest ' + (moved ? 'PASS' : 'FAIL') + ' dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1),
        'color:' + (moved ? '#0f0' : '#f33') + ';font-weight:bold')
      if (!moved) console.log('[octobot] no move -> ensure: spawned, canvas focused (click it), 560772==0, not in a menu. Try diepBot.status().')
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
  bot.maxStats = function () {
    let i = 0
    const id = setInterval(() => { for (let k = 49; k <= 56; k++) { try { E().ua(k, 1); E().ua(k, 0) } catch (e) {} } if (++i > 10) clearInterval(id) }, 100)
  }
  bot.maxLevel = function () {
    if (!clickByText('Max Level')) { clickByText('Sandbox|Cheat'); setTimeout(() => { if (!clickByText('Max Level')) console.warn('[octobot] Max Level not found — open the flask panel and click it'); }, 200) }
  }
  bot.start = async function () {
    bot.spawn(); await sleep(1300)
    bot.maxLevel(); await sleep(900)
    bot.maxStats(); await sleep(400)
    console.log('%c[octobot] spawned + maxed. Click the tank tree to OCTO TANK now.', 'color:#0ff')
    bot.moveTest('right')      // verify movement works in THIS tab before going live
    setTimeout(() => { bot.on = true; console.log('%c[octobot] ON — attacking. Press B to toggle, diepBot.status() to inspect.', 'color:#f0f;font-weight:bold') }, 4000)
  }

  // ---- main loop + toggle ----
  function loop() { try { tick() } catch (e) {} requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  W.addEventListener('keydown', e => {
    if (e.key === 'b' || e.key === 'B') {
      bot.on = !bot.on
      if (!bot.on) { stopMove(); fire(false) }
      console.log('%c[octobot] ' + (bot.on ? 'ON — attacking' : 'OFF'), 'color:#f0f;font-weight:bold')
    }
  })
  console.log('%c[octobot v0.4] loaded. Sandbox -> spawn -> diepBot.start() (or press B). diepBot.status() to debug.',
    'color:#f0f;font-weight:bold')
})()
