/**
 * The forecast time axis: scrub, play, step.
 *
 * Implements docs/07-map-layers/render-architecture.md §6, which calls this "the
 * highest value per line of code" in the whole map effort — and it is, because
 * the app already downloads, decompresses and decodes `nt` forecast steps and
 * then draws index 0. Everything after the first hour is paid for and thrown
 * away. This component is the thing that spends it.
 *
 * Four decisions here are not cosmetic:
 *
 *   - **UTC and local, both, always.** Offshore crews work in UTC and shore
 *     crews do not, and a forecast read in the wrong frame is a forecast for the
 *     wrong day. Expedition puts the display time top-left for this reason.
 *   - **A timer, not `requestAnimationFrame`.** rAF ties the forecast animation
 *     to the display's refresh rate, which on a 120 Hz phone means 120 texture
 *     swaps a second to show something that changes hourly. §5 notes animation
 *     tied to the render loop "can feel rushed" and that slower steps are easier
 *     to follow: slower is both cheaper and more legible.
 *   - **Pause on `document.hidden`.** A backgrounded tab animating a forecast is
 *     pure battery cost on a phone that has to last a race. It pauses rather
 *     than stopping, so coming back resumes where you left off.
 *   - **Arrow keys step time**, matching Expedition's ↑/↓ stepping, so a
 *     navigator with a keyboard never reaches for the scrubber.
 *
 * The component owns no time state of its own. `value` comes down, `onChange`
 * goes up, so one scrubber can drive the map, the router's start time, or both
 * at once (§6: linking the route's time to the scrubber "is how a navigator
 * builds trust in the answer").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  /** First forecast step, epoch ms UTC. */
  t0: number
  dtMs: number
  nt: number
  /** Currently displayed valid time, epoch ms UTC. */
  value: number
  onChange(t: number): void
  playing: boolean
  onPlayingChange(p: boolean): void
  /** Forecast steps per second while playing. Defaults to 1. */
  speed?: number
  onSpeedChange?(s: number): void
  /** Model and run, e.g. "GFS 06Z" — the provenance half of §7. */
  runLabel?: string
}

/**
 * Wall-clock milliseconds per forecast step at speed 1.
 *
 * About one step a second is as fast as a wind field can change and still be
 * followed by eye. Faster reads as a flicker, which costs battery and delivers
 * nothing.
 */
const STEP_MS = 900

const SPEEDS = [1, 2, 4, 8]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number): string => String(n).padStart(2, '0')

/** What every reading on this strip shows when there is no number behind it. */
const NO_TIME = '—'

/**
 * Clamp, with a non-finite input pinned to `lo`.
 *
 * The plain three-way comparison returns NaN unchanged — both comparisons are
 * false against NaN — so one bad number in the cube header used to flow straight
 * through to the slider position and out again through `onChange`. `lo` is the
 * honest answer for every caller here, because all of them are placing a forecast
 * index and index 0 is the step the cube certainly has.
 */
const clamp = (x: number, lo: number, hi: number): number =>
  !Number.isFinite(x) ? lo : x < lo ? lo : x > hi ? hi : x

/** `Tue 14:00Z`. The day name matters: a 72-hour forecast wraps past midnight twice. */
function fmtUtc(t: number): string {
  if (!Number.isFinite(t)) return NO_TIME
  const d = new Date(t)
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

/** `Tue 10:00 EDT`, with whatever zone abbreviation the platform knows. */
function fmtLocal(t: number): string {
  if (!Number.isFinite(t)) return NO_TIME
  const d = new Date(t)
  const clock = `${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
    }).formatToParts(d)
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value
    return tz ? `${clock} ${tz}` : `${clock} local`
  } catch {
    return `${clock} local`
  }
}

/**
 * Whether the tab is hidden, as state, so an effect can depend on it.
 *
 * The initial read matters as much as the event: a tab restored in the
 * background mounts already hidden, and starting an animation for a page nobody
 * is looking at is exactly what §5 says not to do.
 */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== 'undefined' && document.hidden,
  )
  useEffect(() => {
    const on = () => setHidden(document.hidden)
    on()
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return hidden
}

export function Timeline({
  t0,
  dtMs,
  nt,
  value,
  onChange,
  playing,
  onPlayingChange,
  speed = 1,
  onSpeedChange,
  runLabel,
}: Props) {
  const lastIndex = Math.max(0, (Number.isFinite(nt) ? nt : 1) - 1)
  const idx = dtMs > 0 ? clamp((value - t0) / dtMs, 0, lastIndex) : 0
  const hidden = useHidden()

  /**
   * Latest position and callback behind refs so the play timer can stay mounted
   * across renders. Listing `value` in the effect's dependencies would tear the
   * interval down and rebuild it on every tick, resetting its phase and making
   * playback stutter.
   */
  const idxRef = useRef(idx)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    idxRef.current = idx
    onChangeRef.current = onChange
  }, [idx, onChange])

  const goToIndex = useCallback(
    (i: number) => {
      const t = t0 + clamp(i, 0, lastIndex) * dtMs
      // A cube whose header did not survive decoding cannot be scrubbed. Emitting
      // nothing leaves the map on the last good time; emitting NaN would push it
      // into the layers, the router's start time and the tide lookup at once.
      if (Number.isFinite(t)) onChangeRef.current(t)
    },
    [t0, dtMs, lastIndex],
  )

  /**
   * Step whole forecast steps, without wrapping. Playback loops; a button press
   * does not, because a control that jumps from the end of the forecast back to
   * now loses the user's place in it.
   */
  const step = useCallback(
    (delta: number) => {
      const snap = delta > 0
        ? Math.floor(idxRef.current + 1e-6)
        : Math.ceil(idxRef.current - 1e-6)
      goToIndex(snap + delta)
    },
    [goToIndex],
  )

  // -------------------------------------------------------------- play timer
  useEffect(() => {
    if (!playing || hidden || nt < 2 || dtMs <= 0) return
    const period = Math.max(60, STEP_MS / Math.max(0.25, speed))
    const id = window.setInterval(() => {
      // The epsilon stops a scrubber parked a hair below a step from advancing
      // to the step it is already displaying.
      const next = Math.floor(idxRef.current + 1e-6) + 1
      goToIndex(next > lastIndex ? 0 : next)
    }, period)
    return () => window.clearInterval(id)
  }, [playing, hidden, nt, dtMs, speed, lastIndex, goToIndex])

  // ----------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      // A focused field keeps its own arrow keys: the range input already steps
      // itself, and double-stepping it would feel broken.
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1)
      // Space activates a focused button on its own; toggling as well would fire
      // twice.
      else if (e.key === ' ' && tag !== 'BUTTON') onPlayingChange(!playing)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, playing, onPlayingChange])

  const utc = useMemo(() => fmtUtc(value), [value])
  const local = useMemo(() => fmtLocal(value), [value])
  const plusH = (value - t0) / 3_600_000

  return (
    <div
      style={{
        background: 'var(--bg-sunk)',
        borderTop: '1px solid var(--line)',
        padding: '8px var(--pad)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 7,
          fontSize: 12,
        }}
      >
        {/* UTC first and brightest: it is the frame the forecast is stated in. */}
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>{utc}</span>
        <span style={{ color: 'var(--ink-dim)' }}>{local}</span>
        {/* Dropped rather than dashed: "T+—h" reads as a measurement of nothing. */}
        {Number.isFinite(plusH) ? <span className="chip">T+{Math.round(plusH)}h</span> : null}
        {runLabel ? (
          <span className="chip" style={{ color: 'var(--ink-faint)' }}>
            {runLabel}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => step(-1)}
          disabled={idx <= 0}
          aria-label="Previous forecast step"
        >
          ‹
        </button>
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => onPlayingChange(!playing)}
          disabled={nt < 2}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          style={{ minWidth: 46 }}
        >
          {playing ? '❙❙' : '▶'}
        </button>
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => step(1)}
          disabled={idx >= lastIndex}
          aria-label="Next forecast step"
        >
          ›
        </button>

        <input
          type="range"
          min={0}
          max={lastIndex}
          // Quarter steps: the layers mix between forecast hours in the shader
          // (§3), and a scrubber that can only land on the hour hides that.
          step={0.25}
          value={idx}
          onChange={(e) => goToIndex(Number(e.currentTarget.value))}
          disabled={nt < 2}
          aria-label="Forecast time"
          style={{ flex: 1, minWidth: 0, height: 30, accentColor: 'var(--accent)' }}
        />

        {onSpeedChange ? (
          <div className="seg" style={{ flexShrink: 0 }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSpeedChange(s)}
                aria-pressed={s === speed}
                aria-label={`${s} times speed`}
              >
                {s}×
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
