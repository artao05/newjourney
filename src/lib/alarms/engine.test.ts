import { describe, expect, it } from 'vitest'
import { IDLE, evaluate, sounding, type AlarmRule, type AlarmState } from './engine'

const depth: AlarmRule = { id: 'd', name: 'Shallow', channel: 'depth', op: 'below', value: 3, hysteresis: 0.5, delayS: 2, enabled: true }

/** Runs a rule over values a second apart, returning the states and what fired or cleared. */
function run(rule: AlarmRule, vs: Array<number | null>) {
  let states: Record<string, AlarmState> = {}
  const events: string[] = []
  vs.forEach((v, i) => {
    const e = evaluate([rule], { [rule.channel]: v }, states, i * 1000)
    states = e.states
    for (const r of e.fired) events.push(`fire@${i}:${r.id}`)
    for (const r of e.cleared) events.push(`clear@${i}:${r.id}`)
  })
  return { states, events }
}

describe('the alarm engine', () => {
  it('fires only once the condition has held for its delay', () => {
    expect(run(depth, [4, 2.9, 2.8]).events).toEqual([])
    expect(run(depth, [4, 2.9, 2.8, 2.7]).events).toEqual(['fire@3:d'])
    // One shallow second in a seaway resets the wait.
    expect(run(depth, [2.9, 2.8, 3.1, 2.9, 2.9]).events).toEqual([])
  })

  it('clears only past the threshold by the hysteresis', () => {
    const { events, states } = run(depth, [2, 2, 2, 3.2, 3.4, 3.5])
    expect(events).toEqual(['fire@2:d', 'clear@5:d'])
    expect(states.d).toEqual(IDLE)
  })

  it('treats a gap in the data as no change either way', () => {
    expect(run(depth, [2, 2, 2, null, null, 2.5]).states.d).toMatchObject({ active: true, value: 2.5 })
    expect(run(depth, [2, null, null, null]).states.d.pendingSince).toBe(0)
  })

  it('compares the size of the value when asked, for cross-track either side', () => {
    const xte: AlarmRule = { id: 'x', name: 'Off course', channel: 'xte', op: 'above', value: 0.2, hysteresis: 0.05, delayS: 0, enabled: true, absolute: true }
    expect(run(xte, [-0.3]).events).toEqual(['fire@0:x'])
    expect(run(xte, [0.1]).events).toEqual([])
  })

  it('clears a rule that is switched off, and ignores it while off', () => {
    const on = run(depth, [2, 2, 2]).states
    const off = evaluate([{ ...depth, enabled: false }], { depth: 1 }, on, 5000)
    expect(off.cleared.map((r) => r.id)).toEqual(['d'])
    expect(off.states.d).toEqual(IDLE)
  })

  it('lists what is sounding, oldest first, and not what was acknowledged', () => {
    const rules = [depth, { ...depth, id: 'e' }, { ...depth, id: 'f' }]
    const states: Record<string, AlarmState> = {
      d: { ...IDLE, active: true, since: 20 },
      e: { ...IDLE, active: true, since: 10 },
      f: { ...IDLE, active: true, since: 5, acknowledged: true },
    }
    expect(sounding(rules, states).map((r) => r.id)).toEqual(['e', 'd'])
  })
})
