import { describe, expect, it } from 'vitest'
import { destination } from '@/lib/geo'
import { defaultCourse, defaultCourseMarks } from '../engine/course'
import { demoForecast, forecastWind } from '../engine/forecast'
import { World } from '../engine/world'
import { analyze } from './analyze'
import { emptyProfile, learnFrom, learnedFactor } from './learn'

const CENTER = { lat: 43.585, lon: -70.16 }
const T0 = new Date(2026, 6, 15, 14, 0, 0).getTime()

function race(mistakes: boolean) {
  const forecast = demoForecast(CENTER, T0)
  const twd = forecastWind(forecast, CENTER, T0)!.twd
  const marks = defaultCourseMarks(CENTER, twd, 0.9)
  const w = new World({ forecast, marks, course: defaultCourse(marks), boatId: 'j70', ownPos: destination(CENTER, twd + 180, 0.2), t: T0 })
  w.setMistakes(mistakes)
  w.spawnFleet()
  w.startSequence(3)
  for (let i = 0; i < 7200 && !w.boats.every((b) => b.phase === 'finished'); i++) w.step(1)
  const fleet = w.boats.filter((b) => !b.own)
  const beats = w.sequence.filter((_m, i) => i === 0 || i === 3).length
  const perBeat = fleet.map((b) => b.tacks / beats).sort((a, b) => a - b)
  return analyze({
    samples: w.samples,
    sequence: w.sequence,
    gunT: w.gunT,
    boatLengthM: 6.93,
    fleetTacksPerBeat: perBeat[Math.floor(perBeat.length / 2)]!,
  })
}

describe('coach analysis', () => {
  it('finds the learner profile mistakes', () => {
    const a = race(true)
    const cats = new Set(a.findings.map((f) => f.category))
    console.log(a.findings.map((f) => `${f.category.padEnd(9)} ${f.title.padEnd(36)} ${f.metric.padEnd(16)} ~${f.costS.toFixed(0)} s`).join('\n'))
    console.log(JSON.stringify({ ...a.stats }, null, 0))
    expect(cats.has('start')).toBe(true)
    expect(cats.has('pointing')).toBe(true)
    expect(cats.has('tacking')).toBe(true)
    expect(cats.has('downwind')).toBe(true)
    expect(a.lostS).toBeGreaterThan(30)
  })

  it('finds much less in a clean race', () => {
    const a = race(false)
    const messy = race(true)
    console.log('clean', a.findings.map((f) => f.title).join(' | '))
    expect(a.lostS).toBeLessThan(messy.lostS / 2)
  })

  it('learns a polar factor', () => {
    const a = race(true)
    const p = learnFrom(emptyProfile('j70'), a)
    const f = learnedFactor(p, a.stats.avgTws, true)!
    expect(f).toBeGreaterThan(0.85)
    expect(f).toBeLessThan(1.02)
    expect(p.sessions).toHaveLength(1)
  })
})
