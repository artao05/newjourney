/**
 * Weather chart images on the chart: pick an image, say where its edges are,
 * and it is laid under the weather layers, see-through to taste.
 */
import { useRef } from 'react'
import { useChartImages, type ChartImage } from '@/state/weatherFiles'
import type { BBox } from '@/lib/types'

function Row({ img }: { img: ChartImage }) {
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
        <button className="btn btn--sm btn--ghost" onClick={() => remove(img.id)} aria-label={`Remove ${img.name}`}>
          ✕
        </button>
      </div>
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
        accept="image/png,image/jpeg,image/gif,image/webp"
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
