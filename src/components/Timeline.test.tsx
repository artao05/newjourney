/**
 * The forecast time axis.
 *
 * Its own docstring calls this "the highest value per line of code" in the map
 * effort, because the app decodes `nt` forecast steps and would otherwise draw
 * index 0 forever. It had no test.
 *
 * Most of what is worth pinning here is arithmetic that never appears as a number
 * on screen: which step a press lands on, whether playback wraps and stepping does
 * not, and whether a timer is running at all. Those are exactly the things that
 * look fine in a screenshot and are wrong in use.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Timeline } from './Timeline'

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0)
const HOUR = 3_600_000

interface Harness {
  changes: number[]
  playing: boolean[]
  rerender(over?: Partial<Parameters<typeof Timeline>[0]>): void
}

function mount(over: Partial<Parameters<typeof Timeline>[0]> = {}): Harness {
  const changes: number[] = []
  const playing: boolean[] = []
  const props = {
    t0: T0,
    dtMs: HOUR,
    nt: 12,
    value: T0,
    onChange: (t: number) => changes.push(t),
    playing: false,
    onPlayingChange: (p: boolean) => playing.push(p),
    ...over,
  }
  const view = render(<Timeline {...props} />)
  return {
    changes,
    playing,
    rerender: (next = {}) => view.rerender(<Timeline {...props} {...next} />),
  }
}

/** Which forecast index a reported time corresponds to. */
const indexOf = (t: number): number => (t - T0) / HOUR

const prev = () => screen.getByLabelText('Previous forecast step') as HTMLButtonElement
const next = () => screen.getByLabelText('Next forecast step') as HTMLButtonElement
const slider = () => screen.getByLabelText('Forecast time') as HTMLInputElement

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ------------------------------------------------------------------ stepping

describe('stepping', () => {
  it('moves one forecast step at a time', () => {
    const h = mount({ value: T0 + 3 * HOUR })
    fireEvent.click(next())
    expect(h.changes.map(indexOf)).toEqual([4])
    fireEvent.click(prev())
    expect(h.changes.map(indexOf)).toEqual([4, 2])
  })

  it('snaps to whole steps from a scrubbed position between them', () => {
    // The slider moves in quarter steps, so `value` is routinely off-grid. A
    // press should land on a forecast hour, not carry the fraction along.
    const h = mount({ value: T0 + 3.25 * HOUR })
    fireEvent.click(next())
    expect(h.changes.map(indexOf)).toEqual([4])
  })

  it('does not wrap at either end, and says so by disabling the button', () => {
    // Playback loops; a button press must not. Jumping from the end of the
    // forecast back to now loses the reader's place in it.
    const atEnd = mount({ value: T0 + 11 * HOUR })
    expect(next().disabled).toBe(true)
    fireEvent.click(next())
    expect(atEnd.changes).toEqual([])
    cleanup()

    const atStart = mount({ value: T0 })
    expect(prev().disabled).toBe(true)
    fireEvent.click(prev())
    expect(atStart.changes).toEqual([])
  })

  it('does not wrap via the keyboard either, where no disabled button protects it', () => {
    // The buttons are disabled at the ends, so clicking them cannot show whether
    // the stepping arithmetic wraps — the attribute masks it. Arrow keys reach
    // `step` directly and are the only way to see what it actually computes.
    const atEnd = mount({ value: T0 + 11 * HOUR })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(atEnd.changes.map(indexOf)).toEqual([11])
    cleanup()

    const atStart = mount({ value: T0 })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(atStart.changes.map(indexOf)).toEqual([0])
  })

  it('clamps a value that arrives outside the forecast', () => {
    // `ChartSurface` seeds the scrubber from `Date.now()` and only clamps it into
    // range in an effect, so the first render with a new cube can legitimately be
    // handed a time the forecast does not cover.
    const h = mount({ value: T0 - 50 * HOUR })
    expect(Number(slider().value)).toBe(0)
    fireEvent.click(next())
    expect(h.changes.map(indexOf)).toEqual([1])
  })
})

// ------------------------------------------------------------------ playback

describe('playback', () => {
  it('advances on a timer and wraps at the end', () => {
    vi.useFakeTimers()
    const h = mount({ value: T0 + 10 * HOUR, playing: true })
    vi.advanceTimersByTime(1000)
    expect(h.changes.map(indexOf)).toEqual([11])
    // Still parked at 10 because `value` is a prop and nothing fed it back; the
    // component reads its own last reported position, so the next tick wraps.
    h.rerender({ value: T0 + 11 * HOUR, playing: true })
    vi.advanceTimersByTime(1000)
    expect(h.changes.map(indexOf)).toEqual([11, 0])
  })

  it('does not re-emit the step it is already showing', () => {
    // The epsilon in the play tick. A scrubber parked a hair below a step must
    // advance past it rather than onto it.
    vi.useFakeTimers()
    const h = mount({ value: T0 + 2 * HOUR + 1, playing: true })
    vi.advanceTimersByTime(1000)
    expect(h.changes.map(indexOf)).toEqual([3])
  })

  it('runs faster at a higher speed, without dropping below a sane floor', () => {
    vi.useFakeTimers()
    const fast = mount({ playing: true, speed: 8 })
    vi.advanceTimersByTime(900)
    expect(fast.changes.length).toBeGreaterThan(1)
  })

  it('stops when the tab is hidden, and resumes where it left off', () => {
    vi.useFakeTimers()
    const h = mount({ value: T0 + 2 * HOUR, playing: true })
    vi.advanceTimersByTime(1000)
    const before = h.changes.length
    expect(before).toBeGreaterThan(0)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    vi.advanceTimersByTime(5000)
    expect(h.changes.length).toBe(before)

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    vi.advanceTimersByTime(1000)
    expect(h.changes.length).toBeGreaterThan(before)
  })

  it('never starts a timer for a single-step forecast', () => {
    vi.useFakeTimers()
    const h = mount({ nt: 1, playing: true })
    vi.advanceTimersByTime(5000)
    expect(h.changes).toEqual([])
    expect((screen.getByLabelText('Pause') as HTMLButtonElement).disabled).toBe(true)
  })
})

// ------------------------------------------------------------------ keyboard

describe('keyboard', () => {
  it('steps with both arrow pairs', () => {
    const h = mount({ value: T0 + 5 * HOUR })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(h.changes.map(indexOf)).toEqual([6, 6, 4, 4])
  })

  it('leaves a focused field its own arrow keys', () => {
    // The range input steps itself; double-stepping it would feel broken.
    const h = mount()
    fireEvent.keyDown(slider(), { key: 'ArrowRight' })
    expect(h.changes).toEqual([])
  })

  it('ignores an arrow key that carries a modifier', () => {
    const h = mount()
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true })
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true })
    expect(h.changes).toEqual([])
  })

  it('toggles playback with space, except on a focused button', () => {
    const h = mount()
    fireEvent.keyDown(window, { key: ' ' })
    expect(h.playing).toEqual([true])
    // Space already activates a focused button; toggling too would fire twice.
    fireEvent.keyDown(next(), { key: ' ' })
    expect(h.playing).toEqual([true])
  })

  it('stops listening once unmounted', () => {
    const h = mount()
    cleanup()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(h.changes).toEqual([])
  })
})

// ----------------------------------------------------------------- the labels

describe('the labels', () => {
  it('shows the same instant in UTC and local, with the day name', () => {
    mount({ value: T0 })
    // The day name is not decoration: a 72-hour forecast wraps past midnight
    // twice, and "14:00Z" alone is three different times.
    expect(screen.getByText(/Thu 12:00Z/)).toBeTruthy()
  })

  it('counts hours from the start of the forecast, not from now', () => {
    mount({ value: T0 + 7 * HOUR })
    expect(screen.getByText('T+7h')).toBeTruthy()
  })

  it('shows the run label when given one', () => {
    mount({ runLabel: 'GFS 06Z' })
    expect(screen.getByText('GFS 06Z')).toBeTruthy()
  })
})

// ------------------------------------------------------- degenerate forecasts

describe('a forecast the component cannot scrub', () => {
  it('survives a zero time step without dividing by it', () => {
    const h = mount({ dtMs: 0, nt: 4 })
    expect(Number(slider().value)).toBe(0)
    fireEvent.click(next())
    for (const t of h.changes) expect(Number.isFinite(t)).toBe(true)
  })

  it('renders no non-finite number anywhere, whatever it is handed', () => {
    /*
     * The standard the rest of this codebase already holds: a missing number
     * renders as a dash, never as garbage. A cube decoded from a truncated or
     * corrupt payload can carry a non-finite `t0`, and every figure on this
     * strip — both clocks, the T+ chip and the slider position — is arithmetic
     * on it.
     */
    for (const [label, over] of [
      ['NaN value', { value: Number.NaN }],
      ['NaN t0', { t0: Number.NaN }],
      ['NaN dtMs', { dtMs: Number.NaN }],
      ['infinite value', { value: Number.POSITIVE_INFINITY }],
    ] as Array<[string, Partial<Parameters<typeof Timeline>[0]>]>) {
      cleanup()
      const h = mount(over)
      const text = document.body.textContent ?? ''
      expect(text, label).not.toMatch(/NaN|Infinity|undefined/)
      // Not merely finite: a range input silently sanitizes an invalid value to
      // the midpoint of its own min/max, so NaN would present as the middle of
      // the forecast — a specific, wrong, plausible-looking time. Index 0 is the
      // step the cube certainly has.
      expect(Number(slider().value), `${label}: slider`).toBe(0)
      fireEvent.click(next())
      for (const t of h.changes) expect(Number.isFinite(t), `${label}: onChange`).toBe(true)
    }
  })
})
