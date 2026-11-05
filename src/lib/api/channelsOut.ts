/**
 * Channels out: the app's channels, sent as JSON over a WebSocket to a server
 * the user names (a logger, a display, a script, a Signal K server). The
 * schema is in docs/09-api/channels-out.md; this file is its reference.
 *
 * A web app cannot listen for connections, so it connects out: to ws:// on
 * the boat's network (a page served over https may only reach wss://, or
 * ws://localhost), and reconnects, backing off, when the link drops.
 *
 *   → {"type":"hello","v":1,"app":"newjourney","channels":[{"id","name","unit","group"}…]}
 *   → {"type":"channels","v":1,"t":<ms>,"values":{"<id>":<number>…}}   (at the rate set)
 *   ← {"type":"subscribe","channels":["tws","twd"]} | {"type":"subscribe","channels":"*"}
 *   ← {"type":"ping"}  → {"type":"pong","t":<ms>}
 *
 * In Signal K form it sends deltas instead: the channels Signal K has paths
 * for, in its SI units, and no hello.
 */
import { CHANNELS } from '../channels/catalogue'
import type { ChannelValues } from '../channels/snapshot'
import type { ChannelsOutSettings } from './channelsOutSettings'

export const API_VERSION = 1

export { DEFAULT_CHANNELS_OUT, type ChannelsOutSettings, type OutFormat } from './channelsOutSettings'

export function helloFrame(): string {
  return JSON.stringify({
    type: 'hello',
    v: API_VERSION,
    app: 'newjourney',
    channels: CHANNELS.filter((c) => c.today).map((c) => ({ id: c.id, name: c.name, unit: c.unit, group: c.group })),
  })
}

/** The channels with a value, all of them or the ones subscribed to. */
export function channelFrame(values: ChannelValues, t: number, only: ReadonlySet<string> | null = null): string {
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(values)) {
    if (v == null || !Number.isFinite(v) || (only && !only.has(id))) continue
    out[id] = v
  }
  return JSON.stringify({ type: 'channels', v: API_VERSION, t, values: out })
}

const KN = 1852 / 3600
const DEG = Math.PI / 180

/** Channel id → Signal K path, and the factor from the catalogue's unit to SI. */
export const SIGNALK_PATHS: Readonly<Record<string, [string, number]>> = {
  sog: ['navigation.speedOverGround', KN],
  cog: ['navigation.courseOverGroundTrue', DEG],
  bsp: ['navigation.speedThroughWater', KN],
  heading: ['navigation.headingTrue', DEG],
  'heel-roll': ['navigation.attitude.roll', DEG],
  tws: ['environment.wind.speedTrue', KN],
  twd: ['environment.wind.directionTrue', DEG],
  twa: ['environment.wind.angleTrueWater', DEG],
  aws: ['environment.wind.speedApparent', KN],
  awa: ['environment.wind.angleApparent', DEG],
  vmg: ['performance.velocityMadeGood', KN],
  'target-bsp': ['performance.targetSpeed', KN],
  'target-twa': ['performance.targetAngle', DEG],
  'polar-bsp': ['performance.polarSpeed', KN],
  'current-set': ['environment.current.setTrue', DEG],
  'current-drift': ['environment.current.drift', KN],
}

/** A Signal K delta of the channels it has paths for; null when there are none. */
export function signalKDelta(values: ChannelValues, t: number): string | null {
  const out: Array<{ path: string; value: unknown }> = []
  const lat = values.latitude
  const lon = values.longtitude
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ path: 'navigation.position', value: { latitude: lat, longitude: lon } })
  for (const [id, [path, k]] of Object.entries(SIGNALK_PATHS)) {
    const v = values[id]
    if (v != null && Number.isFinite(v)) out.push({ path, value: v * k })
  }
  if (!out.length) return null
  return JSON.stringify({ updates: [{ source: { label: 'newjourney' }, timestamp: new Date(t).toISOString(), values: out }] })
}

export type OutStatus = 'off' | 'connecting' | 'open' | 'closed'

interface SocketLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((e: unknown) => void) | null
  onclose: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
}

const OPEN = 1

/**
 * One connection out. `push` is called with every snapshot (once a second
 * or so); frames go at most at the rate set. On a drop it reconnects after
 * 1, 2, 4 … 30 seconds.
 */
export class ChannelsOut {
  status: OutStatus = 'off'
  sent = 0
  private ws: SocketLike | null = null
  private only: Set<string> | null = null
  private lastSent = -Infinity
  private backoffS = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(
    private s: Pick<ChannelsOutSettings, 'url' | 'format' | 'rateHz'>,
    private onStatus: (s: OutStatus) => void = () => {},
    private open: (url: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike,
  ) {}

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    this.setStatus('off')
  }

  push(values: ChannelValues, t: number) {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN) return
    if (t - this.lastSent < 1000 / Math.max(0.1, this.s.rateHz) - 1) return
    const frame = this.s.format === 'signalk' ? signalKDelta(values, t) : channelFrame(values, t, this.only)
    if (!frame) return
    ws.send(frame)
    this.lastSent = t
    this.sent++
  }

  private setStatus(s: OutStatus) {
    this.status = s
    this.onStatus(s)
  }

  private connect() {
    if (this.stopped) return
    this.setStatus('connecting')
    let ws: SocketLike
    try {
      ws = this.open(this.s.url)
    } catch {
      this.retry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.backoffS = 1
      this.setStatus('open')
      if (this.s.format === 'json') ws.send(helloFrame())
    }
    ws.onmessage = (e) => this.receive(ws, e.data)
    ws.onerror = () => {}
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.setStatus('closed')
      this.retry()
    }
  }

  private retry() {
    if (this.stopped || this.timer) return
    const wait = this.backoffS
    this.backoffS = Math.min(30, this.backoffS * 2)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, wait * 1000)
  }

  /** What the far end may ask: which channels to send, and whether we are there. */
  private receive(ws: SocketLike, data: unknown) {
    if (typeof data !== 'string') return
    let m: { type?: string; channels?: unknown }
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (m.type === 'subscribe') {
      if (m.channels === '*') this.only = null
      else if (Array.isArray(m.channels)) this.only = new Set(m.channels.filter((c): c is string => typeof c === 'string'))
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }))
    }
  }
}
