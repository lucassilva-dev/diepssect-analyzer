/**
 * Clientbound 0x00 (update) packet decoder — REAL implementation.
 *
 * Grounded in two real sources, NOT in guesses:
 *   1. diep-bot/coder.js — the working varuint/varint/varfloat/string codec.
 *   2. CLIENTBOUND.md     — the hand-verified structure of the update packet.
 *
 * It is validated by re-parsing the exact worked example from CLIENTBOUND.md
 * (run `node scripts/clientbound-decoder.js` to see the trace).
 *
 * IMPORTANT PROTOCOL FACT (this is the whole difficulty of diep RE):
 *   The field's TYPE is NOT present in the packet. After the field index
 *   (delta-encoded varindex) the value bytes follow immediately, with no tag.
 *   So to know how many bytes a field consumes you must already know its type.
 *   A field whose type is unknown halts parsing — you cannot skip past it.
 *   This is why recovering the full index->type table (from the WASM) matters.
 */

'use strict'

// ---- Reader: the real codec from diep-bot/coder.js, trimmed to decoding ----
const _conv = new ArrayBuffer(4)
const _u8 = new Uint8Array(_conv)
const _i32 = new Uint32Array(_conv)
const _f32 = new Float32Array(_conv)

const endianSwap = val =>
    ((val & 0xff) << 24)
  | ((val & 0xff00) << 8)
  | ((val >> 8) & 0xff00)
  | ((val >> 24) & 0xff)

class Reader {
  constructor(content) {
    this.at = 0
    this.buffer = new Uint8Array(content)
  }
  get remaining() { return this.buffer.length - this.at }
  u8() { return this.buffer[this.at++] }
  i32() { _u8.set(this.buffer.subarray(this.at, this.at += 4)); return _i32[0] }
  float() { _u8.set(this.buffer.subarray(this.at, this.at += 4)); return _f32[0] }
  vu() {
    let out = 0, at = 0
    while (this.buffer[this.at] & 0x80) {
      out |= (this.buffer[this.at++] & 0x7f) << at
      at += 7
    }
    out |= this.buffer[this.at++] << at
    return out >>> 0
  }
  vi() {
    let out = this.vu()
    let sign = out & 1
    out >>>= 1
    return sign ? ~out : out
  }
  vf() { _i32[0] = endianSwap(this.vi()); return _f32[0] }
  string() {
    let at = this.at
    while (this.buffer[this.at]) this.at++
    const s = Buffer.from(this.buffer.subarray(at, this.at)).toString()
    this.at++ // skip null terminator
    return s
  }
  // Entity id: vu(time) vu(counter), rendered "time:counter".
  entityId() {
    const time = this.vu()
    const counter = this.vu()
    return { time, counter, toString() { return `${time}:${counter}` } }
  }
  // Varindex: vu() XOR 1. In the update packet it is a DELTA on the running
  // field index; a decoded delta of 0 terminates the field list.
  varindexDelta() { return this.vu() ^ 1 }
}

/**
 * Field type table. Only entries with a real source are marked verified.
 * `vi` = signed varint, `vu` = unsigned varint, `f32` = raw float32,
 * `vf` = varfloat. Type is needed to know the value's byte length.
 *
 * NOTE: CLIENTBOUND.md is internally inconsistent about indices 1/2/3 — its
 * field *table* says 1=angle,2=x,3=y while its worked *example* labels the
 * same delta sequence x,y,angle. We keep the indices and read them as `vi`
 * (that part is unambiguous); the human label is left as a known-conflict.
 */
const DEFAULT_FIELD_TYPES = {
  1:  { type: 'vi', label: 'field1 (doc conflict: angle vs x)' },
  2:  { type: 'vi', label: 'field2 (doc conflict: x vs y)' },
  3:  { type: 'vi', label: 'field3 (doc conflict: y vs angle)' },
  5:  { type: 'f32', label: 'maxHealth' },
  24: { type: 'f32', label: 'health' },
}

function readFieldValue(reader, type) {
  switch (type) {
    case 'vi':  return reader.vi()
    case 'vu':  return reader.vu()
    case 'f32': return reader.float()
    case 'vf':  return reader.vf()
    default: throw new Error(`unknown field type "${type}"`)
  }
}

/**
 * Decode a clientbound 0x00 update packet body.
 * @param {Uint8Array|ArrayBuffer|number[]} bytes - full packet incl. type byte
 * @param {object} fieldTypes - index -> {type,label}
 * @returns {object} structured parse + `consumedAll` flag
 */
function decodeUpdate(bytes, fieldTypes = DEFAULT_FIELD_TYPES) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const result = { packetType: null, preamble: [], deleted: [], updated: [], notes: [] }

  result.packetType = r.vu() // 0x00 = update
  // The doc's example carries one more leading varuint before the deletion
  // count ("packet id vu 32"); its meaning is not firmly established, so we
  // capture it as preamble rather than pretend certainty.
  result.preamble.push(r.vu())

  const numDeleted = r.vu()
  for (let i = 0; i < numDeleted; i++) {
    result.deleted.push(r.entityId().toString())
  }

  const numUpdated = r.vu()
  for (let i = 0; i < numUpdated; i++) {
    const entity = { id: r.entityId().toString(), mode: [r.vu(), r.vu()], fields: {} }
    let index = 0
    while (true) {
      const delta = r.varindexDelta()
      if (delta === 0) break // terminator
      index += delta
      const def = fieldTypes[index]
      if (!def) {
        // Cannot know the byte length of an unknown field -> must stop.
        entity.fields[index] = { value: null, type: 'UNKNOWN', halted: true }
        result.notes.push(
          `Halted at entity ${entity.id}: field ${index} has unknown type; ` +
          `cannot determine its length to continue parsing.`
        )
        result.updated.push(entity)
        result.consumedAll = false
        result.bytesLeft = r.remaining
        return result
      }
      entity.fields[index] = { value: readFieldValue(r, def.type), type: def.type, label: def.label }
    }
    result.updated.push(entity)
  }

  result.consumedAll = r.remaining === 0
  result.bytesLeft = r.remaining
  return result
}

// ---------------------------------------------------------------------------
// Self-test: the exact worked example from CLIENTBOUND.md.
// Byte stream reconstructed from the doc's left-hand hex column:
//   00 20 02  01 04  01 06  01  01 07  00 01  00 a2 02  00 fc 01  00 73  01
// ---------------------------------------------------------------------------
const CLIENTBOUND_MD_EXAMPLE = [
  0x00, 0x20,                   // packet type + preamble varuint
  0x02,                         // 2 deleted
  0x01, 0x04,                   //   entity 1:4
  0x01, 0x06,                   //   entity 1:6
  0x01,                         // 1 updated
  0x01, 0x07,                   //   entity 1:7
  0x00, 0x01,                   //   update mode (vu 0, vu 1)
  0x00, 0xa2, 0x02,             //   +1 -> field 1 = vi
  0x00, 0xfc, 0x01,             //   +1 -> field 2 = vi
  0x00, 0x73,                   //   +1 -> field 3 = vi
  0x01,                         //   delta 0 -> end
]

function hex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

function selfTest() {
  console.log('Decoding CLIENTBOUND.md worked example...')
  console.log('Bytes:', hex(CLIENTBOUND_MD_EXAMPLE), '\n')

  const out = decodeUpdate(CLIENTBOUND_MD_EXAMPLE)
  console.log(JSON.stringify(out, null, 2))

  const checks = [
    ['packet type == 0 (update)', out.packetType === 0],
    ['2 entities deleted', out.deleted.length === 2],
    ['deleted ids are 1:4 and 1:6', out.deleted.join(',') === '1:4,1:6'],
    ['1 entity updated', out.updated.length === 1],
    ['updated id is 1:7', out.updated[0] && out.updated[0].id === '1:7'],
    ['3 fields with delta indices 1,2,3',
      out.updated[0] && Object.keys(out.updated[0].fields).join(',') === '1,2,3'],
    ['all bytes consumed (clean parse)', out.consumedAll === true],
  ]

  console.log('\nValidation:')
  let allPass = true
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) allPass = false
  }
  console.log(`\n${allPass ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`)
  console.log(`\nField values decoded (raw vi): ` +
    Object.entries(out.updated[0].fields).map(([i, f]) => `[${i}]=${f.value}`).join('  '))
  console.log('(values are raw signed varints; angle/coords are server-scaled, ' +
    'so the raw magnitudes are expected, not degrees/pixels)')
  return allPass
}

if (require.main === module) {
  process.exit(selfTest() ? 0 : 1)
}

module.exports = { Reader, decodeUpdate, DEFAULT_FIELD_TYPES, CLIENTBOUND_MD_EXAMPLE }
