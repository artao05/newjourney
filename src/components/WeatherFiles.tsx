/**
 * The GRIB files the user has opened: a picker that takes several at once, and
 * a list with what each holds, a tick for whether it is used, and remove.
 */
import { useRef, useState } from 'react'
import {
  GRIB_ACCEPT,
  openWeatherFiles,
  summariseCatalogue,
  useWeatherFiles,
  type WeatherFile,
} from '@/state/weatherFiles'

const utc = (t: number) => (Number.isFinite(t) ? `${new Date(t).toISOString().slice(5, 16).replace('T', ' ')}Z` : '—')

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A button that opens the picker, and reports how the files went. */
export function OpenGribButton({ className = 'chip' }: { className?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <button className={className} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Reading GRIB…' : 'Open GRIB'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={GRIB_ACCEPT}
        aria-label="GRIB files to open"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          setBusy(true)
          try {
            await openWeatherFiles(files)
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}

function FileRow({ f }: { f: WeatherFile }) {
  const setEnabled = useWeatherFiles((s) => s.setEnabled)
  const remove = useWeatherFiles((s) => s.remove)
  const rows = summariseCatalogue(f.catalogue)
  const c = f.cube
  return (
    <section aria-label={`GRIB file ${f.name}`} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <input type="checkbox" checked={f.enabled} disabled={!c} onChange={(e) => setEnabled(f.id, e.target.checked)} />
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</b>
        </label>
        <span className="note">{size(f.bytes)}</span>
        <button className="btn btn--sm btn--ghost" onClick={() => remove(f.id)} aria-label={`Remove ${f.name}`}>
          ✕
        </button>
      </div>
      {f.error && <p className="warnbox">Could not use this file: {f.error}</p>}
      {c && (
        <p className="note">
          Run {c.run ? utc(Date.parse(c.run)) : '—'} · {c.nx}×{c.ny} at {c.dx}° · {c.bbox.south.toFixed(2)}° to {c.bbox.north.toFixed(2)}°,{' '}
          {c.bbox.west.toFixed(2)}° to {c.bbox.east.toFixed(2)}° · {c.nt} step{c.nt === 1 ? '' : 's'} from {utc(c.t0)}
        </p>
      )}
      {!c && !f.error && <p className="note">Nothing here the chart or the router uses (wind, pressure, waves or current).</p>}
      {rows.length > 0 && (
        <table className="table" aria-label={`Parameters in ${f.name}`} style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Parameter</th>
              <th style={{ textAlign: 'left' }}>Level</th>
              <th>Steps</th>
              <th>From</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.name}|${r.level}`}>
                <td>{r.name}</td>
                <td>{r.level}</td>
                <td style={{ textAlign: 'center' }}>{r.steps}</td>
                <td style={{ textAlign: 'center' }}>{utc(r.from)}</td>
                <td style={{ textAlign: 'center' }}>{utc(r.to)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {[...f.warnings, ...f.skipped.map((s) => `skipped a message: ${s.reason}`)].map((w, i) => (
        <p key={i} className="note">
          {w}
        </p>
      ))}
    </section>
  )
}

/** The list of opened files. */
export function WeatherFilesSheet({ onClose }: { onClose: () => void }) {
  const files = useWeatherFiles((s) => s.files)
  const clear = useWeatherFiles((s) => s.clear)
  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Weather files">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Weather files</h2>
      <p className="note">
        GRIB 1 and 2 files, opened here or dropped on the chart. The newest ticked file is the one the chart shows. They are kept
        until the page reloads.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <OpenGribButton className="btn btn--sm" />
        {files.length > 0 && (
          <button className="btn btn--sm btn--ghost" onClick={clear}>
            Clear all
          </button>
        )}
        <button className="btn btn--sm btn--ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>
          Done
        </button>
      </div>
      {files.length === 0 && <p className="note">No files open.</p>}
      {files.map((f) => (
        <FileRow key={f.id} f={f} />
      ))}
    </div>
  )
}
