import { describe, expect, it } from 'vitest'
import { summariseEnsemble, type MemberRoute } from './ensemble'

const m = (member: string, elapsedS: number | null, ok = true): MemberRoute => ({ member, ok, elapsedS, etaMs: null, track: [] })

describe('an ensemble of routes', () => {
  it('gives the spread of arrivals, and the member nearest the mean', () => {
    const s = summariseEnsemble([m('control', 3600), m('member 1', 3300), m('member 2', 4200), m('member 3', null, false)])!
    expect(s).toMatchObject({ count: 3, failed: 1, minS: 3300, maxS: 4200, meanS: 3700, typical: 'control' })
    expect(s.sdS).toBeCloseTo(Math.sqrt(((3600 - 3700) ** 2 + (3300 - 3700) ** 2 + (4200 - 3700) ** 2) / 3), 9)
  })

  it('has nothing to say when no member could be routed', () => {
    expect(summariseEnsemble([m('control', null, false)])).toBeNull()
  })
})
