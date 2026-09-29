/**
 * Build a GRIB request for Saildocs: the area (the chart's, to start with),
 * model, grid, times and parameters, with the size the reply will be. The mail
 * opens in the user's own mail app; nothing is sent from here.
 */
import { useState } from 'react'
import { SAILDOCS_MODELS, estimateBytes, saildocsMailto, saildocsQuery, type GribRequest } from '@/lib/weather/gribRequest'
import type { BBox } from '@/lib/types'

const RES = [0.25, 0.5, 1, 2]
const STEPS = [3, 6, 12, 24]

function size(b: number) {
  return b < 1024 * 1024 ? `about ${Math.max(1, Math.round(b / 1024))} kB` : `about ${(b / 1024 / 1024).toFixed(1)} MB`
}

export function GribRequestForm({ area }: { area: BBox }) {
  const [r, setR] = useState<GribRequest>(() => ({
    model: 'gfs',
    bbox: { west: +area.west.toFixed(2), south: +area.south.toFixed(2), east: +area.east.toFixed(2), north: +area.north.toFixed(2) },
    res: 0.5,
    hours: 72,
    stepH: 3,
    params: ['WIND', 'PRESS'],
  }))
  const model = SAILDOCS_MODELS.find((m) => m.id === r.model) ?? SAILDOCS_MODELS[0]
  const set = (patch: Partial<GribRequest>) => setR((x) => ({ ...x, ...patch }))
  const edge = (k: keyof BBox, label: string) => (
    <div className="field" style={{ flex: 1, minWidth: 90 }}>
      <label htmlFor={`gr-${k}`}>{label}</label>
      <input
        id={`gr-${k}`}
        type="number"
        step="0.25"
        inputMode="decimal"
        value={r.bbox[k]}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) set({ bbox: { ...r.bbox, [k]: v } })
        }}
      />
    </div>
  )
  const ok = r.bbox.north > r.bbox.south && r.bbox.east > r.bbox.west && r.params.length > 0
  return (
    <section aria-label="Request a GRIB" style={{ marginBottom: 12 }}>
      <h2>Request a GRIB by email</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {edge('north', 'North °')}
        {edge('south', 'South °')}
        {edge('west', 'West °')}
        {edge('east', 'East °')}
      </div>
      <div className="field">
        <label htmlFor="gr-model">Model</label>
        <select
          id="gr-model"
          value={r.model}
          onChange={(e) => {
            const m = SAILDOCS_MODELS.find((x) => x.id === e.target.value) ?? SAILDOCS_MODELS[0]
            set({ model: m.id, params: r.params.filter((p) => m.params.includes(p)).length ? r.params.filter((p) => m.params.includes(p)) : [m.params[0]], hours: Math.min(r.hours, m.maxHours) })
          }}
        >
          {SAILDOCS_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="gr-res">Grid °</label>
          <select id="gr-res" value={r.res} onChange={(e) => set({ res: Number(e.target.value) })}>
            {RES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="gr-hours">Hours ahead</label>
          <input id="gr-hours" type="number" min="6" max={model.maxHours} step="6" value={r.hours} onChange={(e) => set({ hours: Math.max(6, Math.min(model.maxHours, Number(e.target.value) || 6)) })} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="gr-step">Every h</label>
          <select id="gr-step" value={r.stepH} onChange={(e) => set({ stepH: Number(e.target.value) })}>
            {STEPS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div role="group" aria-label="Parameters" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        {model.params.map((p) => (
          <label key={p} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={r.params.includes(p)}
              onChange={(e) => set({ params: e.target.checked ? [...r.params, p] : r.params.filter((x) => x !== p) })}
            />
            {p}
          </label>
        ))}
      </div>
      {ok ? (
        <>
          <p className="note" aria-label="Request text">
            <code>{saildocsQuery(r)}</code> · {size(estimateBytes(r))}
          </p>
          <a className="btn btn--sm" href={saildocsMailto(r)}>
            Email Saildocs
          </a>
        </>
      ) : (
        <p className="warnbox">Give an area with north above south and east of west, and at least one parameter.</p>
      )}
    </section>
  )
}
