# Live capture corpus — keystream material (2026-06-22)

Controlled capture from live diep.io (São Paulo FFA) with a **known nickname**
`AAAAAAAAAAAA` (12 × `0x41`) to recover outbound keystream. Sanitized: the
client handshake token was deliberately **excluded** (the capture tool flagged it
as a possible account credential — not persisted).

- Build id (plaintext, from init): `1e13c49fb0551f3117dd82093e0d6acfd44a0eee`
- Transport: `wss://sao-…​.diep.io:2001`

## Handshake order (cipher engages only after this)

1. `out 0x00` (42 B, plaintext): `00` + ascii build id + `00`
2. `in  0xf5` (39 B): **server seed / key material** (below)
3. `out 0x00` (1030 B): client token — **excluded (possible credential)**
4. `in  0x04` (9 B), `in 0x07` (1 B, "ready"), `in 0x05` (ping)
5. `in  0x00` (encrypted updates begin; body entropy ~7.9)

The key derives from the **server seed `0xf5`** (and possibly the client token).

## Server seed (0xf5), 39 bytes
```
f5 b2 d4 82 d1 77 f4 5c 76 64 0e bc 2c 48 45 33 c3 be 3c 58
9c 87 a5 03 b0 a0 c6 ab d9 6d 55 64 ab 2c 09 82 fa bc e7
```

## Known-plaintext spawn → outbound keystream
Plaintext (documented framing): `02` ‖ `41`×12 ‖ `00` (type byte not encrypted).
```
cipher    : 02 3d 03 4c 24 87 30 4c 79 de 40 8b f5 ae
keystream : 00 7c 42 0d 65 c6 71 0d 38 9f 01 ca b4 ae
            ^^ type byte is plaintext (xor 0 with itself)
```
So the first 13 bytes of the **outbound** keystream (from the spawn packet's
position in the stream) are `7c 42 0d 65 c6 71 0d 38 9f 01 ca b4 ae`.

Cross-session check: a prior session (nick "Claude") gave keystream
`ed c8 69 23 58 3a 67` at the spawn position — **different**, confirming the key
is **per-connection** (seeded by the `0xf5` value), not a fixed global cipher.

## Encrypted update sample (inbound 0x00), 187 bytes
```
00 06 33 25 b9 c1 b3 73 f7 fa 0c c7 7d 52 3d 6f 60 2a 5f 4a
10 73 9e 17 bb a6 f7 9e 6d 33 e5 d9 b1 fd f2 0b b7 a7 02 da
4f e3 3b 84 74 18 32 74 af ea c6 04 bc 28 44 bc 2a 32 8b 24
3c 79 94 b7 ec 9e 76 b8 33 07 9c b6 94 59 3f a1 e1 bd 0d 61
c3 ee 16 98 9c 75 40 a2 b7 e3 40 d9 d4 82 38 35 4d e9 e4 39
10 4f 1a b7 9d 40 b2 c7 5d 5b 9d 41 88 fc 22 41 0c fe 1e 63
67 da a8 d8 4b dc 54 16 cc f1 80 84 3a b3 d7 7a 15 18 86 6c
d5 10 68 c6 cb fe 9b 0e 19 a0 06 b5 25 36 fd e6 5b fa b9 b7
f1 5a 6e 24 aa 58 77 ac e0 13 51 77 b5 d6 83 0d 01 05 a3 56
3a 3f d0 75 d5 73 84
```
(5207 such updates in ~30 s; inbound keystream is a separate stream from outbound.)

## How to attack next (offline)
1. Fetch the current build glue `build_1e13c49…​.wasm.js` + `.wasm`.
2. Find where the `0xf5` payload is consumed → key/seed setup.
3. Find the per-byte transform applied to send/recv bodies (stream cipher step).
4. Validate against the known-plaintext keystream above (`7c 42 0d 65 …`).
