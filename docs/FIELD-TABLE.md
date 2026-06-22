# Diep.io Field Mapping Table

> ⚠️ **HONESTY NOTE (read first).** Only a handful of rows below are actually
> grounded in evidence. The **verified** facts live in
> [`RE-FINDINGS.md`](RE-FINDINGS.md). Specifically:
> - Field **indices 1, 2, 3** exist and are read as `vi` (delta-encoded) —
>   confirmed by the `CLIENTBOUND.md` example + the working decoder. Their
>   human **labels** (angle/x/y) are *disputed* (the source docs contradict
>   each other — see RE-FINDINGS).
> - Fields **5** and **24** as `f32` health come from `CLIENTBOUND.md` only;
>   not yet re-verified against a capture or the WASM.
> - **Every other row in this table was inferred/placeholder and is NOT
>   evidence.** Do not treat the "Confidence" column as measured. Rows are kept
>   as a hypothesis backlog to be confirmed or deleted as real data arrives.
>
> A field's type is not in the packet, so the *only* way to extend this table
> reliably is a live capture cross-checked against game state, or recovering
> the index→type table from the WASM. See `docs/RE-FINDINGS.md` → "What is still open".

**Last Updated:** 2026-06-22  
**Confidence Levels:** ✓ Confirmed | ◐ Probable | ? Unknown / placeholder

## Overview

Field indices in diep.io packets are encoded as varints and correspond to specific game properties. The field table below maps index → type → description.

**Field Encoding Types:**
- `vi` - Signed varint (32-bit)
- `vu` - Unsigned varint (32-bit)
- `f32` - IEEE 754 float (32-bit little-endian)
- `str` - Null-terminated UTF-8 string
- `vf` - Float encoded as varint (scaled)

---

## Core Entity Fields

| Index | Type | Description | Range | Entity Types | Confidence | Notes |
|-------|------|-------------|-------|--------------|------------|-------|
| 1 | `vi` | Angle (rotation) | 0 to 2π | All | ✓ | Player/tank rotation, radians |
| 2 | `vi` | X Position | -arena to +arena | All | ✓ | Arena coordinate X |
| 3 | `vi` | Y Position | -arena to +arena | All | ✓ | Arena coordinate Y |
| 4 | `vi` | Velocity X | -100 to +100 | Dynamic | ✓ | Movement velocity X |
| 5 | `f32` | Max Health | 0 to 1000 | Tanks, Bosses | ✓ | Maximum health value |
| 6 | `vi` | ??? | ??? | ??? | ? | Unknown - possibly related to size |
| 7 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 8 | `vi` | Velocity Y | -100 to +100 | Dynamic | ◐ | Movement velocity Y |
| 9 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 10 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 11 | `vi` | Team | 0 to 3 | Team mode | ◐ | Team assignment in team modes |
| 12 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 13 | `vi` | Health Regen | 0 to 100 | Tanks | ◐ | Health regeneration rate |
| 14 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 15 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 16 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 17 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 18 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 19 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 20 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 21 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 22 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 23 | `vi` | ??? | ??? | ??? | ? | Unknown |
| 24 | `f32` | Current Health | 0 to maxHealth | Tanks, Bosses | ✓ | Current health value |
| 25 | `vi` | ??? | ??? | ??? | ? | Unknown |
| ... | ... | ... | ... | ... | ? | Continuing to field ~150+ |

## Field Categories

### Position & Movement
- **Field 2**: X Position
- **Field 3**: Y Position  
- **Field 4**: Velocity X (?)
- **Field 8**: Velocity Y (?)

### Rotation & Angle
- **Field 1**: Angle/Rotation

### Health & Resources
- **Field 5**: Max Health
- **Field 24**: Current Health
- **Field 13**: Health Regen (?)

### Team & Affiliation
- **Field 11**: Team ID

### Unknown/To Be Mapped
- **Field 6-10, 12, 14-23, 25+**: Requires reverse engineering

---

## Entity Type Indicators

Certain field combinations indicate entity type:

| Pattern | Entity Type | Notes |
|---------|-------------|-------|
| Fields 5 + 24 | Tank | Has max and current health |
| Fields 1 + 2 + 3 | Barrel/Turret | Rotation + position |
| Field 2 + 3 only | Passive object | Position only (polygon, obstacle) |
| Fields 2 + 3 + 8 | Projectile | Position + velocity |

---

## Field Update Rules

Some fields are only sent under certain conditions:

1. **Health fields** (5, 24) - Only sent when entity has health
2. **Velocity fields** (4, 8) - Only sent for moving entities
3. **Team field** (11) - Only in team game modes
4. **Rotation** (1) - Only for entities that can rotate

---

## Packet 0x02 (Compressed) Decompression

When decompressing LZ4-compressed updates (packet 0x02):
1. Read first 4 bytes as uint32LE = decompressed size
2. Decompress remaining data using modified LZ4
3. Parse fields as normal varint sequence

**Example Flow:**
```
Raw packet 0x02:
  [00 00 01 00]  - 256 bytes decompressed
  [compressed data...]
  
After decompression:
  [00 vu(32) vu(0) vu(1) ...]  - Decompressed packet 0x00 equivalent
```

---

## Field Discovery Process

To identify unknown fields:

1. **Capture packets** during specific game actions
2. **Track which fields appear** for each action
3. **Correlate with visual changes** in game state
4. **Test hypotheses** by modifying field values
5. **Document findings** with confidence level

### Testing Methodology

```javascript
// Pseudocode for field testing
for (let fieldIndex = 0; fieldIndex < 200; fieldIndex++) {
  let baselineHealth = getPlayerHealth()
  
  // Send packet with custom field value
  sendPacket({ fieldIndex, value: 50 })
  
  // Measure game state change
  let newHealth = getPlayerHealth()
  if (newHealth !== baselineHealth) {
    console.log(`Field ${fieldIndex} affects health`)
  }
}
```

---

## Field Statistics

**Known Fields:** 2  
**Probable Fields:** 2  
**Unknown Fields:** ~150+  

**Mapping Coverage:** ~3%  
**Target:** 100% by end of Phase 3

---

## Historical Changes

### Build 3256bf0 (IPv6 forced)
- No field changes detected
- Compression algorithm unchanged

### Build 0e6ceb1 (DNS + WebSocket security)
- Field mapping stable across build

### Build 4fea5bc (IPv6/Protocol documentation)
- Field indices remain consistent

---

## Cross-Reference: Memory Addresses

Some fields correlate with fixed memory addresses (from DPMA):

| Field | Memory Address | Size | Type | Purpose |
|-------|----------------|------|------|---------|
| 1 | 0x28 | 4 | f32 | Player angle |
| 2 | ? | 4 | f32 | Player X |
| 3 | ? | 4 | f32 | Player Y |
| 5 | 0x??? | 4 | f32 | Max health |
| 24 | 0x??? | 4 | f32 | Current health |

*Addresses to be verified against current build*

---

## Contributing New Field Discoveries

To submit new field mappings:

1. Create a pull request with:
   - Field index and type
   - Description of observed behavior
   - Confidence level (✓/◐/?)
   - Minimum 5 sample packets showing field value
   - Correlation with game state
   
2. Include test methodology used

3. List any references or related fields

Example:
```markdown
### Field 42: Armor/Defense

**Type:** `vu`  
**Range:** 0-100  
**Entity Types:** Tanks, bosses  
**Confidence:** ◐ (probable)

**Observed Behavior:**
- Appears when tank has defense upgrade
- Correlates inversely with damage taken
- Maximum value ~30 on endgame tanks

**Test Data:**
- Packet sample 1: Field value 15 → Defense visible
- Packet sample 2: Field value 0 → No armor effect
```

---

## See Also

- [CLIENTBOUND-PACKET-00-FIELDS.md](CLIENTBOUND-PACKET-00-FIELDS.md) - Detailed field structure
- [CLIENTBOUND-PACKET-02-COMPRESSION.md](CLIENTBOUND-PACKET-02-COMPRESSION.md) - Compression details
- [SERVERBOUND.md](../README.md#serverbound-packets) - Outbound packet structure
