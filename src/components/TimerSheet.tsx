/**
 * The start timer, beyond the minute buttons: a gun set by minutes and seconds
 * or by the clock, the roll between class starts, and the countdown's sounds.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { parseClockTime, parseCountdown } from '@/lib/timer'
import { beep, primeAudio } from '@/lib/beep'

export function TimerSheet({ onClose }: { onClose: () => void }) {
  const setGunTime = useStore((s) => s.setGunTime)
  const timer = useStore((s) => s.timer)
  const setTimer = useStore((s) => s.setTimer)
  const [countdown, setCountdown] = useState('5:00')
  const [clock, setClock] = useState('')
  const [error, setError] = useState<string | null>(null)

  const setBy = (at: number | null, what: string) => {
    if (at == null) {
      setError(`That is not a ${what}.`)
      return
    }
    primeAudio()
    setError(null)
    setGunTime(at)
  }

  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Start timer">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Set the gun</h2>
      <div className="field">
        <label htmlFor="timer-countdown">Time to the gun <span className="note">m:ss</span></label>
        <input id="timer-countdown" value={countdown} inputMode="numeric"
          onChange={(e) => setCountdown(e.target.value)} />
      </div>
      <button className="btn btn--sm" onClick={() => {
        const s = parseCountdown(countdown)
        setBy(s == null ? null : Date.now() + s * 1000, 'time to the gun')
      }}>
        START COUNTDOWN
      </button>
      <div className="field">
        <label htmlFor="timer-clock">Gun at <span className="note">hh:mm or hh:mm:ss, this device&apos;s clock</span></label>
        <input id="timer-clock" value={clock} placeholder="14:05" inputMode="numeric"
          onChange={(e) => setClock(e.target.value)} />
      </div>
      <button className="btn btn--sm" onClick={() => setBy(parseClockTime(clock, Date.now()), 'clock time')}>
        SET GUN TIME
      </button>
      {error && <p className="warnbox" role="alert">{error}</p>}

      <h2>Class starts</h2>
      <div className="field">
        <label htmlFor="timer-roll">Minutes between starts</label>
        <input id="timer-roll" type="number" min="1" step="1" value={timer.rollMin}
          onChange={(e) => setTimer({ rollMin: Math.max(1, Number(e.target.value) || 5) })} />
      </div>
      <div className="field">
        <label htmlFor="timer-before">Classes starting before ours</label>
        <input id="timer-before" type="number" min="0" step="1" value={timer.classesBefore}
          onChange={(e) => setTimer({ classesBefore: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
      </div>
      <p className="note">
        At each of their guns the timer rolls on to the next start, and a held wind stays held until ours.
      </p>
      <button className="btn btn--sm btn--ghost" onClick={() => setBy(Date.now() + timer.rollMin * 60_000, 'roll')}>
        RESTART AT {timer.rollMin} MIN
      </button>

      <h2>Sound</h2>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={timer.sound} aria-label="Sound the countdown"
          onChange={(e) => {
            if (e.target.checked) primeAudio()
            setTimer({ sound: e.target.checked })
          }} />
        <span>Beep on the minutes, at 30 s and for the last ten seconds</span>
      </label>
      <button className="btn btn--sm btn--ghost" onClick={() => {
        primeAudio()
        // After a tick, so a context this tap has just woken is running for it.
        window.setTimeout(() => beep('long'), 50)
      }}>
        TEST SOUND
      </button>
      <p className="note">
        Try it before the start. Silent mode or low volume can mute it, and the app cannot tell.
      </p>

      <div className="actions">
        <button className="btn btn--sm" onClick={onClose}>DONE</button>
      </div>
    </div>
  )
}
