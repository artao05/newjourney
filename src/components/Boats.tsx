/**
 * The boats database: the fleet with each boat's colour, polar and size, and
 * what AIS and the trackers know her by.
 */
import { POLAR_LIBRARY } from '@/data/polars'
import { useState } from 'react'
import { useStore } from '@/state/store'
import { importTrackingFiles, useTracking } from '@/state/tracking'

/** Tracking files in: GPX with a track a boat, or a CSV of boat, time, lat and lon. */
function ImportTracks() {
  const fleet = useStore((s) => s.fleet)
  const tracks = useTracking((s) => s.tracks)
  const clear = useTracking((s) => s.clear)
  const [note, setNote] = useState<string | null>(null)
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
        IMPORT TRACKS
        <input
          type="file"
          multiple
          accept=".gpx,.csv,.txt,application/gpx+xml,text/csv"
          aria-label="Tracking files to import"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (!files.length) return
            const r = await importTrackingFiles(files, fleet)
            setNote(`${r.tracks} track${r.tracks === 1 ? '' : 's'}, ${r.matched} matched to the boats here${r.errors.length ? `; ${r.errors.join('; ')}` : ''}`)
          }}
        />
      </label>
      {tracks.length > 0 && (
        <button className="btn btn--sm btn--ghost" onClick={clear}>
          CLEAR TRACKS
        </button>
      )}
      <span className="note" aria-label="Tracks">
        {note ?? (tracks.length ? `${tracks.length} tracks held` : 'No tracks')}
      </span>
    </div>
  )
}

export function BoatsDatabase() {
  const fleet = useStore((s) => s.fleet)
  const update = useStore((s) => s.updateFleetBoat)
  if (!fleet.length) return null
  const num = (v: string) => {
    const n = Number(v)
    return v.trim() && Number.isFinite(n) ? n : null
  }
  return (
    <section aria-label="Boats" style={{ marginTop: 12 }}>
      <h2>Boats</h2>
      <table className="targets" aria-label="Boats database" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th />
            <th style={{ textAlign: 'left' }}>Boat</th>
            <th>Polar</th>
            <th>Length m</th>
            <th>Sail no.</th>
            <th>MMSI</th>
            <th>Tracker id</th>
          </tr>
        </thead>
        <tbody>
          {fleet.map((b) => (
            <tr key={b.id}>
              <td>
                <input type="color" aria-label={`${b.name} colour`} value={b.colour ?? '#90a4ae'} onChange={(e) => update(b.id, { colour: e.target.value })} style={{ width: 28, height: 22, padding: 0, border: 'none', background: 'none' }} />
              </td>
              <td>{b.name}</td>
              <td>
                <select aria-label={`${b.name} polar`} value={b.polarId ?? ''} onChange={(e) => update(b.id, { polarId: e.target.value || null })}>
                  <option value="">none</option>
                  <option value="navigation">ours</option>
                  {POLAR_LIBRARY.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label={`${b.name} length`} type="number" step="0.1" min="0" value={b.lengthM ?? ''} onChange={(e) => update(b.id, { lengthM: num(e.target.value) })} style={{ width: 60 }} />
              </td>
              <td>
                <input aria-label={`${b.name} sail number`} value={b.sailNumber ?? ''} onChange={(e) => update(b.id, { sailNumber: e.target.value })} style={{ width: 70 }} />
              </td>
              <td>
                <input aria-label={`${b.name} MMSI`} inputMode="numeric" value={b.mmsi ?? ''} onChange={(e) => update(b.id, { mmsi: num(e.target.value) })} style={{ width: 96 }} />
              </td>
              <td>
                <input aria-label={`${b.name} tracker id`} value={b.trackerId ?? ''} onChange={(e) => update(b.id, { trackerId: e.target.value })} style={{ width: 80 }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">A polar lets a boat be routed and her targets worked out; the MMSI and tracker id match her to AIS and to tracking files.</p>
      <ImportTracks />
    </section>
  )
}
