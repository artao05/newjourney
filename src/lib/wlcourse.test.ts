import { describe, expect, it } from 'vitest'
import { buildWLCourse, type WLOptions } from './wlcourse'
import { bearing, destination, distance, midpoint } from './geo'
import { angdiff } from './angles'

// A 200 m line square to a northerly: pin to the west, committee boat to the east.
const MID = { lat: 43.65, lon: -70.2 }
const LINE = {
  port: destination(MID, 270, 0.054),
  starboard: destination(MID, 90, 0.054),
}
const base: WLOptions = {
  line: LINE,
  axisTrue: 0,
  windwardNm: 1,
  leewardNm: 0.1,
  leewardAbove: 'middle',
  gateWidthM: null,
  leaveTo: 'port',
  laps: 1,
}

describe("Expedition's W/L course wizard", () => {
  it('puts the windward mark up the axis from the middle of the line', () => {
    const [w] = buildWLCourse(base)
    expect(distance(MID, w.position)).toBeCloseTo(1, 6)
    expect(Math.abs(angdiff(bearing(midpoint(LINE.port, LINE.starboard), w.position), 0))).toBeLessThan(0.01)
    expect(w.roundTo).toBe('port')
  })

  it('puts the leeward mark ABOVE the line for a positive distance, below it for a negative one', () => {
    const above = buildWLCourse(base)[1].position
    expect(above.lat).toBeGreaterThan(MID.lat)
    const below = buildWLCourse({ ...base, leewardNm: -0.2 })[1].position
    expect(below.lat).toBeLessThan(MID.lat)
    expect(distance(MID, below)).toBeCloseTo(0.2, 6)
  })

  it('lines the leeward mark up with the committee boat, the middle or the pin', () => {
    const lon = (at: WLOptions['leewardAbove']) => buildWLCourse({ ...base, leewardAbove: at })[1].position.lon
    expect(lon('committee')).toBeCloseTo(LINE.starboard.lon, 6)
    expect(lon('pin')).toBeCloseTo(LINE.port.lon, 6)
    expect(lon('middle')).toBeCloseTo(MID.lon, 6)
  })

  it("lays a gate with its second buoy to the left looking upwind, at the gate's width", () => {
    const [, gate] = buildWLCourse({ ...base, gateWidthM: 60 })
    expect(gate.name).toBe('Leeward gate')
    expect(gate.roundTo).toBe('either')
    expect(distance(gate.gate!.left, gate.gate!.right) * 1852).toBeCloseTo(60, 1)
    // Upwind is north here, so left is west.
    expect(gate.gate!.left.lon).toBeLessThan(gate.gate!.right.lon)
    expect(distance(gate.position, midpoint(gate.gate!.left, gate.gate!.right))).toBeLessThan(1e-9)
  })

  it('repeats the legs for more laps, and rounds every mark on the chosen side', () => {
    const c = buildWLCourse({ ...base, laps: 2, leaveTo: 'starboard' })
    expect(c.map((m) => m.name)).toEqual(['Windward 1', 'Leeward 1', 'Windward 2', 'Leeward 2'])
    expect(c.every((m) => m.roundTo === 'starboard')).toBe(true)
  })

  it('turns the whole course with the axis', () => {
    const [w] = buildWLCourse({ ...base, axisTrue: 225 })
    expect(Math.abs(angdiff(bearing(MID, w.position), 225))).toBeLessThan(0.01)
  })
})
