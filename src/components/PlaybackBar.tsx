/**
 * The replay controls, across the top of every screen while a log plays:
 * play and pause, a minute back or on, the speed, a slider to seek, and stop.
 */

import { useStore } from '@/state/store'
import { PLAYBACK_SPEEDS } from '@/lib/logging/playback'

const hms = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function PlaybackBar() {
  const p = useStore((s) => s.playback)
  const setPlayback = useStore((s) => s.setPlayback)
  if (!p) return null
  const span = Math.max(1, p.end - p.start)

  return (
    <div className="playback" role="region" aria-label="Log playback">
      <span className="playback__label">
        REPLAY {p.day} · {hms(p.t)}
      </span>
      <button className="btn btn--sm btn--ghost" aria-label="A minute back" onClick={() => setPlayback({ t: p.t - 60_000 })}>
        −1m
      </button>
      <button className="btn btn--sm" onClick={() => setPlayback({ playing: !p.playing })}>
        {p.playing ? 'PAUSE' : 'PLAY'}
      </button>
      <button className="btn btn--sm btn--ghost" aria-label="A minute on" onClick={() => setPlayback({ t: p.t + 60_000 })}>
        +1m
      </button>
      <select aria-label="Replay speed" value={p.speed} onChange={(e) => setPlayback({ speed: Number(e.target.value) })}>
        {PLAYBACK_SPEEDS.map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
      <input
        type="range"
        aria-label="Replay position"
        min={0}
        max={span}
        step={1000}
        value={p.t - p.start}
        onChange={(e) => setPlayback({ t: p.start + Number(e.target.value) })}
        style={{ flex: 1, minWidth: 80 }}
      />
      <button className="btn btn--sm btn--ghost" onClick={() => setPlayback(null)}>
        STOP
      </button>
    </div>
  )
}
