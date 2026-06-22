#!/usr/bin/env node
/**
 * Static extraction from a diep.io WASM memory image (.mem).
 *
 * Pulls REAL artifacts straight out of the binary's data section:
 *   - the embedded achievements JSON  -> docs/extracted/achievements.json
 *   - canonical stat ids               -> docs/extracted/stat-ids.json
 *   - canonical class (tank) ids       -> docs/extracted/class-ids.json
 *
 * These are ground truth for that build (not guesses). Note the build is old
 * (emscripten 1.37.9), so ids are canonical/base — a live build applies a
 * per-update shuffle on top (see SHUFFLER in diep-bot/main.js).
 *
 * Usage: node scripts/extract-from-mem.js <path-to.mem>
 */
'use strict'
const fs = require('fs')
const path = require('path')

const memPath = process.argv[2] ||
  'source/build_16c5a0cc9e22f4a8dd6aff32e1ad70e056f530f5.mem'

const buf = fs.readFileSync(memPath)
const ascii = buf.toString('latin1')

// --- locate the achievements JSON array (a null-terminated C string) ---
const start = ascii.indexOf('[{"name":"A moment to cherish forever"')
if (start < 0) {
  console.error('Achievements JSON not found in', memPath)
  process.exit(1)
}
// The array is null-terminated in memory; find the terminating NUL.
let end = start
while (end < ascii.length && ascii.charCodeAt(end) !== 0) end++
const json = ascii.slice(start, end)

let ach
try {
  ach = JSON.parse(json)
} catch (e) {
  console.error('Failed to parse achievements JSON:', e.message)
  process.exit(1)
}
console.log('Parsed', ach.length, 'achievements')

// --- derive canonical stat + class ids from achievement conditions ---
const stats = {}
const classes = {}
for (const a of ach) {
  for (const c of a.conds || []) {
    const t = c.tags || {}
    if (c.event === 'statUpgraded' && typeof t.id === 'number') {
      stats[t.id] = a.desc.replace(/^Upgrade /, '').replace(/ to its maximum value$/, '')
    }
    if (c.event === 'classChange' && typeof t.class === 'number') {
      classes[t.class] = a.desc.replace(/^Upgrade to /, '')
    }
  }
}

const outDir = path.join(path.dirname(memPath), '..', 'docs', 'extracted')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'achievements.json'), JSON.stringify(ach, null, 2))
fs.writeFileSync(path.join(outDir, 'stat-ids.json'), JSON.stringify(stats, null, 2))
fs.writeFileSync(path.join(outDir, 'class-ids.json'), JSON.stringify(classes, null, 2))

console.log('\nCanonical STAT ids (from statUpgraded conditions):')
for (const k of Object.keys(stats).sort((a, b) => a - b)) console.log(`  ${k}: ${stats[k]}`)
console.log('\nCanonical CLASS ids (from classChange conditions):')
for (const k of Object.keys(classes).sort((a, b) => a - b)) console.log(`  ${k}: ${classes[k]}`)
console.log('\nWrote artifacts to', outDir)
