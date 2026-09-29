/**
 * AIS: the AIVDM (others) and AIVDO (own ship) sentences an AIS receiver puts
 * on the NMEA bus, decoded after ITU-R M.1371.
 *
 * A sentence carries a 6-bit-armoured payload; long messages (type 5, some 24s
 * and 21s) come in several sentences, joined here by sequence id and channel.
 * Read: position reports (1–3, class A; 18, class B; 27, long range), base
 * stations (4), static and voyage data (5), SAR aircraft (9), safety text (14),
 * class B extended (19), aids to navigation (21) and class B static data (24).
 * Every field an AIS "not available" value marks comes back null.
 */

export type AisMessage =
  | AisPosition
  | AisBase
  | AisStatic
  | AisSafety
  | AisAton

interface Common {
  type: number
  repeat: number
  mmsi: number
  /** From AIVDO: this is our own ship. */
  own: boolean
  channel: string
}

export interface AisPosition extends Common {
  kind: 'position'
  cls: 'A' | 'B' | 'SAR' | 'LR'
  status: number | null
  /** Degrees a minute, signed (+ to starboard); null when not given or not turning information. */
  rot: number | null
  sog: number | null
  lat: number | null
  lon: number | null
  cog: number | null
  heading: number | null
  accuracy: boolean
  /** Second of the UTC minute the fix is from, 0–59, else null. */
  second: number | null
  /** Aircraft altitude in metres, for type 9. */
  altitudeM?: number | null
  /** Name, type and size, for type 19. */
  name?: string
  shipType?: number
  dims?: Dimensions
}

export interface AisBase extends Common {
  kind: 'base'
  time: number | null
  lat: number | null
  lon: number | null
}

export interface Dimensions {
  bow: number
  stern: number
  port: number
  starboard: number
}

export interface AisStatic extends Common {
  kind: 'static'
  /** Type 24 comes in two parts: A the name, B the rest. */
  part?: 'A' | 'B'
  imo?: number | null
  callSign?: string
  name?: string
  shipType?: number
  dims?: Dimensions
  draughtM?: number | null
  destination?: string
  /** ETA as month, day, hour, minute (no year in AIS). */
  eta?: { month: number; day: number; hour: number; minute: number } | null
}

export interface AisSafety extends Common {
  kind: 'safety'
  text: string
}

export interface AisAton extends Common {
  kind: 'aton'
  aidType: number
  name: string
  lat: number | null
  lon: number | null
  offPosition: boolean
  virtual: boolean
  dims: Dimensions
}

// ------------------------------------------------------------------ bits

function unarmour(payload: string, fill: number): Uint8Array {
  const bits = new Uint8Array(payload.length * 6)
  for (let i = 0; i < payload.length; i++) {
    let v = payload.charCodeAt(i) - 48
    if (v > 40) v -= 8
    if (v < 0 || v > 63) throw new Error(`"${payload[i]}" is not AIS payload`)
    for (let b = 0; b < 6; b++) bits[i * 6 + b] = (v >> (5 - b)) & 1
  }
  return fill > 0 ? bits.subarray(0, bits.length - fill) : bits
}

class Bits {
  constructor(private readonly b: Uint8Array) {}
  get length() {
    return this.b.length
  }
  u(start: number, len: number): number {
    let v = 0
    for (let i = 0; i < len; i++) v = v * 2 + (this.b[start + i] ?? 0)
    return v
  }
  s(start: number, len: number): number {
    const v = this.u(start, len)
    return v >= 2 ** (len - 1) ? v - 2 ** len : v
  }
  text(start: number, chars: number, trim = true): string {
    const table = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?'
    let s = ''
    for (let i = 0; i < chars; i++) {
      if (start + i * 6 + 6 > this.b.length) break
      s += table[this.u(start + i * 6, 6)]
    }
    // '@' pads the end; trailing spaces are padding too, unless more text follows.
    const cut = s.replace(/@.*$/, '')
    return trim ? cut.trimEnd() : cut
  }
}

// --------------------------------------------------------------- fields

const lonOf = (v: number, scale: number) => (Math.abs(v / scale) > 180 ? null : v / scale)
const latOf = (v: number, scale: number) => (Math.abs(v / scale) > 90 ? null : v / scale)
const sogOf = (v: number) => (v === 1023 ? null : v / 10)
const cogOf = (v: number) => (v >= 3600 ? null : v / 10)
const hdgOf = (v: number) => (v === 511 ? null : v)
const secOf = (v: number) => (v < 60 ? v : null)
function rotOf(v: number): number | null {
  // Coded as 4.733 × √(rate); ±127 turning faster than 5°/30 s with no indicator, −128 none.
  if (v === -128 || Math.abs(v) === 127) return null
  const r = (v / 4.733) ** 2
  return v < 0 ? -r : r
}
const dimsOf = (b: Bits, at: number): Dimensions => ({ bow: b.u(at, 9), stern: b.u(at + 9, 9), port: b.u(at + 18, 6), starboard: b.u(at + 24, 6) })

function decodeBits(b: Bits, own: boolean, channel: string): AisMessage | null {
  const type = b.u(0, 6)
  const common = { type, repeat: b.u(6, 2), mmsi: b.u(8, 30), own, channel }
  switch (type) {
    case 1:
    case 2:
    case 3:
      return {
        ...common,
        kind: 'position',
        cls: 'A',
        status: b.u(38, 4) === 15 ? null : b.u(38, 4),
        rot: rotOf(b.s(42, 8)),
        sog: sogOf(b.u(50, 10)),
        accuracy: b.u(60, 1) === 1,
        lon: lonOf(b.s(61, 28), 600000),
        lat: latOf(b.s(89, 27), 600000),
        cog: cogOf(b.u(116, 12)),
        heading: hdgOf(b.u(128, 9)),
        second: secOf(b.u(137, 6)),
      }
    case 4: {
      const [y, mo, d, h, mi, s] = [b.u(38, 14), b.u(52, 4), b.u(56, 5), b.u(61, 5), b.u(66, 6), b.u(72, 6)]
      const ok = y > 0 && mo > 0 && d > 0 && h < 24 && mi < 60 && s < 60
      return { ...common, kind: 'base', time: ok ? Date.UTC(y, mo - 1, d, h, mi, s) : null, lon: lonOf(b.s(79, 28), 600000), lat: latOf(b.s(107, 27), 600000) }
    }
    case 5: {
      const [mo, d, h, mi] = [b.u(274, 4), b.u(278, 5), b.u(283, 5), b.u(288, 6)]
      return {
        ...common,
        kind: 'static',
        imo: b.u(40, 30) || null,
        callSign: b.text(70, 7),
        name: b.text(112, 20),
        shipType: b.u(232, 8),
        dims: dimsOf(b, 240),
        eta: mo && d && h < 24 && mi < 60 ? { month: mo, day: d, hour: h, minute: mi } : null,
        draughtM: b.u(294, 8) ? b.u(294, 8) / 10 : null,
        destination: b.text(302, 20),
      }
    }
    case 9:
      return {
        ...common,
        kind: 'position',
        cls: 'SAR',
        status: null,
        rot: null,
        altitudeM: b.u(38, 12) === 4095 ? null : b.u(38, 12),
        sog: b.u(50, 10) === 1023 ? null : b.u(50, 10),
        accuracy: b.u(60, 1) === 1,
        lon: lonOf(b.s(61, 28), 600000),
        lat: latOf(b.s(89, 27), 600000),
        cog: cogOf(b.u(116, 12)),
        heading: null,
        second: secOf(b.u(128, 6)),
      }
    case 14:
      return { ...common, kind: 'safety', text: b.text(40, Math.floor((b.length - 40) / 6)) }
    case 18:
    case 19: {
      const pos: AisPosition = {
        ...common,
        kind: 'position',
        cls: 'B',
        status: null,
        rot: null,
        sog: sogOf(b.u(46, 10)),
        accuracy: b.u(56, 1) === 1,
        lon: lonOf(b.s(57, 28), 600000),
        lat: latOf(b.s(85, 27), 600000),
        cog: cogOf(b.u(112, 12)),
        heading: hdgOf(b.u(124, 9)),
        second: secOf(b.u(133, 6)),
      }
      if (type === 19) {
        pos.name = b.text(143, 20)
        pos.shipType = b.u(263, 8)
        pos.dims = dimsOf(b, 271)
      }
      return pos
    }
    case 21: {
      // A name longer than 20 characters goes on in an extension after bit 272.
      const ext = b.length > 272 ? b.text(272, Math.floor((b.length - 272) / 6)) : ''
      const name = ext ? b.text(43, 20, false) + ext : b.text(43, 20)
      return {
        ...common,
        kind: 'aton',
        aidType: b.u(38, 5),
        name,
        lon: lonOf(b.s(164, 28), 600000),
        lat: latOf(b.s(192, 27), 600000),
        dims: dimsOf(b, 219),
        offPosition: b.u(259, 1) === 1,
        virtual: b.u(269, 1) === 1,
      }
    }
    case 24: {
      const part = b.u(38, 2)
      if (part === 0) return { ...common, kind: 'static', part: 'A', name: b.text(40, 20) }
      if (part === 1) return { ...common, kind: 'static', part: 'B', shipType: b.u(40, 8), callSign: b.text(90, 7), dims: dimsOf(b, 132) }
      return null
    }
    case 27:
      return {
        ...common,
        kind: 'position',
        cls: 'LR',
        status: b.u(40, 4) === 15 ? null : b.u(40, 4),
        rot: null,
        accuracy: b.u(38, 1) === 1,
        lon: lonOf(b.s(44, 18), 600),
        lat: latOf(b.s(62, 17), 600),
        sog: b.u(79, 6) === 63 ? null : b.u(79, 6),
        cog: b.u(85, 9) === 511 ? null : b.u(85, 9),
        heading: null,
        second: null,
      }
    default:
      return null
  }
}

// --------------------------------------------------------------- framing

function checksumOk(line: string): boolean {
  const star = line.lastIndexOf('*')
  if (star < 0) return true
  let x = 0
  for (let i = 1; i < star; i++) x ^= line.charCodeAt(i)
  return x === parseInt(line.slice(star + 1, star + 3), 16)
}

/**
 * A stateful reader: feed it sentences, get messages as they complete.
 * Parts of a multipart message wait, keyed by sequence id and channel, and
 * are dropped when a newer message with the same key starts.
 */
export class AisDecoder {
  private readonly parts = new Map<string, { total: number; got: string[]; fills: number[] }>()
  /** Sentences that failed their checksum or could not be read. */
  rejected = 0

  push(line: string): AisMessage | null {
    const s = line.trim()
    const m = /^[!$](?:[A-Z]{2})(VDM|VDO),(\d+),(\d+),(\d*),([^,]*),([^,]*),(\d)/.exec(s)
    if (!m) return null
    if (!checksumOk(s)) {
      this.rejected++
      return null
    }
    const [, kind, totalS, numS, seq, channel, payload, fillS] = m
    const total = Number(totalS)
    const num = Number(numS)
    const own = kind === 'VDO'
    try {
      if (total === 1) return decodeBits(new Bits(unarmour(payload, Number(fillS))), own, channel)
      const key = `${seq}|${channel}`
      let p = this.parts.get(key)
      if (num === 1 || !p || p.total !== total) {
        p = { total, got: [], fills: [] }
        this.parts.set(key, p)
      }
      p.got[num - 1] = payload
      p.fills[num - 1] = Number(fillS)
      if (p.got.filter((x) => x != null).length < total) return null
      this.parts.delete(key)
      const joined = p.got.join('')
      return decodeBits(new Bits(unarmour(joined, p.fills[total - 1])), own, channel)
    } catch {
      this.rejected++
      return null
    }
  }
}

/** Every message in a block of sentences. */
export function decodeAis(text: string): AisMessage[] {
  const d = new AisDecoder()
  const out: AisMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = d.push(line)
    if (m) out.push(m)
  }
  return out
}
