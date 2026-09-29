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
