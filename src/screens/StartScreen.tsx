/**
 * The start screen — the app's beachhead feature.
 *
 * Everything here works from a phone GPS alone: no charts, no weather download,
 * no polar, no account, no backend. See docs/05-spec/mvp-scope.md.
 */

import { useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { useTick } from '@/hooks/useSensors'
import { StartCanvas } from '@/components/StartCanvas'
import { Tile, fmtClock, fmtSigned } from '@/components/Tile'
import { computeStart, spareTimeS } from '@/lib/startline'
import { buildLattice } from '@/lib/polar'
import type { PolarLattice, StartNumbers } from '@/lib/types'

const ROLL_OPTIONS = [5, 4, 3, 1]

/** Everything unknown. Used until the first fix arrives. */
const EMPTY_START_NUMBERS: StartNumbers = {
  timeToGunS: null,
  timeToLineS: null,
  timeToBurnS: null,
  distanceBelowLineM: null,
  distanceBelowLineBoatLengths: null,
  biasAngleDeg: null,
  biasLengthM: null,
  favouredEnd: null,
  lineSquareWindDeg: null,
  lineLengthM: null,
  timeToPortEndS: null,
  timeToStarboardEndS: null,
  ocs: false,
}

export function StartScreen() {
  const now = useTick(2)
  const state = useStore((s) => s.state)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const wind = useStore((s) => s.wind)
  const current = useStore((s) => s.current)
  const polar = useStore((s) => s.polar)
  const track = useStore((s) => s.track)
  const setStartEnd = useStore((s) => s.setStartEnd)
  const setGunTime = useStore((s) => s.setGunTime)
  const [showDetail, setShowDetail] = useState(false)

  const lattice = useMemo<PolarLattice | null>(() => {
    if (!polar) return null
    try {
      return buildLattice(polar)
    } catch {
      return null
    }
  }, [polar])

  /*
   * `computeStart` requires a fix. Before the first one lands — which is the
   * normal state for a second or two after a reload, and indefinitely with
   * location denied — we show a fully-null set rather than calling it with a
   * missing position. Every field is nullable precisely so this degrades
   * instead of throwing.
   */
  const numbers: StartNumbers = useMemo(() => {
    if (!state) return EMPTY_START_NUMBERS
    return computeStart({
      line: course.startLine,
      state,
      wind,
      current,
      boat,
      lattice,
      now,
    })
  }, [course.startLine, state, wind, current, boat, lattice, now])

  const gun = course.startLine.gunTime
  const sinceGun = gun == null ? null : (now - gun) / 1000
  const burn = numbers.timeToBurnS

  const ping = (which: 'port' | 'starboard') => {
    if (!state) return
    setStartEnd(which, state.position)
  }

  const startTimer = (minutes: number) => setGunTime(Date.now() + minutes * 60_000)
  const syncTimer = () => {
    // Round to the nearest whole minute — the universal "sync" gesture.
    if (gun == null) return
    const remaining = (gun - now) / 1000
    const rounded = Math.round(remaining / 60) * 60
    setGunTime(now + rounded * 1000)
  }

  /*
   * `timeToBurnS` is Expedition's `timeToLine - timeToGun`, which is POSITIVE
   * when you arrive after the gun — i.e. when you are LATE. A sailor asking
   * "what's my time to burn?" means the opposite: the spare seconds they have to
   * kill before starting. So flip it once, here, and work in spare time.
   *
   *   spare > 0  you will be early by this much — burn it
   *   spare < 0  you will be late by this much
   *
   * Getting this backwards inverts the single most important number on the
   * screen, and it reads plausibly either way, which is why it survived until
   * someone compared it against "gun in 2:03, to line 1:25".
   */
  const spare = spareTimeS(numbers)
  const burnTone =
    spare == null ? undefined : spare > 8 ? 'early' : spare < -3 ? 'late' : 'good'

  /*
   * When the bow is over the line, `timeToLine` is negative by definition, so
   * `timeToBurn = timeToLine − timeToGun` reads as a large negative "you'll be
   * late" — the opposite of the truth. Being over early is its own state, not a
   * point on the burn scale, so it gets its own display.
   */
  const showBurn = !numbers.ocs && burn != null

  /*
   * A line more than ~45° off square is almost certainly a mis-ping rather than
   * a real course. Saying so is better than confidently reporting a favoured end
   * that means nothing.
   */
  const lineSuspect =
    numbers.biasAngleDeg != null && Math.abs(numbers.biasAngleDeg) > 45

  return (
    <>
      <div className="hero">
        <div className="hero__label">
          {numbers.ocs
            ? 'over the line'
            : !showBurn
              ? 'time to gun'
              : spare != null && spare < 0
                ? 'late by'
                : 'time to burn'}
        </div>
        <div
          className={`hero__value${
            numbers.ocs ? ' hero__value--late' : burnTone ? ` hero__value--${burnTone}` : ''
          }`}
        >
          {numbers.ocs
            ? numbers.distanceBelowLineBoatLengths == null
              ? 'OVER'
              : `${Math.abs(numbers.distanceBelowLineBoatLengths).toFixed(1)} BL`
            : gun == null
              ? '—'
              : showBurn
                ? (fmtSigned(spare) ?? '—')
                : (fmtClock(numbers.timeToGunS) ?? '—')}
        </div>
        {!numbers.ocs && <BurnBar spare={spare} />}
        <div style={{ marginTop: 9, fontSize: 12, color: 'var(--ink-faint)' }}>
          {numbers.ocs ? (
            <span style={{ color: 'var(--port)' }}>
              get back below the line — gun in {fmtClock(numbers.timeToGunS) ?? '—'}
            </span>
          ) : gun == null ? (
            <span>no timer running</span>
          ) : (
            <span>
              gun in {fmtClock(numbers.timeToGunS) ?? '—'} · to line{' '}
              {numbers.timeToLineS == null ? '—' : `${Math.round(numbers.timeToLineS)}s`}
            </span>
          )}
        </div>
      </div>

      {lineSuspect && (
        <div className="warnbox" style={{ margin: '10px var(--pad) 0' }}>
          This line is {Math.abs(numbers.biasAngleDeg ?? 0).toFixed(0)}° off square —
          nearly parallel to the wind. Check both ends were pinged in the right
          places, or update the wind.
        </div>
      )}

      <div className="canvas-wrap" style={{ flex: 1, minHeight: 180 }}>
        <StartCanvas
          line={course.startLine}
          state={state}
          wind={wind}
          numbers={numbers}
          boat={boat}
          track={track}
          targetTwa={
            wind && lattice ? lattice.targetsAt(wind.tws).upTwa : undefined
          }
          secondsSinceGun={sinceGun}
        />
      </div>

      <div className="tiles tiles--3">
        <Tile
          label="below line"
          value={numbers.distanceBelowLineBoatLengths}
          unit="BL"
          dp={1}
          tone={numbers.ocs ? 'port' : null}
          sub={
            numbers.distanceBelowLineM == null
              ? undefined
              : `${Math.abs(numbers.distanceBelowLineM).toFixed(0)} m`
          }
          small
        />
        <Tile
          label="favoured"
          value={
            numbers.favouredEnd == null
              ? null
              : numbers.favouredEnd === 'even'
                ? 'even'
                : numbers.favouredEnd === 'port'
                  ? 'PIN'
                  : 'RC'
          }
          tone={
            numbers.favouredEnd === 'port'
              ? 'port'
              : numbers.favouredEnd === 'starboard'
                ? 'stbd'
                : null
          }
          sub={
            numbers.biasLengthM == null
              ? undefined
              : `${(numbers.biasLengthM / Math.max(1, boat.loaMetres)).toFixed(1)} BL · ${Math.abs(
                  numbers.biasAngleDeg ?? 0,
                ).toFixed(0)}°`
          }
          small
          onClick={() => setShowDetail(true)}
        />
        <Tile
          label="line"
          value={numbers.lineLengthM}
          unit="m"
          dp={0}
          sub={
            numbers.lineLengthM == null
              ? undefined
              : `${(numbers.lineLengthM / Math.max(1, boat.loaMetres)).toFixed(0)} boat lengths`
          }
          small
        />
      </div>

      <div className="actions">
        <button className="btn btn--port" onClick={() => ping('port')} disabled={!state}>
          PING PIN
        </button>
        <button className="btn btn--stbd" onClick={() => ping('starboard')} disabled={!state}>
          PING RC
        </button>
      </div>

      <div className="actions" style={{ paddingTop: 0, borderTop: 'none' }}>
        {gun == null ? (
          ROLL_OPTIONS.map((m) => (
            <button key={m} className="btn btn--sm" onClick={() => startTimer(m)}>
              {m} MIN
            </button>
          ))
        ) : (
          <>
            <button className="btn btn--sm" onClick={syncTimer}>
              SYNC
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setGunTime(null)}>
              STOP
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setShowDetail(true)}>
              DETAIL
            </button>
          </>
        )}
      </div>

      {showDetail && (
        <DetailSheet numbers={numbers} onClose={() => setShowDetail(false)} />
      )}
    </>
  )
}

/** `spare` is seconds in hand: positive early, negative late. */
function BurnBar({ spare }: { spare: number | null }) {
  // ±60 s maps to the full width; beyond that it pins.
  const clamped = spare == null ? 0 : Math.max(-60, Math.min(60, spare))
  const pct = (clamped / 60) * 50
  const colour =
    spare == null
      ? 'var(--line-bright)'
      : spare > 8
        ? 'var(--warn)'
        : spare < -3
          ? 'var(--port)'
          : 'var(--stbd)'
  return (
    <div className="burnbar">
      <div
        className="burnbar__fill"
        style={{
          left: pct >= 0 ? '50%' : `${50 + pct}%`,
          width: `${Math.abs(pct)}%`,
          background: colour,
          opacity: spare == null ? 0.3 : 1,
        }}
      />
      <div className="burnbar__zero" />
    </div>
  )
}

function DetailSheet({
  numbers,
  onClose,
}: {
  numbers: StartNumbers
  onClose: () => void
}) {
  const row = (k: string, v: string | null) => (
    <div className="row" key={k}>
      <span>{k}</span>
      <span>{v ?? '—'}</span>
    </div>
  )
  const s = (n: number | null, dp = 0, unit = '') =>
    n == null || !Number.isFinite(n) ? null : `${n.toFixed(dp)}${unit}`

  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet__grip" />
      <div className="rows">
        {row('Time to gun', fmtClock(numbers.timeToGunS))}
        {row('Time to line', s(numbers.timeToLineS, 0, ' s'))}
        {row(
          'Spare time (burn)',
          fmtSigned(numbers.timeToBurnS == null ? null : -numbers.timeToBurnS),
        )}
        {row('Distance below line', s(numbers.distanceBelowLineM, 1, ' m'))}
        {row('Line length', s(numbers.lineLengthM, 0, ' m'))}
        {row('Line square wind', s(numbers.lineSquareWindDeg, 0, '°'))}
        {row('Bias angle', s(numbers.biasAngleDeg, 1, '°'))}
        {row('Bias length', s(numbers.biasLengthM, 1, ' m'))}
        {row('Time to pin', s(numbers.timeToPortEndS, 0, ' s'))}
        {row('Time to RC', s(numbers.timeToStarboardEndS, 0, ' s'))}
        {row('OCS', numbers.ocs ? 'YES' : 'no')}
      </div>
      <p className="note">
        Bias sign follows Expedition&apos;s convention: negative means the port
        (pin) end is favoured. Time to line is the minimum over the enabled
        approaches, including the turn and acceleration. Spare time is positive
        when you will reach the line before the gun and have seconds to kill.
      </p>
      <button className="btn btn--sm" onClick={onClose} style={{ marginTop: 6 }}>
        CLOSE
      </button>
    </div>
  )
}
