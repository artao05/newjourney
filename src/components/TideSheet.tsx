/**
 * The tide at the nearest NOAA station: its curve from six hours ago to a day
 * and a half ahead, the height now and which way it is going, and the highs
 * and lows, above chart datum (MLLW) where NOAA gives the datum. Worked out on
 * the device from the station's harmonic constants, which are kept once fetched.
 */
import { useEffect, useMemo, useState } from 'react'
import { predictTide } from '@/lib/tides/harmonic'
import { nearestStations, stationTides, tideStations, tideTurns, type StationTides, type TideStation } from '@/lib/tides/stations'
import type { LatLon } from '@/lib/types'

const W = 1000
const H = 120
const HOUR = 3_600_000

const clock = (t: number) => {
  const d = new Date(t)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function TideSheet({ at, onClose, now: fixedNow }: { at: LatLon; onClose: () => void; now?: number }) {
  // The clock moves a minute at a time, not on every render.
  const [now, setNow] = useState(() => fixedNow ?? Date.now())
  useEffect(() => {
    if (fixedNow != null) return
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [fixedNow])
  // Where to look, to a hundredth of a degree, so a moving boat does not refetch.
  const lat = Math.round(at.lat * 100) / 100
  const lon = Math.round(at.lon * 100) / 100
  const [near, setNear] = useState<Array<TideStation & { nm: number }> | null>(null)
  const [pick, setPick] = useState(0)
  const [tides, setTides] = useState<StationTides | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    tideStations()
      .then((list) => !off && setNear(nearestStations(list, { lat, lon }, 5)))
      .catch((e) => !off && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      off = true
    }
  }, [lat, lon])

  useEffect(() => {
    const s = near?.[pick]
    if (!s) return
    let off = false
    setTides(null)
    stationTides(s)
      .then((t) => !off && setTides(t))
      .catch((e) => !off && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      off = true
    }
  }, [near, pick])

  const view = useMemo(() => {
    if (!tides) return null
    const t0 = now - 6 * HOUR
    const t1 = now + 36 * HOUR
    const lift = tides.mslAboveMllw ?? 0
    const pts: Array<[number, number]> = []
    for (let t = t0; t <= t1; t += 12 * 60_000) pts.push([t, predictTide(tides.constants, t) + lift])
    const turns = tideTurns(tides.constants, now - HOUR, t1).map((x) => ({ ...x, h: x.h + lift }))
    const lo = Math.min(...pts.map((p) => p[1]))
    const hi = Math.max(...pts.map((p) => p[1]))
    const x = (t: number) => ((t - t0) / (t1 - t0)) * W
    const y = (h: number) => H - 8 - ((h - lo) / Math.max(0.01, hi - lo)) * (H - 16)
    const hNow = predictTide(tides.constants, now) + lift
    const rising = predictTide(tides.constants, now + 10 * 60_000) > predictTide(tides.constants, now)
    return { pts, turns, x, y, hNow, rising, lo, hi, datum: tides.mslAboveMllw != null ? 'above chart datum (MLLW)' : 'above mean sea level' }
  }, [tides, now])

  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Tides">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Tides</h2>
      {error && <p className="warnbox">{error}</p>}
      {!near && !error && <p className="note">Finding the nearest NOAA tide station…</p>}
      {near && near.length > 0 && (
        <div className="field">
          <label htmlFor="tide-station">Station</label>
          <select id="tide-station" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {near.map((s, i) => (
              <option key={s.id} value={i}>
                {s.name}
                {s.state ? `, ${s.state}` : ''} · {s.nm.toFixed(1)} nm
              </option>
            ))}
          </select>
        </div>
      )}
      {near && !tides && !error && <p className="note">Fetching the station's harmonic constants…</p>}
      {view && (
        <>
          <p aria-label="Tide now">
            <b>{view.hNow.toFixed(2)} m</b> {view.datum}, {view.rising ? 'rising' : 'falling'}
          </p>
          <figure style={{ margin: '0 0 8px' }}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Tide curve">
              <polyline
                points={view.pts.map(([t, h]) => `${view.x(t).toFixed(1)},${view.y(h).toFixed(1)}`).join(' ')}
                fill="none"
                stroke="#4fc3f7"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              <line x1={view.x(now)} x2={view.x(now)} y1={0} y2={H} stroke="#ffffff" strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
            </svg>
            <figcaption className="note">
              {view.lo.toFixed(1)} to {view.hi.toFixed(1)} m, six hours ago to a day and a half ahead
            </figcaption>
          </figure>
          <table className="table" aria-label="Highs and lows" style={{ width: '100%', fontSize: 12 }}>
            <tbody>
              {view.turns.map((x) => (
                <tr key={x.t}>
                  <td>{x.high ? 'High' : 'Low'}</td>
                  <td>{clock(x.t)}</td>
                  <td style={{ textAlign: 'right' }}>{x.h.toFixed(2)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Predicted from NOAA's harmonic constants for {tides!.station.name} ({tides!.station.id}), kept on this device. Weather
            and river flow move the real tide by more than the prediction's error.
          </p>
        </>
      )}
      <button className="btn btn--sm" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
