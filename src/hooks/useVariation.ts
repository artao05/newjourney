/**
 * Magnetic variation where the boat is, from the World Magnetic Model: at her
 * last fix, or at the venue's centre before there is one.
 */
import { useStore } from '@/state/store'
import { PILOT_VENUE } from '@/data/venues'
import { variationAt } from '@/lib/magnetic'
import type { Degrees, LatLon, Millis } from '@/lib/types'

/** Where variation is taken: the boat's position, else the venue's centre. */
export function variationPlace(): LatLon {
  return useStore.getState().state?.position ?? PILOT_VENUE.center
}

/** Variation at the boat now (or at `t`), east positive. For event handlers and effects. */
export function variationHere(t: Millis = Date.now()): Degrees {
  return variationAt(variationPlace(), t)
}

/**
 * The same, for rendering. It changes by a hundredth of a degree over tens of
 * miles, so the position is taken to a tenth of a degree and the date to the day,
 * and the component renders again only when either moves.
 */
export function useVariation(): Degrees {
  const lat = useStore((s) => Math.round((s.state?.position.lat ?? PILOT_VENUE.center.lat) * 10) / 10)
  const lon = useStore((s) => Math.round((s.state?.position.lon ?? PILOT_VENUE.center.lon) * 10) / 10)
  const day = Math.floor(Date.now() / 86_400_000)
  return variationAt({ lat, lon }, day * 86_400_000)
}
