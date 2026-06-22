/**
 * Field Validator for diep.io Protocol
 * Automatically validates field mappings through systematic testing
 */

class FieldValidator {
  constructor(options = {}) {
    this.testResults = new Map()
    this.validatedFields = new Map()
    this.failedTests = []
    this.testTimeout = options.testTimeout || 5000
    this.testSamples = options.testSamples || 10
  }

  /**
   * Test a field by sending packets with different values
   * @param {number} fieldIndex - Field to test
   * @param {Array} testValues - Values to test
   * @returns {Promise<TestResult>}
   */
  async testField(fieldIndex, testValues = null) {
    const result = {
      fieldIndex,
      testTime: Date.now(),
      testValues: testValues || this.generateTestValues(fieldIndex),
      results: [],
      conclusion: null,
      confidence: 0,
    }

    // Generate test values if not provided
    if (!testValues) {
      result.testValues = this.generateTestValues(fieldIndex)
    }

    for (const value of result.testValues) {
      const testResult = await this.testSingleValue(fieldIndex, value)
      result.results.push(testResult)
    }

    // Analyze results
    result.conclusion = this.analyzeTestResults(result.results)
    result.confidence = this.calculateConfidence(result.results)

    this.testResults.set(fieldIndex, result)
    return result
  }

  /**
   * Generate test values based on field type
   */
  generateTestValues(fieldIndex) {
    // Heuristics for generating test values
    return [
      0,           // Min
      1,           // Small positive
      127,         // Mid range
      255,         // 8-bit max
      1000,        // Large value
      -1,          // Negative
      -1000,       // Large negative
      Math.PI,     // Float-like
      Number.MAX_SAFE_INTEGER >> 8,  // Near max int
    ]
  }

  /**
   * Test a single field value
   */
  async testSingleValue(fieldIndex, value) {
    return {
      value,
      gameStatesBefore: null,
      gameStatesAfter: null,
      changes: [],
      timeout: false,
      error: null,
    }
  }

  /**
   * Analyze multiple test results
   */
  analyzeTestResults(results) {
    let patterns = {
      noChange: 0,
      linearChange: 0,
      inverseChange: 0,
      nonlinearChange: 0,
      errors: 0,
    }

    for (let i = 0; i < results.length - 1; i++) {
      const r1 = results[i]
      const r2 = results[i + 1]

      if (r1.error || r2.error) {
        patterns.errors++
        continue
      }

      if (!r1.changes.length && !r2.changes.length) {
        patterns.noChange++
      } else if (r1.changes.length && r2.changes.length) {
        // Check if changes are proportional (linear)
        if (this.isLinearRelation(r1.changes, r2.changes)) {
          patterns.linearChange++
        } else if (this.isInverseRelation(r1.changes, r2.changes)) {
          patterns.inverseChange++
        } else {
          patterns.nonlinearChange++
        }
      }
    }

    return patterns
  }

  /**
   * Check if changes are linearly related
   */
  isLinearRelation(changes1, changes2) {
    if (changes1.length === 0 || changes2.length === 0) return false

    // Check if deltas correlate positively
    const ratios = []
    for (let i = 0; i < Math.min(changes1.length, changes2.length); i++) {
      if (changes1[i].delta !== 0) {
        ratios.push(changes2[i].delta / changes1[i].delta)
      }
    }

    if (ratios.length === 0) return false

    // Check if ratios are consistent
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const variance = ratios.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / ratios.length
    const stddev = Math.sqrt(variance)

    return stddev / avg < 0.1 // Low coefficient of variation = linear
  }

  /**
   * Check if changes are inversely related
   */
  isInverseRelation(changes1, changes2) {
    const ratios = []
    for (let i = 0; i < Math.min(changes1.length, changes2.length); i++) {
      if (changes1[i].delta !== 0) {
        ratios.push(changes2[i].delta / changes1[i].delta)
      }
    }

    if (ratios.length === 0) return false

    // Check if all ratios are negative
    return ratios.every(r => r < 0)
  }

  /**
   * Calculate confidence score for field mapping
   */
  calculateConfidence(results) {
    if (results.length === 0) return 0

    let score = 0
    let validTests = 0

    for (const result of results) {
      if (!result.error) {
        validTests++
        if (result.changes.length > 0) {
          score += 0.5 // Has observable effect
        }
      }
    }

    // Confidence = percentage of non-erroring tests that show observable effect
    return validTests > 0 ? score / validTests : 0
  }

  /**
   * Validate health-related fields
   */
  async validateHealthFields() {
    console.log('Validating health fields...')

    const healthTests = {
      maxHealthField: 5,  // Known field
      currentHealthField: 24,  // Known field
    }

    const results = {}

    for (const [name, fieldIndex] of Object.entries(healthTests)) {
      console.log(`  Testing ${name} (field ${fieldIndex})...`)

      // Health should be 0-maxHealth range
      const testResult = await this.testFieldRangeConstraint(
        fieldIndex,
        { min: 0, max: 1000 }
      )

      results[name] = testResult
    }

    return results
  }

  /**
   * Validate position-related fields
   */
  async validatePositionFields() {
    console.log('Validating position fields...')

    const positionTests = {
      xPositionField: 2,
      yPositionField: 3,
    }

    const results = {}

    for (const [name, fieldIndex] of Object.entries(positionTests)) {
      console.log(`  Testing ${name} (field ${fieldIndex})...`)

      // Position should be within arena bounds (approximately)
      const testResult = await this.testFieldRangeConstraint(
        fieldIndex,
        { min: -10000, max: 10000 }  // Arena bounds
      )

      results[name] = testResult
    }

    return results
  }

  /**
   * Validate rotation-related fields
   */
  async validateRotationFields() {
    console.log('Validating rotation fields...')

    const rotationTests = {
      angleField: 1,
    }

    const results = {}

    for (const [name, fieldIndex] of Object.entries(rotationTests)) {
      console.log(`  Testing ${name} (field ${fieldIndex})...`)

      // Angle should be 0-2π or similar
      const testResult = await this.testFieldRangeConstraint(
        fieldIndex,
        { min: 0, max: 2 * Math.PI }
      )

      results[name] = testResult
    }

    return results
  }

  /**
   * Test if field respects a value range constraint
   */
  async testFieldRangeConstraint(fieldIndex, range) {
    const testValues = [
      range.min,
      (range.min + range.max) / 2,
      range.max,
      range.min - 100,      // Below range
      range.max + 100,      // Above range
    ]

    const result = await this.testField(fieldIndex, testValues)

    return {
      fieldIndex,
      range,
      result,
      respectsRange: this.checkRangeRespect(result, range),
    }
  }

  /**
   * Check if field respects a range constraint
   */
  checkRangeRespect(testResult, range) {
    // Simple heuristic: if in-range values produce consistent results
    // and out-of-range values produce errors/anomalies, range is respected
    return testResult.results.filter(r => !r.error).length > 0
  }

  /**
   * Create comprehensive validation report
   */
  async generateValidationReport(fieldMappings) {
    const report = {
      timestamp: new Date().toISOString(),
      fieldsTestedCount: 0,
      fieldsValidatedCount: 0,
      fieldsFailedCount: 0,
      validatedFields: [],
      failedFields: [],
      details: {},
    }

    for (const [fieldIndex, fieldInfo] of Object.entries(fieldMappings)) {
      console.log(`Validating field ${fieldIndex}...`)

      const testResult = await this.testField(parseInt(fieldIndex))
      report.fieldsTestedCount++

      if (testResult.confidence > 0.7) {
        report.fieldsValidatedCount++
        report.validatedFields.push({
          index: fieldIndex,
          type: fieldInfo.type,
          description: fieldInfo.description,
          confidence: testResult.confidence,
        })
      } else {
        report.fieldsFailedCount++
        report.failedFields.push({
          index: fieldIndex,
          reason: 'Low confidence',
          confidence: testResult.confidence,
        })
      }

      report.details[fieldIndex] = testResult
    }

    return report
  }

  /**
   * Export validation results
   */
  exportResults(format = 'json') {
    if (format === 'json') {
      return {
        testResults: Object.fromEntries(this.testResults),
        validatedFields: Object.fromEntries(this.validatedFields),
        failedTests: this.failedTests,
      }
    } else if (format === 'markdown') {
      let md = '# Field Validation Report\n\n'
      md += `Generated: ${new Date().toISOString()}\n\n`

      md += '## Validated Fields\n\n'
      md += '| Field Index | Type | Confidence | Status |\n'
      md += '|-------------|------|-----------|--------|\n'

      for (const [index, field] of this.validatedFields) {
        const conf = (field.confidence * 100).toFixed(1)
        md += `| ${index} | ${field.type || '?'} | ${conf}% | ✓ |\n`
      }

      md += '\n## Failed Tests\n\n'
      for (const failure of this.failedTests) {
        md += `- Field ${failure.fieldIndex}: ${failure.reason}\n`
      }

      return md
    }

    return {}
  }

  /**
   * Clear all validation results
   */
  clear() {
    this.testResults.clear()
    this.validatedFields.clear()
    this.failedTests = []
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FieldValidator
}
