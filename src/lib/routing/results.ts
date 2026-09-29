/**
 * What a route's results show beyond the table: the wind at each leg drawn
 * where and when the boat meets it, and the turning points worth keeping as
 * marks.
 */

import { destination } from '@/lib/geo'
import type { RouteLeg } from '@/lib/types'

/** Every `step`-th leg and the last, so a long route does not draw a barb a minute. */
export function thinLegs(legs: RouteLeg[], max = 24): RouteLeg[] {
  if (legs.length <= max) return legs
  const step = Math.ceil(legs.length / max)
  const out = legs.filter((_, i) => i % step === 0)
  if (out[out.length - 1] !== legs[legs.length - 1]) out.push(legs[legs.length - 1])
  return out
}

/**
 * The wind at each leg's own time, as short lines from the leg downwind, a
 * length that grows with the wind, and the speed for a label.
 */
export function windAlongRouteFC(legs: RouteLeg[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: thinLegs(legs).map((l) => {
      const lenNm = 0.05 + Math.min(l.tws, 40) * 0.012
      const tip = destination(l.position, (l.twd + 180) % 360, lenNm)
      return {
        type: 'Feature' as const,
        properties: { tws: Math.round(l.tws), label: `${Math.round(l.tws)}` },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [l.position.lon, l.position.lat],
            [tip.lon, tip.lat],
          ],
        },
      }
    }),
  }
}

/**
 * The route's turning points: the start, every leg where the heading swings by
 * more than `minTurnDeg` from the last point kept, and the finish.
 */
export function turningPoints(legs: RouteLeg[], minTurnDeg = 15): RouteLeg[] {
  if (legs.length <= 2) return legs
  const out: RouteLeg[] = [legs[0]]
  let hdg = legs[0].heading
  for (let i = 1; i < legs.length - 1; i++) {
    const d = Math.abs(((((legs[i].heading - hdg) % 360) + 540) % 360) - 180)
    if (d > minTurnDeg) {
      out.push(legs[i])
      hdg = legs[i].heading
    }
  }
  out.push(legs[legs.length - 1])
  return out
}
