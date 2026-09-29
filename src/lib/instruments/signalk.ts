/**
 * Signal K: the boat's instruments over a WebSocket.
 *
 * A Signal K server (on a Raspberry Pi, a Cerbo, or built into a gateway)
 * already reads the NMEA 0183 and NMEA 2000 buses, so a browser only has to
 * listen to its delta stream. Values arrive in SI units, angles in radians,
 * and are turned into the same `Reading` the NMEA 0183 decoder produces, so
 * everything downstream has one shape to deal with.
 */

import type { Reading } from './nmea0183'

export const DEFAULT_SIGNALK_URL = 'ws://localhost:3000/signalk/v1/stream?subscribe=self'

const DEG = 180 / Math.PI
const MS_TO_KN = 3600 / 1852
const M_TO_NM = 1 / 1852

interface DeltaValue {
  path: string
  value: unknown
}

export interface Delta {
  context?: string
  updates?: Array<{ timestamp?: string; values?: DeltaValue[] }>
}

const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const scaled = (v: unknown, k: number, offset = 0) => {
  const x = n(v)
  return x == null ? undefined : x * k + offset
}
const wrap = (a: number) => ((a % 360) + 360) % 360
/** Signal K angles relative to the bow run −π..π, port negative, as ours do. */
const signed = (rad: unknown) => {
  const d = scaled(rad, DEG)
  return d == null ? undefined : d > 180 ? d - 360 : d
}
const bearing = (rad: unknown) => {
  const d = scaled(rad, DEG)
  return d == null ? undefined : wrap(d)
}

/** One path and value into the reading fields it sets. */
export function readingFromValue(path: string, value: unknown): Partial<Reading> {
  switch (path) {
    case 'navigation.position': {
      const p = value as { latitude?: unknown; longitude?: unknown } | null
      const lat = n(p?.latitude)
      const lon = n(p?.longitude)
      return lat != null && lon != null ? { lat, lon } : {}
    }
    case 'navigation.courseOverGroundTrue':
      return def({ cog: bearing(value) })
    case 'navigation.speedOverGround':
      return def({ sog: scaled(value, MS_TO_KN) })
    case 'navigation.headingTrue':
      return def({ headingTrue: bearing(value) })
    case 'navigation.headingMagnetic':
      return def({ headingMag: bearing(value) })
    case 'navigation.magneticVariation':
      return def({ variation: signed(value) })
    case 'navigation.speedThroughWater':
      return def({ bsp: scaled(value, MS_TO_KN) })
    case 'navigation.attitude': {
      const a = value as { roll?: unknown; pitch?: unknown } | null
      return def({ heel: signed(a?.roll), pitch: signed(a?.pitch) })
    }
    case 'navigation.rateOfTurn':
      return def({ rateOfTurn: scaled(value, DEG * 60) })
    case 'navigation.log':
      return def({ logNm: scaled(value, M_TO_NM) })
    case 'navigation.trip.log':
      return def({ tripNm: scaled(value, M_TO_NM) })
    case 'navigation.datetime': {
      const t = typeof value === 'string' ? Date.parse(value) : NaN
      return Number.isFinite(t) ? { utc: t } : {}
    }
    case 'navigation.gnss.satellites':
      return def({ satellites: n(value) })
    case 'navigation.gnss.horizontalDilution':
      return def({ hdop: n(value) })
    case 'environment.wind.angleApparent':
      return def({ awa: signed(value) })
    case 'environment.wind.speedApparent':
      return def({ aws: scaled(value, MS_TO_KN) })
    case 'environment.wind.angleTrueWater':
      return def({ twa: signed(value) })
    case 'environment.wind.speedTrue':
      return def({ tws: scaled(value, MS_TO_KN) })
    case 'environment.wind.directionTrue':
      return def({ twd: bearing(value) })
    case 'environment.depth.belowTransducer':
      return def({ depthM: n(value) })
    case 'environment.depth.transducerToKeel':
      return def({ depthOffsetM: scaled(value, -1) })
    case 'environment.depth.surfaceToTransducer':
      return def({ depthOffsetM: n(value) })
    case 'environment.water.temperature':
      return def({ waterTempC: scaled(value, 1, -273.15) })
    case 'environment.outside.temperature':
      return def({ airTempC: scaled(value, 1, -273.15) })
    case 'environment.outside.pressure':
      return def({ baroHpa: scaled(value, 0.01) })
    case 'environment.outside.humidity':
    case 'environment.outside.relativeHumidity':
      return def({ humidityPct: scaled(value, 100) })
    case 'steering.rudderAngle':
      return def({ rudder: signed(value) })
    default:
      return {}
  }
}

function def(r: Partial<Reading>): Partial<Reading> {
  const out: Partial<Reading> = {}
  for (const [k, v] of Object.entries(r)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/**
 * What a delta says about our own boat. Deltas for other vessels (AIS targets
 * relayed by the server) are ignored; `self` is the context the server's
 * hello message named, and a delta with no context is ours by definition.
 */
export function readingFromDelta(delta: Delta, self: string | null): Partial<Reading> {
  if (delta.context && self && delta.context !== self && delta.context !== 'vessels.self') return {}
  if (delta.context && !self && !delta.context.startsWith('vessels.')) return {}
  const out: Partial<Reading> = {}
  for (const u of delta.updates ?? []) for (const v of u.values ?? []) Object.assign(out, readingFromValue(v.path, v.value))
  return out
}

/**
 * Why a browser would refuse this URL from this page, or null. An https page
 * may not open a plain ws:// socket; Chromium makes an exception for localhost.
 */
export function mixedContentWarning(pageProtocol: string, url: string): string | null {
  if (pageProtocol !== 'https:' || !/^ws:\/\//i.test(url)) return null
  const host = url.replace(/^ws:\/\//i, '').split(/[/:]/)[0]
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return 'This page is https and the server is plain ws on this device: Chrome allows that, Safari and Firefox may not.'
  }
  return 'This page is https, so the browser will block a plain ws:// server. Use wss://, or open the app over http on the boat network.'
}

export type SignalKStatus = 'off' | 'connecting' | 'connected' | 'closed' | 'error'

type SocketLike = Pick<WebSocket, 'close'> & {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface SignalKOptions {
  onReading: (r: Partial<Reading>) => void
  onStatus?: (s: SignalKStatus, detail?: string) => void
  /** For tests: something shaped like the WebSocket constructor. */
  socket?: (url: string) => SocketLike
  retryMs?: number
}

/** A delta-stream client that reconnects, with backoff, until stopped. */
export class SignalKClient {
  private ws: SocketLike | null = null
  private self: string | null = null
  private stopped = true
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  deltas = 0

  constructor(
    readonly url: string,
    private readonly opts: SignalKOptions,
  ) {}

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    this.opts.onStatus?.('off')
  }

  private open(): void {
    this.opts.onStatus?.('connecting')
    let ws: SocketLike
    try {
      ws = this.opts.socket ? this.opts.socket(this.url) : (new WebSocket(this.url) as unknown as SocketLike)
    } catch (e) {
      this.opts.onStatus?.('error', e instanceof Error ? e.message : String(e))
      this.scheduleRetry()
      return
    }
    this.ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.attempts = 0
      this.opts.onStatus?.('connected')
    }
    ws.onmessage = (ev) => this.message(ev.data)
    ws.onerror = () => this.opts.onStatus?.('error', 'The connection failed.')
    ws.onclose = () => {
      this.ws = null
      if (this.stopped) return
      // Never opened: the server was not there. Opened and then closed: it went away.
      if (opened) this.opts.onStatus?.('closed')
      else this.opts.onStatus?.('error', 'No server answered at that address.')
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const base = this.opts.retryMs ?? 2000
    const wait = Math.min(base * 2 ** this.attempts++, 30_000)
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped) this.open()
    }, wait)
  }

  private message(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const m = msg as Delta & { self?: string }
    if (typeof m.self === 'string' && !m.updates) {
      this.self = m.self.startsWith('vessels.') ? m.self : `vessels.${m.self}`
      return
    }
    const r = readingFromDelta(m, this.self)
    this.deltas++
    if (Object.keys(r).length) this.opts.onReading(r)
  }
}
