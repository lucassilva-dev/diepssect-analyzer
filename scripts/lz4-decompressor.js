/**
 * LZ4 Decompressor for diep.io Protocol
 * Handles modified LZ4 compression used in packet 0x02
 * Based on LZ4 reference implementation with diep.io specific adaptations
 */

class LZ4Decompressor {
  constructor(options = {}) {
    this.minMatchLength = options.minMatchLength || 4
    this.minCompressedSize = options.minCompressedSize || 20
    this.stats = {
      totalDecompressed: 0,
      totalCompressed: 0,
      compressionRatio: 0,
      tokensProcessed: 0,
    }
  }

  /**
   * Decompress LZ4 data (diep.io variant without magic number)
   * @param {Uint8Array} compressed - Compressed data (excluding header)
   * @returns {Uint8Array} - Decompressed data or null if decompression fails
   */
  decompress(compressed) {
    if (!compressed || compressed.length < this.minCompressedSize) {
      return null
    }

    try {
      // diep.io LZ4 format: no magic number, proceeds directly with blocks
      const decompressed = this.decompressBlocks(compressed, 0)
      return decompressed
    } catch (e) {
      console.error('LZ4 decompression failed:', e.message)
      return null
    }
  }

  /**
   * Decompress LZ4 blocks
   */
  decompressBlocks(data, startOffset) {
    const output = []
    let offset = startOffset
    let blockSize = 0

    // First 4 bytes after header: decompressed block size (little-endian)
    if (offset + 4 > data.length) {
      throw new Error('Not enough data for size header')
    }

    blockSize = this.readUint32LE(data, offset)
    offset += 4

    // Sanity check
    if (blockSize > 10000000) {
      // 10MB limit
      throw new Error('Block size too large: ' + blockSize)
    }

    // Decompress single block
    const decompressed = this.decompressBlock(data, offset, blockSize)

    if (decompressed) {
      this.stats.totalDecompressed += decompressed.length
      this.stats.totalCompressed += offset
      this.stats.compressionRatio = this.stats.totalDecompressed / this.stats.totalCompressed
    }

    return decompressed
  }

  /**
   * Decompress a single LZ4 block
   */
  decompressBlock(data, offset, expectedSize) {
    const output = []
    let inputOffset = offset

    while (inputOffset < data.length) {
      if (output.length >= expectedSize) {
        break
      }

      // Read token byte
      const token = data[inputOffset++]
      if (inputOffset > data.length) break

      // Token: upper 4 bits = literal length, lower 4 bits = match length
      const literalLength = (token >> 4) & 0x0f
      const matchLength = token & 0x0f

      // Handle extended literal length
      let extLiterals = literalLength
      if (literalLength === 15) {
        while (inputOffset < data.length) {
          const byte = data[inputOffset++]
          extLiterals += byte
          if (byte !== 255) break
        }
      }

      // Copy literals
      for (let i = 0; i < extLiterals; i++) {
        if (inputOffset >= data.length) {
          throw new Error('Unexpected end of input during literal copy')
        }
        output.push(data[inputOffset++])
      }

      // If matchLength is 0, this is the last token
      if (matchLength === 0 && extLiterals < 15) {
        break
      }

      // Skip if we're at end
      if (inputOffset + 2 > data.length) {
        if (matchLength === 0) break
        throw new Error('Not enough data for offset')
      }

      // Read offset (little-endian, 2 bytes)
      const offset16 = this.readUint16LE(data, inputOffset)
      inputOffset += 2

      // Handle extended match length
      let extMatch = matchLength
      if (matchLength === 15) {
        while (inputOffset < data.length) {
          const byte = data[inputOffset++]
          extMatch += byte
          if (byte !== 255) break
        }
      }

      // Add minimum match length
      const matchLen = extMatch + 4

      // Copy from previous data (back reference)
      if (offset16 === 0) {
        throw new Error('Invalid offset (0)')
      }

      const matchOffset = output.length - offset16
      if (matchOffset < 0) {
        throw new Error('Match offset is before output start')
      }

      for (let i = 0; i < matchLen; i++) {
        output.push(output[matchOffset + i])
      }

      this.stats.tokensProcessed++
    }

    // Convert to Uint8Array
    return new Uint8Array(output)
  }

  /**
   * Compress data using simplified LZ4
   * @param {Uint8Array} data - Data to compress
   * @returns {Uint8Array} - Compressed data
   */
  compress(data) {
    const output = []
    const sizeBuffer = new Uint8Array(4)
    this.writeUint32LE(sizeBuffer, 0, data.length)
    for (let i = 0; i < 4; i++) {
      output.push(sizeBuffer[i])
    }

    let inputOffset = 0

    while (inputOffset < data.length) {
      // Find best match
      const match = this.findBestMatch(data, inputOffset)

      if (match && match.length >= this.minMatchLength) {
        // Literal before match
        const literalLength = match.start - inputOffset
        const matchLength = match.length - this.minMatchLength

        // Write token
        let token = 0
        let literalLen = literalLength
        if (literalLen < 15) {
          token |= literalLen << 4
        } else {
          token |= 0xf0
        }

        if (matchLength < 15) {
          token |= matchLength
        } else {
          token |= 0x0f
        }

        output.push(token)

        // Write extended literal length
        if (literalLength >= 15) {
          let len = literalLength - 15
          while (len >= 255) {
            output.push(255)
            len -= 255
          }
          output.push(len)
        }

        // Write literals
        for (let i = 0; i < literalLength; i++) {
          output.push(data[inputOffset + i])
        }

        // Write offset
        const offset = inputOffset - match.start
        this.writeUint16LE(new Uint8Array(output.buffer, output.length), 0, offset)
        output.push((offset & 0xff))
        output.push((offset >> 8) & 0xff)

        // Write extended match length
        if (matchLength >= 15) {
          let len = matchLength - 15
          while (len >= 255) {
            output.push(255)
            len -= 255
          }
          output.push(len)
        }

        inputOffset = match.start + match.length
      } else {
        // No good match found
        const literalLength = Math.min(data.length - inputOffset, 100)
        const token = (literalLength < 15) ? literalLength << 4 : 0xf0

        output.push(token)

        if (literalLength >= 15) {
          let len = literalLength - 15
          while (len >= 255) {
            output.push(255)
            len -= 255
          }
          output.push(len)
        }

        for (let i = 0; i < literalLength; i++) {
          output.push(data[inputOffset + i])
        }

        inputOffset += literalLength
      }
    }

    // Write final token
    output.push(0x00)

    return new Uint8Array(output)
  }

  /**
   * Find best match for position in data
   */
  findBestMatch(data, position) {
    let bestMatch = null
    const maxDistance = 65535 // Max offset (16-bit)
    const maxLength = Math.min(data.length - position, 273) // Max match length

    const searchStart = Math.max(0, position - maxDistance)

    for (let i = searchStart; i < position; i++) {
      let length = 0
      while (
        length < maxLength &&
        position + length < data.length &&
        data[i + length] === data[position + length]
      ) {
        length++
      }

      if (length >= this.minMatchLength) {
        if (!bestMatch || length > bestMatch.length) {
          bestMatch = { start: i, length }
        }
      }
    }

    return bestMatch
  }

  /**
   * Analyze compression ratio
   */
  analyzeCompressionRatio(data) {
    if (data.length === 0) return 0
    const compressed = this.compress(data)
    return compressed.length / data.length
  }

  /**
   * Extract token patterns from compressed data
   */
  analyzeTokenPatterns(data) {
    const patterns = {
      literalTokens: 0,
      matchTokens: 0,
      avgLiteralSize: 0,
      avgMatchSize: 0,
    }

    let offset = 4 // Skip size header
    let totalLiterals = 0
    let totalMatches = 0
    let literalCount = 0
    let matchCount = 0

    while (offset < data.length) {
      const token = data[offset++]
      const literalLength = (token >> 4) & 0x0f
      const matchLength = token & 0x0f

      totalLiterals += literalLength
      literalCount++

      if (literalLength === 15) {
        while (offset < data.length && data[offset] === 255) {
          offset++
          totalLiterals += 255
        }
        if (offset < data.length) {
          totalLiterals += data[offset++]
        }
      }

      offset += literalLength

      if (matchLength > 0 || token === 0) {
        if (offset + 2 <= data.length) {
          offset += 2 // Skip offset

          totalMatches += matchLength + 4
          matchCount++

          if (matchLength === 15) {
            while (offset < data.length && data[offset] === 255) {
              offset++
              totalMatches += 255
            }
            if (offset < data.length) {
              totalMatches += data[offset++]
            }
          }
        }
      }
    }

    patterns.literalTokens = literalCount
    patterns.matchTokens = matchCount
    patterns.avgLiteralSize = literalCount > 0 ? totalLiterals / literalCount : 0
    patterns.avgMatchSize = matchCount > 0 ? totalMatches / matchCount : 0

    return patterns
  }

  /**
   * Get decompression statistics
   */
  getStats() {
    return {
      ...this.stats,
      avgLiterals: this.stats.tokensProcessed > 0
        ? this.stats.totalDecompressed / this.stats.tokensProcessed
        : 0,
    }
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalDecompressed: 0,
      totalCompressed: 0,
      compressionRatio: 0,
      tokensProcessed: 0,
    }
  }

  /**
   * Helper: Read uint32 little-endian
   */
  readUint32LE(data, offset) {
    return (
      data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)
    )
  }

  /**
   * Helper: Write uint32 little-endian
   */
  writeUint32LE(data, offset, value) {
    data[offset] = value & 0xff
    data[offset + 1] = (value >> 8) & 0xff
    data[offset + 2] = (value >> 16) & 0xff
    data[offset + 3] = (value >> 24) & 0xff
  }

  /**
   * Helper: Read uint16 little-endian
   */
  readUint16LE(data, offset) {
    return data[offset] | (data[offset + 1] << 8)
  }

  /**
   * Helper: Write uint16 little-endian
   */
  writeUint16LE(data, offset, value) {
    data[offset] = value & 0xff
    data[offset + 1] = (value >> 8) & 0xff
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LZ4Decompressor
}
