/**
 * DEFLATE (RFC 1951) and zlib (RFC 1950) decompression, synchronous, for the
 * places a stream API will not do: PNG-packed GRIB inside a decoder that is
 * itself synchronous, and later KMZ and zipped files.
 *
 * Canonical Huffman decoding one bit at a time, after Mark Adler's puff: small
 * and clear rather than fast. A few megabytes a second is ample for GRIB.
 */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huffman {
  count: Uint16Array
  symbol: Uint16Array
}

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16)
  for (let i = 0; i < n; i++) count[lengths[i]]++
  count[0] = 0
  const offs = new Uint16Array(16)
  for (let len = 1; len < 16; len++) offs[len] = offs[len - 1] + count[len - 1]
  const symbol = new Uint16Array(n)
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i
  return { count, symbol }
}

let FIXED: { lit: Huffman; dist: Huffman } | null = null
function fixed() {
  if (FIXED) return FIXED
  const l = new Uint8Array(288)
  l.fill(8, 0, 144)
  l.fill(9, 144, 256)
  l.fill(7, 256, 280)
  l.fill(8, 280, 288)
  FIXED = { lit: huffman(l, 288), dist: huffman(new Uint8Array(30).fill(5), 30) }
  return FIXED
}

class Inflater {
  private pos = 0
  private bitBuf = 0
  private bitCnt = 0
  out: Uint8Array
  len = 0

  constructor(private readonly src: Uint8Array, start: number, sizeHint: number) {
    this.pos = start
    this.out = new Uint8Array(Math.max(1024, sizeHint))
  }

  private bits(n: number): number {
    let v = this.bitBuf
    while (this.bitCnt < n) {
      if (this.pos >= this.src.length) throw new Error('the compressed data ends early')
      v |= this.src[this.pos++] << this.bitCnt
      this.bitCnt += 8
    }
    this.bitBuf = v >>> n
    this.bitCnt -= n
    return v & ((1 << n) - 1)
  }

  private decode(h: Huffman): number {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1)
      const count = h.count[len]
      if (code - count < first) return h.symbol[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('a Huffman code in the compressed data is not valid')
  }

  private room(n: number) {
    if (this.len + n <= this.out.length) return
    let size = this.out.length * 2
    while (size < this.len + n) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.out.subarray(0, this.len))
    this.out = grown
  }

  private stored() {
    this.bitBuf = 0
    this.bitCnt = 0
    if (this.pos + 4 > this.src.length) throw new Error('the compressed data ends early')
    const n = this.src[this.pos] | (this.src[this.pos + 1] << 8)
    const nc = this.src[this.pos + 2] | (this.src[this.pos + 3] << 8)
    if ((n ^ 0xffff) !== nc) throw new Error('a stored block has a bad length')
    this.pos += 4
    if (this.pos + n > this.src.length) throw new Error('the compressed data ends early')
    this.room(n)
    this.out.set(this.src.subarray(this.pos, this.pos + n), this.len)
    this.len += n
    this.pos += n
  }

  private codes(lit: Huffman, dist: Huffman) {
    for (;;) {
      const sym = this.decode(lit)
      if (sym < 256) {
        this.room(1)
        this.out[this.len++] = sym
      } else if (sym === 256) return
      else {
        const li = sym - 257
        if (li >= 29) throw new Error('a length code in the compressed data is not valid')
        const n = LBASE[li] + this.bits(LEXT[li])
        const di = this.decode(dist)
        if (di >= 30) throw new Error('a distance code in the compressed data is not valid')
        const d = DBASE[di] + this.bits(DEXT[di])
        if (d > this.len) throw new Error('a distance in the compressed data goes back too far')
        this.room(n)
        for (let i = 0; i < n; i++, this.len++) this.out[this.len] = this.out[this.len - d]
      }
    }
  }

  private dynamic() {
    const nlen = this.bits(5) + 257
    const ndist = this.bits(5) + 1
    const ncode = this.bits(4) + 4
    const lengths = new Uint8Array(320)
    for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = this.bits(3)
    const cl = huffman(lengths, 19)
    lengths.fill(0)
    for (let i = 0; i < nlen + ndist; ) {
      const sym = this.decode(cl)
      if (sym < 16) lengths[i++] = sym
      else {
        let rep: number
        let val = 0
        if (sym === 16) {
          if (i === 0) throw new Error('a repeat with nothing to repeat')
          val = lengths[i - 1]
          rep = 3 + this.bits(2)
        } else if (sym === 17) rep = 3 + this.bits(3)
        else rep = 11 + this.bits(7)
        if (i + rep > nlen + ndist) throw new Error('too many code lengths')
        while (rep--) lengths[i++] = val
      }
    }
    this.codes(huffman(lengths, nlen), huffman(lengths.subarray(nlen), ndist))
  }

  run(): Uint8Array {
    let last = 0
    while (!last) {
      last = this.bits(1)
      const type = this.bits(2)
      if (type === 0) this.stored()
      else if (type === 1) this.codes(fixed().lit, fixed().dist)
      else if (type === 2) this.dynamic()
      else throw new Error('a block type in the compressed data is not valid')
    }
    return this.out.slice(0, this.len)
  }
}

/** Raw DEFLATE. */
export function inflateRaw(data: Uint8Array, sizeHint = data.length * 4): Uint8Array {
  return new Inflater(data, 0, sizeHint).run()
}

/** A zlib stream: a two-byte header, DEFLATE, and a checksum this does not check. */
export function inflateZlib(data: Uint8Array, sizeHint = data.length * 4): Uint8Array {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) throw new Error('not a zlib stream')
  if (data[1] & 0x20) throw new Error('a zlib preset dictionary is not supported')
  return new Inflater(data, 2, sizeHint).run()
}
