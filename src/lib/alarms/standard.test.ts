import { describe, expect, it } from 'vitest'
import { STANDARD_ALARMS, anchorDistanceM, windShiftDeg } from './standard'
import { evaluate, type AlarmState } from './engine'
import { destination } from '@/lib/geo'

describe('the standard alarms', () => {
  it('measures the boat from where the anchor went down', () => {
    const anchor = { lat: 43.66, lon: -70.25 }
    expect(anchorDistanceM(anchor, destination(anchor, 90, 40 / 1852))).toBeCloseTo(40, 3)
    expect(anchorDistanceM(null, anchor)).toBeNull()
  })

  it('measures the wind against its mean over the last minutes, veer positive', () => {
    const t0 = 1_000_000
    const steady = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 60_000, twd: 355 + (i % 2) * 10 }))
    // Oscillating 355/5 about north, then a last reading at 20: about a 16° veer.
    const now = t0 + 9 * 60_000
    const shifted = [...steady.slice(0, -1), { t: now, twd: 20 }]
    expect(windShiftDeg(shifted, now)).toBeGreaterThan(10)
    expect(windShiftDeg(shifted.map((p) => ({ ...p, twd: 360 - p.twd })), now)).toBeLessThan(-10)
    // Too little history to say.
    expect(windShiftDeg(steady.slice(0, 2), t0 + 60_000)).toBeNull()
  })

  it('says GPS lost when the fix has gone quiet, and when there is none at all', () => {
    const gps = { ...STANDARD_ALARMS.find((p) => p.key === 'gps')!.rule, id: 'g' }
    const states: Record<string, AlarmState> = {}
    expect(evaluate([gps], { 'gps-age': 12 }, states, 0).fired).toHaveLength(1)
    const none = evaluate([gps], { 'gps-age': null }, states, 0)
    expect(none.fired).toHaveLength(1)
    expect(none.states.g.value).toBeNull()
    expect(evaluate([gps], { 'gps-age': 1 }, none.states, 1000).cleared).toHaveLength(1)
  })

  it('has one rule for each alarm, each on a channel or a derived value', () => {
    expect(new Set(STANDARD_ALARMS.map((p) => p.rule.name)).size).toBe(STANDARD_ALARMS.length)
    expect(STANDARD_ALARMS.map((p) => p.key)).toEqual([
      'depth', 'arrival', 'off-course', 'layline-port', 'layline-starboard', 'gps', 'anchor', 'wind-shift', 'ais-cpa', 'ais-alert',
    ])
  })
})
