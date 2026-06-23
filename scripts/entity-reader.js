/* ============================================================================
 * diep.io LIVE ENTITY READER  (validated 2026)
 * Enumerates every entity from WASM memory and decodes position / health / type
 * — no network cipher, no heavy heap scan. Requires window.mem from the
 * diep-mem-reader userscript (Tampermonkey Sandbox Mode = Raw).
 *
 * Recovered by static RE of analysis/current/diep.wat (two multi-agent workflows
 * + adversarial verification) and confirmed live:
 *   - Enumeration chain: WORLD=582904; base=WORLD+1120 (=entity-container+12);
 *     occupancy bitmap @ base+796; page dir @ base+6940 (idx (probe>>8)<<2);
 *     node = page + (probe&255)*224; stride 224; validation key u16@node+116==6954.
 *   - Obfuscated f32 decode (func 82/528/1298): byte-permuting affine+XOR, fixed
 *     constants, then reinterpret bits as f32. SELF-CHECK: decode(749705847)==0.0.
 *   - Render position (camera-relative) on the renderable component (node+172):
 *     X @ +144, Y @ +164 (obfuscated). WORLD = render + camera(591660/591664).
 *     Live-validated: shapes decode to sane world coords around the player.
 *   - Health: PLAIN ratio (health/maxHealth, [0,1]) at (node+176)+48 (no maxHP client-side).
 *   - Type: draw-callback table index at (node+172)+176 (category discriminator;
 *     no flat int enum — label categories by observing distinct values live).
 * ========================================================================== */
(function () {
  const M = window.mem;
  if (!M) { console.error('window.mem missing (install diep-mem-reader, Sandbox=Raw)'); return null; }
  const u8 = a => M.u8(a >>> 0), u16 = a => M.u16(a >>> 0), u32 = a => M.u32(a >>> 0), f32 = a => M.f32(a >>> 0);
  const HEAP = M.heap().length;
  const ok = p => { p >>>= 0; return p > 0 && p < HEAP - 256; };

  // --- obfuscated-f32 decode (verbatim from func 82) ---
  const _dv = new DataView(new ArrayBuffer(4));
  function decode(v) {
    v >>>= 0; const h = v >>> 16, t = v >>> 24;
    const b2 = ((((v + Math.imul(h, -82)) | 0) - (-64)) ^ 169) & 0xFF;
    const mid = ((((h << 8) - (t << 14)) | 0) + 20736) & 0xFF00;
    const b0 = (t + 208) & 0xFF;
    const b3 = (((((Math.imul(v, 125)) + (v >>> 8)) | 0) - 71) ^ 110) & 0xFF;
    const p = (((b3 << 24) | (b2 << 16) | mid | b0) ^ 252) >>> 0;
    _dv.setUint32(0, p, true); return _dv.getFloat32(0, true);
  }
  if (decode(749705847) !== 0) console.warn('[entity-reader] decode self-check FAILED');

  const WORLD = 582904;
  const base = WORLD + 1120;          // = entity-container + 12 (address, NOT a deref)
  const bm = base + 796;              // occupancy bitmap
  const camX = f32(591660), camY = f32(591664); // player camera = player world pos

  const f64 = a => { const h = M.heap(); return new DataView(h.buffer, h.byteOffset + (a >>> 0), 8).getFloat64(0, true); };
  const cl = x => Math.max(0, Math.min(1, x));
  function healthRatio(node) {
    const H = u32(node + 176);
    if (!ok(H)) return NaN;
    if (u8(H + 72) === 1) return cl(f32(H + 48));
    // smoothstep interpolation (func 285); g[541760] is the frame clock
    const tt = cl((f64(541760) - f64(H + 56)) / 100);
    const s = tt * tt * (3 - 2 * tt);
    const cur = f32(H + 48), from = f32(H + 68);
    return cl((cur - from) * s + from);
  }

  const ents = [];
  for (let probe = 0; probe < 65536 && ents.length < 2000; probe++) {
    if (!((u8(bm + (probe >> 3)) >> (probe & 7)) & 1)) continue;
    const page = u32(base + 6940 + ((probe >> 8) << 2));
    if (!ok(page)) continue;
    const node = (page + (probe & 255) * 224) >>> 0;
    if (!ok(node) || u16(node + 116) !== 6954) continue;
    const R = u32(node + 172);
    let sx = NaN, sy = NaN, type = 0;
    if (ok(R)) { sx = decode(u32(R + 144)); sy = decode(u32(R + 164)); type = u32(R + 176) >>> 0; }
    ents.push({
      probe, node,
      screenX: +sx.toFixed(1), screenY: +sy.toFixed(1),         // camera-relative (for radar)
      worldX: +(sx + camX).toFixed(1), worldY: +(sy + camY).toFixed(1), // absolute
      health: +healthRatio(node).toFixed(3),                   // 0..1 ratio
      type,                                                     // draw-callback index = category
      idTime: u16(node + 64 + 4), idCounter: u16(node + 64 + 8),
    });
  }

  const types = {}; ents.forEach(e => types[e.type] = (types[e.type] || 0) + 1);
  console.log(`[entity-reader] ${ents.length} entities; camera (player) = (${camX.toFixed(0)}, ${camY.toFixed(0)})`);
  console.log('[entity-reader] type-index -> count:', types);
  try { console.table(ents.map(e => ({ worldX: e.worldX, worldY: e.worldY, health: e.health, type: e.type }))); } catch (e) {}
  window.diepEntities = ents;
  return { count: ents.length, camera: { x: camX, y: camY }, entities: ents };
})();
