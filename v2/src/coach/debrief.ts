/**
 * The debrief the coach shows, from Claude when the server has a credential,
 * otherwise written here from the analysis by rules. Both have the same shape.
 */
import type { Analysis, Category, Finding } from './analyze'
import { recurring, type BoatProfile } from './learn'

export interface CoachDebrief {
  headline: string
  summary: string
  tendencies: Array<{ title: string; detail: string }>
  mistakes: Array<{ finding_id: string; title: string; what_happened: string; why_it_matters: string; fix: string }>
  strengths: string[]
  questions: Array<{ id: string; question: string; why: string }>
  drills: string[]
  boat_notes: string[]
  /** Who wrote it. */
  source: 'ai' | 'offline'
}

export interface CoachContext {
  boat: { name: string; lengthM: number; type: string }
  conditions: { avgTwsKn: number; avgTwdDeg: number; forecast: string }
  race: {
    mode: 'race' | 'course' | 'free'
    sequenceMinutes: number | null
    legs: string[]
    durationMin: number
    result: string | null
    fleet: Array<{ name: string; skill: string; finishMin: number | null; tacks: number; startLateS: number | null }>
  }
  analysis: {
    stats: Analysis['stats']
    estimatedSecondsLost: number
    findings: Array<Pick<Finding, 'id' | 'category' | 'title' | 'detail' | 'metric' | 'costS'> & { atRaceMinute: number }>
    manoeuvres: Array<{ kind: string; atRaceMinute: number; lossBoatLengths: number; recoverS: number | null }>
  }
  profile: {
    sessions: number
    learnedPolarPct: Record<string, { up: number; down: number }>
    avgTackLossBoatLengths: number | null
    recurringIssues: Category[]
    previousAnswers: Array<{ question: string; answer: string }>
    notes: string[]
  }
}

const QUESTIONS: Record<Category, { question: string; why: string }> = {
  start: {
    question: 'In the last minute before the gun, what held you back: losing track of time, boats around you, or not knowing how far you were from the line?',
    why: 'Each has a different fix: a countdown routine, a different set-up spot, or pinging the line.',
  },
  pointing: {
    question: 'When you were sailing low, was it on purpose (waves, chop, trying to get through another boat) or did it just feel fast?',
    why: 'Footing in waves can be right; footing in flat water usually costs.',
  },
  tacking: {
    question: 'Who trims the jib through the tack, and when do they release and sheet in? How many crew were aboard?',
    why: 'Most tack loss comes from releasing early or sheeting in too fast before the boat has speed.',
  },
  laylines: {
    question: 'How were you judging the layline: by eye, the compass, or the app?',
    why: 'Overstanding by eye is common; the time-to-layline number can take the guesswork out.',
  },
  shifts: {
    question: 'Were you watching the compass or the wind numbers on the beat, or mostly looking at the sails and other boats?',
    why: 'Most headers are only visible on the numbers; spotting them is a habit you can build.',
  },
  downwind: {
    question: 'Downwind, were you heading up to keep the boat moving in lulls, or did it feel slow when you went deeper?',
    why: 'The fix depends on whether it was a deliberate choice or a habit.',
  },
  speed: {
    question: 'What were your sail settings (jib lead, backstay, outhaul) and where was the crew sitting?',
    why: 'Steady speed below polar is usually trim or weight placement, not steering.',
  },
}

const DRILLS: Record<Category, string> = {
  start: 'Practice "time-on-distance": from 1 minute out, sail away from the line for 30 s, turn, and try to hit it at full speed on the gun. Repeat five times.',
  pointing: 'Groove drill: sail 2 minutes on each tack calling out TWA every 10 s, keeping within 2° of target.',
  tacking: 'Do ten tacks in a row with a 30 s pause, timing from helm-down to back on target speed. Aim to shave 2 s off.',
  laylines: 'On each windward approach, call your layline out loud, then check it against the app. Score how many you got within a boat length.',
  shifts: 'Shift drill: on a beat, call "lift" or "header" every 30 s from the compass alone, then tack on every header over 5°.',
  downwind: 'Downwind angle drill: sail 2 minutes at target TWA, 2 minutes 10° higher, compare VMG on the display.',
  speed: 'Two-boat tune-up: line up with a partner and change one trim setting at a time for 3 minutes.',
}

const NICE: Record<Category, string> = {
  start: 'starts',
  pointing: 'upwind angles',
  tacking: 'tacks',
  laylines: 'laylines',
  shifts: 'shifts',
  downwind: 'downwind angles',
  speed: 'boat speed',
}

export function offlineDebrief(a: Analysis, ctx: CoachContext, profile: BoatProfile): CoachDebrief {
  const f = a.findings
  const s = a.stats
  const L = a.boatLengthM
  const top = f[0]
  const lost = Math.round(a.lostS)
  const headline = top
    ? `${top.title}: about ${Math.round(top.costS)} s of your ${lost} s lost came from it.`
    : 'A clean session: nothing stood out as costly.'
  const parts: string[] = []
  parts.push(
    `${ctx.race.result ? `${ctx.race.result}. ` : ''}You sailed ${s.sailedNm.toFixed(1)} nm in ${(s.durationS / 60).toFixed(0)} minutes in about ${s.avgTws.toFixed(0)} knots of wind.`,
  )
  if (s.upwindPolarPct !== null) parts.push(`Upwind you averaged ${s.upwindPolarPct.toFixed(0)}% of polar speed${s.upwindTwaDelta !== null ? `, ${Math.abs(s.upwindTwaDelta).toFixed(1)}° ${s.upwindTwaDelta > 0 ? 'lower' : 'higher'} than the target angle` : ''}.`)
  if (s.tacks) parts.push(`You made ${s.tacks} tacks${s.avgTackLossM !== null ? ` at ${(s.avgTackLossM / L).toFixed(1)} boat lengths each` : ''}.`)
  if (f.length) parts.push(`Fixing the top ${Math.min(3, f.length)} items below would have saved roughly ${Math.round(f.slice(0, 3).reduce((x, y) => x + y.costS, 0))} seconds.`)

  const rec = recurring(profile)
  const tendencies = rec.map((c) => ({
    title: `Recurring: ${NICE[c]}`,
    detail: `This has come up in ${profile.sessions.slice(-6).filter((x) => x.findings.some((y) => y.category === c)).length} of your last ${Math.min(6, profile.sessions.length)} sessions.`,
  }))
  if (s.upwindTwaDelta !== null && Math.abs(s.upwindTwaDelta) > 2)
    tendencies.push({ title: s.upwindTwaDelta > 0 ? 'You tend to sail low upwind' : 'You tend to pinch upwind', detail: `Average ${Math.abs(s.upwindTwaDelta).toFixed(1)}° off target across the beats.` })
  if (s.downwindTwaDelta !== null && s.downwindTwaDelta < -5)
    tendencies.push({ title: 'You sail high downwind', detail: `Average ${Math.abs(s.downwindTwaDelta).toFixed(0)}° hotter than target.` })

  const strengths: string[] = []
  if (s.downwindPolarPct !== null && s.downwindPolarPct > 97) strengths.push(`Downwind speed was strong at ${s.downwindPolarPct.toFixed(0)}% of polar.`)
  if (s.upwindPolarPct !== null && s.upwindPolarPct > 97) strengths.push(`Upwind speed in steady sailing was ${s.upwindPolarPct.toFixed(0)}% of polar: your trim is working.`)
  if (s.start && s.start.lateS !== null && s.start.lateS <= 4) strengths.push(`Good start: across the line ${s.start.lateS.toFixed(0)} s after the gun.`)
  if (s.avgTackLossM !== null && s.avgTackLossM < 1.3 * L) strengths.push('Your tacks were efficient, about a boat length each.')
  if (!strengths.length) strengths.push('You finished the course and the log is complete: that is the raw material for getting faster.')

  const cats = [...new Set(f.map((x) => x.category))]
  const answered = new Set(profile.answers.map((x) => x.question))
  const questions = cats
    .map((c) => ({ id: c, ...QUESTIONS[c] }))
    .filter((q) => !answered.has(q.question))
    .slice(0, 3)

  const notes: string[] = []
  if (s.avgTackLossM !== null) notes.push(`Tacks cost about ${(s.avgTackLossM / L).toFixed(1)} boat lengths in ${Math.round(s.avgTws)} kn.`)
  if (s.upwindPolarPct !== null) notes.push(`Upwind ${s.upwindPolarPct.toFixed(0)}% of polar in ${Math.round(s.avgTws)} kn.`)

  return {
    source: 'offline',
    headline,
    summary: parts.join(' '),
    tendencies,
    mistakes: f.slice(0, 5).map((x) => ({
      finding_id: x.id,
      title: x.title,
      what_happened: x.detail,
      why_it_matters: `Roughly ${Math.round(x.costS)} s lost.`,
      fix: x.tip,
    })),
    strengths,
    questions,
    drills: cats.slice(0, 3).map((c) => DRILLS[c]),
    boat_notes: notes,
  }
}

export function offlineChat(question: string, a: Analysis | null): string {
  const q = question.toLowerCase()
  if (!a) return 'Sail a session first (or run the simulator), then I can answer from your data.'
  const s = a.stats
  if (/tack/.test(q))
    return `You made ${s.tacks} tacks, each costing about ${s.avgTackLossM !== null ? (s.avgTackLossM / a.boatLengthM).toFixed(1) : '?'} boat lengths, and took ${s.avgTackRecoverS?.toFixed(0) ?? '?'} s to get back to speed. Smooth rudder, build speed low, then point.`
  if (/start|line|gun/.test(q))
    return s.start
      ? `You crossed ${s.start.lateS?.toFixed(0) ?? '?'} s after the gun, ${s.start.lineDistAtGunM !== null ? `${(s.start.lineDistAtGunM / a.boatLengthM).toFixed(1)} lengths back` : ''} at the gun.`
      : 'There was no start sequence in this session.'
  if (/point|high|low|angle/.test(q))
    return `Upwind you averaged ${s.upwindTwaDelta?.toFixed(1) ?? '?'}° from target (positive is low). Downwind ${s.downwindTwaDelta?.toFixed(1) ?? '?'}° (negative is high).`
  if (/speed|slow|fast|polar/.test(q))
    return `Upwind ${s.upwindPolarPct?.toFixed(0) ?? '?'}% of polar, downwind ${s.downwindPolarPct?.toFixed(0) ?? '?'}%.`
  return 'The AI coach is offline (no API key on the server), so I can only answer from the numbers: ask about tacks, the start, angles or speed.'
}
