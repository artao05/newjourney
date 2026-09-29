import { describe, expect, it } from 'vitest'
import { SailChartError, parseSailChart, sailAt, sailColour, sailsIn, serialiseSailChart } from './sailchart'

const TEXT = ['TWS\\TWA\t40\t60\t90\t120\t150\t180', '6\tJ1\tJ1\tC0\tA2\tA2\tA2', '12\tJ2\tJ2\tC0\tA2\tA4\tA4', '20\tJ3\tJ3\tC0\tA3\tA4\tA4'].join('\n')

describe("Expedition's sail chart", () => {
  it('reads the tab-separated table: angles across, speeds down, sails in the cells', () => {
    const c = parseSailChart(TEXT)
    expect(c.twa).toEqual([40, 60, 90, 120, 150, 180])
    expect(c.tws).toEqual([6, 12, 20])
    expect(c.cells[1]).toEqual(['J2', 'J2', 'C0', 'A2', 'A4', 'A4'])
  })

  it('reads a spreadsheet CSV export as well, and skips ! comments', () => {
    const csv = '! from Excel\nTWS,40,90\n8,J1,C0\n'
    expect(parseSailChart(csv).cells).toEqual([['J1', 'C0']])
  })

  it('picks the sail of the nearest angle and speed, on either tack', () => {
    const c = parseSailChart(TEXT)
    expect(sailAt(c, 42, 11)).toBe('J2')
    expect(sailAt(c, -42, 11)).toBe('J2')
    expect(sailAt(c, 145, 19)).toBe('A4')
    expect(sailAt(c, 100, 4)).toBe('C0')
    // Past the edges the edge sail holds.
    expect(sailAt(c, 180, 40)).toBe('A4')
  })

  it('has no sail where nothing is named, or with no chart', () => {
    const c = parseSailChart('TWS\t40\t90\n10\tJ1\t\n')
    expect(sailAt(c, 90, 10)).toBeNull()
    expect(sailAt(null, 40, 10)).toBeNull()
  })

  it('writes back what it read', () => {
    const c = parseSailChart(TEXT)
    expect(parseSailChart(serialiseSailChart(c))).toEqual(c)
  })

  it('refuses a table it cannot place, and says why', () => {
    expect(() => parseSailChart('only one line')).toThrow(SailChartError)
    expect(() => parseSailChart('TWS\t90\t40\n10\tA\tB')).toThrow(/increase across/)
    expect(() => parseSailChart('TWS\t40\n12\tJ1\n8\tJ2')).toThrow(/increase down/)
  })

  it('lists the sails, and colours each one the same way every time', () => {
    expect(sailsIn(parseSailChart(TEXT))).toEqual(['J1', 'C0', 'A2', 'J2', 'A4', 'J3', 'A3'])
    expect(sailColour('A2')).toBe(sailColour('A2'))
    expect(sailColour('A2')).not.toBe(sailColour('J1'))
  })
})
