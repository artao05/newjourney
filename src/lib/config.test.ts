/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FORMAT, ConfigError, exportConfig, parseConfig } from './config'
import { DEFAULT_NUMBER_BOXES, useStore } from '@/state/store'
import { DEFAULT_ROUTE_SETTINGS } from '@/lib/routing/settings'

const imported = {
  name: 'Tuned',
  tws: [6, 12],
  rows: [
    { twa: [45, 90], bsp: [4, 5.5] },
    { twa: [40, 90], bsp: [5.8, 7] },
  ],
  reference: 'masthead' as const,
}

beforeEach(() => {
  localStorage.clear()
  const s = useStore.getState()
  s.clearCourse()
  s.setPolar('j70', null)
  s.updateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS })
  useStore.setState({ numberBoxes: DEFAULT_NUMBER_BOXES.map((b) => ({ ...b, channels: [...b.channels] })) })
})

describe('the user configuration file', () => {
  it('round-trips everything a person configured', () => {
    const s = useStore.getState()
    s.updateBoat({ name: 'Wildcat', loaMetres: 10.5, mastHeightMetres: 15 })
    s.setPolar('custom', imported)
    s.addMark('W', { lat: 43.7, lon: -70.2 })
    s.updateSettings({ units: 'imperial' })
    s.updateRouteSettings({ windRotateDeg: 8, maxGust: 30 })
    s.updateNumberBox('nb-1', { channels: ['vmg', 'tws'] })
    s.setNav({ navPanel: 'setup', navChart: 'weather' })
    s.setPolarRole('start', 'j105')
    const text = JSON.stringify(exportConfig(useStore.getState()))

    // Somebody else's boat in between.
    s.updateBoat({ name: 'Other', loaMetres: 6 })
    s.setPolar('j70', null)
    s.clearCourse()
    s.updateSettings({ units: 'metric' })
    s.updateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS })
    s.setNav({ navPanel: 'race', navChart: 'route' })
    s.setPolarRole('start', 'navigation')

    s.applyConfig(parseConfig(text))
    const back = useStore.getState()
    expect(back.boat).toMatchObject({ name: 'Wildcat', loaMetres: 10.5, mastHeightMetres: 15 })
    expect(back.polarId).toBe('custom')
    expect(back.polar).toEqual(imported)
    expect(back.course.marks.map((m) => m.name)).toEqual(['W'])
    expect(back.settings.units).toBe('imperial')
    expect(back.routeSettings).toMatchObject({ windRotateDeg: 8, maxGust: 30 })
    expect(back.numberBoxes[0].channels).toEqual(['vmg', 'tws'])
    expect(back).toMatchObject({ navPanel: 'setup', navChart: 'weather' })
    expect(back.polarRoles.start).toBe('j105')
  })

  it('leaves a built-in polar out, since it reloads from the library by id', () => {
    useStore.getState().setPolar('j70', imported)
    expect(exportConfig(useStore.getState()).polar).toBeNull()
  })

  it('refuses a file that is not one, and says why', () => {
    expect(() => parseConfig('not json')).toThrow(ConfigError)
    expect(() => parseConfig('{"hello":1}')).toThrow(/not a newjourney configuration/)
    expect(() => parseConfig(JSON.stringify({ format: CONFIG_FORMAT, version: 99 }))).toThrow(/newer version/)
  })

  it('keeps current values for anything an older file does not mention', () => {
    useStore.getState().updateBoat({ name: 'Keep' })
    useStore.getState().applyConfig(parseConfig(JSON.stringify({ format: CONFIG_FORMAT, version: 1, settings: { units: 'imperial' } })))
    expect(useStore.getState().boat.name).toBe('Keep')
    expect(useStore.getState().settings.units).toBe('imperial')
    // A partial settings object merges: the rest of the settings survive.
    expect(useStore.getState().settings.acceptedNotForNavigation).toBeTypeOf('boolean')
  })
})
