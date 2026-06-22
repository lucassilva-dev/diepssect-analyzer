// ==UserScript==
// @name         Diep WASM Probe (cipher RE)
// @description  Captures the WASM heap + raw WebSocket frames for diep.io cipher reverse engineering. Hooks WebAssembly (all instantiation paths) on the PAGE window via unsafeWindow, at document-start.
// @version      0.2
// @namespace    *://diep.io/
// @match        *://diep.io/
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * v0.2 — robustness fixes after v0.1 failed to capture on the live build:
 *   - Use unsafeWindow so we hook the PAGE's WebAssembly even if Tampermonkey
 *     runs us in an isolated world (diep.io CSP can force that). Globals are set
 *     on the page window so the DevTools console (page world) can see them.
 *   - Hook ALL instantiation paths: instantiate, instantiateStreaming, and the
 *     synchronous `new WebAssembly.Instance(module, imports)`.
 *   - Grab the exported Memory ("U") from whichever path the bundle uses.
 *
 * Exposes on the page window:
 *   __wasmMem, __heap(), __caps, __findBytes(pattern), __probeStatus()
 */

;(() => {
  // The real page window, even if we're sandboxed (CSP / isolated world).
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
  const WA = W.WebAssembly
  if (!WA) { console.warn('[wasm-probe] no WebAssembly on page window'); return }
  if (W.__probeInstalled) return
  W.__probeInstalled = true

  W.__caps = []
  W.__wasmMem = null
  let captureSource = null

  const grab = (res, where) => {
    try {
      const inst = res && (res.instance || res)
      if (inst && inst.exports) {
        const mem = inst.exports.U ||
          Object.values(inst.exports).find(x => x instanceof WA.Memory)
        if (mem && mem.buffer) {
          W.__wasmMem = mem
          captureSource = where
          console.log('%c[wasm-probe] captured WASM memory via ' + where + ':',
            'color:#0f0', mem.buffer.byteLength, 'bytes')
        }
      }
    } catch (e) {}
    return res
  }

  // --- async paths ---
  const origInst = WA.instantiate
  WA.instantiate = function (a, b) {
    const p = origInst.call(this, a, b)
    return (p && p.then) ? p.then(r => grab(r, 'instantiate')) : p
  }
  if (WA.instantiateStreaming) {
    const origStream = WA.instantiateStreaming
    WA.instantiateStreaming = function (a, b) {
      return origStream.call(this, a, b).then(r => grab(r, 'instantiateStreaming'))
    }
  }

  // --- synchronous path: new WebAssembly.Instance(module, imports) ---
  try {
    const OrigInstance = WA.Instance
    const Wrapped = function (mod, imports) {
      const inst = new OrigInstance(mod, imports)
      grab(inst, 'new Instance')
      return inst
    }
    Wrapped.prototype = OrigInstance.prototype
    WA.Instance = Wrapped
  } catch (e) { console.warn('[wasm-probe] Instance hook failed', e) }

  // --- WebSocket capture (raw frames / ciphertext) ---
  try {
    const OrigWS = W.WebSocket
    const Hooked = function (url, protocols) {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
      const send = ws.send.bind(ws)
      ws.send = function (d) {
        try {
          let b = d instanceof ArrayBuffer ? d : (d && d.buffer)
          if (b) W.__caps.push({ dir: 'out', t: Date.now(), bytes: new Uint8Array(b.slice ? b.slice(0) : b) })
        } catch (e) {}
        return send(d)
      }
      ws.addEventListener('message', e => {
        try {
          if (e.data instanceof ArrayBuffer)
            W.__caps.push({ dir: 'in', t: Date.now(), bytes: new Uint8Array(e.data) })
        } catch (err) {}
      })
      return ws
    }
    Hooked.prototype = OrigWS.prototype
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = OrigWS[k]
    W.WebSocket = Hooked
  } catch (e) { console.warn('[wasm-probe] WebSocket hook failed', e) }

  // --- helpers (on the page window) ---
  W.__heap = () => W.__wasmMem ? new Uint8Array(W.__wasmMem.buffer) : null

  W.__findBytes = (pattern) => {
    const heap = W.__heap()
    if (!heap) { console.warn('[wasm-probe] heap not captured yet'); return [] }
    const pat = typeof pattern === 'string'
      ? pattern.trim().split(/\s+/).map(h => parseInt(h, 16))
      : Array.from(pattern)
    const hits = []
    for (let i = 0; i + pat.length <= heap.length && hits.length < 50; i++) {
      let ok = true
      for (let j = 0; j < pat.length; j++) { if (heap[i + j] !== pat[j]) { ok = false; break } }
      if (ok) hits.push(i)
    }
    return hits
  }

  W.__probeStatus = () => ({
    installed: !!W.__probeInstalled,
    heapCaptured: !!W.__wasmMem,
    heapBytes: W.__wasmMem ? W.__wasmMem.buffer.byteLength : 0,
    captureSource,
    framesCaptured: (W.__caps || []).length,
    sandboxed: (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window),
  })

  console.log('%c[wasm-probe v0.2] installed; hooking page WebAssembly. sandboxed=' +
    (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window),
    'color:#0f0;font-weight:bold')
})()
