/**
 * The user configuration as one file: Expedition's "Save / Load user
 * configuration", which exists so one computer can sail different boats, or plan
 * ashore for someone else's.
 *
 * Only what a person configured goes in: boat, polar, course, settings, routing
 * options and layouts. Live sensor state, routes and the track never do. Reading
 * is strict about the envelope and forgiving inside it: a field the file lacks
 * keeps its current value, exactly as a reload does (mergePersistedState).
 */

import type { Boat, Course, PolarTable } from '@/lib/types'
import type { RouteSettings } from '@/lib/routing/settings'
import type { NumberBox, Settings, PanelTab, ChartTab } from '@/state/store'

export const CONFIG_FORMAT = 'newjourney-config'
export const CONFIG_VERSION = 1

export interface ConfigFile {
  format: typeof CONFIG_FORMAT
  version: number
  exportedAt: string
  boat: Boat
  polarId: string
  /** Only for an imported polar: a built-in one reloads from the library by id. */
  polar: PolarTable | null
  course: Course
  settings: Settings
  routeSettings: RouteSettings
  numberBoxes: NumberBox[]
  manualWind: { twd: number; tws: number }
  navPanel: PanelTab
  navChart: ChartTab
}

type ConfigSource = Omit<ConfigFile, 'format' | 'version' | 'exportedAt'>

export function exportConfig(s: ConfigSource, now = new Date()): ConfigFile {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: now.toISOString(),
    boat: s.boat,
    polarId: s.polarId,
    polar: s.polarId === 'custom' ? s.polar : null,
    course: s.course,
    settings: s.settings,
    routeSettings: s.routeSettings,
    numberBoxes: s.numberBoxes,
    manualWind: s.manualWind,
    navPanel: s.navPanel,
    navChart: s.navChart,
  }
}

export class ConfigError extends Error {}

/** Parse a configuration file. Throws ConfigError, with a reason a person can read. */
export function parseConfig(text: string): Partial<ConfigSource> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ConfigError('This is not a configuration file: it is not JSON.')
  }
  if (!raw || typeof raw !== 'object') throw new ConfigError('This is not a configuration file.')
  const o = raw as Record<string, unknown>
  if (o.format !== CONFIG_FORMAT) {
    throw new ConfigError('This is not a newjourney configuration file.')
  }
  if (typeof o.version !== 'number' || o.version > CONFIG_VERSION) {
    throw new ConfigError('This configuration was saved by a newer version. Update the app first.')
  }
  const out: Partial<ConfigSource> = {}
  const obj = (k: string) => (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : undefined)
  if (obj('boat')) out.boat = o.boat as Boat
  if (typeof o.polarId === 'string') out.polarId = o.polarId
  if (o.polar === null || obj('polar')) out.polar = (o.polar as PolarTable | null) ?? null
  if (obj('course')) out.course = o.course as Course
  if (obj('settings')) out.settings = o.settings as Settings
  if (obj('routeSettings')) out.routeSettings = o.routeSettings as RouteSettings
  if (Array.isArray(o.numberBoxes)) out.numberBoxes = o.numberBoxes as NumberBox[]
  if (obj('manualWind')) out.manualWind = o.manualWind as ConfigSource['manualWind']
  if (o.navPanel === 'start' || o.navPanel === 'race' || o.navPanel === 'setup') out.navPanel = o.navPanel
  if (o.navChart === 'route' || o.navChart === 'weather') out.navChart = o.navChart
  return out
}
