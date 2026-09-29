import { describe, expect, it } from 'vitest'
import { ChannelLogger, MemoryLogStore, dayOf, logToCsv, polarPoints, rowFrom, trimToCap } from './logger'

const T = new Date(2026, 8, 29, 14, 0, 0).getTime()

describe('the channel logger', () => {
  it('keeps the channels that have a number, and not the clock', () => {
    expect(rowFrom(T, { bsp: 6.2, awa: null, sog: NaN, time: T, twd: 250 })).toEqual({ t: T, v: { bsp: 6.2, twd: 250 } })
  })

  it('logs at most once a second, and nothing for a second with no values', async () => {
    const store = new MemoryLogStore()
    const log = new ChannelLogger(store)
    expect(log.record(T, { bsp: 6 })).toBe(true)
    expect(log.record(T + 400, { bsp: 6.1 })).toBe(false)
    expect(log.record(T + 1000, { bsp: null })).toBe(false)
    expect(log.record(T + 1000, { bsp: 6.2 })).toBe(true)
    await log.flush()
    expect(await store.read(dayOf(T))).toEqual([
      { t: T, v: { bsp: 6 } },
      { t: T + 1000, v: { bsp: 6.2 } },
    ])
  })

  it('files rows under the local day they fall on, across midnight', async () => {
    const store = new MemoryLogStore()
    const log = new ChannelLogger(store)
    const late = new Date(2026, 8, 29, 23, 59, 59).getTime()
    log.record(late, { sog: 5 })
    log.record(late + 2000, { sog: 5.1 })
    await log.flush()
    expect((await store.days()).map((d) => d.day).sort()).toEqual(['2026-09-29', '2026-09-30'])
  })

  it('writes on its own once enough rows are waiting', async () => {
    const store = new MemoryLogStore()
    const log = new ChannelLogger(store, { flushRows: 3 })
    for (let i = 0; i < 3; i++) log.record(T + i * 1000, { bsp: i })
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.days())[0].rows).toBe(3)
  })

  it('drops whole days, oldest first, to stay under the cap, and never today', async () => {
    const store = new MemoryLogStore()
    await store.append('2026-09-20', Array.from({ length: 5 }, (_, i) => ({ t: i, v: { bsp: 1 } })))
    await store.append('2026-09-25', Array.from({ length: 5 }, (_, i) => ({ t: i, v: { bsp: 1 } })))
    await store.append('2026-09-29', Array.from({ length: 8 }, (_, i) => ({ t: i, v: { bsp: 1 } })))
    expect(await trimToCap(store, 13)).toEqual(['2026-09-20'])
    expect(await trimToCap(store, 1)).toEqual(['2026-09-25'])
    expect((await store.days()).map((d) => d.day)).toEqual(['2026-09-29'])
  })
})

describe('a log as CSV', () => {
  it('has UTC time, then a column per channel used, named and in catalogue order', () => {
    const csv = logToCsv([
      { t: Date.UTC(2026, 8, 29, 10), v: { twd: 250, bsp: 6.2 } },
      { t: Date.UTC(2026, 8, 29, 10, 0, 1), v: { bsp: 6.3 } },
    ])
    const [head, a, b] = csv.trim().split('\n')
    expect(head).toBe('Utc,Twd,Bsp')
    expect(a).toBe('2026-09-29T10:00:00.000Z,250,6.2')
    expect(b).toBe('2026-09-29T10:00:01.000Z,,6.3')
  })
})

describe('logged points on the polar', () => {
  // A polar that does 6 kn at every angle and wind.
  const speedAt = () => 6
  const row = (twa: number, tws: number, bsp: number) => ({ t: 0, v: { twa, tws, bsp } })

  it('takes the seconds near a plotted wind speed, by tack, hollow when slower than the polar', () => {
    const pts = polarPoints([row(42, 10.5, 6.3), row(-40, 9.2, 5.5), row(90, 13, 7), row(45, 10, 0.1)], speedAt, [10, 16])
    expect(pts).toEqual([
      { twa: 42, bsp: 6.3, tws: 10.5, tack: 'starboard', below: false },
      { twa: -40, bsp: 5.5, tws: 9.2, tack: 'port', below: true },
    ])
  })

  it('needs all three of TWA, TWS and boat speed', () => {
    expect(polarPoints([{ t: 0, v: { twa: 40, tws: 10 } }], speedAt, [10])).toEqual([])
  })
})

describe('the band of wind speeds points are taken from', () => {
  it('is half the gap between the plotted curves, and at least a knot', async () => {
    const { bandFor } = await import('@/components/PolarWithLog')
    expect(bandFor([6, 10, 14, 20])).toBe(2)
    expect(bandFor([2, 4, 6, 8])).toBe(1)
    expect(bandFor([16, 20, 25, 30])).toBe(2)
    expect(bandFor([10])).toBe(1)
  })
})
