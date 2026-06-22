/**
 * Packet Replay Tool for diep.io Protocol
 * Loads captured sessions and replays packets for testing
 */

class PacketReplayer {
  constructor(options = {}) {
    this.packets = []
    this.currentIndex = 0
    this.isPlaying = false
    this.playbackSpeed = options.playbackSpeed || 1.0
    this.injectedPackets = []
    this.metrics = {
      packetsReplayed: 0,
      packetsInjected: 0,
      totalDelay: 0,
    }
  }

  /**
   * Load captured packets from JSON file
   * @param {Array} packets - Array of captured packets
   */
  loadPackets(packets) {
    this.packets = packets
    this.currentIndex = 0

    console.log(`Loaded ${packets.length} packets`)
    console.log(`Duration: ${this.calculateDuration()}s`)

    return this
  }

  /**
   * Calculate total replay duration
   */
  calculateDuration() {
    if (this.packets.length < 2) return 0

    const first = this.packets[0].timestamp
    const last = this.packets[this.packets.length - 1].timestamp

    return (last - first) / 1000
  }

  /**
   * Start playback
   * @param {Function} onPacket - Callback for each packet
   * @param {number} startIndex - Start from packet index
   */
  async play(onPacket, startIndex = 0) {
    this.isPlaying = true
    this.currentIndex = startIndex

    const startTime = Date.now()
    const baseTime = this.packets[startIndex]?.timestamp || 0

    while (this.isPlaying && this.currentIndex < this.packets.length) {
      const packet = this.packets[this.currentIndex]
      const timeSinceStart = packet.timestamp - baseTime
      const elapsedTime = (Date.now() - startTime) * this.playbackSpeed

      // Wait until it's time to send this packet
      if (elapsedTime < timeSinceStart) {
        await this.sleep(10)
        continue
      }

      // Call callback with packet
      onPacket(packet)
      this.metrics.packetsReplayed++

      this.currentIndex++
    }

    this.isPlaying = false
    return this.metrics
  }

  /**
   * Pause playback
   */
  pause() {
    this.isPlaying = false
  }

  /**
   * Resume playback
   */
  resume(onPacket) {
    return this.play(onPacket, this.currentIndex)
  }

  /**
   * Stop and reset
   */
  stop() {
    this.isPlaying = false
    this.currentIndex = 0
  }

  /**
   * Inject a custom packet into the stream
   * @param {number} atIndex - Inject after this packet index
   * @param {Object} packet - Packet to inject
   */
  injectPacket(atIndex, packet) {
    // Adjust timing to fit in sequence
    if (atIndex < this.packets.length) {
      const prevPacket = this.packets[atIndex]
      const nextPacket = this.packets[atIndex + 1]

      packet.timestamp = (prevPacket.timestamp + nextPacket.timestamp) / 2
    }

    this.injectedPackets.push({
      originalIndex: atIndex,
      packet,
    })

    this.metrics.packetsInjected++
  }

  /**
   * A/B test: compare field values
   * @param {number} fieldIndex - Field to test
   * @param {Array} testValues - Values to test
   * @param {Function} getGameState - Callback to read game state
   */
  async abTest(fieldIndex, testValues, getGameState) {
    const testResults = []

    for (const value of testValues) {
      console.log(`\nTesting field ${fieldIndex} = ${value}`)

      // Capture baseline
      const baselineState = getGameState()

      // Create test packet with modified field
      const testPacket = this.createTestPacket(fieldIndex, value)

      // Play with injected packet
      const sessionResults = await this.playWithInjection(testPacket, getGameState)

      testResults.push({
        value,
        baselineState,
        results: sessionResults,
      })
    }

    return testResults
  }

  /**
   * Create a test packet with a specific field value
   */
  createTestPacket(fieldIndex, value) {
    // Simplified packet structure
    const packet = {
      id: 0x00,
      direction: 'clientbound',
      timestamp: Date.now(),
      data: new Uint8Array(50),
    }

    // Encode field index and value
    let offset = 0
    offset += this.encodeVarint(packet.data, offset, fieldIndex)
    offset += this.encodeVarint(packet.data, offset, value)

    packet.data = packet.data.slice(0, offset)
    return packet
  }

  /**
   * Encode a varint into buffer
   */
  encodeVarint(buffer, offset, value) {
    let bytesWritten = 0

    do {
      let byte = value & 0x7f
      value >>>= 7
      if (value !== 0) byte |= 0x80

      buffer[offset + bytesWritten] = byte
      bytesWritten++
    } while (value !== 0)

    return bytesWritten
  }

  /**
   * Play session with packet injection
   */
  async playWithInjection(injectedPacket, getGameState) {
    const results = {
      statesBeforeInjection: [],
      statesAfterInjection: [],
      injectionIndex: -1,
    }

    let injectionPoint = Math.floor(this.packets.length / 2)

    await this.play(packet => {
      // Record state before injection
      if (this.currentIndex === injectionPoint) {
        results.statesBeforeInjection.push(getGameState())
        results.injectionIndex = this.currentIndex
      }

      // Inject our packet
      if (this.currentIndex === injectionPoint + 1) {
        results.statesAfterInjection.push(getGameState())
      }
    })

    return results
  }

  /**
   * Get packet at index
   */
  getPacket(index) {
    return this.packets[index]
  }

  /**
   * Get current playback position
   */
  getProgress() {
    return {
      current: this.currentIndex,
      total: this.packets.length,
      percentage: (this.currentIndex / this.packets.length * 100).toFixed(1),
    }
  }

  /**
   * Find packets by criteria
   */
  filterPackets(criteria) {
    return this.packets.filter(packet => {
      if (criteria.id !== undefined && packet.id !== criteria.id) return false
      if (criteria.direction && packet.direction !== criteria.direction) return false
      if (criteria.minSize && packet.data.length < criteria.minSize) return false
      if (criteria.maxSize && packet.data.length > criteria.maxSize) return false
      return true
    })
  }

  /**
   * Export replay data
   */
  exportReplay(format = 'json') {
    if (format === 'json') {
      return {
        packets: this.packets,
        injectedPackets: this.injectedPackets,
        metrics: this.metrics,
        duration: this.calculateDuration(),
      }
    } else if (format === 'csv') {
      let csv = 'Index,Timestamp,PacketID,Size,Direction\n'

      for (let i = 0; i < this.packets.length; i++) {
        const p = this.packets[i]
        csv += `${i},${p.timestamp},0x${p.id.toString(16).padStart(2, '0')},${p.data.length},${p.direction}\n`
      }

      return csv
    }

    return {}
  }

  /**
   * Measure latency impact of injection
   */
  measureLatencyImpact(injectedPacket) {
    const results = {
      packetsBeforeInjection: 0,
      packetsAfterInjection: 0,
      delayedPackets: 0,
    }

    let injectionPoint = Math.floor(this.packets.length / 2)

    for (let i = 0; i < this.packets.length; i++) {
      if (i < injectionPoint) {
        results.packetsBeforeInjection++
      } else if (i > injectionPoint) {
        results.packetsAfterInjection++

        // Check if packet timing was affected
        const prev = this.packets[i - 1]
        const curr = this.packets[i]
        const expectedGap = 16.67 // ~60 FPS

        const actualGap = curr.timestamp - prev.timestamp
        if (Math.abs(actualGap - expectedGap) > 5) {
          results.delayedPackets++
        }
      }
    }

    return results
  }

  /**
   * Generate comparison report
   */
  generateComparisonReport(originalMetrics, testMetrics) {
    return {
      originalPackets: originalMetrics.packetsReplayed,
      testPackets: testMetrics.packetsReplayed,
      injectedPackets: testMetrics.packetsInjected,
      deltaDuration: testMetrics.totalDelay - originalMetrics.totalDelay,
    }
  }

  /**
   * Helper: Sleep for ms
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Clear all data
   */
  clear() {
    this.packets = []
    this.injectedPackets = []
    this.currentIndex = 0
    this.metrics = {
      packetsReplayed: 0,
      packetsInjected: 0,
      totalDelay: 0,
    }
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PacketReplayer
}
