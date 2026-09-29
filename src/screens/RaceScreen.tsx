/**
 * Race screen — the tactical numbers, plus the what-if wind shift.
 *
 * The number set is the ~35-channel core from
 * docs/01-expedition-analysis/channels-reference.md, not the 400 Expedition
 * exposes. Every one is computable from a phone GPS, a forecast and a polar.
 */

import { redoMarks, undoMarks, useMarkHistory } from '@/state/markHistory'
import { useMemo, useState } from 'react'
import { BoatsDatabase } from '@/components/Boats'
import { useStore } from '@/state/store'
import { useTick } from '@/hooks/useSensors'
import { NumberBoxes } from '@/components/NumberBoxes'
import { MarkSheet } from '@/components/MarkSheet'
import { MarksLibrary } from '@/components/MarksLibrary'
import { CourseLegs } from '@/components/CourseLegs'
import { RaceNotesList } from '@/components/RaceNotes'
import { HandicapCalc } from '@/components/Handicap'
import { useLayout } from '@/hooks/useWide'
import { usePolarLattices } from '@/hooks/usePolars'
import { Tile, fmtClock } from '@/components/Tile'
import { computeTactics } from '@/lib/tactics'
import { angsep, fmtDeg, fmtShift } from '@/lib/angles'
import { sailAt } from '@/lib/sailchart'
import { distance, bearing, destination } from '@/lib/geo'
import { buildWLCourse } from '@/lib/wlcourse'
import { NO_WHAT_IF, applyWhatIfCurrent, applyWhatIfWind, describeWhatIf, whatIfActive } from '@/lib/whatif'
import { gateNumbers } from '@/lib/gates'
import { declinationAt, magneticToTrue, trueToMagnetic } from '@/lib/magnetic'
import { PILOT_VENUE } from '@/data/venues'
import type { TacticalNumbers, WindEstimate } from '@/lib/types'

export function RaceScreen() {
  const now = useTick(1)
  const state = useStore((s) => s.state)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const wind = useStore((s) => s.wind)
  const current = useStore((s) => s.current)
  const windHistory = useStore((s) => s.windHistory)
  const activeMarkIndex = useStore((s) => s.activeMarkIndex)
  const xteOrigin = useStore((s) => s.xteOrigin)
  const layout = useLayout()
  const sailChart = useStore((s) => s.sailChart)
  const resetXte = useStore((s) => s.resetXte)
  const setActiveMark = useStore((s) => s.setActiveMark)
  const addMark = useStore((s) => s.addMark)
  const dropMob = useStore((s) => s.dropMob)
  const replaceMarks = useStore((s) => s.replaceMarks)
  const clearMarks = useStore((s) => s.clearMarks)

  const [editingMark, setEditingMark] = useState<string | null>(null)
  const { canUndo, canRedo } = useMarkHistory()
  const autoAdvance = useStore((s) => s.settings.autoAdvance)
  const [pingRange, setPingRange] = useState('')
  const [pingBearing, setPingBearing] = useState('')
  const whatIf = useStore((s) => s.whatIf)
  const setWhatIf = useStore((s) => s.setWhatIf)
  const whatIfShift = whatIf.shiftDeg
  const whatIfSpeed = whatIf.speedDeltaKn
  const setWhatIfShift = (v: number) => setWhatIf({ shiftDeg: v })
  const setWhatIfSpeed = (v: number) => setWhatIf({ speedDeltaKn: v })
  const [wlAxis, setWlAxis] = useState(0)
  const [wlUp, setWlUp] = useState(1)
  const [wlDown, setWlDown] = useState(0.1)
  const [wlGate, setWlGate] = useState<number | null>(null)
  const [wlLaps, setWlLaps] = useState(2)
  const [wlAbove, setWlAbove] = useState<'committee' | 'middle' | 'pin'>('middle')
  const [wlLeave, setWlLeave] = useState<'port' | 'starboard'>('port')
  const northRef = useStore((s) => s.settings.northRef)

  const lineMid = useMemo(() => {
    const { port, starboard } = course.startLine
    if (!port || !starboard) return null
    return { lat: (port.lat + starboard.lat) / 2, lon: (port.lon + starboard.lon) / 2 }
  }, [course.startLine])

  const polars = usePolarLattices()
  const lattice = polars.navigation

  /** What-if is just a decorated wind estimate — the same trick Expedition uses. */
  const effectiveWind: WindEstimate | null = useMemo(() => {
    if (!wind) return null
    return applyWhatIfWind(wind, whatIf)
  }, [wind, whatIf])
  const effectiveCurrent = applyWhatIfCurrent(current, whatIf)

  const t: TacticalNumbers | null = useMemo(() => {
    if (!state) return null
    try {
      return computeTactics({
        state,
        wind: effectiveWind,
        current: effectiveCurrent,
        boat,
        lattice,
        course,
        activeMarkIndex,
        windHistory,
        xteOrigin,
        performanceLattice: polars.performance,
      })
    } catch {
      return null
    }
  }, [state, effectiveWind, effectiveCurrent, boat, lattice, course, activeMarkIndex, windHistory, xteOrigin, polars.performance])

  const marks = course.marks
  const active = marks[activeMarkIndex]
  const gate = useMemo(
    () =>
      state && active?.gate
        ? gateNumbers({ from: state.position, left: active.gate.left, right: active.gate.right, wind: effectiveWind, lattice })
        : null,
    [state, active, effectiveWind, lattice],
  )
  const whatIfOn = whatIfActive(whatIf)

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

      {active?.mobAt != null && (
        <div className="errbox mob" role="alert" style={{ margin: 'var(--pad)', marginBottom: 0 }}>
          <b>MAN OVERBOARD</b> · {fmtClock((now - active.mobAt) / 1000)} ago ·{' '}
          {t?.markBearing != null ? `${fmtDeg(t.markBearing)}°` : '—'}{' '}
          {t?.markRange != null ? `${t.markRange.toFixed(2)} nm` : ''}
        </div>
      )}

      {whatIfOn && (
        <div className="warnbox" style={{ margin: 'var(--pad)', marginBottom: 0 }}>
          <b>What-if active</b> — showing {describeWhatIf(whatIf)}. These are not the real
          numbers.
        </div>
      )}

      {/* The nav station has its own column of boxes beside this panel. */}
      {layout === 'phone' && (
        <>
          <h2 className="panel" style={{ paddingBottom: 0 }}>
            Number boxes
          </h2>
          <NumberBoxes />
        </>
      )}

      <div className="tiles">
        <Tile label="TWD" value={t?.twd != null ? fmtDeg(t.twd) : null} unit="°"
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
        <Tile label="polar bsp" value={t?.polarBsp ?? null} unit="kn" dp={2} small
          sub="the polar at this angle" />
        <Tile label="VMG %" value={t?.vmgPct ?? null} unit="%" dp={0} small
          sub="of target VMG" />
        <Tile
          label="sail"
          value={t?.twa != null && t.tws != null ? sailAt(sailChart, t.twa, t.tws) : null}
          small
          sub={sailChart ? 'from the sail chart' : 'no sail chart loaded'}
        />
        <Tile
          label="sail next leg"
          value={
            t?.nextMarkBearing != null && t.tws != null && t.twd != null
              ? sailAt(sailChart, angsep(t.nextMarkBearing, t.twd), t.tws)
              : null
          }
          small
        />
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
              ? fmtShift(t.twd, t.laylines.twdToLay)
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
        <Tile
          label="port layline"
          value={t?.laylines ? fmtDeg(t.laylines.portBearing) : null}
          unit="°"
          tone="port"
          small
          sub="bearing to the mark"
        />
        <Tile
          label="stbd layline"
          value={t?.laylines ? fmtDeg(t.laylines.starboardBearing) : null}
          unit="°"
          tone="stbd"
          small
          sub="bearing to the mark"
        />
      </div>

      <h2 className="panel" style={{ paddingBottom: 0 }}>
        To the mark
      </h2>
      <div className="tiles">
        <Tile label="bearing" value={t?.markBearing != null ? fmtDeg(t.markBearing) : null} unit="°" small />
        <Tile label="range" value={t?.markRange ?? null} unit="nm" dp={2} small />
        <Tile
          label="time to mark"
          value={t?.markTimeS == null ? null : fmtClock(t.markTimeS)}
          small
        />
        <Tile label="steer" value={t?.headingToSteer != null ? fmtDeg(t.headingToSteer) : null} unit="°" small
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
        <Tile
          label="VMC"
          value={t?.vmc ?? null}
          unit="kn"
          dp={2}
          small
          sub={t?.vmcOptimum != null ? `best ${t.vmcOptimum.toFixed(2)} kn` : 'made good to the mark'}
        />
        <Tile
          label="XTE"
          value={t?.xteNm == null ? null : Math.abs(t.xteNm)}
          unit="nm"
          dp={2}
          small
          sub={
            t?.xteNm == null
              ? 'off the leg'
              : `${t.xteNm >= 0 ? 'right' : 'left'} of the ${xteOrigin ? 'reset line' : 'leg'}`
          }
        />
        <Tile label="to finish" value={t?.distanceToFinishNm ?? null} unit="nm" dp={2} small
          sub="through every mark" />
        <Tile
          label="next leg"
          value={t?.nextMarkBearing != null ? fmtDeg(t.nextMarkBearing) : null}
          unit="°"
          small
          sub={t?.nextMarkRange != null ? `${t.nextMarkRange.toFixed(2)} nm` : 'no next mark'}
        />
      </div>
      <div className="actions">
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => state && resetXte(state.position)}
          disabled={!state || !active}
          title="Measure cross-track from here to the mark, instead of from the start of the leg"
        >
          RESET XTE
        </button>
        {xteOrigin && (
          <button className="btn btn--sm btn--ghost" onClick={() => resetXte(null)}>
            XTE FROM LEG
          </button>
        )}
      </div>

      {gate && (
        <>
          <h2 className="panel" style={{ paddingBottom: 0 }}>
            Gate
          </h2>
          <div className="tiles">
            <Tile
              label="favoured buoy"
              value={gate.favoured == null ? null : gate.favoured === 'even' ? 'even' : gate.favoured === 'left' ? 'LEFT' : 'RIGHT'}
              small
              sub={
                gate.biasLengthM != null && gate.biasAngleDeg != null
                  ? `${gate.biasLengthM.toFixed(0)} m · ${Math.abs(gate.biasAngleDeg).toFixed(0)}° · looking upwind`
                  : 'needs a wind'
              }
            />
            <Tile label="square wind" value={fmtDeg(gate.squareWindDeg)} unit="°" small sub={`gate ${gate.lengthM.toFixed(0)} m wide`} />
            <Tile
              label="gate spot"
              value={gate.spotRangeNm}
              unit="nm"
              dp={2}
              small
              sub={gate.spotTimeS != null ? `${fmtClock(gate.spotTimeS)} at target` : 'where both laylines cross'}
            />
          </div>
        </>
      )}

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
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={whatIf.current !== null}
            onChange={(e) => setWhatIf({ current: e.target.checked ? { set: current?.set ?? 0, drift: current?.drift ?? 0.5 } : null })}
            aria-label="What-if current"
          />
          <span>What-if current, instead of the one measured</span>
        </label>
        {whatIf.current && (
          <>
            <div className="field">
              <label htmlFor="wi-set">Current set <span className="note">°T, toward</span></label>
              <input id="wi-set" type="number" step="5" value={whatIf.current.set}
                onChange={(e) => setWhatIf({ current: { ...whatIf.current!, set: Number(e.target.value) } })} inputMode="numeric" />
            </div>
            <div className="field">
              <label htmlFor="wi-drift">Current drift <span className="note">kn</span></label>
              <input id="wi-drift" type="number" step="0.1" min="0" value={whatIf.current.drift}
                onChange={(e) => setWhatIf({ current: { ...whatIf.current!, drift: Math.max(0, Number(e.target.value)) } })} inputMode="decimal" />
            </div>
          </>
        )}
        {whatIfOn && (
          <button
            className="btn btn--sm"
            onClick={() => setWhatIf({ ...NO_WHAT_IF })}
          >
            RESET WHAT-IF
          </button>
        )}

        <h2>Windward / leeward course</h2>
        <p className="note">
          Builds a course around the start line you already pinged, as Expedition&apos;s
          W/L wizard does. A positive leeward distance puts the leeward mark above the
          line, the usual modern course; negative puts it below.
        </p>
        <div className="field">
          <label htmlFor="wl-axis">
            Axis <span className="note">°{northRef === 'magnetic' ? 'M' : 'T'}</span>
          </label>
          <input
            id="wl-axis"
            type="number"
            step="1"
            value={wlAxis}
            onChange={(e) => setWlAxis(Number(e.target.value))}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label htmlFor="wl-up">To windward (nm)</label>
          <input id="wl-up" type="number" step="0.1" value={wlUp}
            onChange={(e) => setWlUp(Number(e.target.value))} inputMode="decimal" />
        </div>
        <div className="field">
          <label htmlFor="wl-down">To leeward (nm)</label>
          <input id="wl-down" type="number" step="0.05" value={wlDown}
            onChange={(e) => setWlDown(Number(e.target.value))} inputMode="decimal" />
        </div>
        <div className="field">
          <label htmlFor="wl-gate">
            Leeward gate <span className="note">m wide, blank for a mark</span>
          </label>
          <input id="wl-gate" type="number" step="10" min="0" placeholder="no gate" value={wlGate ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value)
              setWlGate(e.target.value.trim() === '' || !(v > 0) ? null : v)
            }} inputMode="numeric" />
        </div>
        <div className="field">
          <label htmlFor="wl-laps">Laps</label>
          <input id="wl-laps" type="number" step="1" min="1" max="10" value={wlLaps}
            onChange={(e) => setWlLaps(Math.max(1, Math.min(10, Math.round(Number(e.target.value)) || 1)))}
            inputMode="numeric" />
        </div>
        <div className="seg" role="group" aria-label="Leeward mark above" style={{ marginBottom: 6 }}>
          {(['committee', 'middle', 'pin'] as const).map((a) => (
            <button key={a} aria-pressed={wlAbove === a} onClick={() => setWlAbove(a)}>
              {a === 'committee' ? 'Above RC' : a === 'middle' ? 'Mid-line' : 'Above pin'}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Leave marks to" style={{ marginBottom: 6 }}>
          {(['port', 'starboard'] as const).map((r) => (
            <button key={r} aria-pressed={wlLeave === r} onClick={() => setWlLeave(r)}>
              Leave to {r}
            </button>
          ))}
        </div>
        <div className="actions" style={{ background: 'none', border: 'none', padding: '4px 0 0' }}>
          <button
            className="btn btn--sm"
            disabled={!course.startLine.port || !course.startLine.starboard}
            onClick={() => {
              const { port, starboard } = course.startLine
              if (!port || !starboard) return
              const axisTrue =
                northRef === 'magnetic' ? magneticToTrue(wlAxis, declinationAt(PILOT_VENUE.declination, now)) : wlAxis
              replaceMarks(
                buildWLCourse({
                  line: { port, starboard },
                  axisTrue,
                  windwardNm: wlUp,
                  leewardNm: wlDown,
                  leewardAbove: wlAbove,
                  gateWidthM: wlGate,
                  leaveTo: wlLeave,
                  laps: wlLaps,
                }),
              )
            }}
          >
            BUILD COURSE
          </button>
          <button
            className="btn btn--sm btn--ghost"
            disabled={!wind}
            onClick={() =>
              wind &&
              setWlAxis(
                Math.round(
                  northRef === 'magnetic'
                    ? trueToMagnetic(wind.twd, declinationAt(PILOT_VENUE.declination, now))
                    : wind.twd,
                ),
              )
            }
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ flex: 1 }}>Marks</h2>
          <button className="btn btn--sm btn--ghost" onClick={() => undoMarks()} disabled={!canUndo} aria-label="Undo marks" title="Undo the last change to the marks (Ctrl-Z)">
            ↶ UNDO
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => redoMarks()} disabled={!canRedo} aria-label="Redo marks" title="Redo (Ctrl-Y)">
            ↷ REDO
          </button>
        </div>
        {marks.length === 0 && (
          <p className="note">
            No marks yet. Sail to a mark and press <strong>Drop mark</strong>, or
            build a windward/leeward course above.
          </p>
        )}
        {marks.map((m, i) => (
          <div key={m.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button
            className="field"
            style={{
              flex: 1,
              borderColor: i === activeMarkIndex ? 'var(--accent)' : 'var(--line)',
            }}
            onClick={() => setActiveMark(i)}
          >
            <label style={{ color: i === activeMarkIndex ? 'var(--accent)' : undefined }}>
              {i + 1}. {m.name}
              {m.locked && <span aria-label="locked"> 🔒</span>}
            </label>
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              {state
                ? `${distance(state.position, m.position).toFixed(2)} nm · ${fmtDeg(bearing(
                    state.position,
                    m.position,
                  ))}°`
                : ''}
            </span>
          </button>
          <button
            className="btn btn--sm btn--ghost"
            style={{ marginBottom: 8 }}
            onClick={() => setEditingMark(m.id)}
            aria-label={`Edit mark ${m.name}`}
          >
            EDIT
          </button>
          </div>
        ))}
        {editingMark && marks.some((m) => m.id === editingMark) && (
          <MarkSheet
            mark={marks.find((m) => m.id === editingMark)!}
            index={marks.findIndex((m) => m.id === editingMark)}
            count={marks.length}
            onClose={() => setEditingMark(null)}
          />
        )}
        <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
          <button
            className="btn btn--sm btn--mob"
            disabled={!state}
            onClick={() => state && dropMob(state.position)}
            title="Man overboard: a mark here now, made active (F2)"
          >
            MOB
          </button>
          <button
            className="btn btn--sm"
            disabled={!state}
            onClick={() => state && addMark(`Mark ${marks.length + 1}`, state.position)}
          >
            DROP MARK
          </button>
          <button className="btn btn--sm btn--ghost" onClick={clearMarks} disabled={!marks.length}>
            CLEAR
          </button>
        </div>
        <div className="field">
          <label htmlFor="auto-advance">Advance to the next mark</label>
          <select id="auto-advance" value={autoAdvance} onChange={(e) => useStore.getState().updateSettings({ autoAdvance: e.target.value as typeof autoAdvance })}>
            <option value="off">By hand</option>
            <option value="range">Inside the mark's range</option>
            <option value="bisector">Across the leg bisector</option>
            <option value="both">Either</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="note">From the boat</span>
          <input aria-label="Range from the boat" inputMode="decimal" placeholder="nm" value={pingRange} onChange={(e) => setPingRange(e.target.value)} style={{ width: 60 }} />
          <span className="note">at</span>
          <input aria-label="Bearing from the boat" inputMode="decimal" placeholder="°T" value={pingBearing} onChange={(e) => setPingBearing(e.target.value)} style={{ width: 56 }} />
          <button
            className="btn btn--sm btn--ghost"
            disabled={!state || !(Number(pingRange) > 0) || pingBearing.trim() === '' || !(Number(pingBearing) >= 0 && Number(pingBearing) <= 360)}
            onClick={() => {
              if (!state) return
              addMark(`Mark ${marks.length + 1}`, destination(state.position, Number(pingBearing), Number(pingRange)))
              setPingRange('')
              setPingBearing('')
            }}
            title="A mark at a range and true bearing from the boat, as off a radar or a hand-bearing compass"
          >
            PING AT
          </button>
        </div>
        <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
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
        <CourseLegs lattice={lattice} />
        <MarksLibrary />
        <RaceNotesList />
        <HandicapCalc />
        <BoatsDatabase />
      </div>
    </div>
  )
}
