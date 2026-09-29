/**
 * The forecast at one point over time: a meteogram of wind, gust and pressure
 * with the wind's direction, and the weather table under it with every
 * parameter the forecast has there.
 */
import { useState } from 'react'
import { pointSeries, presentColumns, type PointStep } from '@/lib/weather/meteogram'
import type { LatLon, WeatherCube } from '@/lib/types'

const W = 1000
const H = 140

const COLUMNS: Record<keyof Omit<PointStep, 't'>, { label: string; dp: number }> = {
  twd: { label: 'TWD °', dp: 0 },
  tws: { label: 'TWS kn', dp: 1 },
  gust: { label: 'Gust kn', dp: 1 },
  prmsl: { label: 'MSLP hPa', dp: 1 },
  hs: { label: 'Waves m', dp: 1 },
  t2m: { label: 'Air °C', dp: 1 },
  sst: { label: 'Sea °C', dp: 1 },
  rain: { label: 'Rain mm/h', dp: 1 },
  drift: { label: 'Drift kn', dp: 2 },
  set: { label: 'Set °', dp: 0 },
}

const hhmm = (t: number) => new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z'

export function PointMeteogram({ cube, at, t, place }: { cube: WeatherCube; at: LatLon; t: number; place: string }) {
  const [table, setTable] = useState(false)
  const steps = pointSeries(cube, at)
  const cols = presentColumns(steps)
  if (!steps.some((s) => cols.some((c) => s[c] != null))) return <p className="note">The forecast does not cover {place}.</p>
  const t0 = steps[0].t
  const span = Math.max(1, steps[steps.length - 1].t - t0)
  const x = (tt: number) => ((tt - t0) / span) * W
  const speeds = steps.flatMap((s) => [s.tws, s.gust]).filter((v): v is number => v != null)
  const vmax = Math.max(5, ...speeds) * 1.1
  const y = (v: number) => H - (v / vmax) * (H - 20)
  const pressures = steps.map((s) => s.prmsl).filter((v): v is number => v != null)
  const plo = Math.min(...pressures) - 1
  const phi = Math.max(...pressures) + 1
  const yp = (v: number) => H - ((v - plo) / Math.max(1, phi - plo)) * (H - 20)
  const line = (get: (s: PointStep) => number | null, fy: (v: number) => number) =>
    steps.filter((s) => get(s) != null).map((s) => `${x(s.t).toFixed(1)},${fy(get(s)!).toFixed(1)}`).join(' ')
  const every = Math.max(1, Math.ceil(steps.length / 14))
  return (
    <div>
      <figure style={{ margin: '0 0 8px', position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`Wind, gust and pressure at ${place}`}>
          {pressures.length > 1 && <polyline points={line((s) => s.prmsl, yp)} fill="none" stroke="#b0b8c4" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />}
          <polyline points={line((s) => s.gust, y)} fill="none" stroke="#ffb74d" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <polyline points={line((s) => s.tws, y)} fill="none" stroke="#4fc3f7" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
          {t >= t0 && t <= t0 + span && <line x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="#ffffff" strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        {steps.map((s, i) =>
          i % every === 0 && s.twd != null ? (
            <span key={s.t} aria-hidden="true" className="meteogram__arrow" style={{ left: `${(x(s.t) / W) * 100}%`, transform: `translateX(-50%) rotate(${s.twd}deg)` }}>
              ↓
            </span>
          ) : null,
        )}
        <figcaption className="note">
          <span style={{ color: '#4fc3f7' }}>TWS</span> · <span style={{ color: '#ffb74d' }}>gust</span>
          {pressures.length > 1 ? (
            <>
              {' '}
              · <span style={{ color: '#b0b8c4' }}>MSLP {plo.toFixed(0)}–{phi.toFixed(0)} hPa</span>
            </>
          ) : null}{' '}
          · 0–{vmax.toFixed(0)} kn · {hhmm(t0)} to {hhmm(t0 + span)}
        </figcaption>
      </figure>
      <button className="btn btn--sm btn--ghost" aria-pressed={table} onClick={() => setTable((v) => !v)}>
        {table ? 'Hide table' : 'Weather table'}
      </button>
      {table && (
        <table className="table" aria-label={`Forecast at ${place}`} style={{ width: '100%', fontSize: 12, marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Time</th>
              {cols.map((c) => (
                <th key={c}>{COLUMNS[c].label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.t}>
                <td>{hhmm(s.t)}</td>
                {cols.map((c) => (
                  <td key={c} style={{ textAlign: 'center' }}>
                    {s[c] == null ? '—' : s[c]!.toFixed(COLUMNS[c].dp)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
