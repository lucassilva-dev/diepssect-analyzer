// ==UserScript==
// @name         Diep Memory Reader (RE toolkit)
// @description  Captures the diep.io WASM heap and provides Cheat-Engine-style primitives (scan/diff/watch) to map the decoded game state in memory. Replaces "Diep WASM Probe".
// @version      1.0
// @namespace    *://diep.io/
// @match        *://diep.io/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * Goal: read the ALREADY-DECODED game state from WASM linear memory, so we never
 * need to break the (self-modifying) network cipher. This is the dpma approach,
 * re-derived for the current build.
 *
 * REQUIREMENT: Tampermonkey "Modo Sandbox/Sandbox Mode" must be "Raw" (Settings →
 * Advanced → Security), otherwise the document-start WASM hook loses the race and
 * the heap is never captured.
 *
 * Quick API (all on window):
 *   __probeStatus()                  -> {heapCaptured, heapBytes, frames, ...}
 *   mem.heap()                       -> fresh Uint8Array over the live heap
 *   mem.f32(off) / u32 / i32 / u16 / u8(off)
 *   mem.snap()                       -> snapshot id (copies the heap; for diffing)
 *   mem.diffF32(a,b,opt)             -> offsets whose float32 changed between snaps
 *                                       opt: {range:[min,max], minDelta, maxDelta, limit}
 *   mem.scanF32(value, eps, range)   -> offsets holding ~value (e.g. known health)
 *   mem.scanU32(value)               -> offsets holding exactly value
 *   mem.refine(offsets, pred)        -> keep offsets where pred(off) is true (narrowing)
 *   mem.find(hexOrBytes)             -> byte-pattern offsets (e.g. nickname)
 *   mem.dump(off, len)              -> hex string
 *   mem.struct(off, n)               -> {u32:[...], f32:[...]} decode of n words from off
 *   __caps                           -> raw WebSocket frames [{dir,t,bytes}]
 *
 * Typical workflow to find the player tank (see docs/MEM-MAP.md):
 *   1) spawn, A=mem.snap(); move right 1s; B=mem.snap();
 *   2) cand = mem.diffF32(A,B,{range:[-1e7,1e7],minDelta:1}) // X moved, candidates
 *   3) move right again; C=mem.snap(); cand2 = mem.diffF32(B,C,...) ; intersect
 *   4) the surviving offset is X position; Y is ~4-8 bytes away; health via damage-diff.
 */

;(() => {
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  const WA = W.WebAssembly
  if (!WA || W.__memReaderInstalled) return
  W.__memReaderInstalled = true
  W.__caps = []
  W.__wasmMem = null
  let captureSource = null

  const grab = (res, where) => {
    try {
      const inst = res && (res.instance || res)
      if (inst && inst.exports) {
        W.__wasmExports = inst.exports   // ALL exported wasm funcs/memory (for input injection / RE)
        const m = inst.exports.U || Object.values(inst.exports).find(x => x instanceof WA.Memory)
        if (m && m.buffer) { W.__wasmMem = m; captureSource = where
          console.log('%c[mem-reader] captured WASM memory + exports via ' + where + ':', 'color:#0f0', m.buffer.byteLength, 'bytes',
            Object.keys(inst.exports).length, 'exports') }
      }
    } catch (e) {}
    return res
  }
  const oI = WA.instantiate
  WA.instantiate = function (a, b) { const p = oI.call(this, a, b); return (p && p.then) ? p.then(r => grab(r, 'instantiate')) : p }
  if (WA.instantiateStreaming) { const oS = WA.instantiateStreaming; WA.instantiateStreaming = function (a, b) { return oS.call(this, a, b).then(r => grab(r, 'instantiateStreaming')) } }
  try { const OI = WA.Instance; const Wd = function (m, i) { const inst = new OI(m, i); grab(inst, 'new Instance'); return inst }; Wd.prototype = OI.prototype; WA.Instance = Wd } catch (e) {}

  // WebSocket capture (ciphertext frames; useful for handshake/seed)
  try {
    const OWS = W.WebSocket
    const H = function (u, p) {
      const ws = p === undefined ? new OWS(u) : new OWS(u, p)
      const s = ws.send.bind(ws)
      ws.send = function (d) { try { let b = d instanceof ArrayBuffer ? d : (d && d.buffer); if (b) W.__caps.push({ dir: 'out', t: Date.now(), bytes: new Uint8Array(b.slice ? b.slice(0) : b) }) } catch (e) {} return s(d) }
      ws.addEventListener('message', e => { try { if (e.data instanceof ArrayBuffer) W.__caps.push({ dir: 'in', t: Date.now(), bytes: new Uint8Array(e.data) }) } catch (err) {} })
      return ws
    }
    H.prototype = OWS.prototype
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) H[k] = OWS[k]
    W.WebSocket = H
  } catch (e) {}

  // ---- memory toolkit ----
  const snaps = []
  const dv = () => new DataView(W.__wasmMem.buffer)

  const mem = {
    heap: () => W.__wasmMem ? new Uint8Array(W.__wasmMem.buffer) : null,
    f32: off => dv().getFloat32(off, true),
    u32: off => dv().getUint32(off, true),
    i32: off => dv().getInt32(off, true),
    u16: off => dv().getUint16(off, true),
    u8: off => mem.heap()[off],

    // snapshot the whole heap (copy) for later diffing; returns its index
    snap: () => { const id = snaps.length; snaps.push(mem.heap().slice(0)); console.log('[mem-reader] snapshot', id, '(' + snaps.length + ' stored)'); return id },
    clearSnaps: () => { snaps.length = 0 },

    // offsets (4-aligned) whose float32 changed between two snapshots
    diffF32: (a, b, opt = {}) => {
      const A = snaps[a], B = snaps[b]
      if (!A || !B) { console.warn('bad snapshot ids'); return [] }
      const range = opt.range || [-1e9, 1e9], minD = opt.minDelta || 0, maxD = opt.maxDelta || Infinity, limit = opt.limit || 4000
      const va = new DataView(A.buffer), vb = new DataView(B.buffer)
      const n = Math.min(A.length, B.length) - 4, out = []
      for (let o = 0; o <= n; o += 4) {
        const x = va.getFloat32(o, true), y = vb.getFloat32(o, true)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        if (x === y) continue
        if (y < range[0] || y > range[1]) continue
        const d = Math.abs(y - x); if (d < minD || d > maxD) continue
        out.push(o); if (out.length >= limit) break
      }
      console.log('[mem-reader] diffF32:', out.length, 'changed offsets')
      return out
    },

    // current-value scans
    scanF32: (value, eps = 0.5, range) => {
      const h = mem.heap(), v = new DataView(h.buffer), n = h.length - 4, out = []
      for (let o = 0; o <= n; o += 4) { const x = v.getFloat32(o, true); if (Number.isFinite(x) && Math.abs(x - value) <= eps) { if (range && (x < range[0] || x > range[1])) continue; out.push(o); if (out.length >= 5000) break } }
      console.log('[mem-reader] scanF32:', out.length, 'hits'); return out
    },
    scanU32: (value) => {
      const v = dv(), n = W.__wasmMem.buffer.byteLength - 4, out = []
      for (let o = 0; o <= n; o += 4) if (v.getUint32(o, true) === value) { out.push(o); if (out.length >= 5000) break }
      console.log('[mem-reader] scanU32:', out.length, 'hits'); return out
    },

    // keep only offsets where pred(off) holds (use between scans to narrow)
    refine: (offsets, pred) => { const out = offsets.filter(pred); console.log('[mem-reader] refine:', out.length, 'of', offsets.length); return out },

    find: (pat) => {
      const h = mem.heap(); const p = typeof pat === 'string' ? pat.trim().split(/\s+/).map(x => parseInt(x, 16)) : Array.from(pat)
      const out = []; for (let i = 0; i + p.length <= h.length && out.length < 200; i++) { let ok = 1; for (let j = 0; j < p.length; j++) if (h[i + j] !== p[j]) { ok = 0; break } if (ok) out.push(i) }
      return out
    },
    dump: (off, len = 64) => Array.from(mem.heap().slice(off, off + len)).map(x => x.toString(16).padStart(2, '0')).join(' '),
    // decode n 4-byte words from off as both u32 and f32 (to eyeball a struct)
    struct: (off, n = 16) => { const u = [], f = []; for (let i = 0; i < n; i++) { u.push(mem.u32(off + i * 4)); f.push(+mem.f32(off + i * 4).toFixed(3)) } return { off, u32: u, f32: f } },
  }
  W.mem = mem

  W.__probeStatus = () => ({ installed: true, heapCaptured: !!W.__wasmMem, heapBytes: W.__wasmMem ? W.__wasmMem.buffer.byteLength : 0, captureSource, frames: (W.__caps || []).length, snapshots: snaps.length, sandboxed: (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) })

  console.log('%c[mem-reader v1.0] installed. window.mem ready once heap is captured.', 'color:#0f0;font-weight:bold')
})()
