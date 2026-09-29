import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignalKClient, mixedContentWarning, readingFromDelta, readingFromValue, type SignalKStatus } from './signalk'
import { boatStateFrom, headingTrueOf, windFrom } from './toBoat'
import type { Reading } from './nmea0183'

const SELF = 'vessels.urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d'

/**
 * A delta stream as signalk-server sends it with `subscribe=self`: the hello,
 * then updates from two sources, one AIS target relayed for another vessel,
 * and a line of noise. Values are SI: radians, m/s, metres, kelvin, pascals.
 */
const RECORDED = [
  JSON.stringify({ name: 'signalk-server', version: '2.8.0', self: SELF, roles: ['master', 'main'], timestamp: '2026-09-29T10:00:00.000Z' }),
  JSON.stringify({
    context: SELF,
    updates: [{
      $source: 'nmea0183.GP',
      timestamp: '2026-09-29T10:00:00.100Z',
      values: [
        { path: 'navigation.position', value: { latitude: 43.6591, longitude: -70.2468 } },
        { path: 'navigation.courseOverGroundTrue', value: 3.6652 },
        { path: 'navigation.speedOverGround', value: 3.0866 },
        { path: 'navigation.gnss.horizontalDilution', value: 0.8 },
        { path: 'navigation.gnss.satellites', value: 11 },
        { path: 'navigation.datetime', value: '2026-09-29T10:00:00.000Z' },
      ],
    }],
  }),
  JSON.stringify({
    context: SELF,
    updates: [{
      $source: 'can0.115',
      values: [
        { path: 'navigation.headingMagnetic', value: 3.8397 },
        { path: 'navigation.magneticVariation', value: -0.2531 },
        { path: 'navigation.speedThroughWater', value: 3.2408 },
        { path: 'navigation.attitude', value: { roll: -0.2094, pitch: 0.0262, yaw: 3.84 } },
        { path: 'environment.wind.angleApparent', value: -0.5236 },
        { path: 'environment.wind.speedApparent', value: 7.7167 },
        { path: 'environment.wind.angleTrueWater', value: -0.7854 },
        { path: 'environment.wind.speedTrue', value: 6.1733 },
        { path: 'environment.depth.belowTransducer', value: 12.4 },
        { path: 'environment.water.temperature', value: 290.65 },
        { path: 'environment.outside.pressure', value: 101320 },
        { path: 'steering.rudderAngle', value: 0.0524 },
        { path: 'navigation.log', value: 2286294 },
      ],
    }],
  }),
  JSON.stringify({
    context: 'vessels.urn:mrn:imo:mmsi:367001234',
    updates: [{ values: [{ path: 'navigation.position', value: { latitude: 43.7, longitude: -70.1 } }] }],
  }),
  'not json',
]

class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {}
  close() {
    this.closed = true
    this.onclose?.({})
  }
  send(data: string) {
    this.onmessage?.({ data })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Signal K deltas into a reading', () => {
  it('reads a recorded stream: SI units into knots and degrees, our boat only', () => {
    const sockets: FakeSocket[] = []
    const got: Reading = {}
    const statuses: SignalKStatus[] = []
    const c = new SignalKClient('ws://pi.local:3000/signalk/v1/stream?subscribe=self', {
      onReading: (r) => Object.assign(got, r),
      onStatus: (s) => statuses.push(s),
      socket: (url) => {
        const s = new FakeSocket(url)
        sockets.push(s)
        return s
      },
    })
    c.start()
    sockets[0].onopen?.({})
    for (const line of RECORDED) sockets[0].send(line)

    expect(statuses).toEqual(['connecting', 'connected'])
    expect(got.lat).toBe(43.6591) // the AIS target's position was not taken
    expect(got.lon).toBe(-70.2468)
    expect(got.cog).toBeCloseTo(210, 1)
    expect(got.sog).toBeCloseTo(6, 2)
    expect(got.bsp).toBeCloseTo(6.3, 2)
    expect(got.headingMag).toBeCloseTo(220, 1)
    expect(got.variation).toBeCloseTo(-14.5, 1)
    expect(got.heel).toBeCloseTo(-12, 1)
    expect(got.awa).toBeCloseTo(-30, 1)
    expect(got.aws).toBeCloseTo(15, 2)
    expect(got.twa).toBeCloseTo(-45, 1)
    expect(got.tws).toBeCloseTo(12, 2)
    expect(got.depthM).toBe(12.4)
    expect(got.waterTempC).toBeCloseTo(17.5, 6)
    expect(got.baroHpa).toBeCloseTo(1013.2, 6)
    expect(got.rudder).toBeCloseTo(3, 1)
    expect(got.logNm).toBeCloseTo(1234.5, 1)
    expect(got.hdop).toBe(0.8)
    expect(got.utc).toBe(Date.UTC(2026, 8, 29, 10))
    c.stop()
  })

  it('takes a delta with no context as ours, and ignores paths it does not know', () => {
    expect(readingFromDelta({ updates: [{ values: [{ path: 'navigation.speedThroughWater', value: 2.5722 }] }] }, null).bsp).toBeCloseTo(5, 3)
    expect(readingFromValue('electrical.batteries.1.voltage', 12.6)).toEqual({})
    expect(readingFromValue('navigation.position', null)).toEqual({})
    expect(readingFromValue('environment.wind.speedTrue', 'fast')).toEqual({})
  })
})

describe('the Signal K connection', () => {
  it('reconnects with a growing wait after the server goes away, and stops when told', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const statuses: SignalKStatus[] = []
    const c = new SignalKClient('ws://x', {
      onReading: () => {},
      onStatus: (s) => statuses.push(s),
      socket: (url) => {
        const s = new FakeSocket(url)
        sockets.push(s)
        return s
      },
      retryMs: 1000,
    })
    c.start()
    sockets[0].onopen?.({})
    sockets[0].onclose?.({})
    expect(statuses.at(-1)).toBe('closed')
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    // This one never opens: nobody is there, which is not the same as going away.
    sockets[1].onclose?.({})
    expect(statuses.at(-1)).toBe('error')
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    c.stop()
    expect(sockets[2].closed).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(3)
    expect(statuses.at(-1)).toBe('off')
  })

  it('warns when an https page asks for a plain ws server', () => {
    expect(mixedContentWarning('http:', 'ws://pi.local:3000')).toBeNull()
    expect(mixedContentWarning('https:', 'wss://pi.local:3000')).toBeNull()
    expect(mixedContentWarning('https:', 'ws://pi.local:3000/signalk')).toMatch(/block/)
    expect(mixedContentWarning('https:', 'ws://localhost:3000')).toMatch(/Chrome allows/)
  })
})

describe('an instrument reading as boat state and wind', () => {
  it('needs a position for a boat state, and leaves what was not sent unknown', () => {
    expect(boatStateFrom({ sog: 5 }, 1)).toBeNull()
    const b = boatStateFrom({ lat: 43, lon: -70, hdop: 1.2 }, 5)!
    expect(b).toMatchObject({ t: 5, position: { lat: 43, lon: -70 }, accuracyM: 6, heading: null, bsp: null, heelDeg: null })
    expect(Number.isNaN(b.cog)).toBe(true)
  })

  it('works heading true out of magnetic, deviation and variation', () => {
    expect(headingTrueOf({ headingMag: 220, variation: -14.5 })).toBeCloseTo(205.5, 9)
    expect(headingTrueOf({ headingMag: 5, deviation: -2, variation: -14.5 })).toBeCloseTo(348.5, 9)
    expect(headingTrueOf({ headingTrue: 90, headingMag: 100, variation: -14.5 })).toBe(90)
    expect(headingTrueOf({ headingMag: 220 })).toBeNull()
  })

  it('takes the true wind as sent, or from TWA and the heading', () => {
    expect(windFrom({ twd: 250, tws: 12 }, 7)).toEqual({ twd: 250, tws: 12, source: 'instrument', uncertaintyDeg: 3, t: 7 })
    expect(windFrom({ twa: -45, tws: 12, headingMag: 220, variation: -14.5 }, 7)!.twd).toBeCloseTo(160.5, 9)
    // Apparent wind alone is the pipeline's job (6.4), not a guess here.
    expect(windFrom({ awa: -30, aws: 15, headingTrue: 205 }, 7)).toBeNull()
  })
})
