# Diepssect Enhanced Tools Guide

## Overview

This guide covers the new analysis, validation, and reverse engineering tools added to diepssect. These tools automate protocol discovery and field mapping.

**Version:** 1.0  
**Date:** 2026-06-22  
**Status:** Beta (Phase 1-3 tools complete, Phase 4 tools functional)

---

## Quick Start

### Phase 1: Core Analysis Tools

#### 1. PacketAnalyzer (`scripts/packet-analyzer.js`)

Captures and analyzes WebSocket packets in real-time.

**Node.js Usage:**
```javascript
const PacketAnalyzer = require('./scripts/packet-analyzer.js');

const analyzer = new PacketAnalyzer({ maxPackets: 5000 });

// Capture packets
analyzer.capturePacket(0x00, packetData, 'clientbound', Date.now());

// Get statistics
const summary = analyzer.getSummary();
console.log(summary);

// Export data
const json = analyzer.exportToJSON({ direction: 'clientbound', packetId: 0x00 });
```

**Browser Usage (via diep-pl enhancements):**
```javascript
// Automatically available as window.packetAnalyzer
window.packetAnalyzer.getSummary();
window.packetAnalyzer.exportToJSON();
```

#### 2. FieldMapper (`scripts/field-mapper.js`)

Automatically correlates packet fields with game properties.

**Usage:**
```javascript
const FieldMapper = require('./scripts/field-mapper.js');

const mapper = new FieldMapper();

// Register known fields
mapper.registerField(1, 'vi', 'Angle/Rotation', { min: 0, max: Math.PI * 2 });
mapper.registerField(2, 'vi', 'X Position', { min: -10000, max: 10000 });

// Record field changes
mapper.recordDelta(1, 0.5, 0.7, { entityId: 1 });

// Export findings
const markdown = mapper.exportMarkdown();
```

#### 3. LZ4Decompressor (`scripts/lz4-decompressor.js`)

Decompresses packet 0x02 (compressed updates).

**Usage:**
```javascript
const LZ4Decompressor = require('./scripts/lz4-decompressor.js');

const decompressor = new LZ4Decompressor();

// Decompress packet 0x02 data
const compressedData = new Uint8Array([
  0x00, 0x00, 0x01, 0x00,  // Size = 256 bytes
  // ... compressed data
]);

const decompressed = decompressor.decompress(compressedData);
console.log(decompressed);  // Decompressed Uint8Array

// Get stats
console.log(decompressor.getStats());
```

**Analysis:**
```javascript
// Analyze compression ratio
const ratio = decompressor.analyzeCompressionRatio(someData);
console.log(`Compression ratio: ${ratio.toFixed(2)}x`);

// Extract token patterns
const patterns = decompressor.analyzeTokenPatterns(compressedData);
console.log(patterns);
```

#### 4. PayloadClassifier (`scripts/payload-classifier.js`)

Detects packet structure patterns automatically.

**Usage:**
```javascript
const PayloadClassifier = require('./scripts/payload-classifier.js');

const classifier = new PayloadClassifier();

// Classify a payload
const result = classifier.classify(packetData);
console.log(result);
// Output: { type: 'varint_sequence', confidence: 0.85, details: {...} }
```

---

### Phase 2: Enhanced Userscripts

#### Enhanced Diep-PL (`userscripts/diep-pl-enhancements.js`)

Adds automated analysis to the packet logger.

**Installation:**
1. Copy `diep-pl-enhancements.js` to your userscripts folder
2. Install in Tampermonkey alongside `diep-pl.user.js`
3. Both scripts work together (load both)

**Features:**
- Real-time packet statistics panel
- Automatic packet type detection
- JSON export of captures
- Keyboard shortcuts for analysis

**Keyboard Shortcuts:**
- `Alt+A` - Toggle analysis panel
- `Alt+E` - Export captured packets to JSON
- `Alt+C` - Clear captures
- `Alt+Z` - Dump to console (original diep-pl)

**Exported API:**
```javascript
// Access analyzer from console
window.packetAnalyzer.getSummary()
window.packetAnalyzer.exportToJSON()
window.packetAnalyzer.clear()
```

---

### Phase 3: Reverse Engineering

#### Reverse Engineer CLI (`scripts/reverse-engineer.js`)

Interactive command-line tool for protocol analysis.

**Installation:**
```bash
npm install  # Ensure Node.js dependencies
chmod +x scripts/reverse-engineer.js
```

**Interactive Mode:**
```bash
node scripts/reverse-engineer.js
```

Then use commands:
```
> help                    # Show all commands
> test 24                 # Test field 24
> auto 50                 # Auto-discover first 50 fields
> analyze packets.json    # Load and analyze captured data
> classify 00 01 02 03    # Classify payload structure
> decompress [hex data]   # Decompress LZ4 data
> export json             # Export findings
> quit                    # Exit
```

**Programmatic Usage:**
```javascript
const ReverseEngineer = require('./scripts/reverse-engineer.js');

const re = new ReverseEngineer();

// Test a field
await re.testField(24);

// Run auto-discovery
await re.autoDiscoverFields(100);

// Export findings
re.exportFindings('markdown');
```

#### Documentation Files

**FIELD-TABLE.md** - Master field reference
- All known fields indexed
- Type and range information
- Entity type indicators
- Field discovery methodology

**CLIENTBOUND-PACKET-02-COMPRESSION.md** - LZ4 Compression Details
- Modified LZ4 format specification
- Decompression algorithm walkthrough
- Performance characteristics
- Testing vectors

---

### Phase 4: Validation & Automation

#### Field Validator (`scripts/field-validator.js`)

Automatically validates field mappings.

**Usage:**
```javascript
const FieldValidator = require('./scripts/field-validator.js');

const validator = new FieldValidator();

// Test a single field
const result = await validator.testField(24);

// Validate health fields
const healthResults = await validator.validateHealthFields();

// Validate position fields
const positionResults = await validator.validatePositionFields();

// Generate full report
const report = await validator.generateValidationReport({
  1: { type: 'vi', description: 'Angle' },
  2: { type: 'vi', description: 'X Position' },
  24: { type: 'f32', description: 'Current Health' }
});

console.log(report);
```

#### Packet Replayer (`scripts/packet-replay.js`)

Replays captured sessions for deterministic testing.

**Usage:**
```javascript
const PacketReplayer = require('./scripts/packet-replay.js');

const replayer = new PacketReplayer({ playbackSpeed: 1.0 });

// Load captured packets
replayer.loadPackets(capturedPackets);

// Play through them
await replayer.play(packet => {
  console.log(`Playing packet: ${packet.id}`);
});

// A/B test field values
const testResults = await replayer.abTest(24, [50, 100, 200], () => {
  return {
    health: getPlayerHealth(),
    position: getPlayerPosition()
  };
});

// Inject custom packets
replayer.injectPacket(50, customPacket);

// Export comparison
console.log(replayer.exportReplay('csv'));
```

---

## Workflow Examples

### Example 1: Discover Unknown Field

```bash
# Step 1: Capture packets in-game
# - Use Tampermonkey with diep-pl.user.js + enhancements
# - Alt+E to export captures
# - Save as packets.json

# Step 2: Analyze structure
node scripts/reverse-engineer.js
> analyze packets.json

# Step 3: Test hypothesis for field 42
> test 42

# Step 4: Run automated discovery
> auto 100

# Step 5: Export findings
> export markdown

# Result: findings-<timestamp>.md with all discoveries
```

### Example 2: Validate Health Field Mapping

```javascript
const FieldValidator = require('./scripts/field-validator.js');
const validator = new FieldValidator();

// Test health field #24
const result = await validator.testFieldRangeConstraint(
  24,  // Field index
  { min: 0, max: 1000 }  // Expected range
);

if (result.respectsRange) {
  console.log('✓ Field 24 is valid health field');
} else {
  console.log('✗ Field 24 failed validation');
}
```

### Example 3: Decompress and Analyze Packet 0x02

```javascript
const LZ4Decompressor = require('./scripts/lz4-decompressor.js');
const PayloadClassifier = require('./scripts/payload-classifier.js');

const decompressor = new LZ4Decompressor();
const classifier = new PayloadClassifier();

// Decompress the captured packet
const compressed = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x00, ...]);
const decompressed = decompressor.decompress(compressed.slice(1));

// Analyze the decompressed structure
const classification = classifier.classify(decompressed);
console.log(`Packet type: ${classification.type}`);
console.log(`Confidence: ${(classification.confidence * 100).toFixed(1)}%`);

// Get compression stats
const stats = decompressor.getStats();
console.log(`Compression ratio: ${stats.compressionRatio.toFixed(2)}x`);
```

### Example 4: Replay Session with Field Injection

```javascript
const PacketReplayer = require('./scripts/packet-replay.js');

const replayer = new PacketReplayer();
replayer.loadPackets(loadedPackets);

// Inject a test packet at position 50
const testPacket = {
  id: 0x00,
  direction: 'clientbound',
  timestamp: Date.now(),
  data: new Uint8Array([
    0x18, 0x64,  // Field 24 (health) = 100
  ])
};

replayer.injectPacket(50, testPacket);

// Play with injection and measure impact
await replayer.play(packet => {
  // Process each packet
  sendToGameEngine(packet);
});

const metrics = replayer.metrics;
console.log(`Replayed ${metrics.packetsReplayed} packets`);
console.log(`Injected ${metrics.packetsInjected} test packets`);
```

---

## Integration with Existing Tools

### With DPMA

The PacketAnalyzer and FieldMapper integrate with DPMA's memory reader:

```javascript
// In DPMA, access the analyzer
window.packetAnalyzer.getSummary()

// Cross-reference memory addresses with packet fields
const memoryAddress = 0x28;  // From DPMA hexedit
const fieldIndex = findFieldForMemory(memoryAddress);  // Maps to field 1
```

### With Diep-PL

Enhancement adds real-time analysis overlay:

```javascript
// Original diep-pl functions still available
window.diepLog(packetData);

// New enhancement adds:
window.packetAnalyzer (global)
Automatic packet capture via hooks
```

### With Bot Framework

Bot can use reverse engineer CLI for testing:

```bash
# From bot-error.js or coder.js
node scripts/reverse-engineer.js --auto 50
```

---

## File Locations

```
scripts/
  ├── packet-analyzer.js          (Phase 1)
  ├── field-mapper.js             (Phase 1)
  ├── lz4-decompressor.js         (Phase 1)
  ├── payload-classifier.js       (Phase 1)
  ├── reverse-engineer.js         (Phase 3)
  ├── field-validator.js          (Phase 4)
  └── packet-replay.js            (Phase 4)

userscripts/
  ├── diep-pl.user.js             (existing)
  └── diep-pl-enhancements.js     (new - Phase 2)

docs/
  ├── FIELD-TABLE.md              (Phase 3)
  ├── CLIENTBOUND-PACKET-02-COMPRESSION.md  (Phase 3)
  ├── CLIENTBOUND.md              (existing)
  └── [other docs]
```

---

## Performance Notes

### Typical Performance

- **PacketAnalyzer:** 10,000 packets = ~5MB memory, <100ms summary
- **LZ4 Decompression:** ~50MB/s, 0.2-0.5ms per packet
- **PayloadClassifier:** <1ms classification
- **FieldValidator:** 5-30 seconds per field test

### Memory Usage

- **1000 packets:** ~1-2MB
- **10000 packets:** ~10-20MB
- **Max recommended:** 100,000 packets (~100-200MB)

Use `analyzer.clear()` to reset if memory grows too large.

---

## Troubleshooting

### LZ4 Decompression Fails

**Problem:** "Not enough data for size header"  
**Solution:** Ensure first 4 bytes are the uint32LE size header

**Problem:** "Block size too large"  
**Solution:** Size header exceeds 10MB - may be corrupted packet

### Field Validation Shows Low Confidence

**Problem:** Field tests return <50% confidence  
**Solution:**
1. Check field index is correct (use `test` command first)
2. Ensure test values are in valid range
3. Try different test methodology

### Packet Replay Timing Issues

**Problem:** Packets replay too fast/slow  
**Solution:** Adjust `playbackSpeed` option:
```javascript
const replayer = new PacketReplayer({ playbackSpeed: 0.5 }); // 2x slower
```

---

## Contributing

To add new discoveries to FIELD-TABLE.md:

1. Use reverse-engineer.js to test field
2. Confirm findings with at least 5 samples
3. Submit PR with:
   - Field index
   - Type (vi/vu/f32/str)
   - Description
   - Confidence level
   - Sample packets (hex)
   - Test methodology

---

## References

- [LZ4 Specification](https://github.com/lz4/lz4/blob/master/doc/)
- [Varint Encoding](https://developers.google.com/protocol-buffers/docs/encoding#varints)
- Original CLIENTBOUND.md documentation
- Diep.io game source analysis

---

## Future Enhancements

**Phase 5 (Planned):**
- Continuous monitoring daemon
- Version auto-patching for bot
- Machine learning field prediction
- WebGL visualization of packet data
- Multiplayer packet correlation

---

**Questions?** Check individual tool files for detailed comments and examples.
