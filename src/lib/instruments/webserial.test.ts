import { afterEach, describe, expect, it, vi } from 'vitest'
import { SerialNmeaSource, choosePort, grantedPort, webSerialAvailable, type SerialPortLike } from './webserial'
import { withChecksum, type Reading } from './nmea0183'
import type { SignalKStatus } from './signalk'

/** A port that plays back byte chunks, the way an adaptor delivers them: anywhere mid-line. */
function mockPort(chunks: string[], opts: { failOpen?: boolean; throwAfter?: boolean } = {}) {
  const enc = new TextEncoder()
  const queue = chunks.map((c) => enc.encode(c))
  const port = {
    opened: null as null | { baudRate: number },
    closed: false,
    cancelled: false,
    async open(o: { baudRate: number }) {
      if (opts.failOpen) throw new Error('The port is already open.')
      port.opened = o
    },
    async close() {
      port.closed = true
    },
    readable: {
      getReader: () => ({
        read: async () => {
          if (port.cancelled) return { done: true }
          const value = queue.shift()
          if (value) return { value, done: false }
          if (opts.throwAfter) throw new Error('The device has been lost.')
          return { done: true }
        },
        cancel: async () => {
          port.cancelled = true
        },
        releaseLock: () => {},
      }),
    },
  }
  return port satisfies SerialPortLike
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NMEA 0183 over a serial port', () => {
  it('opens at the baud rate, decodes lines split across chunks, and closes at the end', async () => {
    const rmc = withChecksum('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W')
    const mwv = withChecksum('IIMWV,315.0,R,12.4,N,A')
    const port = mockPort([rmc.slice(0, 30), rmc.slice(30) + '\r\n' + mwv.slice(0, 5), mwv.slice(5) + '\r\n$GPHDT,1*00\r\n'])
    const got: Reading = {}
    const statuses: SignalKStatus[] = []
    const src = new SerialNmeaSource(async () => port, 4800, {
      onReading: (r) => Object.assign(got, r),
      onStatus: (s) => statuses.push(s),
    })
    await src.start()
    expect(port.opened).toEqual({ baudRate: 4800 })
    expect(got).toMatchObject({ sog: 22.4, cog: 84.4, awa: -45, aws: 12.4 })
    expect(src.decoder.stats.badChecksum).toBe(1)
    expect(port.closed).toBe(true)
    expect(statuses).toEqual(['connecting', 'connected', 'closed'])
  })

  it('says what went wrong: no port granted, a port that will not open, an adaptor pulled out', async () => {
    const statuses: Array<[SignalKStatus, string | undefined]> = []
    const onStatus = (s: SignalKStatus, d?: string) => statuses.push([s, d])
    await new SerialNmeaSource(async () => null, 4800, { onReading: () => {}, onStatus }).start()
    expect(statuses.at(-1)).toEqual(['error', 'Choose the serial port again: press CONNECT SERIAL.'])
    await new SerialNmeaSource(async () => mockPort([], { failOpen: true }), 4800, { onReading: () => {}, onStatus }).start()
    expect(statuses.at(-1)).toEqual(['error', 'The port is already open.'])
    const pulled = mockPort([withChecksum('IIHDT,10.0,T') + '\n'], { throwAfter: true })
    await new SerialNmeaSource(async () => pulled, 4800, { onReading: () => {}, onStatus }).start()
    expect(statuses.at(-1)).toEqual(['closed', undefined])
    expect(statuses.at(-2)).toEqual(['error', 'The device has been lost.'])
    expect(pulled.closed).toBe(true)
  })

  it('stops mid-read when stopped, and closes the port', async () => {
    const port = mockPort(Array.from({ length: 1000 }, () => withChecksum('IIHDT,10.0,T') + '\n'))
    const statuses: SignalKStatus[] = []
    let readings = 0
    let stopping: Promise<void> | null = null
    const src = new SerialNmeaSource(async () => port, 9600, {
      onReading: () => {
        if (++readings === 5) stopping = src.stop()
      },
      onStatus: (s) => statuses.push(s),
    })
    await src.start()
    await stopping
    expect(readings).toBe(5)
    expect(port.cancelled).toBe(true)
    expect(port.closed).toBe(true)
    expect(statuses).toEqual(['connecting', 'connected', 'off'])
  })

  it('never opens a port it was stopped before reaching', async () => {
    const port = mockPort([])
    const src = new SerialNmeaSource(async () => port, 4800, { onReading: () => {} })
    const running = src.start()
    await src.stop()
    await running
    expect(port.opened).toBeNull()
  })
})

describe('choosing a port', () => {
  it('knows when the browser has no Web Serial', async () => {
    vi.stubGlobal('navigator', {})
    expect(webSerialAvailable()).toBe(false)
    expect(await choosePort()).toBeNull()
  })

  it('remembers the chosen port, and finds a granted one after a reload', async () => {
    const granted = mockPort([])
    const chosen = mockPort([])
    vi.stubGlobal('navigator', { serial: { requestPort: async () => chosen, getPorts: async () => [granted] } })
    expect(webSerialAvailable()).toBe(true)
    expect(await choosePort()).toBe(chosen)
    expect(await grantedPort()).toBe(chosen)
  })
})
