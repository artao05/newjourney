/**
 * The handicap calculator, with the fleet it works on.
 *
 * Each boat has a rating, an optional start of her own and an event time: when
 * she rounded or finished. Tap her name as she crosses to stamp it. The table
 * then gives elapsed and corrected times, the margin on the reference boat, and
 * what is owed: how long after her the reference boat can finish and still tie.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { fleetTable, fmtHms } from '@/lib/handicap'

export function HandicapCalc() {
  const fleet = useStore((s) => s.fleet)
  const handicap = useStore((s) => s.handicap)
  const gunTime = useStore((s) => s.course.startLine.gunTime)
  const addFleetBoat = useStore((s) => s.addFleetBoat)
  const updateFleetBoat = useStore((s) => s.updateFleetBoat)
  const removeFleetBoat = useStore((s) => s.removeFleetBoat)
  const setReferenceBoat = useStore((s) => s.setReferenceBoat)
  const setHandicap = useStore((s) => s.setHandicap)
  const [name, setName] = useState('')
  const [rating, setRating] = useState(1)
  const tot = handicap.system === 'tot'
  const rows = fleetTable(handicap.system, fleet, gunTime, handicap.distanceNm)

  return (
    <section aria-label="Handicap">
      <h2>Handicap</h2>
      <div className="seg" role="group" aria-label="Handicap system" style={{ marginBottom: 8 }}>
        <button aria-pressed={tot} onClick={() => setHandicap({ system: 'tot' })}>Time on time</button>
        <button aria-pressed={!tot} onClick={() => setHandicap({ system: 'tod' })}>Time on distance</button>
      </div>
      {!tot && (
        <div className="field">
          <label htmlFor="hc-distance">Course distance <span className="note">nm</span></label>
          <input id="hc-distance" type="number" step="0.1" min="0" inputMode="decimal"
            value={handicap.distanceNm}
            onChange={(e) => setHandicap({ distanceNm: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
      )}
      {!gunTime && fleet.length > 0 && (
        <p className="note">No gun yet: elapsed times start at the gun, or at a boat&apos;s own start.</p>
      )}
      {fleet.length > 0 && (
        <div className="tablewrap">
        <table className="targets" aria-label="Handicap results">
          <thead>
            <tr>
              <th>Boat</th>
              <th>{tot ? 'TCF' : 's/nm'}</th>
              <th>Elapsed</th>
              <th>Corrected</th>
              <th>Delta</th>
              <th>Owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const boat = fleet.find((b) => b.id === r.id)!
              return (
                <tr key={r.id}>
                  <td>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => updateFleetBoat(r.id, { eventAt: Date.now() })}
                      title="Stamp her event time now"
                      aria-label={`Stamp ${r.name}`}
                    >
                      {r.name}
                    </button>
                    <label style={{ fontSize: 11, display: 'block' }}>
                      <input
                        type="radio"
                        name="hc-reference"
                        checked={r.reference}
                        onChange={() => setReferenceBoat(r.id)}
                        aria-label={`${r.name} is the reference boat`}
                      />{' '}
                      ref
                    </label>
                  </td>
                  <td>
                    <input
                      type="number"
                      step={tot ? 0.001 : 1}
                      style={{ width: 64 }}
                      value={boat.rating}
                      aria-label={`${r.name} rating`}
                      onChange={(e) => updateFleetBoat(r.id, { rating: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td>{fmtHms(r.elapsedS)}</td>
                  <td>{fmtHms(r.correctedS)}</td>
                  <td>{r.deltaS == null ? '—' : `${r.deltaS > 0 ? '+' : ''}${fmtHms(r.deltaS)}`}</td>
                  <td>{r.owedS == null ? '—' : `${r.owedS > 0 ? '+' : ''}${fmtHms(r.owedS)}`}</td>
                  <td>
                    <button className="btn btn--sm btn--ghost" aria-label={`Remove ${r.name}`}
                      onClick={() => removeFleetBoat(r.id)}>
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
        <input aria-label="New boat name" placeholder="Boat" value={name} style={{ flex: 2 }}
          onChange={(e) => setName(e.target.value)} />
        <input aria-label="New boat rating" type="number" step={tot ? 0.001 : 1} value={rating} style={{ flex: 1 }}
          onChange={(e) => setRating(Number(e.target.value) || 0)} />
        <button
          className="btn btn--sm"
          disabled={!(rating > 0)}
          onClick={() => {
            addFleetBoat(name, rating)
            setName('')
          }}
        >
          ADD BOAT
        </button>
      </div>
      {fleet.length > 0 && (
        <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
          <button className="btn btn--sm btn--ghost"
            onClick={() => fleet.forEach((b) => updateFleetBoat(b.id, { startAt: null }))}>
            ALL STARTS TO GUN
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => {
            const now = Date.now()
            fleet.forEach((b) => updateFleetBoat(b.id, { eventAt: now }))
          }}>
            ALL EVENTS NOW
          </button>
          <button className="btn btn--sm btn--ghost"
            onClick={() => fleet.forEach((b) => updateFleetBoat(b.id, { eventAt: null }))}>
            CLEAR EVENTS
          </button>
        </div>
      )}
      <p className="note">
        Delta is her corrected time less the reference boat&apos;s. Owed is how long after her the
        reference boat can finish and still tie; negative means the reference boat owes her time.
      </p>
    </section>
  )
}
