/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { redoMarks, resetMarkHistory, startMarkHistory, undoMarks, useMarkHistory } from './markHistory'

let clock = 0
startMarkHistory(() => clock)

const names = () => useStore.getState().course.marks.map((m) => m.name)
const A = { lat: 43.6, lon: -70.2 }
const B = { lat: 43.7, lon: -70.1 }

beforeEach(() => {
  useStore.getState().clearCourse()
  resetMarkHistory()
  clock = 0
})

describe('undo and redo for the marks', () => {
  it('takes back and puts back each change, one at a time', () => {
    const s = useStore.getState()
    clock = 10_000
    s.addMark('One', A)
    clock = 20_000
    s.addMark('Two', B)
    clock = 30_000
    s.removeMark(useStore.getState().course.marks[0].id)
    expect(names()).toEqual(['Two'])
    expect(useMarkHistory.getState()).toEqual({ canUndo: true, canRedo: false })
    expect(undoMarks()).toBe(true)
    expect(names()).toEqual(['One', 'Two'])
    undoMarks()
    expect(names()).toEqual(['One'])
    expect(useMarkHistory.getState().canRedo).toBe(true)
    redoMarks()
    redoMarks()
    expect(names()).toEqual(['Two'])
    expect(redoMarks()).toBe(false)
  })

  it('counts typing into the same mark as one change', () => {
    const s = useStore.getState()
    clock = 10_000
    s.addMark('Windward', A)
    const id = useStore.getState().course.marks[0].id
    clock = 20_000
    for (const [i, n] of ['W', 'Wi', 'Win', 'Wind'].entries()) {
      clock = 20_000 + i * 200
      s.updateMark(id, { name: n })
    }
    expect(names()).toEqual(['Wind'])
    undoMarks()
    expect(names()).toEqual(['Windward'])
    undoMarks()
    expect(names()).toEqual([])
  })

  it('forgets what could be redone once a new change is made', () => {
    const s = useStore.getState()
    clock = 10_000
    s.addMark('One', A)
    undoMarks()
    clock = 20_000
    s.addMark('Other', B)
    expect(useMarkHistory.getState().canRedo).toBe(false)
    expect(names()).toEqual(['Other'])
  })
})

describe('locked marks', () => {
  it('neither move nor go until unlocked, though they can be renamed', () => {
    const s = useStore.getState()
    s.addMark('Pin', A)
    const id = useStore.getState().course.marks[0].id
    s.updateMark(id, { locked: true })
    s.updateMark(id, { position: B })
    expect(useStore.getState().course.marks[0].position).toEqual(A)
    s.updateMark(id, { name: 'Pin end', position: B })
    expect(useStore.getState().course.marks[0]).toMatchObject({ name: 'Pin end', position: A })
    s.removeMark(id)
    expect(names()).toEqual(['Pin end'])
    s.updateMark(id, { locked: false })
    s.updateMark(id, { position: B })
    expect(useStore.getState().course.marks[0].position).toEqual(B)
    s.removeMark(id)
    expect(names()).toEqual([])
  })
})

describe('inserting a mark', () => {
  it('keeps the active mark the same one, unless the new one is to be sailed to next', () => {
    const s = useStore.getState()
    s.addMark('One', A)
    s.addMark('Two', B)
    s.setActiveMark(1)
    s.insertMark('Between', { lat: 43.65, lon: -70.15 }, 1)
    expect(names()).toEqual(['One', 'Between', 'Two'])
    expect(useStore.getState().activeMarkIndex).toBe(2)
    s.insertMark('Go here', { lat: 43.66, lon: -70.16 }, 2, true)
    expect(names()).toEqual(['One', 'Between', 'Go here', 'Two'])
    expect(useStore.getState().activeMarkIndex).toBe(2)
    s.insertMark('Last', B, 99)
    expect(names().at(-1)).toBe('Last')
  })
})

describe('pairing marks into a gate', () => {
  it('makes one gate between them, its buoys left and right looking upwind', () => {
    const s = useStore.getState()
    // Two buoys 0.1 nm apart east and west; the wind from the north.
    const west = { lat: 43.6, lon: -70.202 }
    const east = { lat: 43.6, lon: -70.198 }
    s.addMark('Windward', { lat: 43.7, lon: -70.2 })
    s.addMark('Gate W', west)
    s.addMark('Gate E', east)
    s.setActiveMark(2)
    const [, w, e] = useStore.getState().course.marks
    s.makeGate(w.id, e.id, 0)
    const m = useStore.getState().course.marks
    expect(m.map((x) => x.name)).toEqual(['Windward', 'Gate W'])
    const g = m[1]
    // Looking north, west is on the left.
    expect(g.gate!.left).toEqual(west)
    expect(g.gate!.right).toEqual(east)
    expect(g.gate!.widthM).toBeCloseTo(322, -1)
    expect(g.position.lon).toBeCloseTo(-70.2, 9)
    expect(g.roundTo).toBe('either')
    // The active mark was the one that went into the gate: it is the gate now.
    expect(useStore.getState().activeMarkIndex).toBe(1)
    // Looking south, it is the other way round.
    undoMarks()
    s.makeGate(w.id, e.id, 180)
    expect(useStore.getState().course.marks[1].gate!.left).toEqual(east)
  })
})
