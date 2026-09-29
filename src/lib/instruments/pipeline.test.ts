import { describe, expect, it } from 'vitest'
import { DEFAULT_PIPELINE, Damper, InstrumentPipeline, type PipelineSettings } from './pipeline'

const raw = (over: Partial<PipelineSettings> = {}): PipelineSettings => ({
  ...DEFAULT_PIPELINE,
  dampAngleS: 0,
  dampSpeedS: 0,
  ...over,
})

describe('damping', () => {
  it('weights recent values with a time constant', () => {
    const d = new Damper(3)
    d.push(0, 0)
    expect(d.push(10, 1000)).toBeCloseTo(10 * (1 - Math.exp(-1 / 3)), 9)
    // Given long enough it arrives.
    expect(d.push(10, 60_000)).toBeCloseTo(10, 6)
  })

  it('damps a bearing on the circle, so north does not average to south', () => {
    const d = new Damper(3, 'bearing', 'boxcar')
    d.push(359, 0)
    const v = d.push(1, 500)
    expect(Math.min(v, 360 - v)).toBeCloseTo(0, 6)
    const s = new Damper(3, 'signed', 'boxcar')
    s.push(179, 0)
    expect(Math.abs(s.push(-179, 500))).toBeCloseTo(180, 6)
  })

  it('box-car averages the window and forgets what falls out of it', () => {
    const d = new Damper(2, 'linear', 'boxcar')
    d.push(4, 0)
    d.push(8, 1000)
    expect(d.value).toBe(6)
    expect(d.push(10, 2500)).toBe(9)
  })

  it('passes values through with no damping, and ignores a non-number', () => {
    const d = new Damper(0)
    expect(d.push(7, 0)).toBe(7)
    expect(d.push(NaN, 1)).toBe(7)
  })
})

describe('the instrument pipeline', () => {
  it('works true wind out of apparent, against the hand-worked triangle', () => {
    // AWA 30°, AWS 15, BSP 6, heading 200, upright: across 7.5, along 12.99 − 6.
    const d = new InstrumentPipeline(raw()).step({ awa: 30, aws: 15, bsp: 6, headingTrue: 200, heel: 0 }, 0)
    const along = 15 * Math.cos(Math.PI / 6) - 6
    expect(d.tws).toBeCloseTo(Math.hypot(along, 7.5), 9)
    expect(d.twa).toBeCloseTo((Math.atan2(7.5, along) * 180) / Math.PI, 9)
    expect(d.twd).toBeCloseTo(200 + d.twa!, 9)
    expect(d.leeway).toBe(0)
  })

  it('puts leeway on the course, to leeward: heel to starboard is port tack, and clockwise', () => {
    const d = new InstrumentPipeline(raw()).step({ bsp: 6, headingTrue: 200, heel: 15 }, 0)
    expect(d.leeway).toBeCloseTo((10 * 15) / 36, 9)
    expect(d.course).toBeCloseTo(200 + 150 / 36, 9)
    const starboard = new InstrumentPipeline(raw()).step({ bsp: 6, headingTrue: 200, heel: -15 }, 0)
    expect(starboard.leeway).toBeCloseTo(-150 / 36, 9)
  })

  it('corrects apparent wind for heel only when asked, since many instruments already do', () => {
    const r = { awa: 30, aws: 15, heel: 20 }
    expect(new InstrumentPipeline(raw()).step(r, 0)).toMatchObject({ awa: 30, aws: 15 })
    const c = new InstrumentPipeline(raw({ heelCorrect: true })).step(r, 0)
    const across = (15 * Math.sin(Math.PI / 6)) / Math.cos((20 * Math.PI) / 180)
    expect(c.awa).toBeCloseTo((Math.atan2(across, 15 * Math.cos(Math.PI / 6)) * 180) / Math.PI, 9)
    expect(c.aws).toBeGreaterThan(15)
  })

  it('takes the instruments’ own true wind when that is the choice, or when there is no apparent', () => {
    const r = { awa: 30, aws: 15, bsp: 6, headingTrue: 200, twd: 250, tws: 11 }
    expect(new InstrumentPipeline(raw({ trueWind: 'instrument' })).step(r, 0)).toMatchObject({ twd: 250, tws: 11, twa: 50 })
    expect(new InstrumentPipeline(raw()).step({ twa: -40, tws: 11, headingTrue: 200 }, 0)).toMatchObject({ twd: 160, tws: 11 })
  })

  it('estimates set and drift while sailing steadily, and not through a tack', () => {
    const steady = { cog: 90, sog: 6, headingTrue: 90, bsp: 5, heel: 0 }
    const p = new InstrumentPipeline(raw())
    const d = p.step(steady, 0)
    expect(d.current!.set).toBeCloseTo(90, 9)
    expect(d.current!.drift).toBeCloseTo(1, 9)
    // An instrument rate of turn of 10°/s: mid-tack.
    expect(new InstrumentPipeline(raw()).step({ ...steady, rateOfTurn: 600 }, 0).current).toBeNull()
    // Or no instrument rate, and the heading swinging 20° in a second.
    const q = new InstrumentPipeline(raw())
    q.step(steady, 0)
    expect(q.step({ ...steady, headingTrue: 110 }, 1000)).toMatchObject({ current: null, rotDegS: 20 })
  })

  it('turns true wind into ground wind with the current', () => {
    // Wind from the north at 10 over water setting south at 1: the air goes south
    // at 11 over the ground. Against a stream setting north, 9.
    const down = new InstrumentPipeline(raw()).step({ cog: 180, sog: 6, headingTrue: 180, bsp: 5, heel: 0, twd: 0, tws: 10 }, 0)
    expect(down.current!.set).toBeCloseTo(180, 9)
    expect(down.gws).toBeCloseTo(11, 9)
    expect(Math.min(down.gwd!, 360 - down.gwd!)).toBeCloseTo(0, 6)
    const up = new InstrumentPipeline(raw()).step({ cog: 0, sog: 6, headingTrue: 0, bsp: 5, heel: 0, twd: 0, tws: 10 }, 0)
    expect(up.gws).toBeCloseTo(9, 9)
  })

  it('passes the sensor angles on with their offsets, undamped', () => {
    const p = new InstrumentPipeline(DEFAULT_PIPELINE, {
      bsp: null, awa: null, aws: null, twa: null, tws: null, deviation: null,
      offsets: { heel: 0, pitch: 0.5, rudder: 1, compass: 0, mast: -3 },
    })
    expect(p.step({ pitch: 2, rudder: -4, mastAngle: 25 }, 0)).toMatchObject({ pitch: 2.5, rudder: -3, mastAngle: 22 })
  })

  it('damps what it passes on: a jump in boat speed arrives over the time constant', () => {
    const p = new InstrumentPipeline({ ...DEFAULT_PIPELINE, dampSpeedS: 3 })
    p.step({ bsp: 5 }, 0)
    expect(p.step({ bsp: 7 }, 1000).bsp).toBeCloseTo(5 + 2 * (1 - Math.exp(-1 / 3)), 9)
  })
})
