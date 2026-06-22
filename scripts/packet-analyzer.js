/**
 * Packet Analyzer for diep.io Protocol
 * Provides real-time packet capture, analysis, and reverse engineering tools
 */

class PacketAnalyzer {
  constructor(options = {}) {
    this.packets = []
    this.stats = {}
    this.patterns = new Map()
    this.startTime = Date.now()
    this.maxPackets = options.maxPackets || 10000
    this.autoAnalyze = options.autoAnalyze !== false
  }

  /**
   * Capture a packet and add to analysis queue
   * @param {number} id - Packet type ID
   * @param {Uint8Array} data - Raw packet data
   * @param {string} direction - 'clientbound' or 'serverbound'
   * @param {number} timestamp - Optional timestamp
   */
  capturePacket(id, data, direction, timestamp = Date.now()) {
    if (this.packets.length >= this.maxPackets) {
      this.packets.shift()
    }

    const packet = {
      id,
      data: new Uint8Array(data),
      size: data.length,
      direction,
      timestamp,
      elapsed: timestamp - this.startTime,
      hash: this.hashPacket(data),
    }

    this.packets.push(packet)
    this.updateStats(packet)

    if (this.autoAnalyze) {
      this.analyzePacket(packet)
    }

    return packet
  }

  /**
   * Update running statistics for packet type
   */
  updateStats(packet) {
    const key = `${packet.direction}:${packet.id}`

    if (!this.stats[key]) {
      this.stats[key] = {
        count: 0,
        totalSize: 0,
        minSize: Infinity,
        maxSize: 0,
        avgSize: 0,
        timestamps: [],
        hashes: new Set(),
        entropy: 0,
      }
    }

    const stat = this.stats[key]
    stat.count++
    stat.totalSize += packet.size
    stat.minSize = Math.min(stat.minSize, packet.size)
    stat.maxSize = Math.max(stat.maxSize, packet.size)
    stat.avgSize = stat.totalSize / stat.count
    stat.timestamps.push(packet.timestamp)
    stat.hashes.add(packet.hash)
    stat.entropy = this.calculateEntropy(packet.data)
  }

  /**
   * Analyze packet structure
   */
  analyzePacket(packet) {
    const analysis = {
      varintCount: 0,
      floatCount: 0,
      stringCount: 0,
      nullBytes: 0,
      suspectedTypes: [],
    }

    const data = packet.data
    let i = 0

    while (i < data.length) {
      const byte = data[i]

      // Check for varint continuation
      if (byte & 0x80) {
        analysis.varintCount++
        i++
        while (i < data.length && data[i] & 0x80) i++
        i++
      }
      // Check for null terminator (string end)
      else if (byte === 0 && i > 0 && i < data.length - 1) {
        analysis.stringCount++
        analysis.suspectedTypes.push({ offset: i - 5, type: 'string' })
        i++
      }
      // Check for float pattern (4 bytes that look like IEEE 754)
      else if (i + 4 <= data.length) {
        const floatBytes = data.slice(i, i + 4)
        if (this.looksLikeFloat(floatBytes)) {
          analysis.floatCount++
          analysis.suspectedTypes.push({ offset: i, type: 'float32' })
          i += 4
        } else {
          i++
        }
      } else {
        if (byte === 0) analysis.nullBytes++
        i++
      }
    }

    return analysis
  }

  /**
   * Simple heuristic: does this look like an IEEE 754 float?
   */
  looksLikeFloat(bytes) {
    // Check if values are in reasonable ranges for typical float data
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4)
    const value = view.getFloat32(0, true) // little-endian

    // NaN, Infinity
    if (!Number.isFinite(value)) return false

    // Values should be in reasonable game coordinate ranges
    return Math.abs(value) < 100000
  }

  /**
   * Calculate Shannon entropy of byte array
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
   * Generate hash of packet data
   */
  hashPacket(data) {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data[i]
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash.toString(16)
  }

  /**
   * Compare two packets byte-by-byte
   */
  diffPackets(packet1, packet2) {
    const diff = {
      commonPrefix: 0,
      commonSuffix: 0,
      differences: [],
    }

    const data1 = packet1.data
    const data2 = packet2.data
    const minLen = Math.min(data1.length, data2.length)

    // Find common prefix
    let i = 0
    while (i < minLen && data1[i] === data2[i]) i++
    diff.commonPrefix = i

    // Find common suffix
    let j = minLen - 1
    while (j >= i && data1[j] === data2[j]) j--
    diff.commonSuffix = minLen - 1 - j

    // Find differences
    for (let k = i; k <= j; k++) {
      if (data1[k] !== data2[k]) {
        diff.differences.push({
          offset: k,
          value1: data1[k],
          value2: data2[k],
        })
      }
    }

    return diff
  }

  /**
   * Frequency analysis for packet type
   */
  getFrequencyAnalysis(direction, packetId) {
    const key = `${direction}:${packetId}`
    const packets = this.packets.filter(
      p => p.direction === direction && p.id === packetId
    )

    if (packets.length === 0) return null

    return {
      packetsPerSecond:
        packets.length / ((this.packets[this.packets.length - 1].timestamp - this.startTime) / 1000) || 0,
      totalPackets: packets.length,
      avgSize: packets.reduce((sum, p) => sum + p.size, 0) / packets.length,
      uniqueVariants: new Set(packets.map(p => p.hash)).size,
      sizeDistribution: this.getSizeDistribution(packets),
      timingGaps: this.getTimingGaps(packets),
    }
  }

  /**
   * Analyze distribution of packet sizes
   */
  getSizeDistribution(packets) {
    const distribution = new Map()

    for (const packet of packets) {
      const bucket = Math.floor(packet.size / 10) * 10
      distribution.set(bucket, (distribution.get(bucket) || 0) + 1)
    }

    return Object.fromEntries(distribution)
  }

  /**
   * Analyze timing gaps between packets
   */
  getTimingGaps(packets) {
    const gaps = []

    for (let i = 1; i < packets.length; i++) {
      gaps.push(packets[i].timestamp - packets[i - 1].timestamp)
    }

    if (gaps.length === 0) return null

    return {
      minGap: Math.min(...gaps),
      maxGap: Math.max(...gaps),
      avgGap: gaps.reduce((a, b) => a + b, 0) / gaps.length,
      medianGap: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)],
    }
  }

  /**
   * Export captured data to JSON
   */
  exportToJSON(options = {}) {
    const filtered = this.packets.filter(p => {
      if (options.direction && p.direction !== options.direction) return false
      if (options.packetId !== undefined && p.id !== options.packetId) return false
      if (options.minSize && p.size < options.minSize) return false
      if (options.maxSize && p.size > options.maxSize) return false
      return true
    })

    return {
      captureTime: new Date(this.startTime).toISOString(),
      totalPackets: this.packets.length,
      filteredPackets: filtered.length,
      packets: filtered.map(p => ({
        id: p.id,
        direction: p.direction,
        size: p.size,
        timestamp: p.timestamp,
        data: Array.from(p.data),
      })),
      stats: this.stats,
    }
  }

  /**
   * Export to CSV format
   */
  exportToCSV(options = {}) {
    const filtered = this.packets.filter(p => {
      if (options.direction && p.direction !== options.direction) return false
      if (options.packetId !== undefined && p.id !== options.packetId) return false
      return true
    })

    let csv = 'Timestamp,Direction,PacketID,Size,Entropy\n'

    for (const packet of filtered) {
      csv += `${packet.timestamp},${packet.direction},0x${packet.id.toString(16).toUpperCase().padStart(2, '0')},${packet.size},${packet.hash}\n`
    }

    return csv
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    return {
      totalPackets: this.packets.length,
      captureTime: (Date.now() - this.startTime) / 1000,
      packetsPerSecond:
        this.packets.length / ((Date.now() - this.startTime) / 1000) || 0,
      statsByType: Object.entries(this.stats).map(([type, stat]) => ({
        type,
        count: stat.count,
        avgSize: Math.round(stat.avgSize),
        minSize: stat.minSize,
        maxSize: stat.maxSize,
        uniqueVariants: stat.hashes.size,
        entropy: stat.entropy.toFixed(2),
      })),
    }
  }

  /**
   * Find suspicious or anomalous packets
   */
  findAnomalies(options = {}) {
    const anomalies = []
    const threshold = options.entropyThreshold || 7.5

    for (const packet of this.packets) {
      const analysis = this.analyzePacket(packet)
      const entropy = this.calculateEntropy(packet.data)

      // High entropy suggests encryption or random data
      if (entropy > threshold) {
        anomalies.push({
          packet,
          reason: 'high_entropy',
          entropy,
        })
      }

      // Very small packets might be special commands
      if (packet.size < 2) {
        anomalies.push({
          packet,
          reason: 'very_small',
        })
      }

      // No recognized patterns
      if (analysis.varintCount === 0 && analysis.floatCount === 0 && analysis.stringCount === 0) {
        anomalies.push({
          packet,
          reason: 'no_patterns',
        })
      }
    }

    return anomalies
  }

  /**
   * Clear all captured data
   */
  clear() {
    this.packets = []
    this.stats = {}
    this.patterns.clear()
    this.startTime = Date.now()
  }

  /**
   * Get packets of specific type
   */
  getPackets(direction, packetId) {
    return this.packets.filter(
      p => p.direction === direction && p.id === packetId
    )
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PacketAnalyzer
}
