/**
 * Sharing between copies of the app, through the bridge: what one navigator
 * sets (the course, the start line) and what one boat's instruments read,
 * passed to the others, on this machine or, over linked bridges, on the
 * boat's network. Expedition calls this networking between its computers.
 *
 * A message names its topic and the copy of the app it came from, so a copy
 * never takes back its own; the bridge sends each on to every other copy.
 */
import type { SignalKStatus } from './instruments/signalk'

export type ShareTopic = 'course' | 'start' | 'instruments'

export const SHARE_TOPICS: Array<{ id: ShareTopic; name: string }> = [
  { id: 'course', name: 'Course: the marks and the active one' },
  { id: 'start', name: 'Start line and gun' },
  { id: 'instruments', name: 'Instruments' },
]

export interface Shared {
  topic: ShareTopic
  data: unknown
  from: string
  t: number
}

/** This copy of the app, for as long as the page is open. */
export const APP_ID = `app-${Math.random().toString(36).slice(2, 10)}`

type SocketLike = {
  close(): void
  send(data: string): void
  readyState?: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface ShareOptions {
  onShared: (m: Shared) => void
  onStatus?: (s: SignalKStatus, detail?: string) => void
  socket?: (url: string) => SocketLike
  retryMs?: number
  id?: string
}

/** A link to the bridge for sharing, reconnecting with back-off until stopped. */
export class ShareLink {
  private ws: SocketLike | null = null
  private open = false
  private stopped = true
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  readonly url: string
  readonly id: string
  private readonly opts: ShareOptions

  constructor(url: string, opts: ShareOptions) {
    this.url = url
    this.opts = opts
    this.id = opts.id ?? APP_ID
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    const ws = this.ws
    this.ws = null
    this.open = false
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    this.opts.onStatus?.('off')
  }

  /** Send a topic's value to the other copies; nothing if the link is down. */
  send(topic: ShareTopic, data: unknown): boolean {
    if (!this.open || !this.ws) return false
    this.ws.send(JSON.stringify({ type: 'share', topic, data, from: this.id, t: Date.now() }))
    return true
  }

  private connect(): void {
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
    ws.onopen = () => {
      this.open = true
      this.attempts = 0
      this.opts.onStatus?.('connected')
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let m: { type?: string } & Partial<Shared>
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (m.type !== 'shared' || typeof m.topic !== 'string' || m.from === this.id) return
      this.opts.onShared({ topic: m.topic as ShareTopic, data: m.data, from: String(m.from), t: Number(m.t) || Date.now() })
    }
    ws.onerror = () => this.opts.onStatus?.('error', 'The connection to the bridge failed.')
    ws.onclose = () => {
      this.ws = null
      this.open = false
      if (this.stopped) return
      this.opts.onStatus?.('error', 'No bridge answered: is `node bridge/bridge.ts` running on this machine?')
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const wait = Math.min((this.opts.retryMs ?? 2000) * 2 ** this.attempts++, 30_000)
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped) this.connect()
    }, wait)
  }
}

/** Only the channels chosen, of an instrument reading (none chosen is all of them). */
export function filterReading<T extends Record<string, unknown>>(r: T, channels: string[]): Partial<T> {
  if (!channels.length) return { ...r }
  const out: Partial<T> = {}
  for (const k of channels) if (k in r) (out as Record<string, unknown>)[k] = r[k]
  return out
}

/**
 * Instrument readings taken from another copy of the app, for the peer source
 * in useInstruments to pass on as if they were its own instruments.
 */
export const peerReadings = {
  listeners: new Set<(r: Partial<Record<string, unknown>>) => void>(),
  subscribe(f: (r: Partial<Record<string, unknown>>) => void): () => void {
    this.listeners.add(f)
    return () => this.listeners.delete(f)
  },
  emit(r: Partial<Record<string, unknown>>): void {
    for (const f of this.listeners) f(r)
  },
}
