/**
 * What the top-bar wind chip says. It is on every tab, and it is the only place a
 * sailor sees what the Start tab's bias and laylines rest on.
 */

import { describe, expect, it } from 'vitest'
import { STALE_MANUAL_MIN, windChip } from './WindSheet'

const NOW = Date.UTC(2026, 8, 27, 14, 0)
const MIN = 60_000
const manual = { twd: 235, tws: 14, source: 'manual' }

describe('windChip', () => {
  it('asks for a wind nobody has set', () => {
    expect(windChip(null, null, NOW)).toEqual({ text: 'set wind', warn: true })
  })

  it('says a wind is unavailable when one was set but none is in use', () => {
    // A failed forecast, say: the sailor has set a wind before, so "set wind" is
    // the wrong ask - the wind in use is what is missing.
    expect(windChip(null, NOW - 5 * MIN, NOW)).toEqual({ text: 'wind unavailable', warn: true })
  })

  it('names a fresh hand-set wind as manual, without an age', () => {
    expect(windChip(manual, NOW - (STALE_MANUAL_MIN - 1) * MIN, NOW)).toEqual({
      text: '235° · 14 kn · manual',
      warn: false,
    })
  })

  it('gives a hand-set wind its age once it is old enough to have shifted', () => {
    expect(windChip(manual, NOW - 45 * MIN, NOW)).toEqual({
      text: '235° · 14 kn · manual · 45 min old',
      warn: true,
    })
    expect(windChip(manual, NOW - 3 * 60 * MIN, NOW).text).toBe('235° · 14 kn · manual · 3 h old')
  })

  it('does not age a forecast by when a manual wind was last set', () => {
    const forecast = { twd: 200, tws: 9, source: 'forecast' }
    expect(windChip(forecast, NOW - 5 * 60 * MIN, NOW)).toEqual({
      text: '200° · 9 kn · forecast',
      warn: false,
    })
  })
})

describe('windChip in magnetic', () => {
  it('shows the compass bearing, marked M, for a wind held in true', () => {
    // 235 T at Portland's 14.46 W is 249.5 M: "variation west, magnetic best".
    expect(windChip(manual, NOW - 5 * MIN, NOW, -14.45669).text).toBe('249°M · 14 kn · manual')
  })
})
