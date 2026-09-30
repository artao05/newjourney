import { describe, expect, it, vi } from 'vitest'
import { BridgeClient, type BridgeInput } from './bridge'
import type { Reading } from './nmea0183'

/** A socket the test drives. */
function fakeSocket() {
  const s = {
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    closed: false,
    close() {
      s.closed = true
    },
    say(m: object) {
      s.onmessage?.({ data: JSON.stringify(m) })
    },
  }
  return s
}

const nmea = (body: string) => {
  let x = 0
  for (const c of body) x ^= c.charCodeAt(0)
  return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`
}

describe('the bridge as an instrument source', () => {
  it('lists its inputs, and reads NMEA 0183, AIS and Expedition lines by input', () => {
    const socks: Array<ReturnType<typeof fakeSocket>> = []
    const readings: Array<Partial<Reading>> = []
    const ais: string[] = []
    const hash: string[] = []
    let inputs: BridgeInput[] = []
    const c = new BridgeClient('ws://127.0.0.1:3080', {
      onReading: (r) => readings.push(r),
      onAisLine: (l) => ais.push(l),
      onHashLine: (l) => hash.push(l),
      onInputs: (i) => (inputs = i),
      socket: () => {
        const s = fakeSocket()
        socks.push(s)
        return s
      },
    })
    c.start()
    socks[0].onopen?.({})
    socks[0].say({ type: 'hello', bridge: 'newjourney-bridge', version: 1, inputs: [{ id: 'udp:10110', kind: 'udp', format: 'nmea0183', address: '0.0.0.0:10110', state: 'listening', detail: null, lines: 0, lastAt: null }] })
    expect(inputs.map((i) => i.id)).toEqual(['udp:10110'])
    socks[0].say({ type: 'lines', input: 'udp:10110', format: 'nmea0183', lines: [nmea('IIMWV,330.0,R,17.0,N,A'), '!AIVDM,1,1,,A,15N7KvPP1krvJtPHvUH3eS000000,0*70', '#GUN,120000'] })
    expect(Object.assign({}, ...readings)).toMatchObject({ awa: -30, aws: 17 })
    expect(ais).toHaveLength(1)
    expect(hash).toEqual(['#GUN,120000'])
    expect(c.lines).toBe(3)
    c.stop()
  })

  it('tries again when there is no bridge, and says how to start one', () => {
    vi.useFakeTimers()
    try {
      const socks: Array<ReturnType<typeof fakeSocket>> = []
      const said: string[] = []
      const c = new BridgeClient('ws://127.0.0.1:3080', {
        onReading: () => undefined,
        onStatus: (s, d) => said.push(`${s}${d ? `: ${d}` : ''}`),
        retryMs: 100,
        socket: () => {
          const s = fakeSocket()
          socks.push(s)
          return s
        },
      })
      c.start()
      socks[0].onclose?.({})
      expect(said.at(-1)).toMatch(/node bridge\/bridge\.ts/)
      vi.advanceTimersByTime(100)
      expect(socks).toHaveLength(2)
      c.stop()
      expect(said.at(-1)).toBe('off')
    } finally {
      vi.useRealTimers()
    }
  })
})
