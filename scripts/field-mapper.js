/**
 * Field Mapper for diep.io Protocol
 * Automatically correlates packet fields with game properties
 */

class FieldMapper {
  constructor(options = {}) {
    this.fieldMap = new Map()
    this.typeInference = new Map()
    this.correlations = []
    this.deltaHistory = []
    this.maxHistory = options.maxHistory || 1000
  }

  /**
   * Register a known field mapping
   */
  registerField(index, type, description = '', range = null) {
    this.fieldMap.set(index, {
      index,
      type,
      description,
      range,
      observations: 0,
      lastValue: null,
    })
  }

  /**
   * Record a field delta (change between packets)
   */
  recordDelta(fieldIndex, oldValue, newValue, context = {}) {
    const delta = {
      fieldIndex,
      oldValue,
      newValue,
      change: newValue - oldValue,
      timestamp: Date.now(),
      context, // Entity ID, position, etc
    }

    this.deltaHistory.push(delta)
    if (this.deltaHistory.length > this.maxHistory) {
      this.deltaHistory.shift()
    }

    // Update field info
    const field = this.fieldMap.get(fieldIndex)
    if (field) {
      field.observations++
      field.lastValue = newValue
      if (field.range) {
        field.range.min = Math.min(field.range.min, newValue)
        field.range.max = Math.max(field.range.max, newValue)
      }
    }

    return delta
  }

  /**
   * Infer field type based on byte patterns
   */
  inferFieldType(data, offset, maxBytes = 4) {
    const sample = data.slice(offset, Math.min(offset + maxBytes, data.length))

    // Check for float pattern (4 bytes, IEEE 754)
    if (sample.length >= 4) {
      const view = new DataView(sample.buffer, sample.byteOffset, 4)
      const float = view.getFloat32(0, true)

      // Looks like a valid float in game coordinate range
      if (Number.isFinite(float) && Math.abs(float) < 100000) {
        return {
          type: 'f32',
          confidence: 0.9,
          value: float,
        }
      }
    }

    // Check for varint (continues while high bit set)
    const byte1 = sample[0]
    if ((byte1 & 0x80) !== 0) {
      let varintBytes = 1
      let i = 1
      while (i < sample.length && (sample[i] & 0x80) !== 0) {
        varintBytes++
        i++
      }
      varintBytes++

      return {
        type: 'varint',
        confidence: 0.8,
        byteLength: varintBytes,
        value: this.decodeVarint(sample),
      }
    }

    // Check for string (null-terminated ASCII)
    if (this.looksLikeString(sample)) {
      return {
        type: 'string',
        confidence: 0.7,
        value: this.decodeString(sample),
      }
    }

    // Default to raw integer
    return {
      type: 'i32',
      confidence: 0.5,
      value: sample[0] | (sample[1] << 8) | (sample[2] << 16) | (sample[3] << 24),
    }
  }

  /**
   * Analyze player movement deltas to find position fields
   */
  correlateMovement(packets, mousePositions) {
    const correlations = []

    // For each packet, try to find fields that correlate with mouse X/Y
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i]
      const mouse = mousePositions[i]

      if (!mouse) continue

      // Scan for fields that match mouse coordinates
      const fields = this.parseFields(packet.data)

      for (const field of fields) {
        // Check if field value is close to mouse X
        if (Math.abs(field.value - mouse.x) < 100) {
          correlations.push({
            fieldIndex: field.index,
            gameProperty: 'mouseX',
            correlation: 0.9,
            samples: [{ fieldValue: field.value, gameValue: mouse.x }],
          })
        }

        // Check if field value is close to mouse Y
        if (Math.abs(field.value - mouse.y) < 100) {
          correlations.push({
            fieldIndex: field.index,
            gameProperty: 'mouseY',
            correlation: 0.9,
            samples: [{ fieldValue: field.value, gameValue: mouse.y }],
          })
        }
      }
    }

    this.correlations = correlations
    return correlations
  }

  /**
   * Find fields that scale with health/size
   */
  findScaleFields(healthDeltas, sizeDeltas) {
    const candidates = []

    // Health typically ranges from 0-100 or similar
    // Find fields that change proportionally to health changes
    for (const [fieldIndex, deltas] of Object.entries(healthDeltas)) {
      let correlation = 0
      let count = 0

      for (let i = 0; i < Math.min(deltas.length, 10); i++) {
        if (sizeDeltas[fieldIndex] && sizeDeltas[fieldIndex][i]) {
          const healthDelta = deltas[i]
          const fieldDelta = sizeDeltas[fieldIndex][i]

          // Strong correlation if changes are proportional
          if ((healthDelta > 0 && fieldDelta > 0) || (healthDelta < 0 && fieldDelta < 0)) {
            correlation += 0.5
            count++
          }
        }
      }

      if (count > 0) {
        candidates.push({
          fieldIndex: parseInt(fieldIndex),
          correlationType: 'health_scale',
          correlation: correlation / count,
        })
      }
    }

    return candidates
  }

  /**
   * Identify entity-related fields
   */
  findEntityFields(entityPackets) {
    const fields = new Map()

    for (const packet of entityPackets) {
      const parsed = this.parseFields(packet.data)

      for (const field of parsed) {
        if (!fields.has(field.index)) {
          fields.set(field.index, {
            index: field.index,
            appearances: 0,
            valueRange: { min: Infinity, max: -Infinity },
          })
        }

        const info = fields.get(field.index)
        info.appearances++
        info.valueRange.min = Math.min(info.valueRange.min, field.value)
        info.valueRange.max = Math.max(info.valueRange.max, field.value)
      }
    }

    return Array.from(fields.values()).sort((a, b) => b.appearances - a.appearances)
  }

  /**
   * Simple varint decoder
   */
  decodeVarint(data) {
    let value = 0
    let shift = 0
    let i = 0

    while (i < data.length) {
      const byte = data[i]
      value |= (byte & 0x7f) << shift

      if ((byte & 0x80) === 0) break
      shift += 7
      i++
    }

    return value
  }

  /**
   * Simple string decoder (null-terminated ASCII)
   */
  decodeString(data) {
    let str = ''
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) break
      str += String.fromCharCode(data[i])
    }
    return str
  }

  /**
   * Check if data looks like a string
   */
  looksLikeString(data) {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i]
      if (byte === 0) return true // Found null terminator
      if (byte < 32 || byte > 126) return false // Non-printable
    }
    return data.length > 3
  }

  /**
   * Parse simple field structure from packet data
   * Assumes each field starts with an index (varint) followed by value
   */
  parseFields(data) {
    const fields = []
    let offset = 0

    while (offset < data.length) {
      // Try to read field index (varint)
      const indexResult = this.readVarint(data, offset)
      if (!indexResult) break

      const fieldIndex = indexResult.value
      offset = indexResult.nextOffset

      // Try to infer field type
      const typeResult = this.inferFieldType(data, offset)
      if (!typeResult) break

      fields.push({
        index: fieldIndex,
        type: typeResult.type,
        value: typeResult.value,
        offset,
      })

      // Skip ahead based on field type
      if (typeResult.type === 'f32') {
        offset += 4
      } else if (typeResult.type === 'varint') {
        offset += typeResult.byteLength
      } else if (typeResult.type === 'string') {
        offset += typeResult.value.length + 1 // +1 for null terminator
      } else {
        offset += 4
      }
    }

    return fields
  }

  /**
   * Read a single varint and return next offset
   */
  readVarint(data, offset) {
    let value = 0
    let shift = 0
    let i = offset

    while (i < data.length) {
      const byte = data[i]
      value |= (byte & 0x7f) << shift

      i++
      if ((byte & 0x80) === 0) break
      shift += 7
    }

    return {
      value,
      nextOffset: i,
    }
  }

  /**
   * Build a field normalization map (for scale/offset detection)
   */
  buildNormalizationMap(fieldSamples) {
    const normMap = new Map()

    for (const [fieldIndex, samples] of Object.entries(fieldSamples)) {
      if (samples.length < 2) continue

      const values = samples.map(s => s.value).sort((a, b) => a - b)
      const min = values[0]
      const max = values[values.length - 1]
      const range = max - min

      // Check if this field likely represents a normalized value (0-1, 0-100, etc)
      if (range > 0 && range <= 100) {
        normMap.set(parseInt(fieldIndex), {
          type: 'normalized',
          min,
          max,
          range,
          scale: 100 / range,
        })
      } else if (range > 100 && range < 1000000) {
        normMap.set(parseInt(fieldIndex), {
          type: 'coordinate',
          min,
          max,
          range,
          scale: 1 / range,
        })
      }
    }

    return normMap
  }

  /**
   * Export field mapping as JSON
   */
  exportJSON() {
    return {
      fieldMap: Object.fromEntries(this.fieldMap),
      correlations: this.correlations,
      deltaCount: this.deltaHistory.length,
    }
  }

  /**
   * Export field mapping as markdown table
   */
  exportMarkdown() {
    let md = '| Index | Type | Description | Range | Observations |\n'
    md += '|-------|------|-------------|-------|---------------|\n'

    const sorted = Array.from(this.fieldMap.values()).sort((a, b) => a.index - b.index)

    for (const field of sorted) {
      const range = field.range
        ? `${field.range.min.toFixed(2)}-${field.range.max.toFixed(2)}`
        : 'N/A'
      md += `| ${field.index} | ${field.type} | ${field.description} | ${range} | ${field.observations} |\n`
    }

    return md
  }

  /**
   * Clear all mappings
   */
  clear() {
    this.fieldMap.clear()
    this.correlations = []
    this.deltaHistory = []
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FieldMapper
}
