import { describe, expect, it } from 'vitest'
import { ORIENTATION_FRESH_MS, fromOrientationEvent, phoneAdditions } from './orientation'

describe('the phone’s orientation', () => {
  it('takes iOS’s compass bearing and its accuracy, turned with the screen', () => {
    const p = fromOrientationEvent({ alpha: 10, beta: 3, gamma: -15, webkitCompassHeading: 350, webkitCompassAccuracy: 8 }, 90, 5)
    expect(p).toEqual({ headingMag: 80, heel: -15, pitch: 3, accuracyDeg: 8, quality: 'good', t: 5 })
    expect(fromOrientationEvent({ alpha: 0, beta: 0, gamma: 0, webkitCompassHeading: 10, webkitCompassAccuracy: 25 }, 0, 0).quality).toBe('poor')
    expect(fromOrientationEvent({ alpha: 0, beta: 0, gamma: 0, webkitCompassHeading: 10, webkitCompassAccuracy: -1 }, 0, 0).quality).toBe('unknown')
  })

  it('reads Android’s absolute alpha as a compass, anticlockwise, with no accuracy', () => {
    const p = fromOrientationEvent({ alpha: 90, beta: 0, gamma: 5, absolute: true }, 0, 0)
    expect(p).toMatchObject({ headingMag: 270, heel: 5, quality: 'unknown', accuracyDeg: null })
  })

  it('has no compass from a relative orientation, only the tilt', () => {
    expect(fromOrientationEvent({ alpha: 90, beta: 1, gamma: 5, absolute: false }, 0, 0)).toMatchObject({ headingMag: null, heel: 5 })
    expect(fromOrientationEvent({ alpha: null, beta: null, gamma: null }, 0, 0)).toMatchObject({ headingMag: null, heel: null, pitch: null })
  })

  it('offers heel while fresh, and a true heading only when trusted and good', () => {
    const good = { headingMag: 100, heel: 8, pitch: 1, accuracyDeg: 5, quality: 'good' as const, t: 0 }
    expect(phoneAdditions(good, 1000, false, -14.5)).toEqual({ heading: null, heelDeg: 8 })
    expect(phoneAdditions(good, 1000, true, -14.5)).toEqual({ heading: 85.5, heelDeg: 8 })
    expect(phoneAdditions({ ...good, quality: 'unknown' }, 1000, true, -14.5).heading).toBeNull()
    expect(phoneAdditions(good, ORIENTATION_FRESH_MS + 1, true, -14.5)).toEqual({ heading: null, heelDeg: null })
    expect(phoneAdditions(null, 0, true, 0)).toEqual({ heading: null, heelDeg: null })
  })
})
