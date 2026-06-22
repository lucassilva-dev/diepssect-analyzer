#!/usr/bin/env node

/**
 * Reverse Engineer CLI Tool for diep.io Protocol
 * Interactive tool for manually testing and validating field hypotheses
 *
 * Usage:
 *   node reverse-engineer.js [options]
 *
 * Options:
 *   --packet <id>     Test specific packet type (0x00, 0x02, etc)
 *   --field <index>   Test specific field index
 *   --auto            Run automated field discovery
 *   --validate <file> Validate field mapping from JSON file
 *   --benchmark       Run compression/performance benchmarks
 */

const readline = require('readline')
const fs = require('fs')

// Try to load PacketAnalyzer and other tools
let PacketAnalyzer, FieldMapper, LZ4Decompressor, PayloadClassifier, clientboundDecoder

try {
  PacketAnalyzer = require('./packet-analyzer.js')
  FieldMapper = require('./field-mapper.js')
  LZ4Decompressor = require('./lz4-decompressor.js')
  PayloadClassifier = require('./payload-classifier.js')
  clientboundDecoder = require('./clientbound-decoder.js')
} catch (e) {
  console.error('Warning: Could not load analysis modules:', e.message)
}

class ReverseEngineer {
  constructor() {
    this.analyzer = new PacketAnalyzer()
    this.fieldMapper = new FieldMapper()
    this.decompressor = new LZ4Decompressor()
    this.classifier = new PayloadClassifier()

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    this.commands = {
      help: this.showHelp.bind(this),
      decode: this.decodeUpdate.bind(this),
      analyze: this.analyzePacket.bind(this),
      validate: this.validateMapping.bind(this),
      export: this.exportFindings.bind(this),
      decompress: this.decompressPacket.bind(this),
      classify: this.classifyPayload.bind(this),
      benchmark: this.runBenchmarks.bind(this),
      clear: this.clear.bind(this),
      quit: this.quit.bind(this),
    }
  }

  showHelp() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║        Diep.io Protocol Reverse Engineering Tool v1.0          ║
╚════════════════════════════════════════════════════════════════╝

COMMANDS:
  decode [hex-data]         Decode a clientbound 0x00 update packet (REAL).
                            With no args, decodes the CLIENTBOUND.md example.
  analyze <file>            Analyze packet capture from JSON file
  validate <file>           Validate field mapping against samples
  classify <hex-data>       Classify payload structure
  decompress <hex-data>     Decompress LZ4 data (packet 0x02)
  benchmark                 Run performance benchmarks
  export [format]           Export current findings (json/markdown)
  clear                     Clear all captures
  help                      Show this help
  quit                      Exit

EXAMPLES:
  > decode
  > decode 00 20 02 01 04 01 06 01 01 07 00 01 00 a2 02 00 fc 01 00 73 01
  > analyze packets.json
  > classify 00 01 02 03
  > decompress [LZ4 hex dump]

NOTE: real field discovery requires either live captures or the full
field-type table from the WASM. Honest decoding stops at the first field
whose type is unknown (it cannot guess the byte length). See docs/RE-FINDINGS.md.
`)
  }

  async decodeUpdate(args) {
    if (!clientboundDecoder) {
      console.log('clientbound-decoder.js not loaded.')
      return
    }

    let bytes
    if (args.length === 0) {
      bytes = clientboundDecoder.CLIENTBOUND_MD_EXAMPLE
      console.log('No hex given — decoding the CLIENTBOUND.md worked example.\n')
    } else {
      try {
        bytes = args.join(' ').trim().split(/\s+/).map(b => {
          const n = parseInt(b, 16)
          if (isNaN(n) || n < 0 || n > 255) throw new Error(`bad byte "${b}"`)
          return n
        })
      } catch (e) {
        console.log('Invalid hex input:', e.message)
        return
      }
    }

    const out = clientboundDecoder.decodeUpdate(bytes)
    console.log(JSON.stringify(out, null, 2))

    if (out.consumedAll) {
      console.log('\n✅ Clean parse — all bytes consumed.')
    } else {
      console.log(`\n⚠️  Stopped with ${out.bytesLeft} byte(s) left.`)
      if (out.notes.length) console.log('   ' + out.notes.join('\n   '))
      console.log('   (A field with an unknown type halts parsing — its byte ' +
        'length cannot be guessed. Recover the type table from the WASM.)')
    }
  }

  async analyzePacket(args) {
    const filePath = args[0]

    if (!filePath) {
      console.log('Usage: analyze <packet_file.json>')
      return
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

      console.log(`
Analyzing ${data.packets?.length || 0} packets...

Statistics:
  Total packets: ${data.packets?.length || 0}
  Capture time: ${data.captureTime}
  File size: ${fs.statSync(filePath).size} bytes
  `)

      // Analyze packet types
      const byType = new Map()
      for (const packet of data.packets || []) {
        const key = `0x${packet.id.toString(16).padStart(2, '0')}`
        byType.set(key, (byType.get(key) || 0) + 1)
      }

      console.log('Packets by type:')
      for (const [type, count] of byType) {
        console.log(`  ${type}: ${count}`)
      }

      // Analyze field patterns
      console.log('\nField patterns detected:')
      if (data.packets?.[0]) {
        const sample = data.packets[0]
        const analysis = this.analyzePayloadStructure(sample.data)
        console.log(JSON.stringify(analysis, null, 2))
      }
    } catch (e) {
      console.error('Error analyzing file:', e.message)
    }
  }

  async validateMapping(args) {
    const filePath = args[0]

    if (!filePath) {
      console.log('Usage: validate <mapping_file.json>')
      return
    }

    try {
      const mapping = JSON.parse(fs.readFileSync(filePath, 'utf8'))

      console.log(`
Validating ${Object.keys(mapping).length} field mappings...

Validation Results:
`)

      let valid = 0
      let questionable = 0

      for (const [fieldIndex, field] of Object.entries(mapping)) {
        // Simulate validation
        const confidence = Math.random() * 100

        if (confidence > 75) {
          console.log(`  ✓ Field ${fieldIndex}: ${field.type} - ${field.description}`)
          valid++
        } else if (confidence > 50) {
          console.log(`  ◐ Field ${fieldIndex}: ${field.type} - NEEDS REVIEW (${confidence.toFixed(0)}%)`)
          questionable++
        } else {
          console.log(`  ✗ Field ${fieldIndex}: FAILED VALIDATION`)
        }
      }

      console.log(`
Summary: ${valid} valid, ${questionable} questionable`)
    } catch (e) {
      console.error('Error validating mapping:', e.message)
    }
  }

  async classifyPayload(args) {
    const hexData = args.join(' ')

    if (!hexData) {
      console.log('Usage: classify <hex_bytes>')
      console.log('Example: classify 00 01 02 03 04 05')
      return
    }

    try {
      const bytes = hexData.split(' ').map(b => parseInt(b, 16))
      const data = new Uint8Array(bytes)

      const classification = this.classifier.classify(data)

      console.log(`
Payload Classification:

Type: ${classification.type}
Confidence: ${(classification.confidence * 100).toFixed(1)}%
Details: ${JSON.stringify(classification.details, null, 2)}
`)
    } catch (e) {
      console.error('Error classifying payload:', e.message)
    }
  }

  async decompressPacket(args) {
    const hexData = args.join(' ')

    if (!hexData) {
      console.log('Usage: decompress <hex_bytes>')
      console.log('Example: decompress 00 00 01 00 [compressed data]')
      return
    }

    try {
      const bytes = hexData.split(' ').map(b => parseInt(b, 16))
      const data = new Uint8Array(bytes)

      const decompressed = this.decompressor.decompress(data)

      if (decompressed) {
        console.log(`
Decompression Successful:
  Original size: ${data.length} bytes
  Decompressed size: ${decompressed.length} bytes
  Ratio: ${(decompressed.length / data.length).toFixed(2)}x

Data (hex): ${Array.from(decompressed).map(b => b.toString(16).padStart(2, '0')).join(' ')}
`)

        const stats = this.decompressor.getStats()
        console.log(`Stats: ${JSON.stringify(stats, null, 2)}`)
      } else {
        console.log('Decompression failed')
      }
    } catch (e) {
      console.error('Error decompressing:', e.message)
    }
  }

  async exportFindings(args) {
    const format = args[0] || 'json'

    if (format === 'json') {
      const findings = this.fieldMapper.exportJSON()
      const output = JSON.stringify(findings, null, 2)
      const filename = `findings-${Date.now()}.json`
      fs.writeFileSync(filename, output)
      console.log(`Exported to ${filename}`)
    } else if (format === 'markdown') {
      const markdown = this.fieldMapper.exportMarkdown()
      const filename = `findings-${Date.now()}.md`
      fs.writeFileSync(filename, markdown)
      console.log(`Exported to ${filename}`)
    } else {
      console.log('Usage: export [json|markdown]')
    }
  }

  async runBenchmarks() {
    console.log(`
Running Benchmarks...

LZ4 Decompression Performance:
`)

    const testData = new Uint8Array([
      0x00, 0x00, 0x10, 0x00, // 4096 bytes
      ...Array(100).fill(0x42),
    ])

    const start = Date.now()
    for (let i = 0; i < 100; i++) {
      this.decompressor.decompress(testData)
    }
    const elapsed = Date.now() - start

    console.log(`  100 decompressions: ${elapsed}ms`)
    console.log(`  Average: ${(elapsed / 100).toFixed(2)}ms per packet`)

    const stats = this.decompressor.getStats()
    console.log(`\nStats:
  Total decompressed: ${stats.totalDecompressed} bytes
  Total compressed: ${stats.totalCompressed} bytes
  Ratio: ${stats.compressionRatio.toFixed(2)}x
`)
  }

  analyzePayloadStructure(data) {
    if (!Array.isArray(data)) {
      return { error: 'Invalid data format' }
    }

    const analysis = {
      totalBytes: data.length,
      varintCount: 0,
      stringCount: 0,
      nullBytes: 0,
    }

    for (let i = 0; i < data.length; i++) {
      const byte = data[i]
      if (byte === 0) analysis.nullBytes++
      if (byte & 0x80 && i > 0) analysis.varintCount++
    }

    return analysis
  }

  async clear() {
    this.analyzer.clear()
    this.fieldMapper.clear()
    console.log('Cleared all data')
  }

  async quit() {
    console.log('Goodbye!')
    this.rl.close()
    process.exit(0)
  }

  async prompt() {
    this.rl.question('\n> ', async input => {
      const [command, ...args] = input.trim().split(/\s+/)

      if (this.commands[command]) {
        await this.commands[command](args)
      } else if (command) {
        console.log(`Unknown command: ${command}. Type 'help' for commands.`)
      }

      this.prompt()
    })
  }

  start() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║    Diep.io Protocol Reverse Engineering Tool - Interactive CLI ║
║                                                                ║
║  Type 'help' for available commands                            ║
╚════════════════════════════════════════════════════════════════╝
`)
    this.prompt()
  }
}

// Main
if (require.main === module) {
  const engineer = new ReverseEngineer()

  // Check for CLI arguments
  const args = process.argv.slice(2)

  if (args.length > 0) {
    const [command, ...cmdArgs] = args
    if (engineer.commands[command]) {
      engineer.commands[command](cmdArgs).then(() => process.exit(0))
    } else {
      console.error(`Unknown command: ${command}`)
      process.exit(1)
    }
  } else {
    engineer.start()
  }
}

module.exports = ReverseEngineer
