/**
 * NMEA 0183: the sentences a race boat's instruments speak.
 *
 * Talker-agnostic: `$GPRMC` and `$GNRMC` are the same sentence, and so are
 * `$IIMWV` and `$WIMWV`. Each decoded sentence becomes a partial `Reading`,
 * and `NmeaDecoder` keeps the latest value of everything, splitting a byte
 * stream into lines and dropping any line whose checksum is wrong. A corrupt
 * line that parsed would put a wrong number on the screen with nothing to say
 * so, which is worse than a gap.
 *
 * Angles are degrees, speeds knots, depths and heights metres, temperatures
 * °C, pressure hPa. AIS (`!AIVDM`) is not handled here; see worklist 12.1.
 */

export interface XdrMeasurement {
  type: string
  value: number
  unit: string
  name: string
}

export interface Reading {
  /** UTC from RMC (with its date) or ZDA. */
  utc?: number
  lat?: number
  lon?: number
  /** Degrees true, and knots. */
  cog?: number
  sog?: number
  /** GGA fix quality: 0 none, 1 GPS, 2 DGPS, 4 RTK fixed, 5 RTK float. */
  fixQuality?: number
  satellites?: number
  hdop?: number
  altitudeM?: number
  headingTrue?: number
  headingMag?: number
  /** Degrees, east positive. */
  variation?: number
  deviation?: number
  /** Apparent and true wind angle, signed: + starboard, − port. */
  awa?: number
  aws?: number
  twa?: number
  tws?: number
  /** True wind direction, degrees true. */
  twd?: number
  bsp?: number
  logNm?: number
  tripNm?: number
  /** Below the transducer, and the transducer offset DPT gives with it. */
  depthM?: number
  depthOffsetM?: number
  waterTempC?: number
  airTempC?: number
  baroHpa?: number
  humidityPct?: number
  /** Heel and pitch, degrees: heel + to starboard, pitch + bow up. */
  heel?: number
  pitch?: number
  /** Rudder angle, degrees; negative turns the bow to port. */
  rudder?: number
  /** Mast rotation, degrees; positive to starboard. */
  mastAngle?: number
  /** Rate of turn, degrees a minute; negative turns the bow to port. */
  rateOfTurn?: number
  /** Cross-track error, nm, and which way to steer to get back. */
  xteNm?: number
  steer?: 'L' | 'R'
  waypoint?: { id: string; lat?: number; lon?: number; rangeNm?: number; bearingTrue?: number }
  xdr?: XdrMeasurement[]
}

/** XOR of every character between `$`/`!` and `*`, as two upper-case hex digits. */
export function nmeaChecksum(body: string): string {
  let x = 0
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i)
  return x.toString(16).toUpperCase().padStart(2, '0')
}

/** A sentence with its checksum appended: for tests and for output. */
export function withChecksum(body: string): string {
  return `$${body}*${nmeaChecksum(body)}`
}

/** True when a line carries a checksum and it is wrong. */
export function checksumFails(line: string): boolean {
  const s = line.trim()
  const star = s.lastIndexOf('*')
  return star >= 0 && s.slice(star + 1, star + 3).toUpperCase() !== nmeaChecksum(s.slice(1, star))
}

export interface Sentence {
  talker: string
  type: string
  fields: string[]
}

/**
 * Split and check one line. A line with a checksum must match it; a line
 * without one is accepted, since some older instruments send none.
 */
export function parseSentence(line: string): Sentence | null {
  const s = line.trim()
  if (!s.startsWith('$')) return null
  if (checksumFails(s)) return null
  const star = s.lastIndexOf('*')
  const body = star >= 0 ? s.slice(1, star) : s.slice(1)
  const fields = body.split(',')
  const address = fields.shift() ?? ''
  if (address.startsWith('P')) return null // proprietary
  if (address.length !== 5) return null
  return { talker: address.slice(0, 2), type: address.slice(2), fields }
}

const num = (f: string | undefined): number | undefined => {
  if (f == null || f.trim() === '') return undefined
  const n = Number(f)
  return Number.isFinite(n) ? n : undefined
}

/** ddmm.mmmm plus a hemisphere into signed decimal degrees. */
function coord(v: string | undefined, hemi: string | undefined, degDigits: 2 | 3): number | undefined {
  if (!v || !hemi) return undefined
  const deg = Number(v.slice(0, degDigits))
  const min = Number(v.slice(degDigits))
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return undefined
  const d = deg + min / 60
  return hemi === 'S' || hemi === 'W' ? -d : d
}

const eastPositive = (v: number | undefined, dir: string | undefined) =>
  v == null ? undefined : dir === 'W' ? -v : v

/** 0–360 relative to the bow, as signed: + starboard, − port. */
const signedAngle = (a: number) => (a > 180 ? a - 360 : a)

const wrap = (a: number) => ((a % 360) + 360) % 360

function speedKn(v: number | undefined, unit: string | undefined): number | undefined {
  if (v == null) return undefined
  if (unit === 'K') return v / 1.852
  if (unit === 'M') return (v * 3600) / 1852
  return v // N
}

function hms(t: string | undefined): { h: number; m: number; s: number } | null {
  if (!t || t.length < 6) return null
  const h = Number(t.slice(0, 2))
  const m = Number(t.slice(2, 4))
  const s = Number(t.slice(4))
  return [h, m, s].every(Number.isFinite) ? { h, m, s } : null
}

function utcFrom(time: string | undefined, day: number, month: number, year: number): number | undefined {
  const t = hms(time)
  if (!t || !(day >= 1 && month >= 1 && month <= 12 && year > 1900)) return undefined
  return Date.UTC(year, month - 1, day, t.h, t.m, 0) + t.s * 1000
}

function xdr(fields: string[]): Partial<Reading> {
  const out: Partial<Reading> = { xdr: [] }
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const value = num(fields[i + 1])
    if (value == null) continue
    const m: XdrMeasurement = { type: fields[i], value, unit: fields[i + 2], name: fields[i + 3] }
    out.xdr!.push(m)
    const name = m.name.toUpperCase()
    if (m.type === 'A' && /HEEL|ROLL/.test(name)) out.heel = value
    else if (m.type === 'A' && /PTCH|PITCH/.test(name)) out.pitch = value
    else if (m.type === 'A' && /MAST/.test(name)) out.mastAngle = value
    else if (m.type === 'P') out.baroHpa = m.unit === 'B' ? value * 1000 : m.unit === 'P' ? value / 100 : undefined
    else if (m.type === 'C' && /AIR/.test(name)) out.airTempC = value
    else if (m.type === 'C' && /WATER|ENV_WATER/.test(name)) out.waterTempC = value
  }
  if (out.baroHpa == null) delete out.baroHpa
  return out
}

/** What one sentence says, or null for a sentence this decoder does not read. */
export function decode(s: Sentence): Partial<Reading> | null {
  const f = s.fields
  switch (s.type) {
    case 'RMC': {
      const out: Partial<Reading> = {}
      const date = f[8]
      if (date && date.length === 6) {
        const yy = Number(date.slice(4, 6))
        out.utc = utcFrom(f[0], Number(date.slice(0, 2)), Number(date.slice(2, 4)), yy < 80 ? 2000 + yy : 1900 + yy)
      }
      const v = eastPositive(num(f[9]), f[10])
      if (v != null) out.variation = v
      if (f[1] !== 'A') return clean(out)
      return clean({ ...out, lat: coord(f[2], f[3], 2), lon: coord(f[4], f[5], 3), sog: num(f[6]), cog: num(f[7]) })
    }
    case 'GGA': {
      const quality = num(f[5])
      const out: Partial<Reading> = { fixQuality: quality, satellites: num(f[6]), hdop: num(f[7]), altitudeM: num(f[8]) }
      if (quality) Object.assign(out, { lat: coord(f[1], f[2], 2), lon: coord(f[3], f[4], 3) })
      return clean(out)
    }
    case 'GLL':
      return f[5] === 'A' ? clean({ lat: coord(f[0], f[1], 2), lon: coord(f[2], f[3], 3) }) : {}
    case 'VTG':
      // Modern VTG labels each field; the oldest form has no labels at all.
      return f[1] === 'T' || f[1] === '' ? clean({ cog: num(f[0]), sog: num(f[4]) }) : clean({ cog: num(f[0]), sog: num(f[2]) })
    case 'HDG': {
      const mag = num(f[0])
      const dev = eastPositive(num(f[1]), f[2])
      const variation = eastPositive(num(f[3]), f[4])
      const out: Partial<Reading> = { headingMag: mag, deviation: dev, variation }
      if (mag != null && variation != null) out.headingTrue = wrap(mag + (dev ?? 0) + variation)
      return clean(out)
    }
    case 'HDM':
      return clean({ headingMag: num(f[0]) })
    case 'HDT':
      return clean({ headingTrue: num(f[0]) })
    case 'MWV': {
      if (f[4] !== 'A') return {}
      const angle = num(f[0])
      const speed = speedKn(num(f[2]), f[3])
      if (angle == null) return {}
      return f[1] === 'R'
        ? clean({ awa: signedAngle(angle), aws: speed })
        : clean({ twa: signedAngle(angle), tws: speed })
    }
    case 'MWD':
      return clean({ twd: num(f[0]), tws: num(f[4]) ?? speedKn(num(f[6]), 'M') })
    case 'VHW':
      return clean({ bsp: num(f[4]) ?? speedKn(num(f[6]), 'K'), headingTrue: num(f[0]), headingMag: num(f[2]) })
    case 'VLW':
      return clean({ logNm: num(f[0]), tripNm: num(f[2]) })
    case 'DPT':
      return clean({ depthM: num(f[0]), depthOffsetM: num(f[1]) })
    case 'DBT':
      return clean({ depthM: num(f[2]) ?? (num(f[0]) != null ? num(f[0])! * 0.3048 : undefined) })
    case 'MTW':
      return clean({ waterTempC: num(f[0]) })
    case 'MDA': {
      const bar = num(f[2])
      const inches = num(f[0])
      return clean({
        baroHpa: bar != null ? bar * 1000 : inches != null ? inches * 33.8639 : undefined,
        airTempC: num(f[4]),
        waterTempC: num(f[6]),
        humidityPct: num(f[8]),
        twd: num(f[12]),
        tws: num(f[16]),
      })
    }
    case 'XDR':
      return xdr(f)
    case 'RSA':
      return f[1] === 'A' ? clean({ rudder: num(f[0]) }) : {}
    case 'ROT':
      return f[1] === 'A' ? clean({ rateOfTurn: num(f[0]) }) : {}
    case 'ZDA': {
      const utc = utcFrom(f[0], Number(f[1]), Number(f[2]), Number(f[3]))
      return clean({ utc })
    }
    case 'XTE':
      if (f[0] !== 'A' || f[1] !== 'A') return {}
      return clean({ xteNm: num(f[2]), steer: steerDir(f[3]) })
    case 'APB':
      if (f[0] !== 'A' || f[1] !== 'A') return {}
      return clean({ xteNm: num(f[2]), steer: steerDir(f[3]), waypoint: f[9] ? { id: f[9] } : undefined })
    case 'RMB': {
      if (f[0] !== 'A') return {}
      return clean({
        xteNm: num(f[1]),
        steer: steerDir(f[2]),
        waypoint: {
          id: f[4],
          lat: coord(f[5], f[6], 2),
          lon: coord(f[7], f[8], 3),
          rangeNm: num(f[9]),
          bearingTrue: num(f[10]),
        },
      })
    }
    default:
      return null
  }
}

const steerDir = (d: string | undefined): 'L' | 'R' | undefined => (d === 'L' || d === 'R' ? d : undefined)

/** Drop the fields a sentence left empty, so they never overwrite a good value. */
function clean(r: Partial<Reading>): Partial<Reading> {
  const out: Partial<Reading> = {}
  for (const [k, v] of Object.entries(r)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/**
 * Turns a byte stream into the latest reading. Feed it whatever arrives; it
 * keeps a partial line until its end comes, and counts what it could not use.
 */
export class NmeaDecoder {
  reading: Reading = {}
  /** When each field was last set, by the clock passed to `feed`. */
  updated: Partial<Record<keyof Reading, number>> = {}
  stats = { sentences: 0, badChecksum: 0, unknown: 0 }
  private buffer = ''

  /** Lines that are not NMEA but Expedition's own protocol (`#...`) go here. */
  constructor(private readonly onHashLine?: (line: string) => void) {}

  feed(chunk: string, now = Date.now()): Array<Partial<Reading>> {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    // A stream that never sends a newline must not grow without bound.
    if (this.buffer.length > 1024) this.buffer = ''
    const out: Array<Partial<Reading>> = []
    for (const line of lines) {
      const r = this.line(line, now)
      if (r) out.push(r)
    }
    return out
  }

  line(line: string, now = Date.now()): Partial<Reading> | null {
    const t = line.trim()
    if (t.startsWith('#')) {
      this.onHashLine?.(t)
      return null
    }
    if (!t.startsWith('$')) return null
    const s = parseSentence(line)
    if (!s) {
      if (checksumFails(line)) this.stats.badChecksum++
      else this.stats.unknown++
      return null
    }
    const r = decode(s)
    if (!r) {
      this.stats.unknown++
      return null
    }
    this.stats.sentences++
    Object.assign(this.reading, r)
    for (const k of Object.keys(r) as Array<keyof Reading>) this.updated[k] = now
    return r
  }
}
