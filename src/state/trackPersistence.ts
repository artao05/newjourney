/**
 * Keeps the recorded track across a reload, in its own localStorage key.
 *
 * Not part of the store's persisted state, on purpose: zustand's persist rewrites
 * that on every change - every GPS fix, about once a second - and a track grows to
 * hundreds of kilobytes over a race day. So a compact copy is written on a timer,
 * and at once when the page is hidden, which on a phone is the last moment sure to
 * run before the OS drops a backgrounded app.
 *
 * Capped by the store's own MAX_TRACK_POINTS: about five and a half hours at one
 * fix a second, and well under a megabyte in the compact form below.
 */

import { useEffect } from 'react'
import { MAX_TRACK_POINTS, useStore } from './store'
import type { TrackPoint } from '@/lib/types'

export const TRACK_KEY = 'newjourney.track.v1'
export const TRACK_SAVE_MS = 10_000

/**
 * One point as saved: ms after `t0`, position to 1e-6° (about 0.1 m - far inside
 * any GPS error), speed to 0.1 kn and course to 1°. `null` stands for NaN, the
 * app's "no reading", which JSON cannot carry.
 */
type Saved = [number, number, number, number | null, number | null]

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp
const reading = (x: number, dp: number) => (Number.isFinite(x) ? round(x, dp) : null)

export function encodeTrack(points: readonly TrackPoint[]): string {
  const t0 = points.length > 0 ? points[0].t : 0
  return JSON.stringify({
    v: 1,
    t0,
    p: points.map(
      (q): Saved => [q.t - t0, round(q.lat, 6), round(q.lon, 6), reading(q.sog, 1), reading(q.cog, 0)],
    ),
  })
}

/** The saved track, or null for anything that is not one. Malformed points are dropped. */
export function decodeTrack(raw: string): TrackPoint[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const { v, t0, p } = doc as { v?: unknown; t0?: unknown; p?: unknown }
  if (v !== 1 || typeof t0 !== 'number' || !Array.isArray(p)) return null
  const out: TrackPoint[] = []
  for (const q of p) {
    if (!Array.isArray(q) || q.length !== 5) continue
    const [dt, lat, lon, sog, cog] = q as unknown[]
    if (typeof dt !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    out.push({
      t: t0 + dt,
      lat,
      lon,
      sog: typeof sog === 'number' ? sog : Number.NaN,
      cog: typeof cog === 'number' ? cog : Number.NaN,
    })
  }
  return out
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Restore the saved track on mount, then keep the saved copy current. */
export function useTrackPersistence(): void {
  useEffect(() => {
    const store = storage()
    if (!store) return

    // A session that already has points - a hot reload, say - keeps its own.
    if (useStore.getState().track.length === 0) {
      const raw = store.getItem(TRACK_KEY)
      const saved = raw ? decodeTrack(raw) : null
      if (saved && saved.length > 0) useStore.setState({ track: saved.slice(-MAX_TRACK_POINTS) })
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    const save = () => {
      if (timer) clearTimeout(timer)
      timer = null
      const { track } = useStore.getState()
      try {
        if (track.length === 0) store.removeItem(TRACK_KEY)
        else store.setItem(TRACK_KEY, encodeTrack(track))
      } catch {
        // Storage full: keep the newer half rather than nothing. The whole track
        // is still in memory, and still exportable, either way.
        try {
          store.setItem(TRACK_KEY, encodeTrack(track.slice(-Math.floor(track.length / 2))))
        } catch {
          /* nothing more to try */
        }
      }
    }

    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.track === prev.track) return
      // A clear takes effect at once: CLEAR TRACK must not come back on reload.
      if (s.track.length === 0) save()
      else timer ??= setTimeout(save, TRACK_SAVE_MS)
    })
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', save)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', save)
      save()
    }
  }, [])
}
