/**
 * The local bridge (bridge/bridge.ts) as an instrument source: NMEA 0183, AIS
 * and NMEA 2000 lines from UDP and TCP on the boat's network, which a browser
 * cannot open itself, over a WebSocket on this machine.
 *
 * Each input's lines go through the same decoders as a serial port's: NMEA 0183
 * sentences (and AIS, and Expedition's own `#` commands) or NMEA 2000 frames as
 * text, by the format the bridge says the input speaks.
 */
import { NmeaDecoder, type Reading } from './nmea0183'
import { N2kDecoder } from './n2k'
import type { SignalKStatus } from './signalk'

/** An input as the bridge reports it (bridge/inputs.ts InputStatus). */
export interface BridgeInput {
  id: string
  kind: 'udp' | 'tcp-client' | 'tcp-server'
  format: 'nmea0183' | 'n2k'
  address: string
  state: string
  detail: string | null
  lines: number
  lastAt: number | null
}

type SocketLike = {
  close(): void
  send?(data: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface BridgeOptions {
  onReading: (r: Partial<Reading>) => void
  onStatus?: (s: SignalKStatus, detail?: string) => void
  onAisLine?: (line: string) => void
  onHashLine?: (line: string) => void
  /** The bridge's inputs, on connecting and whenever one changes. */
  onInputs?: (inputs: BridgeInput[]) => void
  /** For tests: something shaped like the WebSocket constructor. */
  socket?: (url: string) => SocketLike
  retryMs?: number
}

export { DEFAULT_BRIDGE_URL } from './defaults'

/** A bridge client that reconnects, with backoff, until stopped. */
export class BridgeClient {
  private ws: SocketLike | null = null
  private stopped = true
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private nmea = new Map<string, NmeaDecoder>()
  private n2k = new Map<string, N2kDecoder>()
  lines = 0
  readonly url: string
  private readonly opts: BridgeOptions

  constructor(url: string, opts: BridgeOptions) {
    this.url = url
    this.opts = opts
  }

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
    ws.onerror = () => this.opts.onStatus?.('error', 'The connection to the bridge failed.')
    ws.onclose = () => {
      this.ws = null
      if (this.stopped) return
      if (opened) this.opts.onStatus?.('closed', 'The bridge went away.')
      else this.opts.onStatus?.('error', 'No bridge answered: is `node bridge/bridge.ts` running on this machine?')
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

  /** One message from the bridge. Public for tests. */
  message(data: unknown): void {
    if (typeof data !== 'string') return
    let m: { type?: string; input?: string; format?: string; lines?: unknown; inputs?: BridgeInput[] }
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (m.type === 'hello' || m.type === 'status') {
      if (Array.isArray(m.inputs)) this.opts.onInputs?.(m.inputs)
      return
    }
    if (m.type !== 'lines' || !Array.isArray(m.lines) || typeof m.input !== 'string') return
    const lines = m.lines.filter((l): l is string => typeof l === 'string')
    this.lines += lines.length
    if (m.format === 'n2k') {
      let d = this.n2k.get(m.input)
      if (!d) this.n2k.set(m.input, (d = new N2kDecoder()))
      for (const l of lines) {
        const r = d.line(l)
        if (r && Object.keys(r).length) this.opts.onReading(r)
      }
      return
    }
    let d = this.nmea.get(m.input)
    if (!d) this.nmea.set(m.input, (d = new NmeaDecoder(this.opts.onHashLine, this.opts.onAisLine)))
    for (const r of d.feed(lines.join('\r\n') + '\r\n')) this.opts.onReading(r)
  }
}
