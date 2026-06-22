/**
 * Payload Classifier for diep.io Protocol
 * Detects and classifies packet payload structures
 */

class PayloadClassifier {
  constructor() {
    this.classifications = new Map()
    this.patterns = []
  }

  /**
   * Classify a payload by analyzing its structure
   * @returns Classification object with type, confidence, and details
   */
  classify(data) {
    if (!data || data.length === 0) {
      return {
        type: 'empty',
        confidence: 1.0,
      }
    }

    const classification = {
      type: 'unknown',
      confidence: 0,
      details: {},
    }

    // Try each classification method
    const results = [
      this.classifyAsVarintSequence(data),
      this.classifyAsStructured(data),
      this.classifyAsString(data),
      this.classifyAsCompressed(data),
      this.classifyAsEntityUpdate(data),
    ]

    // Use classification with highest confidence
    const best = results.reduce((prev, current) =>
      current.confidence > prev.confidence ? current : prev
    )

    if (best.confidence > 0) {
      return best
    }

    return classification
  }

  /**
   * Classify as sequence of varints
   */
  classifyAsVarintSequence(data) {
    let offset = 0
    let varintCount = 0
    const varints = []

    while (offset < data.length && varintCount < 100) {
      const result = this.tryReadVarint(data, offset)
      if (!result) break

      varints.push(result.value)
      offset = result.nextOffset
      varintCount++
    }

    const coveragePercent = offset / data.length

    return {
      type: 'varint_sequence',
      confidence: varintCount > 3 ? Math.min(1.0, coveragePercent * 1.2) : 0,
      details: {
        varintCount,
        coverage: coveragePercent,
        varints: varints.slice(0, 10),
      },
    }
  }

  /**
   * Classify as structured data (mixed types)
   */
  classifyAsStructured(data) {
    const analysis = {
      hasFloats: 0,
      hasStrings: 0,
      hasVarints: 0,
      nullBytes: 0,
      printablePercent: 0,
    }

    let offset = 0
    let printable = 0

    while (offset < data.length) {
      const byte = data[offset]

      // Count printable ASCII
      if (byte >= 32 && byte <= 126) {
        printable++
      }

      // Check for null terminator (string indicator)
      if (byte === 0) {
        analysis.nullBytes++
        analysis.hasStrings++
      }

      // Check for varint
      if (offset < data.length - 1 && (byte & 0x80)) {
        analysis.hasVarints++
      }

      // Check for potential float (simple heuristic)
      if (
        offset < data.length - 4 &&
        this.isFloatLike(data.slice(offset, offset + 4))
      ) {
        analysis.hasFloats++
      }

      offset++
    }

    analysis.printablePercent = printable / data.length

    const diversity =
      (analysis.hasFloats > 0 ? 1 : 0) +
      (analysis.hasStrings > 0 ? 1 : 0) +
      (analysis.hasVarints > 0 ? 1 : 0)

    return {
      type: 'structured',
      confidence: diversity > 1 ? 0.7 : 0,
      details: analysis,
    }
  }

  /**
   * Classify as string data
   */
  classifyAsString(data) {
    // Check if mostly printable ASCII with null terminators
    let printable = 0
    let nulls = 0

    for (let i = 0; i < data.length; i++) {
      const byte = data[i]
      if (byte === 0) nulls++
      else if (byte >= 32 && byte <= 126) printable++
    }

    const printablePercent = printable / data.length

    if (nulls > 0 && printablePercent > 0.6) {
      try {
        const str = this.decodeNullTerminatedString(data)
        return {
          type: 'string',
          confidence: 0.8,
          details: {
            string: str,
            length: str.length,
          },
        }
      } catch (e) {
        // Fall through
      }
    }

    return {
      type: 'string',
      confidence: 0,
      details: {},
    }
  }

  /**
   * Classify as compressed data
   */
  classifyAsCompressed(data) {
    // Check for LZ4 patterns
    const entropy = this.calculateEntropy(data)
    const hasLZ4Patterns = this.detectLZ4Patterns(data)

    // High entropy + LZ4 patterns = likely compressed
    if (hasLZ4Patterns && entropy > 7.0) {
      return {
        type: 'compressed_lz4',
        confidence: 0.85,
        details: {
          entropy,
          lz4Confidence: 0.8,
        },
      }
    }

    return {
      type: 'compressed_lz4',
      confidence: 0,
      details: {},
    }
  }

  /**
   * Classify as entity update packet
   */
  classifyAsEntityUpdate(data) {
    // Entity updates typically:
    // - Start with update type (varint)
    // - Followed by entity ID (varint pair: time, counter)
    // - Then field updates

    if (data.length < 4) return { type: 'entity_update', confidence: 0, details: {} }

    let offset = 0

    // Try to read update type
    const typeResult = this.tryReadVarint(data, offset)
    if (!typeResult) {
      return { type: 'entity_update', confidence: 0, details: {} }
    }

    offset = typeResult.nextOffset

    // Try to read entity ID (should be 2 varints)
    const idTime = this.tryReadVarint(data, offset)
    if (!idTime) {
      return { type: 'entity_update', confidence: 0, details: {} }
    }

    offset = idTime.nextOffset
    const idCounter = this.tryReadVarint(data, offset)
    if (!idCounter) {
      return { type: 'entity_update', confidence: 0, details: {} }
    }

    // Good heuristic: found 3+ varints in sequence
    return {
      type: 'entity_update',
      confidence: 0.75,
      details: {
        updateType: typeResult.value,
        entityTimeId: idTime.value,
        entityCounter: idCounter.value,
      },
    }
  }

  /**
   * Segment a payload based on detected structure
   */
  segmentPayload(data) {
    const segments = []
    let offset = 0

    // Heuristic: segments are separated by null bytes or pattern changes
    let currentSegment = {
      start: 0,
      data: [],
      type: 'unknown',
    }

    while (offset < data.length) {
      const byte = data[offset]

      // Null byte might indicate segment boundary
      if (byte === 0 && currentSegment.data.length > 0) {
        currentSegment.data.push(byte)
        currentSegment.end = offset
        segments.push(currentSegment)

        currentSegment = {
          start: offset + 1,
          data: [],
          type: 'unknown',
        }
        offset++
      } else {
        currentSegment.data.push(byte)
        offset++
      }
    }

    // Add final segment
    if (currentSegment.data.length > 0) {
      currentSegment.end = offset
      segments.push(currentSegment)
    }

    return segments
  }

  /**
   * Detect varint vs raw integer
   */
  detectVarintVsInteger(data, offset, length = 4) {
    if (offset + length > data.length) return null

    const sample = data.slice(offset, offset + length)

    // Varint has high bit set on continuation bytes
    let isVarint = true
    for (let i = 0; i < sample.length - 1; i++) {
      if (!(sample[i] & 0x80)) {
        isVarint = false
        break
      }
    }

    if (isVarint && sample[sample.length - 1] & 0x80) {
      isVarint = false
    }

    return {
      isVarint,
      asInteger: this.readInt32LE(sample),
      asVarint: isVarint ? this.decodeVarint(sample) : null,
    }
  }

  /**
   * Try to read a single varint
   */
  tryReadVarint(data, offset) {
    if (offset >= data.length) return null

    let value = 0
    let shift = 0
    let i = offset

    while (i < data.length && i < offset + 5) {
      const byte = data[i]
      value |= (byte & 0x7f) << shift

      i++
      if (!(byte & 0x80)) {
        return { value, nextOffset: i }
      }

      shift += 7
    }

    return null
  }

  /**
   * Decode varint
   */
  decodeVarint(data) {
    let value = 0
    let shift = 0

    for (let i = 0; i < data.length && i < 5; i++) {
      const byte = data[i]
      value |= (byte & 0x7f) << shift

      if (!(byte & 0x80)) break
      shift += 7
    }

    return value
  }

  /**
   * Decode null-terminated string
   */
  decodeNullTerminatedString(data) {
    let str = ''
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) break
      str += String.fromCharCode(data[i])
    }
    return str
  }

  /**
   * Check if 4 bytes look like a float
   */
  isFloatLike(bytes) {
    if (bytes.length < 4) return false

    const view = new DataView(bytes.buffer, bytes.byteOffset, 4)
    const value = view.getFloat32(0, true)

    // Check for reasonable game values
    return Number.isFinite(value) && Math.abs(value) < 100000
  }

  /**
   * Calculate Shannon entropy
   */
  calculateEntropy(data) {
    const frequencies = new Map()

    for (const byte of data) {
      frequencies.set(byte, (frequencies.get(byte) || 0) + 1)
    }

    let entropy = 0
    for (const freq of frequencies.values()) {
      const p = freq / data.length
      entropy -= p * Math.log2(p)
    }

    return entropy
  }

  /**
   * Detect LZ4 compression patterns
   */
  detectLZ4Patterns(data) {
    if (data.length < 8) return false

    // LZ4 blocks start with a token byte (4 bits literal, 4 bits match)
    // Look for patterns that suggest LZ4 encoding

    let patternCount = 0

    for (let i = 1; i < Math.min(data.length - 2, 50); i++) {
      const token = data[i]
      const literalLen = (token >> 4) & 0x0f
      const matchLen = token & 0x0f

      // Valid token if either part is non-zero
      if (literalLen > 0 || matchLen > 0) {
        patternCount++
      }

      // If token is 0, might be end marker
      if (token === 0) {
        patternCount++
      }
    }

    return patternCount > 10
  }

  /**
   * Helper: Read int32 little-endian
   */
  readInt32LE(data) {
    return (
      data[0] |
      (data[1] << 8) |
      (data[2] << 16) |
      (data[3] << 24)
    )
  }

  /**
   * Export classifications as JSON
   */
  exportJSON() {
    return {
      classifications: Array.from(this.classifications.entries()),
      patterns: this.patterns,
    }
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PayloadClassifier
}
