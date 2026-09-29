import { describe, expect, it } from 'vitest'
import {
  CalibrationError,
  NO_CALIBRATION,
  calibrateRaw,
  calibrateTrue,
  deviationAt,
  lookup,
  parseDeviation,
  parseTable,
  type Calibration,
} from './calibration'
import { DEFAULT_PIPELINE, InstrumentPipeline } from './pipeline'

const cal = (over: Partial<Calibration>): Calibration => ({ ...NO_CALIBRATION, ...over })

describe('correction tables', () => {
  const t = parseTable(`
    # bsp across, heel down
    heel, 4, 8
    0, 0.2, 0.4
    20, 0.4, 0.8
  `)

  it('reads the layout: column values first, then a row value and its corrections', () => {
    expect(t).toEqual({ cols: [4, 8], rows: [0, 20], values: [[0.2, 0.4], [0.4, 0.8]] })
    expect(parseTable('4 8\n0 0.2 0.4')).toEqual({ cols: [4, 8], rows: [0], values: [[0.2, 0.4]] })
  })

  it('interpolates between the points, and holds the edges beyond them', () => {
    expect(lookup(t, 6, 10)).toBeCloseTo(0.45, 9)
    expect(lookup(t, 4, 0)).toBe(0.2)
    expect(lookup(t, 2, -5)).toBe(0.2)
    expect(lookup(t, 20, 40)).toBe(0.8)
  })

  it('says what is wrong with a table that will not read', () => {
    expect(() => parseTable('4, 8')).toThrow(CalibrationError)
    expect(() => parseTable('x, 4, 8\n0, 0.2')).toThrow(/Row 1 should be a row value and 2 numbers/)
    expect(() => parseTable('x, 8, 4\n0, 0.2, 0.4')).toThrow(/must go up/)
  })
})

describe('compass deviation', () => {
  const dev = parseDeviation('0, 2\n90, -1\n180, -3\n270, 1')

  it('interpolates round the compass, across north as well', () => {
    expect(deviationAt(dev, 45)).toBeCloseTo(0.5, 9)
    expect(deviationAt(dev, 315)).toBeCloseTo(1.5, 9)
    expect(deviationAt(dev, 360)).toBeCloseTo(2, 9)
    expect(deviationAt([[90, 3]], 200)).toBe(3)
  })

  it('refuses a line that is not a heading and a deviation', () => {
    expect(() => parseDeviation('0, 2\nnorth, 3')).toThrow(/Line 2/)
    expect(() => parseDeviation('# nothing')).toThrow(CalibrationError)
  })
})

describe('calibrating a reading', () => {
  it('adds the offsets, and the deviation table to the magnetic heading', () => {
    const r = calibrateRaw(
      { heel: 10, pitch: 1, rudder: -2, headingMag: 45 },
      cal({ offsets: { heel: -1.5, pitch: 0.5, rudder: 1, compass: 2, mast: -3 }, deviation: [[0, 2], [90, -1]] }),
    )
    expect(r).toMatchObject({ heel: 8.5, pitch: 1.5, rudder: -1, headingMag: 47 })
    expect(calibrateRaw({ mastAngle: 25 }, cal({ offsets: { ...NO_CALIBRATION.offsets, mast: -3 } })).mastAngle).toBe(22)
    expect(r.deviation).toBeCloseTo(0.5, 9)
  })

  it('corrects boat speed by speed and the size of the heel, either tack', () => {
    const bsp = parseTable('heel, 4, 8\n0, 0.2, 0.4\n20, 0.4, 0.8')
    expect(calibrateRaw({ bsp: 6, heel: -10 }, cal({ bsp })).bsp).toBeCloseTo(6.45, 9)
    expect(calibrateRaw({ bsp: 6, heel: 10 }, cal({ bsp })).bsp).toBeCloseTo(6.45, 9)
  })

  it('applies angle corrections with the side’s sign, so the tacks stay symmetric', () => {
    const twa = parseTable('tws, 30, 60\n10, 2, 1\n20, 2, 1')
    expect(calibrateTrue(40, 12, cal({ twa })).twa).toBeCloseTo(41.667, 3)
    expect(calibrateTrue(-40, 12, cal({ twa })).twa).toBeCloseTo(-41.667, 3)
    const awa = parseTable('aws, 20, 40\n10, 1, 1')
    expect(calibrateRaw({ awa: -30, aws: 12 }, cal({ awa })).awa).toBe(-31)
  })

  it('changes nothing with no calibration', () => {
    const r = { bsp: 6, heel: 10, awa: 30, aws: 12, headingMag: 45 }
    expect(calibrateRaw(r, NO_CALIBRATION)).toEqual(r)
    expect(calibrateTrue(40, 12, NO_CALIBRATION)).toEqual({ twa: 40, tws: 12 })
  })
})

describe('calibration in the pipeline', () => {
  it('moves TWD by the upwash correction, the same way on each tack', () => {
    const settings = { ...DEFAULT_PIPELINE, dampAngleS: 0, dampSpeedS: 0 }
    const twa = parseTable('tws, 0, 180\n0, 3, 3')
    const plain = new InstrumentPipeline(settings).step({ awa: 30, aws: 15, bsp: 6, headingTrue: 200, heel: 0 }, 0)
    const fixed = new InstrumentPipeline(settings, cal({ twa })).step({ awa: 30, aws: 15, bsp: 6, headingTrue: 200, heel: 0 }, 0)
    expect(fixed.twa! - plain.twa!).toBeCloseTo(3, 9)
    expect(fixed.twd! - plain.twd!).toBeCloseTo(3, 9)
    const port = new InstrumentPipeline(settings, cal({ twa })).step({ awa: -30, aws: 15, bsp: 6, headingTrue: 200, heel: 0 }, 0)
    expect(port.twa).toBeCloseTo(-fixed.twa!, 9)
  })
})
