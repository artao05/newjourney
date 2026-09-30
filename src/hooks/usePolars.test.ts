import { describe, expect, it } from 'vitest'
import { weighted } from './usePolars'
import { requestParts } from '@/lib/routing/settings'
import { DEFAULT_ROUTE_SETTINGS } from '@/lib/routing/settings'
import type { PolarTable } from '@/lib/types'

const table: PolarTable = { name: 't', tws: [6, 12], rows: [{ twa: [45, 90], bsp: [5, 6] }, { twa: [45, 90], bsp: [6, 7.5] }], reference: '10m' }

describe('wind weight', () => {
  it('scales the polar’s speeds, and leaves it alone at 1', () => {
    expect(weighted(table, 1.1)!.rows.map((r) => r.bsp.map((v) => +v.toFixed(3)))).toEqual([[5.5, 6.6], [6.6, 8.25]])
    expect(weighted(table, 1)).toBe(table)
    expect(weighted(null, 1.1)).toBeNull()
  })

  it('scales routing as the polar % does', () => {
    const boat = { polarPct: 95, polarPctNight: 90, tackPenaltyS: 10, gybePenaltyS: 10, windWeight: 1.1 }
    const p = requestParts(DEFAULT_ROUTE_SETTINGS, boat, true, 1)
    expect(p.scalings.polarPct).toBeCloseTo(104.5, 9)
    expect(p.scalings.polarPctNight).toBeCloseTo(99, 9)
    expect(requestParts(DEFAULT_ROUTE_SETTINGS, { ...boat, windWeight: undefined }, true, 1).scalings.polarPct).toBe(95)
  })
})
