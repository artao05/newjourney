/**
 * The start display's world-to-screen transform, and its inverse.
 *
 * Dragging an end to fix a mis-ping turns a finger position back into a lat/lon.
 * That is only right if the inverse is exact, and if the view it is taken in is
 * the one the line was drawn in.
 */

import { describe, expect, it } from 'vitest'
import { END_HIT_PX, MAGNIFY_BL, fromPx, hitEnd, nearEnd, startView, toPx } from './StartCanvas'
import { destination, mToNm } from '@/lib/geo'
import type { LatLon } from '@/lib/types'

const MID: LatLon = { lat: 43.6675, lon: -70.1735 }
// A 120 m line on a bearing of 060, as a committee might lay one in a NE breeze.
const port = destination(MID, 240, mToNm(60))
const starboard = destination(MID, 60, mToNm(60))
const boat = destination(MID, 150, mToNm(80))
const W = 390
const H = 420

describe('startView', () => {
  const v = startView(port, starboard, boat, W, H)

  it('puts the pin on the left and the committee boat on the right, level', () => {
    const a = toPx(v, port)
    const b = toPx(v, starboard)
    expect(a.px).toBeLessThan(b.px)
    expect(Math.abs(a.py - b.py)).toBeLessThan(1e-6)
  })

  it('keeps the line and the boat on screen', () => {
    for (const p of [port, starboard, boat]) {
      const q = toPx(v, p)
      expect(q.px).toBeGreaterThanOrEqual(0)
      expect(q.px).toBeLessThanOrEqual(W)
      expect(q.py).toBeGreaterThanOrEqual(0)
      expect(q.py).toBeLessThanOrEqual(H)
    }
  })

  it('inverts exactly: a pixel back to the place it was drawn from', () => {
    for (const p of [port, starboard, boat, MID, destination(MID, 330, mToNm(45))]) {
      const q = toPx(v, p)
      const back = fromPx(v, q.px, q.py)
      expect(back.lat).toBeCloseTo(p.lat, 9)
      expect(back.lon).toBeCloseTo(p.lon, 9)
    }
  })

  it('moves an end dragged in a held view to exactly where the finger is', () => {
    // The view is frozen at pick-up; the end drawn through it must land under the
    // finger, which is what re-fitting during the drag would break.
    const a = toPx(v, port)
    const dropped = fromPx(v, a.px + 25, a.py - 10)
    const q = toPx(v, dropped)
    expect(q.px).toBeCloseTo(a.px + 25, 6)
    expect(q.py).toBeCloseTo(a.py - 10, 6)
  })
})

describe('the magnified end', () => {
  const LOA = 10
  const nearPin = destination(port, 150, mToNm(LOA * 3))

  it('zooms in on the end the boat is within five lengths of', () => {
    expect(nearEnd(port, starboard, nearPin, LOA)).toBe('port')
    expect(nearEnd(port, starboard, destination(starboard, 150, mToNm(LOA * 2)), LOA)).toBe('starboard')
    expect(nearEnd(port, starboard, destination(port, 150, mToNm(LOA * (MAGNIFY_BL + 1))), LOA)).toBeNull()
    expect(nearEnd(port, starboard, boat, LOA)).toBeNull()
  })

  it('never on a line too short for the whole of it to shrink the end', () => {
    expect(nearEnd(port, starboard, nearPin, 20)).toBeNull()
  })

  it('fits that end and the boat, larger, and leaves the far end off the screen', () => {
    const whole = startView(port, starboard, nearPin, W, H)
    const zoomed = startView(port, starboard, nearPin, W, H, LOA)
    expect(whole.magnified).toBeNull()
    expect(zoomed.magnified).toBe('port')
    expect(zoomed.scale).toBeGreaterThan(whole.scale * 2)
    for (const p of [port, nearPin]) {
      const q = toPx(zoomed, p)
      expect(q.px).toBeGreaterThanOrEqual(0)
      expect(q.px).toBeLessThanOrEqual(W)
    }
    expect(toPx(zoomed, starboard).px).toBeGreaterThan(W)
  })
})

describe('hitEnd', () => {
  const v = startView(port, starboard, boat, W, H)
  const a = toPx(v, port)
  const b = toPx(v, starboard)

  it('picks up an end under a fingertip', () => {
    expect(hitEnd(v, { port, starboard }, a.px + 8, a.py - 8)).toBe('port')
    expect(hitEnd(v, { port, starboard }, b.px, b.py + END_HIT_PX - 1)).toBe('starboard')
  })

  it('ignores a touch that is not on either end', () => {
    expect(hitEnd(v, { port, starboard }, (a.px + b.px) / 2, a.py + END_HIT_PX * 3)).toBeNull()
  })
})
