/**
 * The start timer's sounds, from Web Audio, with a buzz where there is one.
 *
 * A browser only lets a page make sound once someone has touched it, so the
 * context is primed from the timer's own buttons (`primeAudio`). A reload in the
 * sequence loses that, and a phone can suspend the context when it is locked or
 * takes a call. A beep then cannot sound, so `soundState` says so and the Start tab
 * asks for a tap: a countdown that has quietly gone silent costs a start.
 */

import type { Beep } from '@/lib/timer'

let audio: AudioContext | null = null

function audioClass(): typeof AudioContext | undefined {
  return typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
}

function context(): AudioContext | null {
  if (audio) return audio
  const AC = audioClass()
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

/**
 * Whether a beep would sound now: `ready`, `blocked` until someone taps, or
 * `unavailable` on a browser with no Web Audio.
 *
 * `ready` cannot promise it is heard. Nothing tells a page the volume is down, and an
 * iPhone's silent switch is expected to mute Web Audio with no sign of it.
 */
export type SoundState = 'ready' | 'blocked' | 'unavailable'

export function soundState(): SoundState {
  if (!audioClass()) return 'unavailable'
  return audio?.state === 'running' ? 'ready' : 'blocked'
}

export function beep(kind: Beep, delayS = 0): void {
  const len = kind === 'long' ? 0.6 : 0.12
  try {
    navigator.vibrate?.(len * 1000)
    const ctx = context()
    if (!ctx) return
    if (ctx.state !== 'running') {
      // Worth asking: it lets a context suspended by the phone come back for the next beep.
      void ctx.resume?.().catch(() => {})
      return
    }
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
