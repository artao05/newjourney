/**
 * Turns one session's instrument log into numbers and findings a coach can
 * talk about. Works from samples alone (what an NMEA 2000 network gives you
 * once a second), so it reads a real boat's log the same way as the
 * simulator's. Every finding carries the time window and position it is
 * about, and a rough cost in seconds so the biggest problems come first.
 */
import { angdiff, twaFrom } from '@/lib/angles'
import { bearing, distance } from '@/lib/geo'
import type { LatLon, Mark, Sample } from '../engine/types'

export type Category = 'start' | 'pointing' | 'tacking' | 'laylines' | 'shifts' | 'downwind' | 'speed'

export interface Finding {
  id: string
  category: Category
  title: string
  detail: string
  /** The number that shows it, already formatted. */
  metric: string
  /** Rough seconds lost to it. */
  costS: number
  tFrom: number
  tTo: number
  at: LatLon
  tip: string
}

export interface Manoeuvre {
  kind: 'tack' | 'gybe'
  t: number
  at: LatLon
  /** Metres of ground lost against sailing on at target VMG. */
  lossM: number
  /** Seconds to get back to 90% of target speed. */
  recoverS: number | null
  minBsp: number
}

export interface Stats {
  durationS: number
  sailedNm: number
  avgTws: number
  avgTwd: number
  upwindPolarPct: number | null
  downwindPolarPct: number | null
  /** Mean upwind TWA minus target, degrees (positive = sailing lower than target). */
  upwindTwaDelta: number | null
  /** Mean downwind TWA minus target (negative = sailing higher than target). */
  downwindTwaDelta: number | null
  tacks: number
  gybes: number
  avgTackLossM: number | null
  avgTackRecoverS: number | null
  start: { lateS: number | null; lineDistAtGunM: number | null; speedAtGunPct: number | null } | null
  headedS: number
}

export interface Analysis {
  stats: Stats
  findings: Finding[]
  manoeuvres: Manoeuvre[]
  /** Estimated total seconds lost to the findings. */
  lostS: number
  boatLengthM: number
}

const UP = 90

function isUpwind(s: Sample): boolean {
  return s.legKind ? s.legKind === 'beat' : Math.abs(s.twa) < UP
}

function isDownwind(s: Sample): boolean {
  return s.legKind ? s.legKind === 'run' : Math.abs(s.twa) > 110
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function circMean(degs: number[]): number {
  let s = 0
  let c = 0
  for (const d of degs) {
    s += Math.sin((d * Math.PI) / 180)
    c += Math.cos((d * Math.PI) / 180)
  }
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360
}

const pos = (s: Sample): LatLon => ({ lat: s.lat, lon: s.lon })

/** Target VMG for a sample, knots (positive). */
function targetVmg(s: Sample): number {
  return Math.abs(s.targetBsp * Math.cos((s.targetTwa * Math.PI) / 180))
}

/** VMG against the wind (upwind positive) or with it (downwind positive). */
function windVmg(s: Sample): number {
  const v = s.bsp * Math.cos((s.twa * Math.PI) / 180)
  return Math.abs(s.twa) < 90 ? v : -v
}

export function findManoeuvres(samples: Sample[]): Manoeuvre[] {
  const out: Manoeuvre[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!
    const b = samples[i]!
    if (a.phase === 'free' || Math.sign(a.twa) === Math.sign(b.twa) || Math.abs(a.twa) < 0.5) continue
    // Ignore a dither near the wind: require a settled side for 4 s before.
    const before = samples.slice(Math.max(0, i - 5), i)
    if (before.some((s) => Math.sign(s.twa) !== Math.sign(a.twa))) continue
    const kind: Manoeuvre['kind'] = Math.abs(a.twa) + Math.abs(b.twa) < 180 ? 'tack' : 'gybe'
    // Loss: ground made good in the wind's direction over [-10 s, +30 s] against target VMG.
    const w0 = Math.max(0, i - 10)
    const w1 = Math.min(samples.length - 1, i + 30)
    let made = 0
    let ideal = 0
    let minBsp = Infinity
    for (let k = w0; k <= w1; k++) {
      const s = samples[k]!
      made += windVmg(s)
      ideal += targetVmg(s)
      minBsp = Math.min(minBsp, s.bsp)
    }
    const lossM = Math.max(0, ((ideal - made) / 3600) * 1852)
    let recoverS: number | null = null
    for (let k = i; k < Math.min(samples.length, i + 120); k++) {
      const s = samples[k]!
      if (s.bsp >= 0.9 * s.targetBsp && !s.inManoeuvre) {
        recoverS = (s.t - b.t) / 1000
        break
      }
    }
    out.push({ kind, t: b.t, at: pos(b), lossM, recoverS, minBsp })
  }
  return out
}

/** Contiguous runs of samples where `pred` holds, at least `minS` long. */
function runs(samples: Sample[], pred: (s: Sample, i: number) => boolean, minS: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i <= samples.length; i++) {
    const ok = i < samples.length && pred(samples[i]!, i)
    if (ok && start < 0) start = i
    if (!ok && start >= 0) {
      const a = samples[start]!
      const b = samples[i - 1]!
      if ((b.t - a.t) / 1000 >= minS) out.push([start, i - 1])
      start = -1
    }
  }
  return out
}

function nearManoeuvre(t: number, ms: Manoeuvre[], beforeS = 8, afterS = 25): boolean {
  return ms.some((m) => t >= m.t - beforeS * 1000 && t <= m.t + afterS * 1000)
}

export interface AnalyzeInput {
  samples: Sample[]
  marks?: Mark[]
  /** Marks in rounding order, for laylines. */
  sequence?: Mark[]
  gunT?: number | null
  boatLengthM: number
  /** Median tacks per beat in the fleet, when racing against one. */
  fleetTacksPerBeat?: number | null
}

export function analyze(input: AnalyzeInput): Analysis {
  const all = input.samples
  const racing = all.filter((s) => s.phase === 'racing' || s.phase === 'finished')
  const samples = racing.length > 30 ? racing.filter((s) => s.phase === 'racing') : all
  const L = input.boatLengthM
  const findings: Finding[] = []
  const ms = findManoeuvres(samples)
  const tacks = ms.filter((m) => m.kind === 'tack')
  const gybes = ms.filter((m) => m.kind === 'gybe')

  const steady = samples.filter((s) => !s.inManoeuvre && !nearManoeuvre(s.t, ms))
  const up = steady.filter(isUpwind)
  const down = steady.filter(isDownwind)

  // ------------------------------------------------------------ start
  let start: Stats['start'] = null
  const gunT = input.gunT ?? null
  if (gunT !== null && all.some((s) => s.phase === 'prestart')) {
    const atGun = all.find((s) => s.t >= gunT)
    const crossed = all.find((s) => s.t >= gunT && s.lineNm !== null && s.lineNm <= 0)
    const lateS = crossed ? (crossed.t - gunT) / 1000 : null
    const lineM = atGun?.lineNm != null ? atGun.lineNm * 1852 : null
    const spd = atGun ? (atGun.bsp / Math.max(0.1, atGun.targetBsp)) * 100 : null
    start = { lateS, lineDistAtGunM: lineM, speedAtGunPct: spd }
    if (lateS !== null && lateS > 6 && atGun) {
      findings.push({
        id: 'start-late',
        category: 'start',
        title: 'Late off the start line',
        detail: `You crossed the line ${lateS.toFixed(0)} s after the gun, ${lineM !== null ? `${(lineM / L).toFixed(1)} boat lengths back` : 'well back'} at the gun and at ${spd?.toFixed(0)}% of target speed. The front of the fleet was already ${(lateS * atGun.targetBsp * 0.5144 / L).toFixed(0)} lengths up the course.`,
        metric: `+${lateS.toFixed(0)} s`,
        costS: lateS - 2,
        tFrom: gunT - 30_000,
        tTo: crossed?.t ?? gunT + 30_000,
        at: pos(atGun),
        tip: 'Time your final approach with time-on-distance: at 30 s to go, check the "time to line" number and burn the difference by luffing, not by stopping.',
      })
    }
  }

  // ------------------------------------------------------------ pointing
  const upDeltas = up.map((s) => Math.abs(s.twa) - s.targetTwa)
  const upwindTwaDelta = mean(upDeltas)
  const footRuns = runs(samples, (s) => isUpwind(s) && !s.inManoeuvre && Math.abs(s.twa) - s.targetTwa > 4, 45)
  for (const [a, b] of footRuns) {
    const seg = samples.slice(a, b + 1)
    const d = mean(seg.map((s) => Math.abs(s.twa) - s.targetTwa))!
    const lostNm = seg.reduce((acc, s) => acc + (targetVmg(s) - windVmg(s)) / 3600, 0)
    const lostS = (lostNm / Math.max(0.5, mean(seg.map(targetVmg))!)) * 3600
    const dur = (seg[seg.length - 1]!.t - seg[0]!.t) / 1000
    findings.push({
      id: `foot-${seg[0]!.t}`,
      category: 'pointing',
      title: 'Not pointing high enough',
      detail: `For ${Math.round(dur)} s you sailed about ${d.toFixed(0)}° lower than the target angle of ${seg[0]!.targetTwa.toFixed(0)}°. Boat speed went up a little, but VMG (speed made good towards the wind) dropped.`,
      metric: `${d.toFixed(0)}° low`,
      costS: Math.max(0, lostS),
      tFrom: seg[0]!.t,
      tTo: seg[seg.length - 1]!.t,
      at: pos(seg[Math.floor(seg.length / 2)]!),
      tip: 'Steer to the target TWA on the display. If the jib telltales are all streaming, you can head up until the windward ones just start to lift.',
    })
  }
  const pinchRuns = runs(samples, (s) => isUpwind(s) && !s.inManoeuvre && s.targetTwa - Math.abs(s.twa) > 3.5, 45)
  for (const [a, b] of pinchRuns) {
    const seg = samples.slice(a, b + 1)
    const d = mean(seg.map((s) => s.targetTwa - Math.abs(s.twa)))!
    const pct = mean(seg.map((s) => (s.bsp / Math.max(0.1, s.targetBsp)) * 100))!
    const lostNm = seg.reduce((acc, s) => acc + (targetVmg(s) - windVmg(s)) / 3600, 0)
    const lostS = (lostNm / Math.max(0.5, mean(seg.map(targetVmg))!)) * 3600
    findings.push({
      id: `pinch-${seg[0]!.t}`,
      category: 'pointing',
      title: 'Pinching: too high and too slow',
      detail: `You sailed ${d.toFixed(0)}° higher than target and the boat slowed to ${pct.toFixed(0)}% of target speed. Pointing that high stalls the keel and you slip sideways.`,
      metric: `${pct.toFixed(0)}% speed`,
      costS: Math.max(0, lostS),
      tFrom: seg[0]!.t,
      tTo: seg[seg.length - 1]!.t,
      at: pos(seg[Math.floor(seg.length / 2)]!),
      tip: 'Speed first, then height: bear off two or three degrees until you are on target speed, then come back up slowly.',
    })
  }

  // ------------------------------------------------------------ tacking
  const tackLoss = mean(tacks.map((m) => m.lossM))
  const recover = mean(tacks.map((m) => m.recoverS).filter((x): x is number => x !== null))
  const beats = new Set(samples.filter((s) => s.legKind === 'beat').map((s) => s.leg)).size || 1
  const perBeat = tacks.length / beats
  const fleetPer = input.fleetTacksPerBeat ?? null
  if (tackLoss !== null && tackLoss > 2.6 * L) {
    const worst = [...tacks].sort((x, y) => y.lossM - x.lossM)[0]!
    findings.push({
      id: 'tack-loss',
      category: 'tacking',
      title: 'Each tack is costing a lot',
      detail: `Your average tack cost ${(tackLoss / L).toFixed(1)} boat lengths (${tackLoss.toFixed(0)} m) and took ${recover?.toFixed(0) ?? '?'} s to get back to speed. Speed dropped as low as ${worst.minBsp.toFixed(1)} kn in the worst one.`,
      metric: `${(tackLoss / L).toFixed(1)} lengths/tack`,
      costS: (tacks.length * Math.max(0, tackLoss - L)) / Math.max(1, (mean(up.map((s) => s.targetBsp)) ?? 5) * 0.5144),
      tFrom: worst.t - 10_000,
      tTo: worst.t + 30_000,
      at: worst.at,
      tip: 'Turn smoothly, not hard: the rudder is a brake. Come out of the tack a few degrees low of target, build speed for 5-10 s, then head up.',
    })
  }
  const tooMany = fleetPer !== null ? perBeat > fleetPer * 1.5 && tacks.length >= 6 : perBeat > 5
  if (tooMany) {
    const extra = fleetPer !== null ? Math.max(0, tacks.length - fleetPer * beats) : tacks.length - 4 * beats
    // The densest minute of tacking.
    let bestI = 0
    let bestN = 0
    for (let i = 0; i < tacks.length; i++) {
      const n = tacks.filter((m) => m.t >= tacks[i]!.t && m.t < tacks[i]!.t + 300_000).length
      if (n > bestN) {
        bestN = n
        bestI = i
      }
    }
    const first = tacks[bestI]!
    findings.push({
      id: 'over-tacking',
      category: 'tacking',
      title: 'Tacking too much',
      detail: `You tacked ${tacks.length} times on ${beats} beat${beats > 1 ? 's' : ''}${fleetPer !== null ? `, where the fleet averaged ${fleetPer.toFixed(1)} per beat` : ''}. ${bestN} of them came within five minutes. Several were not on real headers, so each one paid the tack cost for little or no gain.`,
      metric: `${tacks.length} tacks`,
      costS: (extra * (tackLoss ?? 2 * L)) / Math.max(1, (mean(up.map((s) => s.targetBsp)) ?? 5) * 0.5144),
      tFrom: first.t - 20_000,
      tTo: first.t + 300_000,
      at: first.at,
      tip: 'Tack on headers of about 5° or more that last, not on every wiggle. Watch the TWD trend for 10-15 s before committing.',
    })
  }

  // ------------------------------------------------------------ shifts
  let headedS = 0
  const mean3: number[] = []
  const headed: boolean[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    const win = samples.slice(Math.max(0, i - 180), i + 1).map((x) => x.twd)
    const m = circMean(win)
    mean3.push(m)
    const shift = angdiff(s.twd, m)
    const h = isUpwind(s) && !s.inManoeuvre && (s.twa > 0 ? shift < -5 : shift > 5)
    headed.push(h)
  }
  const headRuns = runs(samples, (_s, i) => headed[i]! && !nearManoeuvre(samples[i]!.t, ms, 0, 20), 50)
  for (const [a, b] of headRuns) headedS += (samples[b]!.t - samples[a]!.t) / 1000
  const longest = [...headRuns].sort((x, y) => samples[y[1]]!.t - samples[y[0]]!.t - (samples[x[1]]!.t - samples[x[0]]!.t))[0]
  if (longest) {
    const seg = samples.slice(longest[0], longest[1] + 1)
    const sh = mean(seg.map((s, k) => Math.abs(angdiff(s.twd, mean3[longest[0] + k]!))))!
    const dur = (seg[seg.length - 1]!.t - seg[0]!.t) / 1000
    findings.push({
      id: `headed-${seg[0]!.t}`,
      category: 'shifts',
      title: 'Sailed on in a header',
      detail: `For ${Math.round(dur)} s the wind was about ${sh.toFixed(0)}° headed on your tack, so you were pointing further from the mark than you would on the other tack.`,
      metric: `${Math.round(dur)} s headed`,
      costS: dur * (1 - Math.cos((sh * 2 * Math.PI) / 180)) * 0.9 + 5,
      tFrom: seg[0]!.t,
      tTo: seg[seg.length - 1]!.t,
      at: pos(seg[0]!),
      tip: 'When the compass heading drops by 5° or more on starboard (or rises on port) and stays there, tack: the other tack is now lifted.',
    })
  }

  // ------------------------------------------------------------ laylines
  const seq = input.sequence ?? []
  if (seq.length) {
    for (let i = 0; i < tacks.length; i++) {
      const m = tacks[i]!
      const idx = samples.findIndex((s) => s.t >= m.t)
      const s = samples[idx]
      if (!s || s.legKind !== 'beat') continue
      const next = tacks[i + 1]
      const roundedLeg = samples.find((x) => x.t > m.t && x.leg !== s.leg)
      // The last tack before the mark.
      if (next && roundedLeg && next.t < roundedLeg.t) continue
      const mark = seq[s.leg]
      if (!mark) continue
      // Settled heading 30 s after the tack.
      const after = samples[Math.min(samples.length - 1, idx + 30)]!
      const twaMark = Math.abs(twaFrom(bearing(pos(after), mark), after.twd))
      const over = twaMark - after.targetTwa
      if (over > 4) {
        const d = distance(pos(after), mark) * 1852
        const extraM = d * (1 / Math.cos(((over) * Math.PI) / 180) - 1) + d * Math.sin((over * Math.PI) / 180) * 0.35
        findings.push({
          id: `overstand-${m.t}`,
          category: 'laylines',
          title: `Overstood the layline to ${mark.name}`,
          detail: `Your last tack for ${mark.name} came about ${over.toFixed(0)}° past the layline, so you reached for the mark instead of sailing to it close-hauled: about ${(extraM / L).toFixed(1)} boat lengths of extra sailing.`,
          metric: `${over.toFixed(0)}° over`,
          costS: extraM / Math.max(1, after.bsp * 0.5144),
          tFrom: m.t - 60_000,
          tTo: m.t + 30_000,
          at: m.at,
          tip: 'Watch the "time to layline" number and tack when it reaches zero. In current or a building breeze, tack a boat length early rather than late.',
        })
      }
    }
  }

  // ------------------------------------------------------------ downwind
  const downwindTwaDelta = mean(down.map((s) => Math.abs(s.twa) - s.targetTwa))
  if (downwindTwaDelta !== null && downwindTwaDelta < -6 && down.length > 60) {
    const seg = down
    const lostNm = seg.reduce((acc, s) => acc + (targetVmg(s) - windVmg(s)) / 3600, 0)
    const lostS = (lostNm / Math.max(0.5, mean(seg.map(targetVmg))!)) * 3600
    findings.push({
      id: 'downwind-high',
      category: 'downwind',
      title: 'Sailing too high downwind',
      detail: `Downwind you averaged ${Math.abs(downwindTwaDelta).toFixed(0)}° higher than the target angle of ${seg[0]!.targetTwa.toFixed(0)}°. It feels fast, but you sailed extra distance for the depth you made.`,
      metric: `${Math.abs(downwindTwaDelta).toFixed(0)}° high`,
      costS: Math.max(0, lostS),
      tFrom: seg[0]!.t,
      tTo: seg[seg.length - 1]!.t,
      at: pos(seg[Math.floor(seg.length / 2)]!),
      tip: 'Sail the target downwind angle and use the puffs to go deeper; head up only in lulls to keep the boat moving.',
    })
  }

  // ------------------------------------------------------------ speed
  const upPct = mean(up.map((s) => (s.bsp / Math.max(0.1, s.polarBsp)) * 100))
  const downPct = mean(down.map((s) => (s.bsp / Math.max(0.1, s.polarBsp)) * 100))
  if (upPct !== null && upPct < 94 && up.length > 60) {
    findings.push({
      id: 'speed-up',
      category: 'speed',
      title: 'Upwind boat speed below the polar',
      detail: `In steady sailing upwind you averaged ${upPct.toFixed(0)}% of the polar speed for your wind and angle.`,
      metric: `${upPct.toFixed(0)}% polar`,
      costS: ((100 - upPct) / 100) * (up.length * 0.6),
      tFrom: up[0]!.t,
      tTo: up[up.length - 1]!.t,
      at: pos(up[0]!),
      tip: 'Check sail trim against your tuning guide: jib lead, halyard tension, and backstay for the wind strength.',
    })
  }

  const durationS = samples.length ? (samples[samples.length - 1]!.t - samples[0]!.t) / 1000 : 0
  let sailedNm = 0
  for (let i = 1; i < samples.length; i++) sailedNm += distance(pos(samples[i - 1]!), pos(samples[i]!))

  findings.sort((a, b) => b.costS - a.costS)
  const stats: Stats = {
    durationS,
    sailedNm,
    avgTws: mean(samples.map((s) => s.tws)) ?? 0,
    avgTwd: circMean(samples.map((s) => s.twd)),
    upwindPolarPct: upPct,
    downwindPolarPct: downPct,
    upwindTwaDelta,
    downwindTwaDelta,
    tacks: tacks.length,
    gybes: gybes.length,
    avgTackLossM: tackLoss,
    avgTackRecoverS: recover,
    start,
    headedS,
  }
  return { stats, findings, manoeuvres: ms, lostS: findings.reduce((a, f) => a + f.costS, 0), boatLengthM: L }
}

// ------------------------------------------------------------ live tips

export interface LiveTip {
  id: string
  tone: 'info' | 'warn' | 'good'
  text: string
}

/** Instant on-the-water prompts from the last minute of data. No AI needed. */
export function liveTips(samples: Sample[], extra?: { laylineS?: number | null }): LiveTip[] {
  const out: LiveTip[] = []
  const last = samples.slice(-30).filter((s) => !s.inManoeuvre)
  if (last.length < 10) return out
  const s = last[last.length - 1]!
  const upwind = Math.abs(s.twa) < 90
  const dTwa = mean(last.map((x) => Math.abs(x.twa) - x.targetTwa))!
  const pct = mean(last.map((x) => (x.bsp / Math.max(0.1, x.targetBsp)) * 100))!
  if (upwind && dTwa > 4) out.push({ id: 'low', tone: 'warn', text: `${dTwa.toFixed(0)}° low of target: head up a touch` })
  if (upwind && dTwa < -3.5 && pct < 92) out.push({ id: 'high', tone: 'warn', text: `Pinching: ${pct.toFixed(0)}% speed. Bear off and build` })
  if (!upwind && dTwa < -8) out.push({ id: 'hot', tone: 'warn', text: `${Math.abs(dTwa).toFixed(0)}° high downwind: soak lower in the puffs` })
  const win = samples.slice(-180).map((x) => x.twd)
  if (win.length > 60 && upwind) {
    const shift = angdiff(s.twd, circMean(win))
    const headedNow = s.twa > 0 ? shift < -5 : shift > 5
    if (headedNow) out.push({ id: 'header', tone: 'warn', text: `Headed ${Math.abs(shift).toFixed(0)}°: the other tack is lifted` })
    else if (Math.abs(shift) > 5) out.push({ id: 'lift', tone: 'good', text: `Lifted ${Math.abs(shift).toFixed(0)}°: stay on this tack` })
  }
  if (extra?.laylineS != null && extra.laylineS < 30 && extra.laylineS > 0)
    out.push({ id: 'layline', tone: 'info', text: `Layline in ${Math.round(extra.laylineS)} s: get ready to tack` })
  if (pct > 98 && Math.abs(dTwa) < 2.5) out.push({ id: 'good', tone: 'good', text: 'On target: nice' })
  return out.slice(0, 3)
}
