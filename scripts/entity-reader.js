/* diep.io live entity enumerator — paste into the diep.io console (window.mem from
   the diep-mem-reader userscript must be present).

   Recovered by static RE of diep.wasm (analysis/current/diep.wat) and adversarially
   verified. See docs/WASM-ENTITY-RE.md for the full pointer chain + evidence.

   Verified WAT anchors:
     func 99  @63345  -> WORLD = i32.const 582904 (address-of constant, NO deref)
     func 77  @11287  -> registry @467744 ; container+12 ; occupancy bitmap @+796
     func 186 @85222  -> page dir @+6940 (idx (probe>>8)<<2) ; node = page + (probe&255)*224
     func 528 @405786 -> base=WORLD+1120 ; begin=load+676 end=load+680 ;
                         ref=u32(slot) ; node=ref+64 ; renderable=u32(node+172) ; color=u32(node+156)
   Entity-node stride = 224 bytes (57344-byte pages, 256 nodes/page).

   OPEN (resolve live by move-diff): exact x/y offset on the renderable component
   (node+172) is not pinned in the WAT; health component (node+176) is unconfirmed.
*/
(function () {
  const m = window.mem;
  if (!m || !m.u32) { console.error('window.mem not found (install diep-mem-reader userscript)'); return null; }
  const HEAP = m.heap().length;
  const ok = p => Number.isFinite(p) && p > 0 && p < HEAP;

  const WORLD = 582904;          // func 99 constant
  const CBASE = WORLD + 1120;    // inner vector base (CONTAINER+12), used by func 528 & 774
  const VEC_BEGIN = CBASE + 676; // render vector begin   (func 528 off676)
  const VEC_END   = CBASE + 680; // render vector end     (func 528 off680)
  const O_RENDER  = 172;         // renderable component ptr (func 528 off172)
  const O_COLOR   = 156;         // style/color id          (func 528 off156)
  const O_HEALTHC = 176;         // health component ptr (UNCONFIRMED)
  const STRIDE    = 224;
  const REF_ADJ   = 64;          // node = ref + 64 (func 528 `i32.const -64 i32.sub`)
  const CAP       = 2000;

  function readNode(node) {
    if (!ok(node)) return null;
    const idTime    = m.u16(node + 64 + 4);  // id 2-tuple at ref(=node+64): time@+4
    const idCounter = m.u16(node + 64 + 8);  //                              counter@+8
    const renderable = m.u32(node + O_RENDER);
    const color      = m.u32(node + O_COLOR);
    let x = NaN, y = NaN, posOff = -1;
    // Position lives in the renderable component (offset TBD). Probe candidate slots.
    if (ok(renderable)) {
      const cand = [8, 88, 120, 128, 152];
      for (const off of cand) {
        const vx = m.f32(renderable + off);
        const vy = m.f32(renderable + off + 4);
        if (Number.isFinite(vx) && Number.isFinite(vy) &&
            Math.abs(vx) < 1e7 && Math.abs(vy) < 1e7 && (vx || vy)) {
          x = vx; y = vy; posOff = off; break;
        }
      }
    }
    let health = NaN;
    const hc = m.u32(node + O_HEALTHC);
    if (ok(hc)) { const h = m.f32(hc + 48); if (Number.isFinite(h)) health = h; }
    return {
      idHex: ((idTime >>> 0).toString(16).padStart(4, '0') + ':' +
              (idCounter >>> 0).toString(16).padStart(4, '0')),
      x, y, health, type: color >>> 0, node, renderable, posOff
    };
  }

  // ---- METHOD A: render vector walk (per-frame visible set) ----
  function viaRenderVector() {
    const begin = m.u32(VEC_BEGIN), end = m.u32(VEC_END);
    const out = [];
    if (!ok(begin) || !Number.isFinite(end) || end < begin) return out;
    const n = Math.min((end - begin) >>> 2, CAP);
    for (let i = 0; i < n; i++) {
      const slot = begin + i * 4;
      if (!ok(slot)) break;
      const ref = m.u32(slot);
      if (!ok(ref)) continue;
      const e = readNode(ref + REF_ADJ);
      if (e) out.push(e);
    }
    return out;
  }

  // ---- METHOD B: canonical hashmap full scan (authoritative store) ----
  function viaHashmap() {
    const out = [], seen = new Set();
    for (let s = 0; s < 2048; s++) {
      const container = m.u32(467744 + s * 4);
      if (!ok(container)) continue;
      const base = container + 12;
      for (let probe = 0; probe < 16384 && out.length < CAP; probe++) {
        const word = m.u32(base + 796 + ((probe >> 3) & ~3));
        if (!((word >>> (probe & 31)) & 1)) continue;
        const page = m.u32(base + 6940 + ((probe >> 8) << 2));
        if (!ok(page)) continue;
        const node = page + (probe & 255) * STRIDE;
        if (!ok(node) || seen.has(node)) continue;
        seen.add(node);
        const e = readNode(node);
        if (e) out.push(e);
      }
    }
    return out;
  }

  let list = viaRenderVector();
  let method = 'render-vector';
  if (!list.length) { console.warn('render vector empty; trying hashmap full scan'); list = viaHashmap(); method = 'hashmap'; }
  if (!list.length) {
    console.warn('No entities via known anchors. Self pos for reference: x=' +
      m.f32(591660) + ' y=' + m.f32(591664));
  }

  console.log('entities:', list.length, '(via ' + method + ')', list.slice(0, 20));
  window.__entities = list;
  return { method, count: list.length, sample: list.slice(0, 20) };
})();
