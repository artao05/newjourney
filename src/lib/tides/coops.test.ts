/**
 * CO-OPS parsing tests.
 *
 * Fixtures are trimmed copies of real responses captured from
 * api.tidesandcurrents.noaa.gov for station CAB1401, so the field names, the
 * `-0` velocity and the space-separated timestamps are NOAA's, not invented.
 * No network here: the fetch path is thin, the parsing is where the bugs live.
 */

import { describe, expect, it } from 'vitest'
import {
  flowAt,
  nextSlack,
  parseCoopsTime,
  parseEvents,
  parseSeries,
  velocityAt,
  type CurrentPrediction,
} from './coops'

const EVENTS_BODY = {
  current_predictions: {
    units: 'feet, knots',
    cp: [
      { Type: 'slack', meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 03:05', Depth: '9', Velocity_Major: -0 },
      { Type: 'flood', meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 05:52', Depth: '9', Velocity_Major: 0.78 },
      { Type: 'slack', meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 08:38', Depth: '9', Velocity_Major: -0 },
      { Type: 'ebb', meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 11:40', Depth: '9', Velocity_Major: -1.21 },
    ],
  },
}

const SERIES_BODY = {
  current_predictions: {
    units: 'feet, knots',
    cp: [
      { meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 00:00', Depth: '9', Velocity_Major: -1.15 },
      { meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 00:06', Depth: '9', Velocity_Major: -1.13 },
      { meanFloodDir: 310, Bin: '11', meanEbbDir: 138, Time: '2026-08-05 00:12', Depth: '9', Velocity_Major: -1.05 },
    ],
  },
}

describe('parseCoopsTime', () => {
  it('reads NOAA timestamps as UTC, not local', () => {
    /*
     * The whole point. NOAA sends 'YYYY-MM-DD HH:mm' with no offset, and we always
     * request time_zone=gmt. `new Date(str)` treats that as local time on every
     * engine, which would shift every slack time by the machine's offset — four
     * hours in Maine — and look entirely plausible while doing it.
     */
    expect(parseCoopsTime('2026-08-05 03:05')).toBe(Date.UTC(2026, 7, 5, 3, 5))
  })

  it('accepts an ISO-style T separator too', () => {
    expect(parseCoopsTime('2026-08-05T03:05')).toBe(Date.UTC(2026, 7, 5, 3, 5))
  })

  it('is NaN for junk rather than silently returning an epoch date', () => {
    expect(Number.isNaN(parseCoopsTime(''))).toBe(true)
    expect(Number.isNaN(parseCoopsTime('not a time'))).toBe(true)
  })
})

describe('parseSeries', () => {
  it('reads the signed curve and the flood/ebb axis', () => {
    const { series, floodDir, ebbDir } = parseSeries(SERIES_BODY)
    expect(floodDir).toBe(310)
    expect(ebbDir).toBe(138)
    expect(series).toHaveLength(3)
    expect(series[0].t).toBe(Date.UTC(2026, 7, 5, 0, 0))
    // Negative means ebbing: the sign is the direction, so it must survive.
    expect(series[0].kn).toBeCloseTo(-1.15, 6)
  })

  it('returns the series ascending in time', () => {
    const shuffled = {
      current_predictions: {
        cp: [
          { meanFloodDir: 310, meanEbbDir: 138, Time: '2026-08-05 00:12', Velocity_Major: -1.05 },
          { meanFloodDir: 310, meanEbbDir: 138, Time: '2026-08-05 00:00', Velocity_Major: -1.15 },
        ],
      },
    }
    const { series } = parseSeries(shuffled)
    expect(series.map((p) => p.t)).toEqual([...series.map((p) => p.t)].sort((a, b) => a - b))
  })

  it('coerces string numbers, which NOAA sometimes sends', () => {
    const asStrings = {
      current_predictions: {
        cp: [{ meanFloodDir: '310', meanEbbDir: '138', Time: '2026-08-05 00:00', Velocity_Major: '-1.15' }],
      },
    }
    const { series, floodDir } = parseSeries(asStrings)
    expect(floodDir).toBe(310)
    expect(series[0].kn).toBeCloseTo(-1.15, 6)
  })

  it('rejects an error payload rather than reporting no current', () => {
    // CO-OPS answers a bad station with HTTP 200 and an error object, so a parser
    // that only looks for `cp` would report calm water at a station that does not
    // exist. Failing loudly is the only safe behaviour.
    const bad = { error: { message: ' No data was found. Please check station id. ' } }
    expect(() => parseSeries(bad)).toThrow(/No data was found/)
  })

  it('rejects an empty prediction', () => {
    expect(() => parseSeries({ current_predictions: { cp: [] } })).toThrow(/empty/)
  })

  it('rejects a body with no cp array', () => {
    expect(() => parseSeries({ something: 'else' })).toThrow(/cp array/)
  })
})

describe('parseEvents', () => {
  it('reads slack and peak events with their types', () => {
    const events = parseEvents(EVENTS_BODY)
    expect(events.map((e) => e.type)).toEqual(['slack', 'flood', 'slack', 'ebb'])
    expect(events[0].t).toBe(Date.UTC(2026, 7, 5, 3, 5))
    expect(events[1].kn).toBeCloseTo(0.78, 6)
    expect(events[3].kn).toBeCloseTo(-1.21, 6)
  })

  it('survives NOAA’s negative zero at slack', () => {
    const events = parseEvents(EVENTS_BODY)
    expect(Number.isFinite(events[0].kn)).toBe(true)
    expect(Math.abs(events[0].kn)).toBeLessThan(1e-9)
  })

  it('skips rows with an unrecognised type instead of guessing', () => {
    const odd = {
      current_predictions: {
        cp: [
          { Type: 'slack', meanFloodDir: 310, meanEbbDir: 138, Time: '2026-08-05 03:05', Velocity_Major: 0 },
          { Type: 'wobble', meanFloodDir: 310, meanEbbDir: 138, Time: '2026-08-05 04:05', Velocity_Major: 1 },
        ],
      },
    }
    expect(parseEvents(odd)).toHaveLength(1)
  })
})

// ------------------------------------------------------------ interrogation

function prediction(): CurrentPrediction {
  const t0 = Date.UTC(2026, 7, 5, 0, 0)
  const h = 3_600_000
  return {
    stationId: 'CAB1401',
    floodDir: 310,
    ebbDir: 138,
    // A clean sinusoid-ish reversal: ebbing, slack at +3 h, flooding after.
    series: [
      { t: t0, kn: -1.0 },
      { t: t0 + 3 * h, kn: 0 },
      { t: t0 + 6 * h, kn: 1.0 },
    ],
    events: [
      { t: t0 + 3 * h, type: 'slack', kn: 0 },
      { t: t0 + 5 * h, type: 'flood', kn: 0.9 },
    ],
    fetchedAt: t0,
  }
}

describe('velocityAt', () => {
  const p = prediction()
  const t0 = p.series[0].t

  it('interpolates between samples', () => {
    // Halfway from -1.0 to 0 over three hours.
    expect(velocityAt(p, t0 + 1.5 * 3_600_000)).toBeCloseTo(-0.5, 6)
  })

  it('is exact on a sample', () => {
    expect(velocityAt(p, t0 + 3 * 3_600_000)).toBeCloseTo(0, 6)
  })

  it('returns null outside the window rather than flat-lining', () => {
    // Clamping to the last value would draw hours of fictitious slack water.
    expect(velocityAt(p, t0 - 1)).toBeNull()
    expect(velocityAt(p, t0 + 7 * 3_600_000)).toBeNull()
  })
})

describe('flowAt', () => {
  const p = prediction()
  const t0 = p.series[0].t

  it('calls a negative velocity an ebb on the ebb bearing', () => {
    const f = flowAt(p, t0)
    expect(f).not.toBeNull()
    expect(f!.label).toBe('ebb')
    expect(f!.dir).toBe(138)
    // Reported speed is a magnitude; the sign lives in the label.
    expect(f!.kn).toBeCloseTo(1.0, 6)
  })

  it('calls a positive velocity a flood on the flood bearing', () => {
    const f = flowAt(p, t0 + 6 * 3_600_000)
    expect(f!.label).toBe('flood')
    expect(f!.dir).toBe(310)
    expect(f!.kn).toBeCloseTo(1.0, 6)
  })

  it('calls near-zero slack', () => {
    const f = flowAt(p, t0 + 3 * 3_600_000)
    expect(f!.label).toBe('slack')
  })

  it('is null outside the window', () => {
    expect(flowAt(p, t0 - 1)).toBeNull()
  })
})

describe('nextSlack', () => {
  const p = prediction()
  const t0 = p.series[0].t

  it('finds the next turn of the tide', () => {
    expect(nextSlack(p, t0)!.t).toBe(t0 + 3 * 3_600_000)
  })

  it('includes a slack happening exactly now', () => {
    expect(nextSlack(p, t0 + 3 * 3_600_000)!.t).toBe(t0 + 3 * 3_600_000)
  })

  it('is null once the last slack has passed', () => {
    expect(nextSlack(p, t0 + 10 * 3_600_000)).toBeNull()
  })
})
