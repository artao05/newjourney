import { describe, expect, it } from 'vitest'
import { defaultCourse, defaultCourseMarks, toLayline, fetches, lineBias } from './course'
import { demoForecast, forecastWind } from './forecast'
import { World } from './world'
import { destination } from '@/lib/geo'

const CENTER = { lat: 43.585, lon: -70.16 }
// 14:00 local on a fixed day: the demo sea breeze is up.
const T0 = new Date(2026, 6, 15, 14, 0, 0).getTime()

function setup(mistakes = true) {
  const forecast = demoForecast(CENTER, T0)
  const twd = forecastWind(forecast, CENTER, T0)!.twd
  const marks = defaultCourseMarks(CENTER, twd, 0.9)
  const course = defaultCourse(marks)
  const w = new World({ forecast, marks, course, boatId: 'j70', ownPos: destination(CENTER, twd + 180, 0.2), t: T0 })
  w.setMistakes(mistakes)
  w.spawnFleet()
  return w
}

describe('world', () => {
  it('runs a full race: every boat starts, tacks and finishes', () => {
    const w = setup()
    w.startSequence(3)
    for (let i = 0; i < 3600 * 2 && !w.boats.every((b) => b.phase === 'finished'); i++) w.step(1)
    for (const b of w.boats) {
      expect(b.phase, `${b.name}: ${b.intent}`).toBe('finished')
      expect(b.crossedLineT, b.name).not.toBeNull()
      expect(b.tacks, b.name).toBeGreaterThan(0)
    }
    const own = w.own
    const pros = w.boats.filter((b) => b.skill.label === 'Pro')
    const ownT = own.finishedT! - w.gunT!
    const bestPro = Math.min(...pros.map((b) => b.finishedT! - w.gunT!))
    // The learner should lose, but not by an absurd margin.
    expect(ownT).toBeGreaterThan(bestPro)
    expect(ownT).toBeLessThan(bestPro * 1.4)
    const startEv = w.events.find((e) => e.boatId === 'own' && e.kind === 'start')!
    expect(startEv).toBeTruthy()
    console.log(
      w.standings().map((b) => `${b.name.padEnd(12)} ${((b.finishedT! - w.gunT!) / 60000).toFixed(2)} min tacks ${b.tacks} gybes ${b.gybes} start +${((b.crossedLineT! - w.gunT!) / 1000).toFixed(0)}s`).join('\n'),
    )
    console.log(w.events.filter((e) => e.boatId === 'own').map((e) => `${((e.t - w.gunT!) / 1000).toFixed(0)}s ${e.kind}: ${e.detail}`).join('\n'))
    expect(w.samples.length).toBeGreaterThan(300)
  })

  it('a clean own boat sails without the scripted lapses', () => {
    const w = setup(false)
    w.startSequence(3)
    for (let i = 0; i < 3600 * 2 && w.own.phase !== 'finished'; i++) w.step(1)
    expect(w.own.phase).toBe('finished')
  })

  it('laylines: fetch test and distance to layline agree', () => {
    const mark = { lat: 43.6, lon: -70.16 }
    const pos = { lat: 43.59, lon: -70.16 } // dead downwind of the mark in a northerly
    expect(fetches(pos, mark, 0, 43, 1, 'beat')).toBe(false)
    const ll = toLayline({ pos, mark, twd: 0, angle: 43, side: 1, bsp: 5, kind: 'beat' })!
    // 0.6 nm south of the mark: the layline is about tan(43)*... sail ~0.41 nm on starboard.
    expect(ll.nm).toBeGreaterThan(0.35)
    expect(ll.nm).toBeLessThan(0.5)
  })

  it('line bias sign: a veer favours the committee (right) end', () => {
    const line = { pin: { lat: 43.6, lon: -70.17 }, committee: { lat: 43.6, lon: -70.15 } }
    expect(lineBias(line, 0)).toBeCloseTo(0, 0)
    expect(lineBias(line, 10)).toBeLessThan(0)
    expect(lineBias(line, 350)).toBeGreaterThan(0)
  })
})
