import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelsOut, channelFrame, helloFrame, signalKDelta, type OutStatus } from './channelsOut'
import { CHANNELS } from '../channels/catalogue'

class FakeSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
  }
  /** The far end, for the test. */
  accept() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

afterEach(() => vi.useRealTimers())

describe('channels out: the frames', () => {
  it('says hello with the channels this build produces', () => {
    const h = JSON.parse(helloFrame())
    expect(h).toMatchObject({ type: 'hello', v: 1, app: 'newjourney' })
    expect(h.channels).toHaveLength(CHANNELS.filter((c) => c.today).length)
    expect(h.channels.find((c: { id: string }) => c.id === 'tws')).toEqual({ id: 'tws', name: 'Tws', unit: 'kn', group: 'wind' })
  })

  it('sends the channels with a value, all or those subscribed to', () => {
    const values = { tws: 12.4, twd: 205, sog: null, bsp: Number.NaN }
    expect(JSON.parse(channelFrame(values, 1000))).toEqual({ type: 'channels', v: 1, t: 1000, values: { tws: 12.4, twd: 205 } })
    expect(JSON.parse(channelFrame(values, 1000, new Set(['twd']))).values).toEqual({ twd: 205 })
  })

  it('sends Signal K deltas in SI units, position as one value', () => {
    const d = JSON.parse(signalKDelta({ latitude: 43.65, longtitude: -70.2, sog: 6, twd: 180, 'current-drift': 1, bogus: 3 }, Date.UTC(2026, 8, 29, 12))!)
    const u = d.updates[0]
    expect(u.source).toEqual({ label: 'newjourney' })
    expect(u.timestamp).toBe('2026-09-29T12:00:00.000Z')
    const v = Object.fromEntries(u.values.map((x: { path: string; value: unknown }) => [x.path, x.value]))
    expect(v['navigation.position']).toEqual({ latitude: 43.65, longitude: -70.2 })
    expect(v['navigation.speedOverGround']).toBeCloseTo((6 * 1852) / 3600, 9)
    expect(v['environment.wind.directionTrue']).toBeCloseTo(Math.PI, 9)
    expect(v['environment.current.drift']).toBeCloseTo(1852 / 3600, 9)
    expect(Object.keys(v)).toHaveLength(4)
    expect(signalKDelta({ bogus: 1 }, 0)).toBeNull()
  })
})

describe('channels out: the connection', () => {
  function open(format: 'json' | 'signalk' = 'json', rateHz = 1) {
    const sockets: FakeSocket[] = []
    const statuses: OutStatus[] = []
    const c = new ChannelsOut({ url: 'ws://boat:8765', format, rateHz }, (s) => statuses.push(s), (u) => {
      const s = new FakeSocket(u)
      sockets.push(s)
      return s
    })
    return { c, sockets, statuses }
  }

  it('says hello on connecting, then sends at the rate set and not faster', () => {
    const { c, sockets, statuses } = open()
    c.start()
    expect(sockets[0].url).toBe('ws://boat:8765')
    c.push({ tws: 10 }, 0)
    expect(sockets[0].sent).toEqual([])
    sockets[0].accept()
    expect(JSON.parse(sockets[0].sent[0]).type).toBe('hello')
    c.push({ tws: 10 }, 1000)
    c.push({ tws: 11 }, 1400)
    c.push({ tws: 12 }, 2000)
    expect(sockets[0].sent.slice(1).map((m) => JSON.parse(m).values.tws)).toEqual([10, 12])
    expect(c.sent).toBe(2)
    expect(statuses).toEqual(['connecting', 'open'])
  })

  it('sends only what the far end subscribes to, and answers a ping', () => {
    const { c, sockets } = open()
    c.start()
    sockets[0].accept()
    sockets[0].say({ type: 'subscribe', channels: ['twd'] })
    c.push({ tws: 10, twd: 200 }, 1000)
    expect(JSON.parse(sockets[0].sent.at(-1)!).values).toEqual({ twd: 200 })
    sockets[0].say({ type: 'subscribe', channels: '*' })
    c.push({ tws: 10, twd: 200 }, 2000)
    expect(JSON.parse(sockets[0].sent.at(-1)!).values).toEqual({ tws: 10, twd: 200 })
    sockets[0].say({ type: 'ping' })
    expect(JSON.parse(sockets[0].sent.at(-1)!).type).toBe('pong')
    // Nonsense is ignored.
    sockets[0].onmessage?.({ data: 'not json' })
    expect(c.status).toBe('open')
  })

  it('reconnects when the link drops, backing off, and stops when told', () => {
    vi.useFakeTimers()
    const { c, sockets, statuses } = open()
    c.start()
    sockets[0].drop()
    expect(statuses.at(-1)).toBe('closed')
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].drop()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    // Connected again, the wait starts over.
    sockets[2].accept()
    sockets[2].drop()
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(4)
    c.stop()
    expect(sockets[3].closed).toBe(true)
    expect(c.status).toBe('off')
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(4)
  })

  it('sends Signal K with no hello', () => {
    const { c, sockets } = open('signalk')
    c.start()
    sockets[0].accept()
    c.push({ sog: 5 }, 1000)
    expect(sockets[0].sent).toHaveLength(1)
    expect(JSON.parse(sockets[0].sent[0]).updates[0].values[0].path).toBe('navigation.speedOverGround')
  })
})
