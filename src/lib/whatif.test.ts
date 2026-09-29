import { describe, expect, it } from 'vitest'
import { NO_WHAT_IF, applyWhatIfCurrent, applyWhatIfWind, describeWhatIf, whatIfActive } from './whatif'

const WIND = { twd: 350, tws: 12, source: 'manual' as const, uncertaintyDeg: 8, t: 0 }
const CURRENT = { set: 90, drift: 0.4, source: 'sim' }

describe('what-if', () => {
  it('changes nothing when nothing is set', () => {
    expect(whatIfActive(NO_WHAT_IF)).toBe(false)
    expect(applyWhatIfWind(WIND, NO_WHAT_IF)).toBe(WIND)
    expect(applyWhatIfCurrent(CURRENT, NO_WHAT_IF)).toBe(CURRENT)
  })

  it('shifts and scales the wind, wrapping and never below half a knot', () => {
    const w = applyWhatIfWind(WIND, { ...NO_WHAT_IF, shiftDeg: 20, speedDeltaKn: -15 })!
    expect(w.twd).toBe(10)
    expect(w.tws).toBe(0.5)
    expect(w.source).toBe('manual')
  })

  it('replaces the current, even where there was none', () => {
    const w = { ...NO_WHAT_IF, current: { set: 405, drift: 0.8 } }
    expect(applyWhatIfCurrent(null, w)).toEqual({ set: 45, drift: 0.8, source: 'what-if' })
    expect(whatIfActive(w)).toBe(true)
  })

  it('says what is on, for the banner every screen shows', () => {
    expect(describeWhatIf({ shiftDeg: 10, speedDeltaKn: -2, current: { set: 45, drift: 0.8 } })).toBe(
      '+10° shift, -2 kn, current 045° 0.8 kn',
    )
  })
})
