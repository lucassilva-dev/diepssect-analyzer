// Analyze the cipher substitution table (sbox1) dumped live from diep.wasm memory
// at offset 1067824 (the 2nd table sat at 1068144, 320 bytes later).
// Goal: is it a valid permutation? an involution (self-inverse)? what pairs swap?
'use strict'

const sbox1 = `
00 01 02 f6 04 05 06 07 08 f3 0a 0b 0c 0d f5 0f 10 11 12 13 14 15 fc 17 18 19 1a 1b 1c 1d 1e 1f
20 21 22 23 24 25 26 27 28 29 2a 2b 2c 2d 2e 2f 30 31 32 33 34 35 36 ee 38 39 3a 3b 3c 3d 3e 3f
fe 41 42 43 44 45 46 47 f9 49 4a 4b 65 4d 4e 4f 50 51 e8 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f
60 ed 62 63 64 f1 66 67 68 69 ff 6b 6c 6d 6e 6f 70 71 72 73 74 75 76 77 78 79 7a 7b 7c f7 7e 7f
80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c f2 9e 9f
a0 a1 a2 a3 a4 a5 a6 a7 a8 ec aa ab fa ad ae af b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 ba bb bc bd be bf
c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ca cb cc cd ce cf d0 d1 d2 d3 d4 f0 d6 d7 d8 d9 da db dc dd de df
e0 e1 e2 fb e4 e5 f8 e7 ef eb e9 ea a9 61 37 fd d5 4c 9d 09 40 0e 03 7d e6 48 ac e3 16 52 f4 6a
`.trim().split(/\s+/).map(h => parseInt(h, 16))

// The seed (server 0xf5 packet) from the SAME session, payload after type byte:
const seed = `4c 8a 2b be 58 2c 86 aa 8d 9a 4e e2 f0 48 62 a1 43 fd 57 aa 0b 46 7f 44 2f 88 35 73 3f c9 ca 0a 6e e7 8b 2b 28 2e`
  .split(/\s+/).map(h => parseInt(h, 16))

console.log('sbox1 length:', sbox1.length)

// 1. valid permutation?
const seen = new Set(sbox1)
console.log('is permutation of 0..255:', seen.size === 256)

// 2. involution? (sbox1[sbox1[i]] === i for all i)
let involution = true
for (let i = 0; i < 256; i++) if (sbox1[sbox1[i]] !== i) { involution = false; break }
console.log('is involution (self-inverse):', involution)

// 3. list the transposition pairs / non-identity mapping
const pairs = []
const fixed = []
for (let i = 0; i < 256; i++) {
  if (sbox1[i] === i) continue
  if (sbox1[i] > i) pairs.push([i, sbox1[i]])   // record each swap once
}
console.log('\nnon-identity entries:', sbox1.filter((v, i) => v !== i).length)
console.log('swap pairs (i <-> sbox[i]), assuming involution:')
console.log(pairs.map(([a, b]) => `${a.toString(16).padStart(2,'0')}<->${b.toString(16).padStart(2,'0')}`).join('  '))

// 4. do the swapped LOW bytes correspond to bytes that appear in the seed?
const lowSwapped = pairs.map(p => p[0])
const seedSet = new Set(seed)
console.log('\nlow side of each swap, and whether that byte value is present in the seed:')
console.log(lowSwapped.map(b => `${b.toString(16).padStart(2,'0')}:${seedSet.has(b)?'Y':'-'}`).join('  '))

// 5. how many distinct seed bytes, and are the high-swapped values (0xe0-0xff) all used?
const highSwapped = pairs.map(p => p[1])
console.log('\nhigh side values:', highSwapped.map(b=>b.toString(16)).join(' '))
console.log('count of swaps:', pairs.length, '| distinct seed bytes:', new Set(seed).size, '| seed len:', seed.length)
