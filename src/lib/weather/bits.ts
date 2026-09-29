/** Bit-level reading for the GRIB decoders. */

/** Reads `bits`-wide unsigned integers from a byte array, most significant bit first. */
export class BitReader {
  private pos = 0
  constructor(private readonly b: Uint8Array, startByte: number) {
    this.pos = startByte * 8
  }
  read(bits: number): number {
    let x = 0
    while (bits > 0) {
      const avail = 8 - (this.pos & 7)
      const take = avail < bits ? avail : bits
      const chunk = ((this.b[this.pos >> 3] ?? 0) >> (avail - take)) & ((1 << take) - 1)
      x = x * (1 << take) + chunk
      bits -= take
      this.pos += take
    }
    return x
  }
  /** Skip to the next octet boundary, as GRIB pads each block of groups. */
  align() {
    this.pos = Math.ceil(this.pos / 8) * 8
  }
  get byte() {
    return this.pos >> 3
  }
}
