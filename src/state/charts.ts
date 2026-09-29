/** Chart cells the user has opened. Not persisted yet (13.5 keeps them). */
import { create } from 'zustand'
import type { EncCell } from '@/lib/charts/s57'

interface ChartsState {
  cells: EncCell[]
  safetyDepthM: number
  add(c: EncCell): void
  clear(): void
  setSafetyDepth(m: number): void
}

export const useCharts = create<ChartsState>()((set) => ({
  cells: [],
  safetyDepthM: 3,
  // A cell opened again (same name) replaces the one held.
  add: (c) => set((s) => ({ cells: [...s.cells.filter((x) => x.name !== c.name), c] })),
  clear: () => set({ cells: [] }),
  setSafetyDepth: (m) => set({ safetyDepthM: m }),
}))
