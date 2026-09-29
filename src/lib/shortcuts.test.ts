import { describe, expect, it } from 'vitest'
import { shortcutFor, type KeyLike } from './shortcuts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('keyboard shortcuts', () => {
  it("maps Expedition's keys where the browser lets a page have them", () => {
    expect(shortcutFor(key('s', { ctrlKey: true }))).toBe('settings')
    expect(shortcutFor(key('m', { ctrlKey: true }))).toBe('marks')
    expect(shortcutFor(key('p', { metaKey: true }))).toBe('polars')
    expect(shortcutFor(key('F2'))).toBe('mob')
    expect(shortcutFor(key('ArrowRight'))).toBe('nextMark')
    expect(shortcutFor(key('ArrowLeft'))).toBe('prevMark')
  })

  it('moves weather to Alt-W, because Ctrl-W closes the tab', () => {
    expect(shortcutFor(key('w', { altKey: true }))).toBe('weather')
    expect(shortcutFor(key('w', { ctrlKey: true }))).toBeNull()
  })

  it('takes full screen on Ctrl-Shift-F, and ignores caps lock', () => {
    expect(shortcutFor(key('F', { ctrlKey: true, shiftKey: true }))).toBe('fullscreen')
    expect(shortcutFor(key('S', { ctrlKey: true }))).toBe('settings')
  })

  it('leaves the up and down arrows to the forecast timeline', () => {
    expect(shortcutFor(key('ArrowUp'))).toBeNull()
    expect(shortcutFor(key('ArrowDown'))).toBeNull()
  })

  it('never fires while someone is typing in a field', () => {
    expect(shortcutFor(key('ArrowRight'), 'INPUT')).toBeNull()
    expect(shortcutFor(key('s', { ctrlKey: true }), 'textarea')).toBeNull()
    expect(shortcutFor(key('F2'), 'SELECT')).toBeNull()
    expect(shortcutFor(key('ArrowRight'), 'BUTTON')).toBe('nextMark')
  })

  it('ignores plain letters, so typing on the page does nothing surprising', () => {
    expect(shortcutFor(key('s'))).toBeNull()
    expect(shortcutFor(key('m'))).toBeNull()
  })
})
