import { describe, expect, it } from 'vitest'
import { dampedValue, situationIndex, situationOf } from './boxValue'
import { formatChannel } from './format'

describe('a number box', () => {
  it('damps over the seconds set, and angles around the circle', () => {
    const h: Array<[number, number]> = [[0, 4], [1000, 5], [2000, 6], [3000, 9]]
    expect(dampedValue(h, 3000, 10)).toBeCloseTo(6, 9)
    expect(dampedValue(h, 3000, 1.5)).toBeCloseTo(7.5, 9)
    // 358° and 4° average to 1°, not 181°; signed angles stay signed.
    expect(dampedValue([[0, 358], [1000, 4]], 1000, 10, 'unsigned')).toBeCloseTo(1, 6)
    expect(dampedValue([[0, -178], [1000, 176]], 1000, 10, 'signed')).toBeCloseTo(179, 6)
    expect(dampedValue([], 1000, 10)).toBeNull()
  })

  it('knows the point of sail against the target, and the prestart', () => {
    expect(situationOf({ twa: -42, 'target-twa': 40 })).toBe('upwind')
    expect(situationOf({ twa: 55, 'target-twa': 40 })).toBe('reaching')
    expect(situationOf({ twa: 55, 'target-twa': 40 }, 20)).toBe('upwind')
    expect(situationOf({ twa: 150, 'target-twa': 145 })).toBe('downwind')
    expect(situationOf({ twa: 120, 'target-twa': 145 })).toBe('reaching')
    expect(situationOf({ twa: 150, 'start-time-to-gun': 90 })).toBe('prestart')
    expect(situationOf({})).toBeNull()
    // Upwind, reaching, downwind, prestart; a box with fewer channels falls back to its first.
    expect(situationIndex('downwind', 4)).toBe(2)
    expect(situationIndex('prestart', 3)).toBe(0)
  })

  it('shows the decimals a box asks for', () => {
    expect(formatChannel({ id: 'bsp', unit: 'kn' }, 6.4567, 'metric', 3)!.text).toBe('6.457')
    expect(formatChannel({ id: 'twd', unit: 'deg' }, 205.46, 'metric', 1)!.text).toBe('205.5')
    expect(formatChannel({ id: 'twa', unit: 'deg' }, 42.3, 'metric', 1)!.text).toBe('+42.3')
    // Times keep their own form.
    expect(formatChannel({ id: 'start-time-to-gun', unit: 's' }, 75, 'metric', 2)!.text).toBe(formatChannel({ id: 'start-time-to-gun', unit: 's' }, 75)!.text)
  })
})
