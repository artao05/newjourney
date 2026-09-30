/**
 * The weather along the route: wind speed and boat speed against time, with an
 * arrow for the wind's direction at each hour, as the boat meets it.
 */

import type { RouteLeg } from '@/lib/types'
import { thinLegs } from '@/lib/routing/results'

const W = 1000
const H = 120

export function RouteMeteogram({ legs }: { legs: RouteLeg[] }) {
  if (legs.length < 2) return null
  const t0 = legs[0].t
  const t1 = legs[legs.length - 1].t
  const span = Math.max(1, t1 - t0)
  const vmax = Math.max(5, ...legs.map((l) => Math.max(l.tws, l.bsp))) * 1.1
  const x = (t: number) => ((t - t0) / span) * W
  const y = (v: number) => H - (v / vmax) * (H - 18)
  const line = (get: (l: RouteLeg) => number) => legs.map((l) => `${x(l.t).toFixed(1)},${y(get(l)).toFixed(1)}`).join(' ')
  const arrows = thinLegs(legs, 12)

  return (
    <figure style={{ margin: '0 0 12px', position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Wind and boat speed along the route">
        <polyline points={line((l) => l.tws)} fill="none" style={{ stroke: 'var(--wind)' }} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <polyline points={line((l) => l.bsp)} fill="none" stroke="#ff3ea5" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* HTML, not SVG: the stretched chart would skew a rotated arrow. A down arrow
          turned by TWD points where the wind is going. */}
      {arrows.map((l, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="meteogram__arrow"
          style={{ left: `${(x(l.t) / W) * 100}%`, transform: `translateX(-50%) rotate(${l.twd}deg)` }}
        >
          ↓
        </span>
      ))}
      <figcaption className="note">
        <span style={{ color: 'var(--wind)' }}>TWS</span> and <span style={{ color: '#ff3ea5' }}>boat speed</span>, 0 to{' '}
        {Math.round(vmax)} kn, arrows downwind. Along the route, at the time the boat is there.
      </figcaption>
    </figure>
  )
}
