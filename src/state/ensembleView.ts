/**
 * An ensemble on the Weather chart: its members, their mean and spread, and
 * which of them the chart shows. Not persisted; a download is minutes old.
 */
import { create } from 'zustand'
import { ensembleStats } from '@/lib/weather/ensembleStats'
import { fetchEnsembleCubes } from '@/lib/weather/openmeteo'
import type { BBox, WeatherCube } from '@/lib/types'

export type EnsembleView = 'mean' | number

interface EnsembleState {
  members: WeatherCube[] | null
  mean: WeatherCube | null
  view: EnsembleView
  busy: boolean
  error: string | null
  setView(v: EnsembleView): void
  load(bbox: BBox, hours: number, fetcher?: typeof fetchEnsembleCubes): Promise<void>
  clear(): void
}

export const useEnsembleView = create<EnsembleState>()((set) => ({
  members: null,
  mean: null,
  view: 'mean',
  busy: false,
  error: null,
  setView: (view) => set({ view }),
  load: async (bbox, hours, fetcher = fetchEnsembleCubes) => {
    set({ busy: true, error: null })
    try {
      const members = await fetcher({ bbox, hours, members: 10 })
      const mean = ensembleStats(members)
      if (!mean) throw new Error('the ensemble came back empty')
      set({ members, mean, view: 'mean', busy: false })
    } catch (e) {
      set({ busy: false, error: `Ensemble unavailable: ${e instanceof Error ? e.message : String(e)}` })
    }
  },
  clear: () => set({ members: null, mean: null, view: 'mean', error: null }),
}))

/** The cube the chart shows for an ensemble view, or null when none is loaded. */
export function ensembleCube(s: Pick<EnsembleState, 'members' | 'mean' | 'view'>): WeatherCube | null {
  if (!s.members || !s.mean) return null
  return s.view === 'mean' ? s.mean : (s.members[s.view] ?? s.mean)
}
