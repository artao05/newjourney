import { afterEach, describe, expect, it } from 'vitest'
import { ensembleCube, useEnsembleView } from './ensembleView'
import type { WeatherCube } from '@/lib/types'

const T0 = Date.UTC(2026, 8, 29, 12)
const cube = (name: string, u: number): WeatherCube => ({
  model: name, run: '', bbox: { west: -71, south: 43, east: -70, north: 44 }, nx: 2, ny: 2, dx: 1, dy: 1, t0: T0, dtMs: 3_600_000, nt: 1,
  params: ['u10', 'v10'], data: { u10: new Float32Array(4).fill(u), v10: new Float32Array(4).fill(0) },
})

afterEach(() => useEnsembleView.getState().clear())

describe('the ensemble on the chart', () => {
  it('loads the members, shows their mean, and any one of them on request', async () => {
    const asked: unknown[] = []
    await useEnsembleView.getState().load({ west: -71, south: 43, east: -70, north: 44 }, 24, (async (o: unknown) => {
      asked.push(o)
      return [cube('gfs control', 6), cube('gfs member 1', 10)]
    }) as never)
    const s = useEnsembleView.getState()
    expect(asked).toEqual([{ bbox: { west: -71, south: 43, east: -70, north: 44 }, hours: 24, members: 10 }])
    expect(s.members).toHaveLength(2)
    expect(ensembleCube(s)!.model).toBe('gfs ensemble mean of 2')
    expect(ensembleCube(s)!.data.u10[0]).toBeCloseTo(8, 5)
    s.setView(1)
    expect(ensembleCube(useEnsembleView.getState())!.model).toBe('gfs member 1')
    useEnsembleView.getState().clear()
    expect(ensembleCube(useEnsembleView.getState())).toBeNull()
  })

  it('says why when the ensemble cannot be had', async () => {
    await useEnsembleView.getState().load({ west: 0, south: 0, east: 1, north: 1 }, 24, (async () => {
      throw new Error('Daily API request limit exceeded')
    }) as never)
    expect(useEnsembleView.getState()).toMatchObject({ members: null, busy: false, error: 'Ensemble unavailable: Daily API request limit exceeded' })
  })
})
