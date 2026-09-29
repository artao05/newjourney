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

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { logStore } from '@/lib/logging/idbStore'
import { dayOf, type LogRow } from '@/lib/logging/logger'
import { meanBetween, sectionDelta, series, valueRange } from '@/lib/logging/strip'
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
          : `${hm(left)} to ${hm(right)}${end == null && !playback ? ', following' : ''}. Tap a pane to drop a wand (${wands.length}/4).`}
      </p>

      {strip.panes.map((id) => {
        const pts = series(rows, id, left, right)
        const [lo, hi] = valueRange(pts)
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
              {wands.map((w, i) => (
                <line key={i} x1={x(w)} x2={x(w)} y1={0} y2={PANE_H} stroke={WAND_COLOURS[i]} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
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
    </div>
  )
}
