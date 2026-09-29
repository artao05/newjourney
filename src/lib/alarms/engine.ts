/**
 * The alarm engine: thresholds on channels, with a delay and hysteresis.
 *
 * A rule fires once its condition has held for `delayS`, so one noisy second
 * in a seaway does not wake the off-watch; and it clears only once the value
 * is back past the threshold by `hysteresis`, so a depth hovering on the limit
 * does not ring on and off every few seconds. A second with no value at all
 * changes nothing: a gap in the data is not good news, and not bad news either
 * (losing the data is an alarm of its own, on the channel's age).
 */

export interface AlarmRule {
  id: string
  name: string
  channel: string
  op: 'above' | 'below'
  value: number
  /** How far back past the threshold the value must come to clear. */
  hysteresis: number
  /** Seconds the condition must hold before it fires. */
  delayS: number
  enabled: boolean
  /** Compare the size, not the sign: cross-track error either side of the line. */
  absolute?: boolean
}

export interface AlarmState {
  active: boolean
  /** When the condition first held, while it waits out the delay. */
  pendingSince: number | null
  /** When it fired. */
  since: number | null
  acknowledged: boolean
  /** The value that fired it, or the latest while active. */
  value: number | null
}

export const IDLE: AlarmState = { active: false, pendingSince: null, since: null, acknowledged: false, value: null }

export function breaches(rule: AlarmRule, v: number): boolean {
  const x = rule.absolute ? Math.abs(v) : v
  return rule.op === 'above' ? x > rule.value : x < rule.value
}

export function clears(rule: AlarmRule, v: number): boolean {
  const x = rule.absolute ? Math.abs(v) : v
  return rule.op === 'above' ? x <= rule.value - rule.hysteresis : x >= rule.value + rule.hysteresis
}

export interface Evaluation {
  states: Record<string, AlarmState>
  fired: AlarmRule[]
  cleared: AlarmRule[]
}

/** One step of every rule against the channel values at `now`. */
export function evaluate(
  rules: AlarmRule[],
  values: Readonly<Record<string, number | null>>,
  prev: Readonly<Record<string, AlarmState>>,
  now: number,
): Evaluation {
  const states: Record<string, AlarmState> = {}
  const fired: AlarmRule[] = []
  const cleared: AlarmRule[] = []
  for (const rule of rules) {
    const s = prev[rule.id] ?? IDLE
    if (!rule.enabled) {
      states[rule.id] = IDLE
      if (s.active) cleared.push(rule)
      continue
    }
    const v = values[rule.channel]
    if (v == null || !Number.isFinite(v)) {
      states[rule.id] = s
      continue
    }
    if (s.active) {
      if (clears(rule, v)) {
        states[rule.id] = IDLE
        cleared.push(rule)
      } else states[rule.id] = { ...s, value: v }
      continue
    }
    if (!breaches(rule, v)) {
      states[rule.id] = IDLE
      continue
    }
    const pendingSince = s.pendingSince ?? now
    if (now - pendingSince >= rule.delayS * 1000) {
      states[rule.id] = { active: true, pendingSince: null, since: now, acknowledged: false, value: v }
      fired.push(rule)
    } else states[rule.id] = { ...IDLE, pendingSince }
  }
  return { states, fired, cleared }
}

/** Alarms that want attention: active and not acknowledged, oldest first. */
export function sounding(rules: AlarmRule[], states: Readonly<Record<string, AlarmState>>): AlarmRule[] {
  return rules
    .filter((r) => states[r.id]?.active && !states[r.id]?.acknowledged)
    .sort((a, b) => (states[a.id].since ?? 0) - (states[b.id].since ?? 0))
}
