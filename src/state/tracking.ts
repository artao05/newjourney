/** The fleet's tracks from tracking files. Not persisted yet; a reload loses them. */
import { create } from 'zustand'
import { matchTracks, mergeTracks, parseTrackingFile, type FleetTrack } from '@/lib/tracking'
import type { FleetIdentity } from '@/lib/fleet'

interface TrackingState {
  tracks: FleetTrack[]
  add(tracks: FleetTrack[]): void
  clear(): void
}

export const useTracking = create<TrackingState>()((set) => ({
  tracks: [],
  add: (t) => set((s) => ({ tracks: mergeTracks(s.tracks, t) })),
  clear: () => set({ tracks: [] }),
}))

/** Read tracking files and add their tracks, matched to the fleet. */
export async function importTrackingFiles(files: Iterable<File>, fleet: FleetIdentity[]): Promise<{ tracks: number; matched: number; errors: string[] }> {
  const errors: string[] = []
  let got: FleetTrack[] = []
  for (const f of files) {
    try {
      // Expedition's own lines may take their time from the file's name, else from when it was written.
      got = got.concat(parseTrackingFile(await f.text(), f.name, { fallbackTime: f.lastModified || null }))
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const matched = matchTracks(got, fleet)
  useTracking.getState().add(matched)
  return { tracks: matched.length, matched: matched.filter((t) => t.boatId).length, errors }
}
