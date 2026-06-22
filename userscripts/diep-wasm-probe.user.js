// ==UserScript==
// @name         Diep WASM Probe (cipher RE)
// @description  Captures the WASM heap + raw WebSocket frames for diep.io cipher reverse engineering. Must run at document-start so it hooks WebAssembly before the game bundle instantiates.
// @version      0.1
// @namespace    *://diep.io/
// @match        *://diep.io/
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Why this exists:
 *   The current diep.io build does NOT expose the emscripten heap to page scope
 *   (window.Module === {locateFile}). The WebAssembly.Memory (export "U") lives
 *   in the bundle's closure. To read decrypted packets / cipher tables from
 *   memory we must grab the Memory object at instantiation time — hence a
 *   document-start hook on WebAssembly.instantiate[Streaming].
 *
 * What it exposes on window:
 *   __wasmMem   : the live WebAssembly.Memory (or null until instantiated)
 *   __heap()    : fresh Uint8Array view over the heap (re-create after growth)
 *   __caps      : array of {dir:'in'|'out', t, bytes:Uint8Array} raw WS frames
 *   __findBytes(pattern) : scan the heap for a byte pattern (array/hex string),
 *                          returns matching offsets (first 50). Use it to locate
 *                          known plaintext (e.g. your nickname) in memory.
 *
 * Workflow for cipher RE (Path B / B2 in docs/CIPHER-RE.md):
 *   1. Install this, open diep.io, spawn with a known nickname (e.g. 12x 'A').
 *   2. __findBytes('41 41 41 41 41 41 41 41 41 41 41 41') -> locate the name
 *      buffer; nearby structures reveal the decoded/plaintext region.
 *   3. After the 0xf5 handshake, snapshot candidate substitution tables and
 *      validate against the known outbound keystream 7c 42 0d 65 c6 71 0d 38 ...
 */

;(() => {
  window.__caps = []

  // ---- hook WebAssembly instantiation to capture the Memory object ----
  const grab = (res) => {
    try {
      const inst = res && (res.instance || res)
      if (inst && inst.exports) {
        const mem = inst.exports.U ||
          Object.values(inst.exports).find(x => x instanceof WebAssembly.Memory)
        if (mem) {
          window.__wasmMem = mem
          console.log('%c[wasm-probe] captured WASM memory:', 'color:#0f0',
            mem.buffer.byteLength, 'bytes')
        }
      }
    } catch (e) {}
    return res
  }

  const origInst = WebAssembly.instantiate
  WebAssembly.instantiate = function (bytes, imports) {
    const p = origInst.call(this, bytes, imports)
    return p && p.then ? p.then(grab) : p
  }

  if (WebAssembly.instantiateStreaming) {
    const origStream = WebAssembly.instantiateStreaming
    WebAssembly.instantiateStreaming = function (src, imports) {
      return origStream.call(this, src, imports).then(grab)
    }
  }

  // ---- hook WebSocket to capture raw frames (ciphertext) ----
  const OrigWS = window.WebSocket
  const Hooked = function (url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
    const send = ws.send.bind(ws)
    ws.send = function (d) {
      try {
        let b = d instanceof ArrayBuffer ? d : (d && d.buffer)
        if (b) window.__caps.push({ dir: 'out', t: Date.now(), bytes: new Uint8Array(b.slice ? b.slice(0) : b) })
      } catch (e) {}
      return send(d)
    }
    ws.addEventListener('message', e => {
      try {
        if (e.data instanceof ArrayBuffer)
          window.__caps.push({ dir: 'in', t: Date.now(), bytes: new Uint8Array(e.data) })
      } catch (err) {}
    })
    return ws
  }
  Hooked.prototype = OrigWS.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = OrigWS[k]
  window.WebSocket = Hooked

  // ---- helpers ----
  window.__heap = () => window.__wasmMem ? new Uint8Array(window.__wasmMem.buffer) : null

  window.__findBytes = (pattern) => {
    const heap = window.__heap()
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
    console.log(`[wasm-probe] ${hits.length} match(es) for ${pat.length}-byte pattern`)
    return hits
  }

  console.log('%c[wasm-probe] installed (document-start). Waiting for WASM…', 'color:#0f0;font-weight:bold')
})()
