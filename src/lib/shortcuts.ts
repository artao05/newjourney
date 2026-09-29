/**
 * Keyboard shortcuts, following Expedition's where a browser allows it.
 *
 * Expedition: Ctrl-S settings, Ctrl-M marks, Ctrl-P polars, Ctrl-W weather, F2 man
 * overboard, left and right arrows for the previous and next mark, and up and down
 * for the display time (Timeline.tsx has those). A browser keeps Ctrl-W for closing
 * the tab and will not hand it to a page, so weather is Alt-W here. Full screen is
 * Ctrl-Shift-F, since F11 is the browser's own.
 *
 * A pure mapping, so the key table can be tested without a DOM.
 */

export type ShortcutAction =
  | 'settings'
  | 'marks'
  | 'polars'
  | 'weather'
  | 'mob'
  | 'fullscreen'
  | 'nextMark'
  | 'prevMark'

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Keys a form control keeps for itself: typing an M in a mark name is not Ctrl-M. */
const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

export function shortcutFor(e: KeyLike, targetTag?: string | null): ShortcutAction | null {
  if (targetTag && FIELD_TAGS.has(targetTag.toUpperCase())) return null
  const cmd = e.ctrlKey || e.metaKey
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.key === 'F2') return 'mob'
  if (cmd && e.shiftKey && k === 'f') return 'fullscreen'
  if (cmd && !e.shiftKey && !e.altKey) {
    if (k === 's') return 'settings'
    if (k === 'm') return 'marks'
    if (k === 'p') return 'polars'
  }
  if (e.altKey && !cmd && k === 'w') return 'weather'
  if (!cmd && !e.altKey && !e.shiftKey) {
    if (e.key === 'ArrowRight') return 'nextMark'
    if (e.key === 'ArrowLeft') return 'prevMark'
  }
  return null
}

/** The shortcut list as the help text shows it. */
export const SHORTCUT_HELP: Array<[keys: string, does: string]> = [
  ['Ctrl-S', 'Setup'],
  ['Ctrl-M', 'Marks (Race)'],
  ['Ctrl-P', 'Polars (Setup)'],
  ['Alt-W', 'Weather'],
  ['F2', 'Man overboard: a MOB mark at the boat, made active'],
  ['← →', 'Previous and next mark'],
  ['↑ ↓', 'Step the forecast time (Weather)'],
  ['Space', 'Play or pause the forecast (Weather)'],
  ['Ctrl-Shift-F', 'Full-screen chart'],
]
