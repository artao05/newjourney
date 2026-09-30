/**
 * The stripchart: logged channels against time, a pane each.
 *
 * It reads the day's log, so what REC has recorded (or a replayed or imported
 * day) is what it shows. Following live, it keeps the latest minutes in view;
 * pan back and it holds still. Tap a pane to drop wands: the first two make a
 * section, the next two a second, and each pane shows its means and the change
 * between them, which is how a tack-to-tack or before-and-after comparison is
 * read.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { logStore } from '@/lib/logging/idbStore'
import { dayOf, type LogRow } from '@/lib/logging/logger'
import { meanBetween, meanSd, nextAxis, resample, sectionDelta, series, type AxisMode } from '@/lib/logging/strip'
import { bestRun, findManoeuvres, performanceReport, type BestRun } from '@/lib/logging/analysis'
import { CHANNELS } from '@/lib/channels/catalogue'
import { useTick } from '@/hooks/useSensors'

const SPANS = [5, 15, 30, 60, 180]
const NAMES = new Map(CHANNELS.map((c) => [c.id, c.name]))
const PANE_H = 84
const WAND_COLOURS = ['#ffd54a', '#ffd54a', '#4fc3f7', '#4fc3f7']

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmt = (v: number | null) => (v == null ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))

export function StripchartScreen() {
  const strip = useStore((s) => s.strip)
  const setStrip = useStore((s) => s.setStrip)
  const playback = useStore((s) => s.playback)
  const recording = useStore((s) => s.recording)
  const tick = useTick(0.2)
  const [days, setDays] = useState<string[]>([])
  const [day, setDay] = useState<string>(() => playback?.day ?? dayOf(Date.now()))
  const [rows, setRows] = useState<LogRow[]>([])
  /** The window's right-hand edge, or null to follow the latest data. */
  const [end, setEnd] = useState<number | null>(null)
  const [wands, setWands] = useState<number[]>([])
  const [adding, setAdding] = useState('')
  const events = useStore((s) => s.events)
  const addEvent = useStore((s) => s.addEvent)
  const removeEvent = useStore((s) => s.removeEvent)
  const sailTests = useStore((s) => s.sailTests)
  const addSailTest = useStore((s) => s.addSailTest)
  const removeSailTest = useStore((s) => s.removeSailTest)
  const [eventKind, setEventKind] = useState<'note' | 'sail'>('note')
  const [eventText, setEventText] = useState('')
  const [testSails, setTestSails] = useState('')
  const [testNote, setTestNote] = useState('')
  const [layoutError, setLayoutError] = useState<string | null>(null)

  useEffect(() => {
    void logStore()
      .days()
      .then((d) => setDays(d.map((x) => x.day).sort().reverse()))
      .catch(() => {})
  }, [tick])

  // Reload the day now and then while it may still be growing.
  useEffect(() => {
    let live = true
    void logStore()
      .read(day)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [day, recording ? tick : 0])

  const spanMs = strip.spanMin * 60_000
  const latest = rows.length ? rows[rows.length - 1].t : Date.now()
  const right = playback && playback.day === day ? playback.t : end ?? latest
  const left = right - spanMs
  const available = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.v)) seen.add(k)
    return CHANNELS.filter((c) => seen.has(c.id) && !strip.panes.includes(c.id))
  }, [rows, strip.panes])

  const sections: Array<[number, number] | null> = [
    wands.length >= 2 ? [wands[0], wands[1]] : null,
    wands.length >= 4 ? [wands[2], wands[3]] : null,
  ]

  const pan = (by: number) => setEnd(Math.min(latest, right + by * spanMs))
  const rate = strip.rateHz ?? 1
  // Each pane's last value axis, for roll and shift to follow on from.
  const axes = useRef(new Map<string, [number, number]>())
  const inWindow = events.filter((e) => e.t >= left && e.t <= right)
  const dayEvents = events.filter((e) => dayOf(e.t) === day)
  const dayTests = sailTests.filter((x) => x.day === day)

  /** The first wanded section as a test: the mean of every channel the log has there. */
  const saveTest = () => {
    const sec = sections[0]
    if (!sec) return
    const [from, to] = sec[0] <= sec[1] ? sec : [sec[1], sec[0]]
    const ids = new Set<string>()
    for (const r of rows) if (r.t >= from && r.t <= to) for (const k of Object.keys(r.v)) ids.add(k)
    const means: Record<string, number> = {}
    for (const id of ids) {
      const m = meanBetween(rows, id, from, to)
      if (m != null) means[id] = m
    }
    addSailTest({ day, from, to, sails: testSails.trim(), note: testNote.trim(), means })
    setTestNote('')
  }

  return (
    <div className="screen panel" aria-label="Stripchart">
      <div className="strip-toolbar">
        <select aria-label="Log day" value={day} onChange={(e) => (setDay(e.target.value), setEnd(null), setWands([]))}>
          {[...new Set([day, ...days])].map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="Time span">
          {SPANS.map((m) => (
            <button key={m} aria-pressed={strip.spanMin === m} onClick={() => setStrip({ spanMin: m })}>
              {m < 60 ? `${m}m` : `${m / 60}h`}
            </button>
          ))}
        </div>
        <select aria-label="Sample rate" value={rate} onChange={(e) => setStrip({ rateHz: Number(e.target.value) })}>
          {[0.5, 1, 2, 5].map((hz) => (
            <option key={hz} value={hz}>{hz} Hz</option>
          ))}
        </select>
        <button className="btn btn--sm btn--ghost" aria-label="Back in time" onClick={() => pan(-0.5)}>◀</button>
        <button className="btn btn--sm btn--ghost" aria-label="On in time" onClick={() => pan(0.5)}>▶</button>
        <button className="btn btn--sm btn--ghost" aria-pressed={end == null} onClick={() => setEnd(null)}>
          LIVE
        </button>
        <button className="btn btn--sm btn--ghost" disabled={!wands.length} onClick={() => setWands([])}>
          CLEAR WANDS
        </button>
      </div>
      <p className="note" aria-label="Stripchart window">
        {rows.length === 0
          ? `No log for ${day}. Turn on REC to log, or pick another day.`
          : `${hm(left)} to ${hm(right)}${end == null && !playback ? ', following' : ''} at ${rate} Hz. Tap a pane to drop a wand (${wands.length}/4).`}
      </p>

      {strip.panes.map((id) => {
        const pts = resample(series(rows, id, left, right, 3000), rate)
        const mode: AxisMode = strip.axes?.[id] ?? 'auto'
        const [lo, hi] = nextAxis(axes.current.get(id) ?? null, pts, mode, Math.max(0.5, (axes.current.get(id)?.[1] ?? 1) - (axes.current.get(id)?.[0] ?? 0)) * 0.1)
        axes.current.set(id, [lo, hi])
        const second = strip.second?.[id]
        const pts2 = second ? resample(series(rows, second, left, right, 3000), rate) : []
        const [lo2, hi2] = nextAxis(null, pts2, 'auto')
        const y2 = (v: number) => PANE_H - ((v - lo2) / (hi2 - lo2)) * PANE_H
        const stats2 = second ? meanSd(second, pts2) : null
        const x = (t: number) => ((t - left) / spanMs) * 1000
        const y = (v: number) => PANE_H - ((v - lo) / (hi - lo)) * PANE_H
        const m = sections.map((s) => (s ? meanBetween(rows, id, s[0], s[1]) : null))
        const delta = sectionDelta(id, m[0], m[1])
        const last = pts.length ? pts[pts.length - 1][1] : null
        return (
          <section key={id} className="strip-pane" aria-label={`Pane ${NAMES.get(id) ?? id}`}>
            <div className="strip-pane__head">
              <b>{NAMES.get(id) ?? id}</b>
              <span>{fmt(last)}</span>
              {m[0] != null && <span style={{ color: WAND_COLOURS[0] }}>mean {fmt(m[0])}</span>}
              {m[1] != null && <span style={{ color: WAND_COLOURS[2] }}>mean {fmt(m[1])}</span>}
              {delta != null && <span aria-label="Section delta">Δ {delta > 0 ? '+' : ''}{fmt(delta)}</span>}
              {second && (
                <span aria-label="Second trace" style={{ color: '#4fc3f7' }}>
                  {NAMES.get(second) ?? second} ({stats2 ? `${fmt(stats2.mean)} ± ${fmt(stats2.sd)}` : '—'})
                </span>
              )}
              <select aria-label={`Axis for ${NAMES.get(id) ?? id}`} value={mode} onChange={(e) => setStrip({ axes: { ...strip.axes, [id]: e.target.value as AxisMode } })}>
                <option value="auto">fit</option>
                <option value="roll">roll</option>
                <option value="shift">shift max</option>
              </select>
              <select aria-label={`Second trace for ${NAMES.get(id) ?? id}`} value={second ?? ''} onChange={(e) => setStrip({ second: { ...strip.second, [id]: e.target.value } })}>
                <option value="">+ trace</option>
                {CHANNELS.filter((c) => c.id !== id && rows.some((r) => Number.isFinite(r.v[c.id]))).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                className="btn btn--sm btn--ghost"
                aria-label={`Remove ${NAMES.get(id) ?? id}`}
                onClick={() => setStrip({ panes: strip.panes.filter((p) => p !== id) })}
              >
                ×
              </button>
            </div>
            <svg
              viewBox={`0 0 1000 ${PANE_H}`}
              preserveAspectRatio="none"
              width="100%"
              height={PANE_H}
              role="img"
              aria-label={`${NAMES.get(id) ?? id} against time`}
              onClick={(e) => {
                if (wands.length >= 4) return
                const r = e.currentTarget.getBoundingClientRect()
                const frac = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5
                setWands([...wands, left + Math.max(0, Math.min(1, frac)) * spanMs])
              }}
            >
              {sections.map((s, i) =>
                s ? (
                  <rect key={i} x={x(Math.min(...s))} width={Math.abs(x(s[1]) - x(s[0]))} y={0} height={PANE_H}
                    fill={WAND_COLOURS[i * 2]} opacity={0.08} />
                ) : null,
              )}
              {inWindow.map((ev) => (
                <line key={ev.id} x1={x(ev.t)} x2={x(ev.t)} y1={0} y2={PANE_H} stroke="#ff8a4a" strokeWidth={1}
                  strokeDasharray="3 3" vectorEffect="non-scaling-stroke">
                  <title>{ev.text}</title>
                </line>
              ))}
              {wands.map((w, i) => (
                <line key={i} x1={x(w)} x2={x(w)} y1={0} y2={PANE_H} stroke={WAND_COLOURS[i]} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
              {pts2.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#4fc3f7"
                  strokeWidth={1.2}
                  vectorEffect="non-scaling-stroke"
                  aria-label="second trace line"
                  points={pts2.map(([t, v]) => `${x(t).toFixed(1)},${y2(v).toFixed(1)}`).join(' ')}
                />
              )}
              {pts.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#e8f1fa"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  points={pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                />
              )}
            </svg>
          </section>
        )
      })}

      <section aria-label="Events" className="strip-block">
        <h2>Events</h2>
        <div className="strip-toolbar">
          <div className="seg" role="group" aria-label="Event kind">
            <button aria-pressed={eventKind === 'note'} onClick={() => setEventKind('note')}>Note</button>
            <button aria-pressed={eventKind === 'sail'} onClick={() => setEventKind('sail')}>Sail change</button>
          </div>
          <input aria-label="Event text" placeholder={eventKind === 'sail' ? 'e.g. J2 to J3' : 'what happened'}
            value={eventText} onChange={(e) => setEventText(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
          <button className="btn btn--sm" disabled={!eventText.trim()} onClick={() => {
            addEvent(eventKind, eventText)
            setEventText('')
          }}>
            ADD NOW
          </button>
        </div>
        {dayEvents.length === 0 ? (
          <p className="note">None on {day}. Pings and the gun are added on their own.</p>
        ) : (
          <table className="targets" aria-label="Day events">
            <tbody>
              {dayEvents.slice(-20).reverse().map((ev) => (
                <tr key={ev.id}>
                  <td style={{ textAlign: 'left' }}>{hm(ev.t)}</td>
                  <td style={{ textAlign: 'left' }}>{ev.kind}</td>
                  <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>{ev.text}</td>
                  <td>
                    <button className="btn btn--sm btn--ghost" aria-label={`Remove event ${ev.text}`} onClick={() => removeEvent(ev.id)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Sail tests" className="strip-block">
        <h2>Tests</h2>
        <div className="strip-toolbar">
          <input aria-label="Test sails" placeholder="sails up" value={testSails} onChange={(e) => setTestSails(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
          <input aria-label="Test note" placeholder="sea, trim, comments" value={testNote} onChange={(e) => setTestNote(e.target.value)} style={{ flex: 2, minWidth: 120 }} />
          <button className="btn btn--sm" disabled={!sections[0]} onClick={saveTest}>
            SAVE TEST
          </button>
        </div>
        {!sections[0] && <p className="note">Drop two wands on a pane to mark the span, then save it as a test.</p>}
        {dayTests.length > 0 && (
          <table className="targets" aria-label="Day tests">
            <tbody>
              {dayTests.map((x) => (
                <tr key={x.id}>
                  <td style={{ textAlign: 'left' }}>{hm(x.from)}–{hm(x.to)}</td>
                  <td style={{ textAlign: 'left' }}>{x.sails || '—'}</td>
                  <td>{x.means.bsp != null ? `${x.means.bsp.toFixed(2)} kn` : '—'}</td>
                  <td>{x.means.twa != null ? `${Math.round(x.means.twa)}°` : '—'}</td>
                  <td>{x.means.tws != null ? `${x.means.tws.toFixed(1)} kn` : '—'}</td>
                  <td>
                    <button className="btn btn--sm btn--ghost" aria-label={`Remove test ${hm(x.from)}`} onClick={() => removeSailTest(x.id)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {available.length > 0 && (
        <div className="field">
          <label htmlFor="strip-add">Add a pane</label>
          <select
            id="strip-add"
            value={adding}
            onChange={(e) => {
              if (e.target.value) setStrip({ panes: [...strip.panes, e.target.value] })
              setAdding('')
            }}
          >
            <option value="">choose a channel…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '4px 0' }}>
        <button
          className="btn btn--sm btn--ghost"
          onClick={async () => {
            const { downloadText } = await import('@/lib/gpx')
            downloadText('stripchart.json', JSON.stringify({ app: 'newjourney', kind: 'stripchart', v: 1, strip }, null, 2), 'application/json')
          }}
        >
          SAVE LAYOUT
        </button>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          LOAD LAYOUT
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Stripchart layout to load"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                const j = JSON.parse(await f.text())
                const l = j?.strip
                if (j?.kind === 'stripchart' && l && Array.isArray(l.panes) && l.panes.every((x: unknown) => typeof x === 'string') && Number.isFinite(l.spanMin)) {
                  setStrip({ panes: l.panes, spanMin: l.spanMin, rateHz: l.rateHz, second: l.second, axes: l.axes })
                  setLayoutError(null)
                } else setLayoutError('Not a stripchart layout.')
              } catch {
                setLayoutError('Not a stripchart layout.')
              }
            }}
          />
        </label>
        {layoutError && <span className="warnbox">{layoutError}</span>}
      </div>
      <Analysis rows={rows} days={days} />
    </div>
  )
}

const n1 = (v: number | null, dp = 1) => (v == null ? '—' : v.toFixed(dp))
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The day's log in numbers: a summary, each tack and gybe and its cost, and the best 24 hours. */
function Analysis({ rows, days }: { rows: LogRow[]; days: string[] }) {
  const report = useMemo(() => (rows.length > 1 ? performanceReport(rows) : null), [rows])
  const man = useMemo(() => findManoeuvres(rows), [rows])
  const [best, setBest] = useState<BestRun | null | 'none'>(null)
  const [busy, setBusy] = useState(false)
  if (!report) return null
  const h = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`
  return (
    <section aria-label="Analysis" className="strip-block">
      <h2>Analysis</h2>
      <table className="targets" aria-label="Day summary">
        <tbody>
          <tr><td>Logged</td><td>{h(report.durationS)}, {n1(report.distanceNm)} nm</td></tr>
          <tr><td>SOG</td><td>{n1(report.meanSog)} kn mean, {n1(report.maxSog)} kn best</td></tr>
          <tr><td>TWS</td><td>{n1(report.meanTws)} kn mean</td></tr>
          <tr><td>Polar, VMG</td><td>{n1(report.meanPolarPct, 0)} %, {n1(report.meanVmgPct, 0)} %</td></tr>
          <tr><td>Upwind, reaching, downwind</td><td>{n1(report.upwindPct, 0)} %, {n1(report.reachingPct, 0)} %, {n1(report.downwindPct, 0)} %</td></tr>
          <tr><td>Tacks, gybes</td><td>{report.tacks} ({n1(report.meanTackLossS, 0)} s each), {report.gybes} ({n1(report.meanGybeLossS, 0)} s each)</td></tr>
        </tbody>
      </table>
      {man.length > 0 && (
        <table className="targets" aria-label="Tacks and gybes">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Time</th><th>Kind</th><th>Lost m</th><th>Lost s</th></tr>
          </thead>
          <tbody>
            {man.map((m) => (
              <tr key={m.t}>
                <td>{clock(m.t)}</td>
                <td style={{ textAlign: 'center' }}>{m.kind}</td>
                <td style={{ textAlign: 'center' }}>{n1(m.lossM, 0)}</td>
                <td style={{ textAlign: 'center' }}>{n1(m.lossS, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="note">A tack or gybe's cost is the distance made good lost against the VMG sailed steadily before it, over a minute around it.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn btn--sm btn--ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              // Every day logged, joined in order: a 24-hour run crosses midnight.
              const all: LogRow[] = []
              for (const d of [...days].sort()) all.push(...(await logStore().read(d)))
              setBest(bestRun(all) ?? 'none')
            } finally {
              setBusy(false)
            }
          }}
        >
          BEST 24 H RUN
        </button>
        {best && (
          <span aria-label="Best 24-hour run">
            {best === 'none' ? 'No positions logged.' : `${best.nm.toFixed(1)} nm, ${new Date(best.from).toLocaleString()} to ${new Date(best.to).toLocaleString()}`}
          </span>
        )}
      </div>
    </section>
  )
}
