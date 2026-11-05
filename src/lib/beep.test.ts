/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Just enough of an AudioContext: starts suspended, as one made before a tap does. */
class FakeAudioContext {
  static started = 0
  state = 'suspended'
  currentTime = 0
  destination = {}
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: () => {
        FakeAudioContext.started++
      },
      stop: () => {},
    }
  }
  createGain() {
    return { gain: { setValueAtTime: () => {} }, connect: (n: unknown) => n }
  }
}

// A fresh module each time: the context is held in it.
const load = () => import('./beep')

beforeEach(() => {
  vi.resetModules()
  FakeAudioContext.started = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the timer sound', () => {
  it('says so on a browser with no Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const { soundState } = await load()
    expect(soundState()).toBe('unavailable')
  })

  it('is blocked until a tap primes it, then ready', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { primeAudio, soundState } = await load()
    expect(soundState()).toBe('blocked')
    primeAudio()
    await Promise.resolve()
    expect(soundState()).toBe('ready')
  })

  it('makes no sound while blocked, asks to resume, and sounds the next beep', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { beep, soundState } = await load()
    beep('short')
    expect(FakeAudioContext.started).toBe(0)
    await Promise.resolve()
    expect(soundState()).toBe('ready')
    beep('short')
    expect(FakeAudioContext.started).toBe(1)
  })

  it('reads blocked again when the phone suspends the context', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const made: FakeAudioContext[] = []
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      constructor() {
        super()
        made.push(this)
      }
    })
    const { primeAudio, soundState } = await load()
    primeAudio()
    await Promise.resolve()
    expect(soundState()).toBe('ready')
    made[0].state = 'interrupted'
    expect(soundState()).toBe('blocked')
  })
})
