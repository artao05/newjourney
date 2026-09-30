/**
 * NMEA 2000: CAN frames from a gateway, decoded into the same `Reading`.
 *
 * Four text forms carry them:
 *
 *   Yacht Devices RAW    17:33:21.107 R 09F80115 A0 7D E6 18 00 00 00 00
 *                        (a YDNU-02 over USB in RAW mode; a YDWG-02 over Wi-Fi, TCP or UDP)
 *   canboat CSV          2026-09-29-10:00:00.000,2,127250,7,255,8,00,ff,7f,...
 *                        (Actisense NGT-1 logs, as canboat's tools write them)
 *   Actisense N2K ASCII  A173321.107 23FF7 1F503 3F9FDCFFFFFFFFFF
 *                        (an Actisense W2K-1 over Wi-Fi: source, destination and priority, PGN, data)
 *   iKonvert             !PDGY,130306,2,35,255,0.000,AAQD+AL///8=
 *                        (Digital Yacht iKonvert and NavLink2: PGN, priority, source, destination, time, data in base64)
 *
 * The first two are CAN frames: messages over 8 bytes arrive as fast packets,
 * several frames with a sequence counter, and are put back together before
 * decoding. The gateways send the last two whole, so they skip that step. A field holding its
 * "not available" pattern (all ones, or the top value of a signed field)
 * decodes to nothing, never to a number.
 */

import type { Reading } from './nmea0183'

const RAD = 180 / Math.PI
const MS_TO_KN = 3600 / 1852
const wrap = (a: number) => ((a % 360) + 360) % 360
const signed = (d: number) => (d > 180 ? d - 360 : d)

export interface Frame {
  pgn: number
  src: number
  priority: number
  data: Uint8Array
  /** A whole message, as a gateway sends it once it has put the fast packets together. */
  whole?: boolean
}

function base64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** A 29-bit CAN id into PGN, source and priority (ISO 11783 addressing). */
export function fromCanId(id: number): { pgn: number; src: number; priority: number } {
  const priority = (id >>> 26) & 0x7
  const pf = (id >>> 16) & 0xff
  const dp = (id >>> 24) & 0x3 // data page and extended data page
  let pgn = (dp << 16) | (pf << 8)
  if (pf >= 240) pgn |= (id >>> 8) & 0xff // PDU2: the PS byte is part of the PGN
  return { pgn, src: id & 0xff, priority }
}

/** One gateway text line as a frame, or null if it is neither format. */
export function parseN2kLine(line: string): Frame | null {
  const s = line.trim()
  const yd = /^\d{2}:\d{2}:\d{2}\.\d{3} [RT] ([0-9A-Fa-f]{8})((?: [0-9A-Fa-f]{2}){1,8})$/.exec(s)
  if (yd) {
    const id = parseInt(yd[1], 16)
    const data = Uint8Array.from(yd[2].trim().split(' ').map((b) => parseInt(b, 16)))
    return { ...fromCanId(id), data }
  }
  // Actisense N2K ASCII: A + time, then SSDDP, the PGN and the data, all hex.
  const act = /^A\d{6}\.\d{3} ([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-7]) ([0-9A-Fa-f]{5,6}) ((?:[0-9A-Fa-f]{2})*)$/.exec(s)
  if (act) {
    const hex = act[5]
    const data = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16))
    return { pgn: parseInt(act[4], 16), src: parseInt(act[1], 16), priority: Number(act[3]), data, whole: true }
  }
  // iKonvert: !PDGY,pgn,priority,source,destination,time,base64. ($PDGY lines are its own status.)
  if (s.startsWith('!PDGY,')) {
    const p = s.split(',')
    if (p.length < 7) return null
    const [pgn, prio, src] = p.slice(1, 4).map(Number)
    const data = base64Bytes(p[6])
    if (!data || ![pgn, prio, src].every(Number.isFinite)) return null
    return { pgn, src, priority: prio, data, whole: true }
  }
  const f = s.split(',')
  if (f.length >= 7) {
    const [prio, pgn, src, , len] = f.slice(1, 6).map(Number)
    const bytes = f.slice(6).map((b) => parseInt(b, 16))
    if ([prio, pgn, src, len].every(Number.isFinite) && bytes.length === len && bytes.every((b) => b >= 0 && b <= 255)) {
      return { pgn, src, priority: prio, data: Uint8Array.from(bytes) }
    }
  }
  return null
}

/** PGNs longer than a frame, sent as fast packets. */
export const FAST_PACKET = new Set([126996, 128275, 129029, 129038, 129039, 129540, 129794, 129809, 129810, 130577])

/** Puts fast packets back together; single-frame PGNs pass straight through. */
export class FastPacketAssembler {
  private partial = new Map<string, { seq: number; len: number; bytes: number[]; next: number }>()

  push(f: Frame): Frame | null {
    if (f.whole || !FAST_PACKET.has(f.pgn)) return f
    const key = `${f.pgn}:${f.src}`
    const seq = f.data[0] >> 5
    const index = f.data[0] & 0x1f
    if (index === 0) {
      const len = f.data[1]
      const p = { seq, len, bytes: Array.from(f.data.slice(2)), next: 1 }
      this.partial.set(key, p)
      return this.done(key, f, p)
    }
    const p = this.partial.get(key)
    // A frame out of order, or from another sequence, spoils the message.
    if (!p || p.seq !== seq || p.next !== index) {
      this.partial.delete(key)
      return null
    }
    p.bytes.push(...f.data.slice(1))
    p.next++
    return this.done(key, f, p)
  }

  private done(key: string, f: Frame, p: { len: number; bytes: number[] }): Frame | null {
    if (p.bytes.length < p.len) return null
    this.partial.delete(key)
    return { ...f, data: Uint8Array.from(p.bytes.slice(0, p.len)) }
  }
}

/** Little-endian fields with NMEA 2000's "not available" patterns. */
class Fields {
  private v: DataView
  constructor(private readonly d: Uint8Array) {
    this.v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  }
  private ok(o: number, n: number) {
    return o + n <= this.d.length
  }
  u8(o: number) {
    return this.ok(o, 1) && this.d[o] !== 0xff ? this.d[o] : null
  }
  u16(o: number) {
    if (!this.ok(o, 2)) return null
    const x = this.v.getUint16(o, true)
    return x >= 0xfffd ? null : x
  }
  i16(o: number) {
    if (!this.ok(o, 2)) return null
    const x = this.v.getInt16(o, true)
    return x === 0x7fff ? null : x
  }
  u32(o: number) {
    if (!this.ok(o, 4)) return null
    const x = this.v.getUint32(o, true)
    return x >= 0xfffffffd ? null : x
  }
  i32(o: number) {
    if (!this.ok(o, 4)) return null
    const x = this.v.getInt32(o, true)
    return x === 0x7fffffff ? null : x
  }
  i64(o: number) {
    if (!this.ok(o, 8)) return null
    const x = this.v.getBigInt64(o, true)
    return x === 0x7fffffffffffffffn ? null : Number(x)
  }
}

const put = <K extends keyof Reading>(out: Partial<Reading>, k: K, v: Reading[K] | null | undefined) => {
  if (v != null && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v
}

/** One complete message into what it says, or null for a PGN not read here. */
export function decodePgn(f: Frame): Partial<Reading> | null {
  const b = new Fields(f.data)
  const out: Partial<Reading> = {}
  const rad = (x: number | null, k = 1e-4) => (x == null ? null : x * k * RAD)
  switch (f.pgn) {
    case 127250: {
      // Vessel heading: true or magnetic, with deviation and variation.
      const h = rad(b.u16(1))
      const ref = f.data[7] != null ? f.data[7] & 0x3 : 0
      if (h != null) put(out, ref === 1 ? 'headingMag' : 'headingTrue', wrap(h))
      put(out, 'deviation', rad(b.i16(3)))
      put(out, 'variation', rad(b.i16(5)))
      return out
    }
    case 127251: {
      const r = b.i32(1)
      put(out, 'rateOfTurn', r == null ? null : r * 3.125e-8 * RAD * 60)
      return out
    }
    case 127257:
      put(out, 'pitch', rad(b.i16(3)))
      put(out, 'heel', rad(b.i16(5)))
      return out
    case 127245:
      put(out, 'rudder', rad(b.i16(4)))
      return out
    case 128259: {
      const w = b.u16(1)
      put(out, 'bsp', w == null ? null : w * 0.01 * MS_TO_KN)
      return out
    }
    case 128267:
      put(out, 'depthM', b.u32(1) == null ? null : b.u32(1)! * 0.01)
      put(out, 'depthOffsetM', b.i16(5) == null ? null : b.i16(5)! * 0.001)
      return out
    case 128275:
      put(out, 'logNm', b.u32(6) == null ? null : b.u32(6)! / 1852)
      put(out, 'tripNm', b.u32(10) == null ? null : b.u32(10)! / 1852)
      return out
    case 129025: {
      const lat = b.i32(0)
      const lon = b.i32(4)
      if (lat != null && lon != null) Object.assign(out, { lat: lat * 1e-7, lon: lon * 1e-7 })
      return out
    }
    case 129026: {
      const ref = f.data[1] & 0x3
      const cog = rad(b.u16(2))
      const sog = b.u16(4)
      if (cog != null && ref === 0) put(out, 'cog', wrap(cog))
      put(out, 'sog', sog == null ? null : sog * 0.01 * MS_TO_KN)
      return out
    }
    case 129029: {
      const days = b.u16(1)
      const secs = b.u32(3)
      if (days != null && secs != null) put(out, 'utc', days * 86_400_000 + Math.round(secs / 10))
      const lat = b.i64(7)
      const lon = b.i64(15)
      if (lat != null && lon != null) Object.assign(out, { lat: lat * 1e-16, lon: lon * 1e-16 })
      const alt = b.i64(23)
      put(out, 'altitudeM', alt == null ? null : alt * 1e-6)
      const method = f.data[31] != null ? f.data[31] >> 4 : null
      // 0 none, 1 GNSS, 2 DGNSS, 4 RTK fixed, 5 RTK float: the same scale as GGA.
      if (method != null && method <= 8) put(out, 'fixQuality', method)
      put(out, 'satellites', b.u8(33))
      put(out, 'hdop', b.i16(34) == null ? null : b.i16(34)! * 0.01)
      return out
    }
    case 130306: {
      const speed = b.u16(1)
      const angle = rad(b.u16(3))
      const ref = f.data[5] & 0x7
      const kn = speed == null ? null : speed * 0.01 * MS_TO_KN
      if (ref === 2) {
        put(out, 'aws', kn)
        put(out, 'awa', angle == null ? null : signed(angle))
      } else if (ref === 4 || ref === 3) {
        put(out, 'tws', kn)
        put(out, 'twa', angle == null ? null : signed(angle))
      } else if (ref === 0) {
        put(out, 'tws', kn)
        put(out, 'twd', angle == null ? null : wrap(angle))
      }
      return out
    }
    case 130310: {
      const water = b.u16(1)
      const air = b.u16(3)
      const p = b.u16(5)
      put(out, 'waterTempC', water == null ? null : water * 0.01 - 273.15)
      put(out, 'airTempC', air == null ? null : air * 0.01 - 273.15)
      put(out, 'baroHpa', p == null ? null : p) // 100 Pa steps are hPa
      return out
    }
    case 130312: {
      const source = f.data[2]
      const t = b.u16(3)
      if (t == null) return out
      if (source === 0) put(out, 'waterTempC', t * 0.01 - 273.15)
      else if (source === 1) put(out, 'airTempC', t * 0.01 - 273.15)
      return out
    }
    default:
      return null
  }
}

/** A stream of gateway lines into readings, fast packets and all. */
export class N2kDecoder {
  private assembler = new FastPacketAssembler()
  stats = { frames: 0, messages: 0, unread: 0, bad: 0 }

  line(line: string): Partial<Reading> | null {
    const f = parseN2kLine(line)
    if (!f) {
      if (line.trim()) this.stats.bad++
      return null
    }
    this.stats.frames++
    const m = this.assembler.push(f)
    if (!m) return null
    const r = decodePgn(m)
    if (!r) {
      this.stats.unread++
      return null
    }
    this.stats.messages++
    return r
  }
}
