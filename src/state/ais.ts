/**
 * The AIS targets heard, kept apart from the main store and not persisted:
 * they are minutes old at best. Fed by `feedAis` from the instrument stream.
 */
import { create } from 'zustand'
import { AisDecoder } from '@/lib/ais/decode'
import { DEFAULT_AIS_FILTER, applyMessage, prune, type AisFilter, type AisTarget } from '@/lib/ais/targets'

interface AisState {
  targets: AisTarget[]
  filter: AisFilter
  setFilter(p: Partial<AisFilter>): void
  clear(): void
}

const map = new Map<number, AisTarget>()
const decoder = new AisDecoder()

export const useAis = create<AisState>()((set) => ({
  targets: [],
  filter: DEFAULT_AIS_FILTER,
  setFilter: (p) => set((s) => ({ filter: { ...s.filter, ...p } })),
  clear: () => {
    map.clear()
    set({ targets: [] })
  },
}))

let pending = false

/** One AIVDM/AIVDO line from the bus. Updates are batched to one render a tick. */
export function feedAis(line: string, now = Date.now()): void {
  const m = decoder.push(line)
  if (!m) return
  applyMessage(map, m, now)
  if (pending) return
  pending = true
  queueMicrotask(() => {
    pending = false
    prune(map, Date.now())
    useAis.setState({ targets: [...map.values()] })
  })
}
