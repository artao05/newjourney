/**
 * Observed weather at the venue's stations, with each station's recent reports
 * set against what the forecast on the chart said for the same place and hour.
 */
import { sampleCube, windFromUv } from '@/lib/weather/cube'
import type { Observation } from '@/lib/weather/observations'
import type { LatLon, WeatherCube } from '@/lib/types'

export interface ObsStation {
  id: string
  name: string
  position: LatLon
  kind: 'coops' | 'ndbc'
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16) + 'Z'
const f = (v: number | null | undefined, dp = 0) => (v == null ? '—' : v.toFixed(dp))

/** One report an hour, the nearest to each whole hour, newest first, up to `n`. */
export function hourly(obs: Observation[], n = 12): Observation[] {
  const byHour = new Map<number, Observation>()
  for (const o of obs) {
    const h = Math.round(o.t / 3_600_000)
    const had = byHour.get(h)
    if (!had || Math.abs(o.t - h * 3_600_000) < Math.abs(had.t - h * 3_600_000)) byHour.set(h, o)
  }
  return [...byHour.values()].sort((a, b) => b.t - a.t).slice(0, n)
}

function forecastAt(cube: WeatherCube | null, at: LatLon, t: number) {
  if (!cube) return null
  const u = sampleCube(cube, 'u10', at.lat, at.lon, t)
  const v = sampleCube(cube, 'v10', at.lat, at.lon, t)
  return u != null && v != null ? windFromUv(u, v) : null
}

export function ObservationsSheet({
  stations,
  obs,
  errors,
  cube,
  onClose,
}: {
  stations: ObsStation[]
  obs: Record<string, Observation[]>
  errors: Record<string, string>
  cube: WeatherCube | null
  onClose: () => void
}) {
  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Observations">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Observations</h2>
      {stations.map((s) => {
        const list = obs[s.id] ?? []
        const latest = list[list.length - 1]
        return (
          <section key={s.id} aria-label={`Station ${s.id}`} style={{ marginBottom: 12 }}>
            <b>
              {s.name} <span className="note">{s.kind === 'coops' ? `NOS ${s.id}` : `NDBC ${s.id}`}</span>
            </b>
            {s.kind === 'ndbc' ? (
              <p className="note">Buoy reports can't be fetched from a browser; they wait for the proxy (D1).</p>
            ) : errors[s.id] ? (
              <p className="warnbox">{errors[s.id]}</p>
            ) : !latest ? (
              <p className="note">Fetching…</p>
            ) : (
              <>
                <p className="note">
                  Latest {hhmm(latest.t)}: {f(latest.twd)}° {f(latest.tws, 1)} kn, gust {f(latest.gust, 1)} kn
                  {latest.pres != null ? `, ${latest.pres.toFixed(1)} hPa` : ''}
                </p>
                <table className="table" aria-label={`Reports from ${s.id}`} style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Time</th>
                      <th>Seen</th>
                      <th>Gust</th>
                      <th>Forecast</th>
                      <th>TWS diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hourly(list).map((o) => {
                      const fc = forecastAt(cube, s.position, o.t)
                      return (
                        <tr key={o.t}>
                          <td>{hhmm(o.t)}</td>
                          <td style={{ textAlign: 'center' }}>
                            {f(o.twd)}° {f(o.tws, 1)}
                          </td>
                          <td style={{ textAlign: 'center' }}>{f(o.gust, 1)}</td>
                          <td style={{ textAlign: 'center' }}>{fc ? `${fc.dir.toFixed(0)}° ${fc.speed.toFixed(1)}` : '—'}</td>
                          <td style={{ textAlign: 'center' }}>{fc && o.tws != null ? `${o.tws - fc.speed >= 0 ? '+' : ''}${(o.tws - fc.speed).toFixed(1)}` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )
      })}
      <button className="btn btn--sm" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
