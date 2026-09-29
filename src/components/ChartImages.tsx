/**
 * Weather chart images on the chart: pick an image, say where its edges are
 * (or place it by control points), and it is laid under the weather layers,
 * see-through to taste.
 */
import { useRef, useState } from 'react'
import { useChartImages, type ChartImage } from '@/state/weatherFiles'
import { boundsFromControlPoints, type ControlPoint, type ImageProjection } from '@/lib/charts/georef'
import type { BBox } from '@/lib/types'

/**
 * Place an image by points on it whose positions are known: tap the picture
 * where a point is (or type its pixel), give its latitude and longitude, and
 * two or more set the edges.
 */
function ControlPoints({ img }: { img: ChartImage }) {
  const update = useChartImages((s) => s.updateImage)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [points, setPoints] = useState<Array<{ x: string; y: string; lat: string; lon: string }>>([])
  const [projection, setProjection] = useState<ImageProjection>('mercator')
  const [result, setResult] = useState<string | null>(null)
  const set = (i: number, k: 'x' | 'y' | 'lat' | 'lon', v: string) => setPoints((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  const place = () => {
    // A blank field would read as 0: only points with all four given.
    const cps: ControlPoint[] = points
      .filter((p) => [p.x, p.y, p.lat, p.lon].every((v) => v.trim() !== ''))
      .map((p) => ({ x: Number(p.x), y: Number(p.y), lat: Number(p.lat), lon: Number(p.lon) }))
      .filter((p) => [p.x, p.y, p.lat, p.lon].every((v) => Number.isFinite(v)))
    const r = size ? boundsFromControlPoints(cps, size.w, size.h, projection) : null
    if (!r) {
      setResult('Needs two points or more, spread across the picture both ways.')
      return
    }
    update(img.id, { bbox: r.bbox })
    setResult(`Placed: the points fit to ${r.rmsPx.toFixed(1)} px.`)
  }
  return (
    <div aria-label={`Control points for ${img.name}`} style={{ marginTop: 6 }}>
      <img
        src={img.url}
        alt={`${img.name}: tap a point whose position you know`}
        style={{ width: '100%', cursor: 'crosshair', display: 'block' }}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onClick={(e) => {
          const el = e.currentTarget
          if (!size || !el.clientWidth) return
          const r = el.getBoundingClientRect()
          const x = Math.round(((e.clientX - r.left) * size.w) / el.clientWidth)
          const y = Math.round(((e.clientY - r.top) * size.h) / el.clientHeight)
          setPoints((ps) => [...ps, { x: String(x), y: String(y), lat: '', lon: '' }])
        }}
      />
      {points.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="note">{i + 1}</span>
          {(['x', 'y', 'lat', 'lon'] as const).map((k) => (
            <input key={k} aria-label={`Point ${i + 1} ${k}`} inputMode="decimal" placeholder={k === 'lat' ? 'lat °N' : k === 'lon' ? 'lon °E' : `${k} px`} value={p[k]} onChange={(e) => set(i, k, e.target.value)} style={{ width: k === 'x' || k === 'y' ? 56 : 84 }} />
          ))}
          <button className="btn btn--sm btn--ghost" aria-label={`Remove point ${i + 1}`} onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <button className="btn btn--sm btn--ghost" onClick={() => setPoints((ps) => [...ps, { x: '', y: '', lat: '', lon: '' }])}>
          ADD POINT
        </button>
        <select aria-label="Picture projection" value={projection} onChange={(e) => setProjection(e.target.value as ImageProjection)}>
          <option value="mercator">Mercator</option>
          <option value="latlon">Latitude/longitude</option>
        </select>
        <button className="btn btn--sm" onClick={place} disabled={points.length < 2}>
          PLACE
        </button>
      </div>
      {result && <p className="note">{result}</p>}
    </div>
  )
}

function Row({ img }: { img: ChartImage }) {
  const [byPoints, setByPoints] = useState(false)
  const update = useChartImages((s) => s.updateImage)
  const remove = useChartImages((s) => s.removeImage)
  const edge = (k: keyof BBox, label: string) => (
    <div className="field" style={{ flex: 1, minWidth: 80 }}>
      <label htmlFor={`${img.id}-${k}`}>{label}</label>
      <input
        id={`${img.id}-${k}`}
        type="number"
        step="0.5"
        inputMode="decimal"
        value={img.bbox[k]}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) update(img.id, { bbox: { ...img.bbox, [k]: v } })
        }}
      />
    </div>
  )
  return (
    <section aria-label={`Image ${img.name}`} style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <input type="checkbox" checked={img.on} onChange={(e) => update(img.id, { on: e.target.checked })} />
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.name}</b>
        </label>
        <button className="btn btn--sm btn--ghost" onClick={() => setByPoints((v) => !v)} aria-pressed={byPoints} title="Place the picture by points on it whose positions are known">
          POINTS
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => remove(img.id)} aria-label={`Remove ${img.name}`}>
          ✕
        </button>
      </div>
      {byPoints && <ControlPoints img={img} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {edge('north', 'Top °')}
        {edge('south', 'Bottom °')}
        {edge('west', 'Left °')}
        {edge('east', 'Right °')}
      </div>
      <div className="field">
        <label htmlFor={`${img.id}-op`}>See-through</label>
        <input id={`${img.id}-op`} type="range" min="0.1" max="1" step="0.05" value={img.opacity} onChange={(e) => update(img.id, { opacity: Number(e.target.value) })} />
      </div>
    </section>
  )
}

export function ChartImages({ area }: { area: BBox }) {
  const images = useChartImages((s) => s.images)
  const add = useChartImages((s) => s.addImage)
  const input = useRef<HTMLInputElement>(null)
  return (
    <section aria-label="Chart images" style={{ marginBottom: 12 }}>
      <h2>Chart images</h2>
      <p className="note">
        A weather chart or satellite picture laid on the chart by its edges, for strategy only. Exact for a latitude/longitude or
        Mercator image; a polar-stereographic chart is only approximate.
      </p>
      <button className="btn btn--sm" onClick={() => input.current?.click()}>
        Add image
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        aria-label="Chart image to add"
        style={{ display: 'none' }}
        onChange={(e) => {
          for (const f of e.target.files ?? []) add(f, { ...area })
          e.target.value = ''
        }}
      />
      {images.map((i) => (
        <Row key={i.id} img={i} />
      ))}
    </section>
  )
}
