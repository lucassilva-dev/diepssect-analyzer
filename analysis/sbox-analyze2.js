'use strict'
// Two cipher tables dumped from the SAME live session (offsets 1112728 & 1113048).
const sbox1 = "00 01 02 f6 04 05 06 07 08 f3 0a 0b 0c 0d f5 0f 10 11 12 13 14 15 fc 17 18 19 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a 2b 2c 2d 2e 2f 30 31 32 33 34 35 36 ee 38 39 3a 3b 3c 3d 3e 3f fe 41 42 43 44 45 46 47 f9 49 4a 4b 65 4d 4e 4f 50 51 ef 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 ed 62 63 64 f1 66 67 68 69 ff 6b 6c 6d e8 6f 70 71 72 73 74 75 76 77 78 79 7a 7b 7c f7 7e 7f 80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c f2 9e 9f a0 a1 a2 a3 a4 a5 a6 a7 a8 ec aa ab fa ad ae af b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 ba bb bc bd be bf c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ca cb cc cd ce cf d0 d1 d2 d3 d4 f0 d6 d7 d8 d9 da db dc dd de df e0 e1 e2 fb e4 e5 f8 e7 e9 6e eb ea a9 61 37 fd d5 4c 9d 09 40 0e 03 7d e6 48 ac e3 16 52 f4 6a".split(/\s+/).map(h=>parseInt(h,16))
const sbox2 = "00 01 02 03 fe 05 06 07 08 09 0a 0b 0c 0d ff 0f 10 11 12 13 14 15 16 17 18 f7 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a 2b 2c 2d 2e 2f 30 31 32 33 34 35 fc 37 38 39 3a 3b 3c 3d 3e 3f 40 41 42 43 44 45 46 47 48 49 f0 4b 4c 4d 4e 4f 50 f9 52 ee 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 bd 66 67 68 69 6a 6b 6c 6d e8 6f 70 71 72 73 74 75 f6 77 78 79 7a 7b 7c 7d 7e 7f 80 81 82 83 84 85 f3 87 88 89 8a f4 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c 9d 9e 9f a0 fb a2 a3 a4 a5 a6 a7 a8 f2 aa ab ac ad ae af b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 ba ef bc f1 be bf c0 ec c2 c3 c4 ed c6 c7 c8 c9 ca cb cc cd ce cf d0 d1 d2 d3 d4 d5 d6 d7 d8 d9 da db dc f8 de df e0 e1 e2 e3 e4 e5 f5 e7 bb e9 6e eb c1 c5 53 ea fa 65 a9 86 8b e6 76 19 fd 51 4a a1 36 dd 04 0e".split(/\s+/).map(h=>parseInt(h,16))

const isPerm = a => new Set(a).size === 256
console.log('sbox1 perm:', isPerm(sbox1), '| sbox2 perm:', isPerm(sbox2))

// inverse tests
let inv12=true, inv21=true, eq=true
for(let i=0;i<256;i++){ if(sbox2[sbox1[i]]!==i)inv12=false; if(sbox1[sbox2[i]]!==i)inv21=false; if(sbox1[i]!==sbox2[i])eq=false }
console.log('sbox2 == inverse(sbox1):', inv12)
console.log('sbox1 == inverse(sbox2):', inv21)
console.log('sbox1 == sbox2:', eq)

// involution?
let inv1=true, inv2=true
for(let i=0;i<256;i++){ if(sbox1[sbox1[i]]!==i)inv1=false; if(sbox2[sbox2[i]]!==i)inv2=false }
console.log('sbox1 involution:', inv1, '| sbox2 involution:', inv2)

// moved-entry counts
const moved = a => a.reduce((c,v,i)=>c+(v!==i?1:0),0)
console.log('moved entries: sbox1', moved(sbox1), 'sbox2', moved(sbox2))

// where they differ from identity — are the moved index-sets the same?
const m1 = new Set(sbox1.map((v,i)=>v!==i?i:-1).filter(x=>x>=0))
const m2 = new Set(sbox2.map((v,i)=>v!==i?i:-1).filter(x=>x>=0))
const same = [...m1].every(x=>m2.has(x)) && m1.size===m2.size
console.log('same moved-index set:', same, '| |m1|=',m1.size,'|m2|=',m2.size)

// Hypothesis: sbox2 is inverse of sbox1 EXCEPT both share many fixed points.
// Print the composition sbox2∘sbox1 deviations from identity (how far from inverse)
let dev=0; const devs=[]
for(let i=0;i<256;i++){ const c=sbox2[sbox1[i]]; if(c!==i){dev++; if(devs.length<20)devs.push(`${i.toString(16)}->${c.toString(16)}`)} }
console.log('sbox2∘sbox1 deviations from identity:', dev)
console.log('sample devs:', devs.join(' '))
