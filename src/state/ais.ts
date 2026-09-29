/**
 * The AIS targets heard, kept apart from the main store and not persisted:
 * they are minutes old at best. Fed by `feedAis` from the instrument stream.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { AisDecoder } from '@/lib/ais/decode'
import { DEFAULT_AIS_FILTER, applyMessage, prune, type AisFilter, type AisTarget } from '@/lib/ais/targets'

/** The last sentences heard, for the raw log. */
export const RAW_LOG_MAX = 200

interface AisState {
  targets: AisTarget[]
  /** The last AIVDM/AIVDO sentences, newest last, each with when it came. */
  raw: Array<{ t: number; line: string }>
  filter: AisFilter
  setFilter(p: Partial<AisFilter>): void
  clear(): void
}

const map = new Map<number, AisTarget>()
const decoder = new AisDecoder()

// The targets are minutes old at best and are not kept; the filter (own MMSI, what is drawn) is.
export const useAis = create<AisState>()(
  persist(
    (set) => ({
      targets: [],
      raw: [],
      filter: DEFAULT_AIS_FILTER,
      setFilter: (p) => set((s) => ({ filter: { ...s.filter, ...p } })),
      clear: () => {
        map.clear()
        rawLog.length = 0
        set({ targets: [], raw: [] })
      },
    }),
    {
      name: 'newjourney.ais.v1',
      partialize: (s) => ({ filter: s.filter }),
      merge: (p, c) => ({ ...c, filter: { ...DEFAULT_AIS_FILTER, ...((p as Partial<AisState>)?.filter ?? {}) } }),
    },
  ),
)

let pending = false
const rawLog: Array<{ t: number; line: string }> = []

/** One AIVDM/AIVDO line from the bus. Updates are batched to one render a tick. */
export function feedAis(line: string, now = Date.now()): void {
  rawLog.push({ t: now, line })
  if (rawLog.length > RAW_LOG_MAX) rawLog.splice(0, rawLog.length - RAW_LOG_MAX)
  const m = decoder.push(line)
  if (!m) return
  applyMessage(map, m, now)
  if (pending) return
  pending = true
  queueMicrotask(() => {
    pending = false
    prune(map, Date.now())
    useAis.setState({ targets: [...map.values()], raw: rawLog.slice() })
  })
}
