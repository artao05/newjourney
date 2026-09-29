import { describe, expect, it } from 'vitest'
import { ChannelLogger, MemoryLogStore, dayOf, logToCsv, rowFrom, trimToCap } from './logger'

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
