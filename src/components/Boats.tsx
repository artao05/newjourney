/**
 * The boats database: the fleet with each boat's colour, polar and size, and
 * what AIS and the trackers know her by.
 */
import { POLAR_LIBRARY } from '@/data/polars'
import { useEffect, useState } from 'react'
import { leaderboard, parseBoatIds } from '@/lib/tracking'
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
      <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }} title="Expedition's BoatId.csv: id,name[,class,handicap], naming the boats the reports give by id">
        IMPORT BOAT IDS
        <input
          type="file"
          accept=".csv,.txt,text/csv"
          aria-label="Boat id file to import"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            const ids = parseBoatIds(await f.text())
            const s = useStore.getState()
            let added = 0
            for (const b of ids) {
              // A boat with that tracker id, or else that name, takes it; any other is added.
              const have = s.fleet.find((x) => x.trackerId === b.id) ?? useStore.getState().fleet.find((x) => x.name === b.name)
              if (!have) {
                s.addFleetBoat(b.name, b.handicap ?? 1)
                added++
              }
              const boat = have ?? useStore.getState().fleet.at(-1)!
              useStore.getState().updateFleetBoat(boat.id, { name: b.name, trackerId: b.id, ...(b.handicap != null ? { rating: b.handicap } : {}) })
            }
            setNote(`${ids.length} boat id${ids.length === 1 ? '' : 's'}: ${added} boat${added === 1 ? '' : 's'} added, ${ids.length - added} named`)
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

/** The fleet now: where each tracked boat is, nearest the mark first, and how far ahead of us. */
function FleetNow() {
  const tracks = useTracking((s) => s.tracks)
  const fleet = useStore((s) => s.fleet)
  const own = useStore((s) => s.state?.position ?? null)
  const mark = useStore((s) => s.course.marks[s.activeMarkIndex]?.position ?? null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const rows = leaderboard(tracks, now, own, mark)
  if (!rows.length) return null
  const f = (v: number | null, dp: number) => (v == null ? '—' : v.toFixed(dp))
  // The table as plain text, to print for the deck or send on.
  const exportText = async () => {
    const { downloadText } = await import('@/lib/gpx')
    const head = 'boat,to mark nm,ahead nm,range nm,bearing,fix min'
    const lines = rows.map((r) => [fleet.find((x) => x.id === r.boatId)?.name ?? r.key, f(r.toMarkNm, 2), r.aheadNm == null ? '' : r.aheadNm.toFixed(2), f(r.rangeNm, 2), f(r.bearing, 0), Math.round(r.ageMin)].join(','))
    downloadText(`fleet-${new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`, [head, ...lines].join('\n') + '\n', 'text/csv')
  }
  return (
    <>
    <button className="btn btn--sm btn--ghost" onClick={() => void exportText()} style={{ marginTop: 8 }}>
      EXPORT FLEET
    </button>
    <table className="targets" aria-label="Fleet now" style={{ width: '100%', marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Boat</th>
          <th>To mark nm</th>
          <th>Ahead nm</th>
          <th>Range nm</th>
          <th>Brg °</th>
          <th>Fix</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const b = fleet.find((x) => x.id === r.boatId)
          return (
            <tr key={r.key}>
              <td style={{ color: b?.colour }}>{b?.name ?? r.key}</td>
              <td style={{ textAlign: 'center' }}>{f(r.toMarkNm, 2)}</td>
              <td style={{ textAlign: 'center' }}>{r.aheadNm == null ? '—' : `${r.aheadNm >= 0 ? '+' : ''}${r.aheadNm.toFixed(2)}`}</td>
              <td style={{ textAlign: 'center' }}>{f(r.rangeNm, 2)}</td>
              <td style={{ textAlign: 'center' }}>{f(r.bearing, 0)}</td>
              <td style={{ textAlign: 'center' }}>
                {Math.round(r.ageMin)} min{r.extrapolated ? ' · dead reckoned' : ''}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    </>
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
      <FleetNow />
    </section>
  )
}
