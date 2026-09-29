/**
 * The start timer's sounds, from Web Audio, with a buzz where there is one.
 *
 * A browser only lets a page make sound once someone has touched it, so the
 * context is primed from the timer's own buttons (`primeAudio`), and a beep
 * before that is silently dropped rather than thrown.
 */

import type { Beep } from '@/lib/timer'

let audio: AudioContext | null = null

function context(): AudioContext | null {
  if (audio) return audio
  const AC = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  if (!AC) return null
  try {
    audio = new AC()
  } catch {
    return null
  }
  return audio
}

/** Call from a tap, so the countdown can sound later. */
export function primeAudio(): void {
  void context()?.resume?.().catch(() => {})
}

export function beep(kind: Beep, delayS = 0): void {
  const len = kind === 'long' ? 0.6 : 0.12
  try {
    navigator.vibrate?.(len * 1000)
    const ctx = context()
    if (!ctx || ctx.state !== 'running') return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = kind === 'long' ? 880 : 1320
    const t = ctx.currentTime + delayS
    gain.gain.setValueAtTime(0.3, t)
    gain.gain.setValueAtTime(0, t + len)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + len + 0.05)
  } catch {
    // No sound is better than a timer that throws.
  }
}
