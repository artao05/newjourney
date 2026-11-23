import { describe, expect, it } from 'vitest'
import { destination, distance } from '@/lib/geo'
import { courseMarks, LAYOUTS, layoutCourse, makeGate, removeGate, segmentsCross } from './course'
import { demoForecast, forecastWind } from './forecast'
import type { Course, Mark } from './types'
import { World } from './world'

const CENTER = { lat: 43.585, lon: -70.16 }
const T0 = new Date(2026, 6, 15, 14, 0, 0).getTime()
const forecast = demoForecast(CENTER, T0)
const twd = forecastWind(forecast, CENTER, T0)!.twd

function race(marks: Mark[], course: Course) {
  const w = new World({ forecast, marks, course, boatId: 'j70', ownPos: destination(CENTER, twd + 180, 0.2), t: T0 })
  w.setMistakes(false)
  w.spawnFleet(3)
  w.startSequence(3)
  for (let i = 0; i < 3600 * 4 && !w.boats.every((b) => b.phase === 'finished'); i++) w.step(1)
  return w
}

describe('course layouts', () => {
  for (const l of LAYOUTS) {
    it(`${l.name}: every boat sails it to the finish`, () => {
      const { marks, course } = layoutCourse(l.id, CENTER, twd, 0.6)
      const w = race(marks, course)
      for (const b of w.boats) expect(b.phase, `${b.name}: ${b.intent}`).toBe('finished')
      // One rounding per entry in the course, the last being the finish.
      const own = w.events.filter((e) => e.boatId === 'own' && (e.kind === 'rounding' || e.kind === 'finish'))
      expect(own.length).toBe(course.sequence.length)
    })
  }

  it('W4 has four beats and W2 two', () => {
    const beats = (id: 'w2' | 'w4') => {
      const { marks, course } = layoutCourse(id, CENTER, twd)
      const windward = marks.find((m) => m.name === 'Windward 1')!.id
      return course.sequence.filter((x) => x === windward).length
    }
    expect(beats('w2')).toBe(2)
    expect(beats('w4')).toBe(4)
  })
})

describe('gates', () => {
  it('an open gate is sailed through and a closed one round the outside', () => {
    for (const open of [true, false]) {
      const { marks, course } = layoutCourse('w2', CENTER, twd, 0.6)
      course.gates = course.gates!.map((g) => ({ ...g, open }))
      const w = race(marks, course)
      const g = course.gates![0]!
      const a = marks.find((m) => m.id === g.aId)!
      const b = marks.find((m) => m.id === g.bId)!
      const fouls = w.events.filter((e) => e.kind === 'foul')
      expect(fouls, open ? 'no fouls at an open gate' : 'nobody sails through a closed gate').toHaveLength(0)
      // The own boat's 1 Hz log after the gun (the W2 gate sits just below the
      // start line, where boats manoeuvre before the start): through the gate
      // when open, never when closed.
      const log = w.samples.filter((x) => x.t >= w.gunT!)
      let through = false
      for (let i = 1; i < log.length; i++) if (segmentsCross(log[i - 1]!, log[i]!, a, b)) through = true
      expect(through, `the own boat ${open ? 'should' : 'should not'} pass between the gate marks`).toBe(open)
      // And every boat rounded the gate once per pass of it in the course.
      const passes = course.sequence.filter((x) => x === g.id).length
      for (const boat of w.boats) expect(w.events.filter((e) => e.boatId === boat.id && e.kind === 'rounding' && e.detail.includes('Gate')).length, boat.name).toBe(passes)
    }
  })

  it('stands in for its two marks at their middle', () => {
    const { marks, course } = layoutCourse('trapezoid', CENTER, twd)
    const seq = courseMarks(marks, course)
    const gate = seq.find((m) => m.gate)!
    expect(distance(gate, gate.gate!.a)).toBeCloseTo(distance(gate, gate.gate!.b), 4)
  })

  it('can be made from a mark and turned back into one', () => {
    const { marks, course } = layoutCourse('triangle', CENTER, twd)
    const lee = marks.find((m) => m.name === 'Leeward 3')!
    const made = makeGate(marks, course, lee.id, twd)!
    expect(made.course.gates).toHaveLength(1)
    expect(made.course.sequence.filter((x) => x === made.course.gates![0]!.id)).toHaveLength(2)
    expect(made.marks).toHaveLength(marks.length + 1)
    const back = removeGate(made.marks, made.course, made.course.gates![0]!.id)!
    expect(back.marks).toHaveLength(marks.length)
    expect(back.course.sequence).toEqual(course.sequence)
    expect(distance(back.marks.find((m) => m.id === lee.id)!, lee)).toBeLessThan(0.001)
  })
})
