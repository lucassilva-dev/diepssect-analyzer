/**
 * Diep Packet Logger Enhancements
 * Adds automated packet analysis, filtering, and export capabilities
 *
 * This module extends the base diep-pl.user.js with:
 * - Real-time packet analysis using PacketAnalyzer
 * - Smart packet filtering
 * - Field change visualization
 * - Session export with metadata
 */

;(() => {
  // Wait for diep-pl to be ready
  if (!window.diepLog) {
    setTimeout(arguments.callee, 100)
    return
  }

  const ENHANCEMENTS_VERSION = '1.0.0'

  // PacketAnalyzer embedded (copy from scripts/packet-analyzer.js)
  class PacketAnalyzer {
    constructor(options = {}) {
      this.packets = []
      this.stats = {}
      this.patterns = new Map()
      this.startTime = Date.now()
      this.maxPackets = options.maxPackets || 10000
      this.autoAnalyze = options.autoAnalyze !== false
    }

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

    analyzePacket(packet) {
      const analysis = {
        varintCount: 0,
        floatCount: 0,
        stringCount: 0,
        nullBytes: 0,
      }

      const data = packet.data
      let i = 0

      while (i < data.length) {
        const byte = data[i]
        if (byte & 0x80) {
          analysis.varintCount++
          i++
          while (i < data.length && data[i] & 0x80) i++
          i++
        } else if (byte === 0 && i > 0) {
          analysis.stringCount++
          i++
        } else {
          if (byte === 0) analysis.nullBytes++
          i++
        }
      }

      return analysis
    }

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

    hashPacket(data) {
      let hash = 0
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash) + data[i]
        hash = hash & hash
      }
      return hash.toString(16)
    }

    getSummary() {
      return {
        totalPackets: this.packets.length,
        captureTime: (Date.now() - this.startTime) / 1000,
        statsByType: Object.entries(this.stats).map(([type, stat]) => ({
          type,
          count: stat.count,
          avgSize: Math.round(stat.avgSize),
          minSize: stat.minSize,
          maxSize: stat.maxSize,
        })),
      }
    }

    exportToJSON(options = {}) {
      const filtered = this.packets.filter(p => {
        if (options.direction && p.direction !== options.direction) return false
        if (options.packetId !== undefined && p.id !== options.packetId) return false
        return true
      })

      return {
        captureTime: new Date(this.startTime).toISOString(),
        totalPackets: this.packets.length,
        packets: filtered.map(p => ({
          id: p.id,
          direction: p.direction,
          size: p.size,
          timestamp: p.timestamp,
          data: Array.from(p.data),
        })),
      }
    }

    clear() {
      this.packets = []
      this.stats = {}
      this.startTime = Date.now()
    }
  }

  // Initialize analyzer
  const analyzer = new PacketAnalyzer()
  window.packetAnalyzer = analyzer

  // Hook into diep-pl's logging system
  const originalLog = window.diepLog
  window.diepLog = function(...args) {
    // Call original logger
    originalLog.apply(this, args)

    // Analyze packet if it's a capture event
    if (args[0] && typeof args[0] === 'object') {
      const packetData = args[0]
      if (packetData.data && packetData.direction) {
        analyzer.capturePacket(
          packetData.id || 0,
          packetData.data,
          packetData.direction,
          Date.now()
        )
      }
    }
  }

  // UI Enhancements
  const createAnalysisPanel = () => {
    const panel = document.createElement('div')
    panel.id = 'diep-analysis-panel'
    panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #00ff00;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid #00ff00;
      z-index: 10000;
      width: 300px;
    `

    const updatePanel = () => {
      const summary = analyzer.getSummary()
      let html = `<div><strong>Packet Analysis v${ENHANCEMENTS_VERSION}</strong></div>`
      html += `<div>Total: ${summary.totalPackets} packets</div>`
      html += `<div>Time: ${summary.captureTime.toFixed(1)}s</div>`
      html += `<div style="margin-top: 5px; border-top: 1px solid #00ff00;"><strong>By Type:</strong></div>`

      for (const stat of summary.statsByType.slice(0, 10)) {
        html += `<div>${stat.type}: ${stat.count} (${stat.avgSize}B avg)</div>`
      }

      html += `<div style="margin-top: 5px; border-top: 1px solid #00ff00; font-size: 11px;">
        <button style="padding: 2px 5px; background: #00ff00; color: black; border: none; cursor: pointer; width: 100%; margin-bottom: 2px;" id="export-btn">Export JSON</button>
        <button style="padding: 2px 5px; background: #00ff00; color: black; border: none; cursor: pointer; width: 100%; margin-bottom: 2px;" id="clear-btn">Clear</button>
        <button style="padding: 2px 5px; background: #00ff00; color: black; border: none; cursor: pointer; width: 100%;" id="toggle-panel">Collapse</button>
      </div>`

      panel.innerHTML = html

      document.getElementById('export-btn').onclick = () => {
        const json = analyzer.exportToJSON()
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `diep-packets-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
      }

      document.getElementById('clear-btn').onclick = () => {
        analyzer.clear()
        updatePanel()
      }

      document.getElementById('toggle-panel').onclick = () => {
        const statsDiv = panel.querySelector('[style*="border-top"]')
        if (statsDiv) {
          statsDiv.style.display = statsDiv.style.display === 'none' ? 'block' : 'none'
        }
      }
    }

    // Update panel every 500ms
    setInterval(updatePanel, 500)
    updatePanel()

    document.body.appendChild(panel)
    return panel
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Alt+A: Toggle analysis panel
    if (e.altKey && e.key === 'a') {
      e.preventDefault()
      const panel = document.getElementById('diep-analysis-panel')
      if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
      } else {
        createAnalysisPanel()
      }
    }

    // Alt+E: Export to JSON
    if (e.altKey && e.key === 'e') {
      e.preventDefault()
      const json = analyzer.exportToJSON()
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `diep-packets-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      console.log('Packet data exported')
    }

    // Alt+C: Clear captures
    if (e.altKey && e.key === 'c') {
      e.preventDefault()
      analyzer.clear()
      console.log('Packet analyzer cleared')
    }
  })

  // Initialize panel on load
  setTimeout(() => {
    createAnalysisPanel()
    console.log(`%cDiep Packet Logger Enhancements v${ENHANCEMENTS_VERSION} loaded`, 'color: #00ff00; font-weight: bold')
    console.log('Shortcuts: Alt+A (toggle panel), Alt+E (export), Alt+C (clear)')
  }, 1000)
})()
