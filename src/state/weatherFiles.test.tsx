/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { file, gfsGrid, message, over, REF } from '@/lib/weather/fixtures/grib2'
import { OpenGribButton, WeatherFilesSheet } from '@/components/WeatherFiles'
import {
  activeFileCube,
  levelLabel,
  looksLikeGrib,
  openWeatherFiles,
  summariseCatalogue,
  useWeatherFiles,
} from './weatherFiles'

const g = gfsGrid(44, 289, 5, 4, 0.5)
const wind = (h: number) => [
  message({ category: 2, number: 2, levelType: 103, levelValue: 10, forecastH: h, grid: g, values: over(g, () => 5 + h), packing: 'simple' }),
  message({ category: 2, number: 3, levelType: 103, levelValue: 10, forecastH: h, grid: g, values: over(g, () => -2), packing: 'sd2' }),
]
const gribFile = (name: string, bytes: Uint8Array<ArrayBuffer>) => new File([bytes], name, { type: 'application/octet-stream' })

afterEach(() => {
  cleanup()
  useWeatherFiles.getState().clear()
})

describe('opened weather files', () => {
  it('opens several at once, newest first, and ticks the ones that can be used', async () => {
    const good = gribFile('gfs.grb2', file(...wind(0), ...wind(3), message({ category: 3, number: 1, levelType: 101, forecastH: 0, grid: g, values: over(g, () => 101300), packing: 'simple' })))
    const temps = gribFile('t2m.grb2', file(message({ category: 0, number: 0, levelType: 103, levelValue: 2, grid: g, values: over(g, () => 290), packing: 'simple' })))
    const junk = gribFile('notes.grb', new TextEncoder().encode('not a GRIB at all'))
    const out = await openWeatherFiles([good, temps, junk])
    expect(out.map((f) => [f.name, f.enabled, f.error ?? null])).toEqual([
      ['gfs.grb2', true, null],
      ['t2m.grb2', true, null],
      ['notes.grb', false, 'no GRIB messages in this file'],
    ])
    const files = useWeatherFiles.getState().files
    expect(files).toHaveLength(3)
    expect(files[0].cube!.params.sort()).toEqual(['prmsl', 'u10', 'v10'])
    expect(files[0].cube!.nt).toBe(2)
    // Air temperature alone is still something to show.
    expect(files[1].cube!.params).toEqual(['t2m'])
    expect(files[1].catalogue[0].name).toBe('TMP')
  })

  it('shows the newest ticked file, and falls back as files are unticked or removed', async () => {
    await openWeatherFiles([gribFile('old.grb2', file(...wind(0)))])
    await openWeatherFiles([gribFile('new.grb2', file(...wind(6)))])
    const s = () => useWeatherFiles.getState()
    expect(activeFileCube(s().files)?.name).toBe('new.grb2')
    s().setEnabled(s().files[0].id, false)
    expect(activeFileCube(s().files)?.name).toBe('old.grb2')
    s().remove(s().files[1].id)
    expect(activeFileCube(s().files)).toBeNull()
  })

  it('summarises the catalogue by parameter and level', async () => {
    const [f] = await openWeatherFiles([gribFile('gfs.grb2', file(...wind(0), ...wind(3), ...wind(6)))])
    expect(summariseCatalogue(f.catalogue)).toEqual([
      { name: 'UGRD', level: '10 m above ground', steps: 3, from: REF, to: REF + 6 * 3_600_000, grid: '5×4' },
      { name: 'VGRD', level: '10 m above ground', steps: 3, from: REF, to: REF + 6 * 3_600_000, grid: '5×4' },
    ])
    expect([levelLabel(1, 0), levelLabel(101, 0), levelLabel(100, 85000), levelLabel(160, 5), levelLabel(7, 3)]).toEqual([
      'surface',
      'mean sea level',
      '850 hPa',
      '5 m below sea level',
      'level 7/3',
    ])
  })

  it('knows a GRIB file by its name when it is dropped among others', () => {
    expect(['a.grb2', 'b.GRIB', 'c.grb', 'gfs.t06z.pgrb2.0p25.f003', 'saildocs.bin', 'x.grb2.bz2'].map(looksLikeGrib)).toEqual([true, true, true, true, true, true])
    expect(['photo.jpg', 'route.gpx', 'notes.txt'].map(looksLikeGrib)).toEqual([false, false, false])
  })
})

describe('the weather files sheet', () => {
  it('lists each file with what it holds, and ticks, removes and clears', async () => {
    await openWeatherFiles([gribFile('gfs.grb2', file(...wind(0), ...wind(3)))])
    render(<WeatherFilesSheet onClose={() => {}} />)
    const section = screen.getByRole('region', { name: 'GRIB file gfs.grb2' })
    const table = within(section).getByRole('table', { name: 'Parameters in gfs.grb2' })
    expect(within(table).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'ParameterLevelStepsFromTo',
      'UGRD10 m above ground209-29 06:00Z09-29 09:00Z',
      'VGRD10 m above ground209-29 06:00Z09-29 09:00Z',
    ])
    expect(section.textContent).toContain('5×4 at 0.5°')
    const tick = within(section).getByRole('checkbox') as HTMLInputElement
    expect(tick.checked).toBe(true)
    fireEvent.click(tick)
    expect(useWeatherFiles.getState().files[0].enabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove gfs.grb2' }))
    expect(screen.getByText('No files open.')).toBeTruthy()
  })

  it('opens the files picked with the button', async () => {
    render(<OpenGribButton />)
    const input = screen.getByLabelText('GRIB files to open') as HTMLInputElement
    expect(input.multiple).toBe(true)
    await act(async () => {
      fireEvent.change(input, { target: { files: [gribFile('a.grb2', file(...wind(0))), gribFile('b.grb2', file(...wind(3)))] } })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(useWeatherFiles.getState().files.map((f) => f.name)).toEqual(['a.grb2', 'b.grb2'])
  })
})
