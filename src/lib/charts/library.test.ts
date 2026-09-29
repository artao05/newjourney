import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { MemoryCellStore, cellStore, groupCellFiles, mergeCell, setCellStore } from './library'
import { buoyUpdate, cell, update3 } from './fixtures/cell'
import { isZip, readZip } from '../zip'
import { installChartFiles, resetChartRestore, restoreCharts, uninstallCell, useCharts } from '@/state/charts'

/** A zip of the given entries: deflated, or stored when `store` is set. */
function zip(entries: Array<{ name: string; bytes: Uint8Array; store?: boolean }>): Uint8Array {
  const locals: number[] = []
  const central: number[] = []
  const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 255)
  for (const e of entries) {
    const name = [...new TextEncoder().encode(e.name)]
    const data = e.store ? e.bytes : new Uint8Array(deflateRawSync(e.bytes))
    const method = e.store ? 0 : 8
    const offset = locals.length
    locals.push(...le(0x04034b50, 4), ...le(20, 2), 0, 0, ...le(method, 2), 0, 0, 0, 0, ...le(0, 4), ...le(data.length, 4), ...le(e.bytes.length, 4), ...le(name.length, 2), 0, 0, ...name, ...data)
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), 0, 0, ...le(method, 2), 0, 0, 0, 0, ...le(0, 4), ...le(data.length, 4), ...le(e.bytes.length, 4), ...le(name.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, ...le(0, 4), ...le(offset, 4), ...name)
  }
  const n = entries.length
  const eocd = [...le(0x06054b50, 4), 0, 0, 0, 0, ...le(n, 2), ...le(n, 2), ...le(central.length, 4), ...le(locals.length, 4), 0, 0]
  return new Uint8Array([...locals, ...central, ...eocd])
}

describe('zip files', () => {
  it('reads stored and deflated entries, and passes folders over', () => {
    const a = new TextEncoder().encode('hello chart '.repeat(40))
    const z = zip([{ name: 'ENC_ROOT/', bytes: new Uint8Array(), store: true }, { name: 'ENC_ROOT/A.TXT', bytes: a }, { name: 'B.TXT', bytes: new Uint8Array([1, 2, 3]), store: true }])
    expect(isZip(z)).toBe(true)
    const got = readZip(z)
    expect(got.map((e) => e.name)).toEqual(['ENC_ROOT/A.TXT', 'B.TXT'])
    expect(new TextDecoder().decode(got[0].bytes)).toBe('hello chart '.repeat(40))
    expect([...got[1].bytes]).toEqual([1, 2, 3])
    expect(isZip(cell())).toBe(false)
    expect(() => readZip(cell())).toThrow(/not a zip/)
  })
})

describe('the chart library', () => {
  it('sorts files into cells, from loose files, folders and zipped exchange sets', () => {
    const base = cell()
    const u3 = update3()
    const { cells, skipped } = groupCellFiles([
      { name: 'ENC_ROOT/US5ME11M/US5ME11M.003', bytes: u3 },
      { name: 'ENC_ROOT/CATALOG.031', bytes: new Uint8Array([1]) },
      { name: 'readme.txt', bytes: new Uint8Array([1]) },
      { name: 'US5ME12M.zip', bytes: zip([{ name: 'ENC_ROOT/US5ME12M/US5ME12M.000', bytes: base }, { name: 'ENC_ROOT/US5ME12M/US5ME12M.001', bytes: u3 }, { name: 'ENC_ROOT/CATALOG.031', bytes: new Uint8Array([2]) }]) },
      { name: 'ENC_ROOT/US5ME11M/us5me11m.000', bytes: base },
    ])
    expect(cells.map((c) => [c.name, !!c.base, c.updates.map((u) => u.n)])).toEqual([
      ['US5ME11M', true, [3]],
      ['US5ME12M', true, [1]],
    ])
    expect(skipped).toEqual(['readme.txt'])
  })

  it('keeps a new base with its own updates, and adds updates to the installed cell', () => {
    const b = new Uint8Array([1])
    const installed = { name: 'X', base: b, updates: [{ n: 1, bytes: new Uint8Array([1]) }, { n: 2, bytes: new Uint8Array([2]) }], addedAt: 1 }
    const more = mergeCell(installed, { name: 'X', base: null, updates: [{ n: 2, bytes: new Uint8Array([22]) }, { n: 3, bytes: new Uint8Array([3]) }] }, 5)
    expect('error' in more).toBe(false)
    if ('error' in more) return
    expect(more.updates.map((u) => [u.n, u.bytes[0]])).toEqual([[1, 1], [2, 22], [3, 3]])
    expect(more.base).toBe(b)
    const fresh = mergeCell(installed, { name: 'X', base: new Uint8Array([9]), updates: [] }, 5)
    expect(fresh).toEqual({ name: 'X', base: new Uint8Array([9]), updates: [], addedAt: 5 })
    expect(mergeCell(undefined, { name: 'Y', base: null, updates: [{ n: 1, bytes: b }] }, 5)).toEqual({ error: 'Y: update files without the base cell (.000)' })
  })
})

describe('installing charts', () => {
  beforeEach(() => {
    setCellStore(new MemoryCellStore())
    resetChartRestore()
    useCharts.getState().clear()
  })
  afterEach(() => useCharts.getState().clear())

  it('installs a cell, brings it up to date with a later update, and draws it again next time', async () => {
    const first = await installChartFiles([{ name: 'US5ME11M.000', bytes: cell() }, { name: 'US5ME11M.003', bytes: update3() }])
    expect(first).toEqual({ installed: ['US5ME11M'], errors: [], skipped: [] })
    expect(useCharts.getState().cells.map((c) => [c.name, c.update])).toEqual([['US5ME11M.000', '3']])

    // Update 4 on its own: the installed cell is drawn again with 3 and 4.
    await installChartFiles([{ name: 'US5ME11M.004', bytes: buoyUpdate('US5ME11M.004', '7', 4, '4') }])
    const c = useCharts.getState().cells[0]
    expect(c.update).toBe('4')
    expect(c.features.find((f) => f.cls === 'BOYLAT')!.attrs.COLOUR).toBe('4')
    expect((await cellStore().list())[0].updates.map((u) => u.n)).toEqual([3, 4])

    // A new session: the chart comes back from the store.
    useCharts.getState().clear()
    await restoreCharts()
    expect(useCharts.getState().cells.map((x) => [x.name, x.update])).toEqual([['US5ME11M.000', '4']])

    await uninstallCell('US5ME11M.000')
    expect(useCharts.getState().cells).toEqual([])
    expect(await cellStore().list()).toEqual([])
  })

  it('says why a file could not be installed, and installs the rest', async () => {
    const r = await installChartFiles([
      { name: 'US5ME12M.001', bytes: update3() },
      { name: 'BROKEN01.000', bytes: new TextEncoder().encode('this is not a chart cell at all, not even close') },
      { name: 'US5ME11M.000', bytes: cell() },
    ])
    expect(r.installed).toEqual(['US5ME11M'])
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]).toMatch(/^BROKEN01: .*ISO 8211/)
    expect(r.errors[1]).toBe('US5ME12M: update files without the base cell (.000)')
    expect((await cellStore().list()).map((c) => c.name)).toEqual(['US5ME11M'])
  })
})
