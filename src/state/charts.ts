/** Chart cells the user has opened, and how they are drawn. Not persisted yet (13.5 keeps them). */
import { create } from 'zustand'
import type { EncCell } from '@/lib/charts/s57'
import type { DisplayCategory } from '@/lib/charts/s52'

export interface EncDisplay {
  category: DisplayCategory
  shallowM: number
  deepM: number
  twoShades: boolean
  night: boolean
}

interface ChartsState {
  cells: EncCell[]
  safetyDepthM: number
  /** S-52 starts on Standard; soundings matter inshore, so this starts on All. */
  display: EncDisplay
  add(c: EncCell): void
  clear(): void
  setSafetyDepth(m: number): void
  setDisplay(p: Partial<EncDisplay>): void
}

export const DEFAULT_ENC_DISPLAY: EncDisplay = { category: 'all', shallowM: 2, deepM: 10, twoShades: false, night: false }

export const useCharts = create<ChartsState>()((set) => ({
  cells: [],
  safetyDepthM: 3,
  display: DEFAULT_ENC_DISPLAY,
  // A cell opened again (same name) replaces the one held.
  add: (c) => set((s) => ({ cells: [...s.cells.filter((x) => x.name !== c.name), c] })),
  clear: () => set({ cells: [] }),
  setSafetyDepth: (m) => set({ safetyDepthM: m }),
  setDisplay: (p) => set((s) => ({ display: { ...s.display, ...p } })),
}))
