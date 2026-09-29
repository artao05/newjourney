/**
 * The entries of a zip file: NOAA hands out ENC cells as zipped exchange
 * sets. Stored and deflated entries only, and no zip64: chart zips are well
 * under 4 GB.
 */
import { inflateRaw } from './inflate'

export interface ZipEntry {
  /** The path inside the zip, with forward slashes. */
  name: string
  bytes: Uint8Array
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

export function readZip(input: Uint8Array | ArrayBuffer): ZipEntry[] {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  // The end-of-central-directory record, searched for back from the end (it may carry a comment).
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no central directory)')
  const count = u16(b, eocd + 10)
  let at = u32(b, eocd + 16)
  const out: ZipEntry[] = []
  const text = new TextDecoder()
  for (let k = 0; k < count; k++) {
    if (u32(b, at) !== 0x02014b50) throw new Error('zip central directory is damaged')
    const method = u16(b, at + 10)
    const csize = u32(b, at + 20)
    const usize = u32(b, at + 24)
    const nameLen = u16(b, at + 28)
    const extraLen = u16(b, at + 30)
    const commentLen = u16(b, at + 32)
    const local = u32(b, at + 42)
    const name = text.decode(b.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/')
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (u32(b, local) !== 0x04034b50) throw new Error(`zip entry ${name} is damaged`)
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28)
    const data = b.subarray(start, start + csize)
    if (method === 0) out.push({ name, bytes: data.slice() })
    else if (method === 8) out.push({ name, bytes: inflateRaw(data, usize) })
    else throw new Error(`zip entry ${name} uses compression method ${method}, which is not supported`)
  }
  return out
}
