import { describe, expect, it } from 'vitest'
import { corrected, fleetTable, fmtHms, owedS, results } from './handicap'

describe('handicap arithmetic, against hand-worked examples', () => {
  it('time on time: corrected is elapsed times TCF', () => {
    // 2 h at TCF 1.050 corrects to 2 h 6 min.
    expect(corrected('tot', 7200, 1.05, 0)).toBeCloseTo(7560, 9)
  })

  it('time on distance: corrected is elapsed less rating times distance', () => {
    // PHRF 120 s/nm over 10 nm takes 20 min off a 2 h race.
    expect(corrected('tod', 7200, 120, 10)).toBe(6000)
  })

  it('says how much later we can finish and still tie, on time on time', () => {
    // She (TCF 1.100) takes 7200 s. At TCF 1.000 we tie at 7920 s: 720 s owed to us.
    expect(owedS('tot', 1.0, 1.1, 7200, 0)).toBeCloseTo(720, 9)
    // The other way round we must finish 654.5 s ahead.
    expect(owedS('tot', 1.1, 1.0, 7200, 0)).toBeCloseTo(7200 / 1.1 - 7200, 6)
  })

  it('and on time on distance, where it is the rating gap times the distance', () => {
    expect(owedS('tod', 150, 120, 7200, 10)).toBe(300)
  })

  it('ranks finishers on corrected time, leaves boats still racing unranked', () => {
    const r = results(
      'tot',
      [
        { name: 'Fast', rating: 1.1, elapsedS: 7000 },
        { name: 'Slow', rating: 0.95, elapsedS: 7900 },
        { name: 'Out', rating: 1.0, elapsedS: null },
      ],
      0,
    )
    expect(r.map((x) => [x.name, x.place])).toEqual([
      ['Slow', 1],
      ['Fast', 2],
      ['Out', null],
    ])
    expect(r[1].behindS).toBeCloseTo(7000 * 1.1 - 7900 * 0.95, 6)
    expect(r[0].behindS).toBe(0)
  })
})

describe('the fleet table', () => {
  const gun = Date.UTC(2026, 8, 29, 12)
  const boats = [
    { id: 'us', name: 'Us', rating: 1.0, startAt: null, eventAt: gun + 7920_000, reference: true },
    { id: 'her', name: 'Her', rating: 1.1, startAt: null, eventAt: gun + 7200_000, reference: false },
    { id: 'late', name: 'Late', rating: 1.0, startAt: gun + 300_000, eventAt: gun + 8000_000, reference: false },
    { id: 'out', name: 'Out', rating: 1.0, startAt: null, eventAt: null, reference: false },
  ]

  it('runs elapsed from her own start, or the gun, and ties us with the boat we owe', () => {
    const t = fleetTable('tot', boats, gun, 0)
    expect(t.map((r) => r.elapsedS)).toEqual([7920, 7200, 7700, null])
    // 7200 × 1.1 = 7920: a dead heat on corrected time, and 720 s owed to us.
    expect(t[1].deltaS).toBeCloseTo(0, 9)
    expect(t[1].owedS).toBeCloseTo(720, 9)
    // Late started five minutes after the gun, so she finished 220 s ahead.
    expect(t[2].deltaS).toBeCloseTo(-220, 9)
    expect(t[3]).toMatchObject({ correctedS: null, deltaS: null, owedS: null })
    expect(t[0]).toMatchObject({ deltaS: null, owedS: null })
  })

  it('has no elapsed times before there is a gun', () => {
    expect(fleetTable('tot', boats.map((b) => ({ ...b, startAt: null })), null, 0).every((r) => r.elapsedS == null)).toBe(true)
  })

  it('formats margins with their seconds', () => {
    expect(fmtHms(7925)).toBe('2:12:05')
    expect(fmtHms(-65)).toBe('-0:01:05')
    expect(fmtHms(null)).toBe('—')
  })
})
