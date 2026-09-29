/**
 * Edit one mark: name, position, rounding side, order, lock, delete, and a new
 * mark at a range and bearing from it.
 *
 * The position field takes whatever the sailing instructions say, in any of the
 * formats parseLatLon reads. It shows the mark's position as a chart plotter
 * writes it, and only takes effect on a position it can read with certainty. Until
 * then it says what it did not understand, and the mark stays where it was.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { parseLatLon } from '@/lib/latlon'
import { fmtDmm } from '@/lib/channels/format'
import { destination } from '@/lib/geo'
import type { Mark, RoundingSide } from '@/lib/types'

export function fmtPosition(p: { lat: number; lon: number }): string {
  return `${fmtDmm(p.lat, false)} ${fmtDmm(p.lon, true)}`
}

export function MarkSheet({ mark, index, count, onClose }: {
  mark: Mark
  index: number
  count: number
  onClose: () => void
}) {
  const updateMark = useStore((s) => s.updateMark)
  const moveMark = useStore((s) => s.moveMark)
  const removeMark = useStore((s) => s.removeMark)
  const addMark = useStore((s) => s.addMark)
  const [posText, setPosText] = useState(fmtPosition(mark.position))
  const parsed = parseLatLon(posText)
  const [rangeNm, setRangeNm] = useState('')
  const [bearingT, setBearingT] = useState('')
  const r = Number(rangeNm)
  const b = Number(bearingT)
  const rbOk = rangeNm.trim() !== '' && bearingT.trim() !== '' && r > 0 && b >= 0 && b <= 360
  const locked = !!mark.locked

  return (
    <div className="sheet" role="dialog" aria-label={`Edit mark ${mark.name}`}>
      <div className="sheet__grip" onClick={onClose} />
      <div className="field field--wide">
        <label htmlFor="mark-name">Name</label>
        <input
          id="mark-name"
          value={mark.name}
          onChange={(e) => updateMark(mark.id, { name: e.target.value })}
        />
      </div>
      <div className="field field--wide">
        <label htmlFor="mark-pos">Position</label>
        <input
          id="mark-pos"
          disabled={locked}
          value={posText}
          onChange={(e) => {
            setPosText(e.target.value)
            const p = parseLatLon(e.target.value)
            if (p) updateMark(mark.id, { position: p })
          }}
          spellCheck={false}
          autoCapitalize="characters"
        />
      </div>
      {parsed ? (
        <p className="note">Reads as {fmtPosition(parsed)}.</p>
      ) : (
        <div className="warnbox">
          Cannot read that as a position, so the mark has not moved. Try
          <code> 43 39.534 N, 070 12.306 W</code>, <code>43.6589, -70.2051</code> or
          degrees, minutes and seconds.
        </div>
      )}
      <h2>Round to</h2>
      <div className="seg" role="group" aria-label="Round to">
        {(['port', 'starboard', 'either'] as RoundingSide[]).map((r) => (
          <button key={r} aria-pressed={mark.roundTo === r} onClick={() => updateMark(mark.id, { roundTo: r })}>
            {r === 'port' ? 'Port' : r === 'starboard' ? 'Starboard' : 'Either'}
          </button>
        ))}
      </div>
      <div className="actions">
        <button className="btn btn--sm btn--ghost" onClick={() => moveMark(mark.id, -1)} disabled={index === 0}>
          ▲ EARLIER
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => moveMark(mark.id, 1)} disabled={index === count - 1}>
          ▼ LATER
        </button>
      </div>
      <h2>New mark from here</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          <input aria-label="Range from this mark" inputMode="decimal" value={rangeNm} onChange={(e) => setRangeNm(e.target.value)} style={{ width: 64 }} /> nm
        </label>
        <label>
          at <input aria-label="Bearing from this mark" inputMode="decimal" value={bearingT} onChange={(e) => setBearingT(e.target.value)} style={{ width: 56 }} /> °T
        </label>
        <button
          className="btn btn--sm btn--ghost"
          disabled={!rbOk}
          onClick={() => {
            addMark(`${mark.name} ${r} nm ${Math.round(b)}°`, destination(mark.position, b, r))
            setRangeNm('')
            setBearingT('')
          }}
        >
          ADD MARK
        </button>
      </div>
      <div className="actions">
        <button className="btn btn--sm btn--ghost" aria-pressed={locked} onClick={() => updateMark(mark.id, { locked: !locked })} title="A locked mark cannot be moved or deleted">
          {locked ? '🔒 LOCKED' : 'LOCK'}
        </button>
        <button
          className="btn btn--sm btn--ghost"
          disabled={locked}
          onClick={() => {
            removeMark(mark.id)
            onClose()
          }}
        >
          DELETE MARK
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          DONE
        </button>
      </div>
    </div>
  )
}
