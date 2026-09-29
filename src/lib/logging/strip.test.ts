import { describe, expect, it } from 'vitest'
import { angleKind, meanBetween, sectionDelta, series, valueRange } from './strip'
import type { LogRow } from './logger'

const rows: LogRow[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, v: { bsp: 5 + i * 0.1, twd: i % 2 ? 355 : 5, twa: i < 5 ? 40 : -40 } }))

describe('the stripchart’s arithmetic', () => {
  it('takes a channel in a window, and thins it to what a pane can draw', () => {
    expect(series(rows, 'bsp', 2000, 4000).map(([t]) => t)).toEqual([2000, 3000, 4000])
    expect(series(rows, 'bsp', 0, 9000, 4)).toHaveLength(4)
    expect(series(rows, 'aws', 0, 9000)).toEqual([])
  })

  it('knows bearings from signed angles from plain numbers', () => {
    expect(angleKind('twd')).toBe('bearing')
    expect(angleKind('twa')).toBe('signed')
    expect(angleKind('bsp')).toBeNull()
  })

  it('averages between wands, angles on the circle, whichever way round the wands went', () => {
    expect(meanBetween(rows, 'bsp', 0, 4000)).toBeCloseTo(5.2, 9)
    expect(meanBetween(rows, 'bsp', 4000, 0)).toBeCloseTo(5.2, 9)
    // 355 and 5 alternate: north, not 180.
    const twd = meanBetween(rows, 'twd', 0, 9000)!
    expect(Math.min(twd, 360 - twd)).toBeCloseTo(0, 6)
    expect(meanBetween(rows, 'aws', 0, 9000)).toBeNull()
  })

  it('gives the change between sections, the short way round for angles', () => {
    expect(sectionDelta('bsp', 5.2, 5.7)).toBeCloseTo(0.5, 9)
    expect(sectionDelta('twd', 355, 5)).toBeCloseTo(10, 9)
    expect(sectionDelta('twa', 40, -40)).toBeCloseTo(-80, 9)
    expect(sectionDelta('bsp', null, 5)).toBeNull()
  })

  it('gives a pane a padded range that is never flat', () => {
    expect(valueRange([])).toEqual([0, 1])
    const [lo, hi] = valueRange([[0, 5], [1, 5]])
    expect(hi - lo).toBeCloseTo(1, 9)
  })
})
