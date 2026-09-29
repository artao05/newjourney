/**
 * The course as legs, and the routes kept for later: Expedition's route pane
 * and route database.
 *
 * Legs run from the boat, or the planned start, through every mark: true bearing,
 * distance, angle off the wind, and polar time with tacks and gybes allowed for.
 * Below them, the course can be reversed, saved under a name, and saved routes
 * made the course again.
 */

import { useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { courseLegs } from '@/lib/legs'
import { fmtDeg } from '@/lib/angles'
import { fmtDuration } from '@/components/Tile'
import type { PolarLattice } from '@/lib/types'

export function CourseLegs({ lattice }: { lattice: PolarLattice | null }) {
  const course = useStore((s) => s.course)
  const state = useStore((s) => s.state)
  const routeStart = useStore((s) => s.routeStart)
  const wind = useStore((s) => s.wind)
  const boat = useStore((s) => s.boat)
  const routes = useStore((s) => s.routes)
  const saveRoute = useStore((s) => s.saveRoute)
  const loadRoute = useStore((s) => s.loadRoute)
  const deleteRoute = useStore((s) => s.deleteRoute)
  const reverseCourse = useStore((s) => s.reverseCourse)
  const [name, setName] = useState('')
  const sailChart = useStore((s) => s.sailChart)

  const start = routeStart
    ? { name: 'Start', position: routeStart }
    : state
      ? { name: 'Boat', position: state.position }
      : null
  const legs = useMemo(
    () => courseLegs({ start, marks: course.marks, wind, lattice, boat, sailChart }),
    // The boat's position changes every fix; a leg table re-sorting its numbers
    // each second is noise, so it follows the fix rounded to a few metres.
    [
      course.marks,
      sailChart,
      wind?.twd,
      wind?.tws,
      lattice,
      boat,
      start?.name,
      start && Math.round(start.position.lat * 2e4),
      start && Math.round(start.position.lon * 2e4),
    ],
  )
  const total = legs.reduce((s, l) => s + l.distanceNm, 0)
  const last = legs.at(-1)

  return (
    <section aria-label="Course legs">
      <h2>Legs</h2>
      {legs.length === 0 ? (
        <p className="note">Add marks to see the legs.</p>
      ) : (
        <div className="rows" role="table" aria-label="Legs">
          {legs.map((l, i) => (
            <div className="row" role="row" key={i}>
              <span>
                {i + 1}. {l.from} → {l.to}
              </span>
              <span>
                {fmtDeg(l.bearing)}° · {l.distanceNm.toFixed(2)} nm
                {l.offWindDeg != null && ` · ${Math.round(l.offWindDeg)}° off`}
                {l.timeS != null && ` · ${fmtDuration(l.timeS)}`}
                {l.sail && ` · ${l.sail}`}
              </span>
            </div>
          ))}
          <div className="row" role="row">
            <span>
              <b>Total</b>
            </span>
            <span>
              <b>
                {total.toFixed(2)} nm
                {last?.elapsedS != null && ` · ${fmtDuration(last.elapsedS)}`}
              </b>
            </span>
          </div>
        </div>
      )}
      {legs.length > 0 && !wind && (
        <p className="note">Set a wind to see the angle off it and the polar time for each leg.</p>
      )}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
        <button className="btn btn--sm btn--ghost" onClick={reverseCourse} disabled={course.marks.length < 2}>
          REVERSE
        </button>
      </div>

      <h2>Routes</h2>
      <div className="field field--wide">
        <label htmlFor="route-name">Save course as</label>
        <input
          id="route-name"
          value={name}
          placeholder={`Route ${routes.length + 1}`}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="actions" style={{ background: 'none', border: 'none', padding: '0 0 8px' }}>
        <button
          className="btn btn--sm"
          disabled={course.marks.length === 0}
          onClick={() => {
            saveRoute(name)
            setName('')
          }}
        >
          SAVE ROUTE
        </button>
      </div>
      {routes.map((r) => (
        <div className="row" key={r.id}>
          <span>
            {r.name} <span className="note">{r.marks.length} marks</span>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn--sm btn--ghost" onClick={() => loadRoute(r.id)} aria-label={`Sail ${r.name}`}>
              SAIL
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => deleteRoute(r.id)} aria-label={`Delete ${r.name}`}>
              ✕
            </button>
          </span>
        </div>
      ))}
    </section>
  )
}
