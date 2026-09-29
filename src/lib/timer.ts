/**
 * The start timer's arithmetic: setting the gun, rolling it for the classes
 * that start before ours, and when to sound.
 */

/** "4:30", "4.5" or "270s" style entry as seconds to the gun; null if unreadable. */
export function parseCountdown(text: string): number | null {
  const t = text.trim()
  const ms = /^(\d{1,3}):([0-5]?\d)$/.exec(t)
  if (ms) return Number(ms[1]) * 60 + Number(ms[2])
  const min = /^(\d{1,3}(?:\.\d+)?)$/.exec(t)
  if (min) return Math.round(Number(min[1]) * 60)
  return null
}

/**
 * The next time the clock reads `hh:mm[:ss]`, local time, after `now`. A gun
 * set at the clock is almost always later today; past it, tomorrow.
 */
export function parseClockTime(text: string, now: number): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(text.trim())
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0)
  let t = d.getTime()
  if (t <= now) t += 86_400_000
  return t
}

/**
 * The first gun after `now` in a sequence of `rollMin`-minute starts from `gun`:
 * the roll a timer does when another class goes and ours is next.
 */
export function rollGun(gun: number, now: number, rollMin: number): number {
  const step = rollMin * 60_000
  if (!(step > 0)) return gun
  if (gun > now) return gun
  return gun + (Math.floor((now - gun) / step) + 1) * step
}

export type Beep = 'long' | 'short'

/**
 * Sounds due as time to gun falls from `prevS` to `nowS` (seconds): a long one
 * on each whole minute and at the gun, one at 30 s, and a short one for each of
 * the last ten seconds.
 */
export function beepsBetween(prevS: number, nowS: number): Beep[] {
  if (!(prevS > nowS) || prevS - nowS > 5) return [] // a jump is a reset, not a countdown
  const out: Beep[] = []
  for (let s = Math.floor(prevS); s > nowS - 1e-9 && s >= 0; s--) {
    if (s >= prevS) continue
    if (s === 0 || s % 60 === 0) out.push('long')
    else if (s === 30 || s <= 10) out.push('short')
  }
  return out
}
