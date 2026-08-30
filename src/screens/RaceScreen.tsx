/**
 * Race screen — the tactical numbers, plus the what-if wind shift.
 *
 * The number set is the ~35-channel core from
 * docs/01-expedition-analysis/channels-reference.md, not the 400 Expedition
 * exposes. Every one is computable from a phone GPS, a forecast and a polar.
 */

import { useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { useTick } from '@/hooks/useSensors'
import { Tile, fmtClock } from '@/components/Tile'
import { computeTactics } from '@/lib/tactics'
import { buildLattice } from '@/lib/polar'
import { wrap360 } from '@/lib/angles'
import { distance, bearing } from '@/lib/geo'
import { makeWLCourse } from '@/lib/sim'
import type { PolarLattice, TacticalNumbers, WindEstimate } from '@/lib/types'

export function RaceScreen() {
  const now = useTick(1)
  const state = useStore((s) => s.state)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const wind = useStore((s) => s.wind)
  const current = useStore((s) => s.current)
  const polar = useStore((s) => s.polar)
  const windHistory = useStore((s) => s.windHistory)
  const activeMarkIndex = useStore((s) => s.activeMarkIndex)
  const setActiveMark = useStore((s) => s.setActiveMark)
  const addMark = useStore((s) => s.addMark)
  const replaceMarks = useStore((s) => s.replaceMarks)
  const clearCourse = useStore((s) => s.clearCourse)

  const [whatIfShift, setWhatIfShift] = useState(0)
  const [whatIfSpeed, setWhatIfSpeed] = useState(0)
  const [wlAxis, setWlAxis] = useState(0)
  const [wlUp, setWlUp] = useState(1)
  const [wlDown, setWlDown] = useState(0.1)

  const lineMid = useMemo(() => {
    const { port, starboard } = course.startLine
    if (!port || !starboard) return null
    return { lat: (port.lat + starboard.lat) / 2, lon: (port.lon + starboard.lon) / 2 }
  }, [course.startLine])

  const lattice = useMemo<PolarLattice | null>(() => {
    if (!polar) return null
    try {
      return buildLattice(polar)
    } catch {
      return null
    }
  }, [polar])

  /** What-if is just a decorated wind estimate — the same trick Expedition uses. */
  const effectiveWind: WindEstimate | null = useMemo(() => {
    if (!wind) return null
    if (whatIfShift === 0 && whatIfSpeed === 0) return wind
    return {
      ...wind,
      twd: wrap360(wind.twd + whatIfShift),
      tws: Math.max(0.5, wind.tws + whatIfSpeed),
    }
  }, [wind, whatIfShift, whatIfSpeed])

  const t: TacticalNumbers | null = useMemo(() => {
    if (!state) return null
    try {
      return computeTactics({
        state,
        wind: effectiveWind,
        current,
        boat,
        lattice,
        course,
        activeMarkIndex,
        windHistory,
      })
    } catch {
      return null
    }
  }, [state, effectiveWind, current, boat, lattice, course, activeMarkIndex, windHistory])

  const marks = course.marks
  const active = marks[activeMarkIndex]
  const whatIfOn = whatIfShift !== 0 || whatIfSpeed !== 0

  return (
    <div className="screen">
      <div className="topbar">
        <span>
          {marks.length === 0 ? (
            'No marks set'
          ) : (
            <>
              Leg {activeMarkIndex + 1}/{marks.length} → <b>{active?.name}</b>
            </>
          )}
        </span>
        <span className="chip">{now % 2 === 0 ? '·' : ' '} live</span>
      </div>

      {whatIfOn && (
        <div className="warnbox" style={{ margin: 'var(--pad)', marginBottom: 0 }}>
          <b>What-if active</b> — showing {whatIfShift > 0 ? '+' : ''}
          {whatIfShift}° shift{whatIfSpeed !== 0 ? `, ${whatIfSpeed > 0 ? '+' : ''}${whatIfSpeed} kn` : ''}.
          These are not the real numbers.
        </div>
      )}

      <div className="tiles">
        <Tile label="TWD" value={t?.twd ?? null} unit="°" dp={0}
          sub={t?.windSource ? `from ${t.windSource}` : undefined} />
        <Tile label="TWS" value={t?.tws ?? null} unit="kn" dp={1} />
        <Tile
          label="TWA"
          value={t?.twa == null ? null : Math.abs(t.twa)}
          unit="°"
          dp={0}
          tone={t?.twa == null ? null : t.twa >= 0 ? 'stbd' : 'port'}
          sub={t?.twa == null ? undefined : t.twa >= 0 ? 'starboard' : 'port'}
        />
        <Tile label="SOG" value={state?.sog ?? null} unit="kn" dp={2} />
      </div>

      <div className="tiles">
        <Tile label="target bsp" value={t?.targetBsp ?? null} unit="kn" dp={2} />
        <Tile
          label="polar %"
          value={t?.polarBspPct ?? null}
          unit="%"
          dp={0}
          tone={
            t?.polarBspPct == null ? null : t.polarBspPct >= 98 ? 'stbd' : t.polarBspPct < 90 ? 'warn' : null
          }
        />
        <Tile label="VMG" value={t?.vmg ?? null} unit="kn" dp={2} />
        <Tile label="target TWA" value={t?.targetTwa ?? null} unit="°" dp={0} />
      </div>

      <h2 className="panel" style={{ paddingBottom: 0 }}>
        Laylines
      </h2>
      <div className="tiles">
        <Tile
          label="to port layline"
          value={t?.laylines?.timeToPortLaylineS == null ? null : fmtClock(t.laylines.timeToPortLaylineS)}
          tone="port"
          small
          sub={
            t?.laylines?.distanceToPortLayline == null
              ? undefined
              : `${t.laylines.distanceToPortLayline.toFixed(2)} nm`
          }
        />
        <Tile
          label="to stbd layline"
          value={
            t?.laylines?.timeToStarboardLaylineS == null
              ? null
              : fmtClock(t.laylines.timeToStarboardLaylineS)
          }
          tone="stbd"
          small
          sub={
            t?.laylines?.distanceToStarboardLayline == null
              ? undefined
              : `${t.laylines.distanceToStarboardLayline.toFixed(2)} nm`
          }
        />
        <Tile
          label="TWD to lay"
          value={t?.laylines?.twdToLay ?? null}
          unit="°"
          dp={0}
          small
          sub={
            t?.laylines?.twdToLay != null && t.twd != null
              ? `${t.laylines.twdToLay - t.twd > 0 ? 'right' : 'left'} ${Math.abs(
                  Math.round(t.laylines.twdToLay - t.twd),
                )}°`
              : undefined
          }
        />
        <Tile
          label="layline band"
          value={t?.laylines?.boundsDeg ?? null}
          unit="°"
          dp={0}
          small
          sub="wind oscillation"
        />
      </div>

      <h2 className="panel" style={{ paddingBottom: 0 }}>
        To the mark
      </h2>
      <div className="tiles">
        <Tile label="bearing" value={t?.markBearing ?? null} unit="°" dp={0} small />
        <Tile label="range" value={t?.markRange ?? null} unit="nm" dp={2} small />
        <Tile
          label="time to mark"
          value={t?.markTimeS == null ? null : fmtClock(t.markTimeS)}
          small
        />
        <Tile label="steer" value={t?.headingToSteer ?? null} unit="°" dp={0} small
          sub="allowing for current" />
        <Tile
          label="on port"
          value={t?.portTackDistanceNm ?? null}
          unit="nm"
          dp={2}
          tone="port"
          small
        />
        <Tile
          label="on starboard"
          value={t?.starboardTackDistanceNm ?? null}
          unit="nm"
          dp={2}
          tone="stbd"
          small
        />
      </div>

      <div className="panel">
        <h2>What if?</h2>
        <p className="note">
          Drag to see where the laylines go if the breeze shifts. This is the
          cheapest tactical tool there is — and the one that teaches fastest.
        </p>
        <div className="field field--wide" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <label>
            Wind shift: {whatIfShift > 0 ? '+' : ''}
            {whatIfShift}°
          </label>
          <input
            type="range"
            min={-40}
            max={40}
            step={1}
            value={whatIfShift}
            onChange={(e) => setWhatIfShift(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
        <div className="field field--wide" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <label>
            Wind speed: {whatIfSpeed > 0 ? '+' : ''}
            {whatIfSpeed} kn
          </label>
          <input
            type="range"
            min={-10}
            max={10}
            step={1}
            value={whatIfSpeed}
            onChange={(e) => setWhatIfSpeed(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
        {whatIfOn && (
          <button
            className="btn btn--sm"
            onClick={() => {
              setWhatIfShift(0)
              setWhatIfSpeed(0)
            }}
          >
            RESET WHAT-IF
          </button>
        )}

        <h2>Windward / leeward course</h2>
        <p className="note">
          Builds a course around the start line you already pinged, oriented on
          the course axis — the same construction Expedition offers from its
          Start panel.
        </p>
        <div className="field">
          <label>Axis</label>
          <input
            type="number"
            step="1"
            value={wlAxis}
            onChange={(e) => setWlAxis(Number(e.target.value))}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label>To windward (nm)</label>
          <input
            type="number"
            step="0.1"
            value={wlUp}
            onChange={(e) => setWlUp(Number(e.target.value))}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>To leeward (nm)</label>
          <input
            type="number"
            step="0.1"
            value={wlDown}
            onChange={(e) => setWlDown(Number(e.target.value))}
            inputMode="decimal"
          />
        </div>
        <div className="actions" style={{ background: 'none', border: 'none', padding: '4px 0 0' }}>
          <button
            className="btn btn--sm"
            disabled={!lineMid}
            onClick={() => {
              if (!lineMid) return
              const c = makeWLCourse(lineMid, wlAxis, wlUp, wlDown)
              replaceMarks([
                { name: 'Windward', position: c.windward },
                { name: 'Leeward', position: c.leeward },
              ])
            }}
          >
            BUILD COURSE
          </button>
          <button
            className="btn btn--sm btn--ghost"
            disabled={!wind}
            onClick={() => wind && setWlAxis(Math.round(wind.twd))}
          >
            USE TWD
          </button>
        </div>
        {!lineMid && (
          <p className="note">
            Ping both ends of the start line first, on the <strong>Start</strong>{' '}
            tab.
          </p>
        )}

        <h2>Marks</h2>
        {marks.length === 0 && (
          <p className="note">
            No marks yet. Sail to a mark and press <strong>Drop mark</strong>, or
            build a windward/leeward course above.
          </p>
        )}
        {marks.map((m, i) => (
          <button
            key={m.id}
            className="field"
            style={{
              width: '100%',
              borderColor: i === activeMarkIndex ? 'var(--accent)' : 'var(--line)',
            }}
            onClick={() => setActiveMark(i)}
          >
            <label style={{ color: i === activeMarkIndex ? 'var(--accent)' : undefined }}>
              {i + 1}. {m.name}
            </label>
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              {state
                ? `${distance(state.position, m.position).toFixed(2)} nm · ${bearing(
                    state.position,
                    m.position,
                  ).toFixed(0)}°`
                : ''}
            </span>
          </button>
        ))}
        <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
          <button
            className="btn btn--sm"
            disabled={!state}
            onClick={() => state && addMark(`Mark ${marks.length + 1}`, state.position)}
          >
            DROP MARK
          </button>
          <button className="btn btn--sm btn--ghost" onClick={clearCourse} disabled={!marks.length}>
            CLEAR
          </button>
        </div>
        <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
          <label className="btn btn--sm btn--ghost" style={{ display: 'block' }}>
            IMPORT GPX
            <input
              type="file"
              accept=".gpx,application/gpx+xml"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  const { parseGpx } = await import('@/lib/gpx')
                  const parsed = parseGpx(await f.text())
                  parsed.waypoints.forEach((w) => addMark(w.name, w.position))
                } catch (err) {
                  alert(`Could not read that GPX: ${err instanceof Error ? err.message : err}`)
                } finally {
                  e.target.value = ''
                }
              }}
            />
          </label>
          <button
            className="btn btn--sm btn--ghost"
            disabled={!marks.length}
            onClick={async () => {
              const { marksToGpx, downloadText } = await import('@/lib/gpx')
              downloadText('course.gpx', marksToGpx(marks, course.name))
            }}
          >
            EXPORT GPX
          </button>
        </div>
      </div>
    </div>
  )
}
