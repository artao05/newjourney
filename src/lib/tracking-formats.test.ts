/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { parseBasicPositions, parseExpeditionPositions, parseMaxSeaPositions, parseTrackingFile, parseVolvoPositions } from './tracking'

// Lines in the layouts the manual gives for each format.
const EXP = ['12,43.60,-70.20', '15,43.58,-70.22,2609291405,2', 'not a line'].join('\n')
const BASIC = ['Wild Horses,29/09/2026 14:05:00 UTC,43 36.00 N,070 12.00 W', 'Sea Fever,29/09/2026 14:05:00,43°34.80N,070°13.20W'].join('\n')
const VOLVO = ['POSRELEASE', '1;ERICSSON 4;49,16.74S;017,30.72E;1230;15Mar08;270;15.2', '2;PUMA;49,20.10S;017,10.00E;1230;15Mar08;265;14.0'].join('\n')
const MAXSEA = ['POSREPORT', 'rank;boat id;lat;lon;date time;dtf;log;dmg;point-to-point', '1;101;48.2967N;004.3012W;03/15/08 12:30:00;100;5;2;3'].join('\n')

describe('the race-office tracking formats', () => {
  it("reads Expedition's own lines, the time from each line or else the file name", () => {
    const t = parseExpeditionPositions(EXP, null, 'fleet2609291400.txt')
    expect(t.map((x) => [x.key, x.points[0]])).toEqual([
      ['12', { t: Date.UTC(2026, 8, 29, 14, 0), lat: 43.6, lon: -70.2 }],
      ['15', { t: Date.UTC(2026, 8, 29, 14, 5), lat: 43.58, lon: -70.22 }],
    ])
    // With no time anywhere a line is not placed.
    expect(parseExpeditionPositions('12,43.60,-70.20')).toEqual([])
  })

  it('reads the Basic format, degrees and decimal minutes, in the date order it was written', () => {
    const t = parseBasicPositions(BASIC)
    expect(t[0].points[0]).toEqual({ t: Date.UTC(2026, 8, 29, 14, 5), lat: 43.6, lon: -70.2 })
    expect(t[1].points[0].lat).toBeCloseTo(43.58, 9)
    expect(t[1].points[0].lon).toBeCloseTo(-70.22, 9)
    const us = parseBasicPositions('Wild Horses,09/29/2026 14:05:00,43 36.00 N,070 12.00 W', 'mdy')
    expect(us[0].points[0].t).toBe(Date.UTC(2026, 8, 29, 14, 5))
  })

  it('reads a Volvo race-office report', () => {
    const t = parseVolvoPositions(VOLVO)
    expect(t.map((x) => x.key)).toEqual(['ERICSSON 4', 'PUMA'])
    expect(t[0].points[0].t).toBe(Date.UTC(2008, 2, 15, 12, 30))
    expect(t[0].points[0].lat).toBeCloseTo(-(49 + 16.74 / 60), 9)
    expect(t[0].points[0].lon).toBeCloseTo(17 + 30.72 / 60, 9)
  })

  it('reads a MaxSea report, its positions as degrees then minutes', () => {
    const [t] = parseMaxSeaPositions(MAXSEA)
    expect(t.key).toBe('101')
    expect(t.points[0].t).toBe(Date.UTC(2008, 2, 15, 12, 30))
    expect(t.points[0].lat).toBeCloseTo(48 + 29.67 / 60, 9)
    expect(t.points[0].lon).toBeCloseTo(-(4 + 30.12 / 60), 9)
  })

  it('tells each format from its content', () => {
    expect(parseTrackingFile(VOLVO)[0].key).toBe('ERICSSON 4')
    expect(parseTrackingFile(MAXSEA)[0].key).toBe('101')
    expect(parseTrackingFile(BASIC)[0].key).toBe('Wild Horses')
    expect(parseTrackingFile(EXP, 'fleet2609291400.txt').map((x) => x.key)).toEqual(['12', '15'])
    expect(parseTrackingFile('boat,time,lat,lon\nA,2026-09-29T14:00:00Z,43.6,-70.2')[0].key).toBe('A')
  })
})
