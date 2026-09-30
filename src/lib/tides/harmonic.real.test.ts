/** The harmonic tide engine against NOAA's own predictions for Portland, ME (8418150), 1–7 October 2026 (fixtures/real). */
import { expect, it } from 'vitest'
import { realText } from '../../realFiles'
import { parseDatums } from './stations'
import { parseHarcon, predictTide } from './harmonic'

it("predicts Portland's tide within a few millimetres of NOAA, hour by hour for a week", () => {
  const constants = parseHarcon(JSON.parse(realText('coops-8418150-harcon.json')))
  const datums = parseDatums(JSON.parse(realText('coops-8418150-datums.json')))
  const noaa = JSON.parse(realText('coops-8418150-predictions-20261001-07.json')).predictions as Array<{ t: string; v: string }>
  expect(constants.length).toBe(37)
  expect(noaa.length).toBe(7 * 24)
  const z0 = datums.MSL - datums.MLLW
  const errors = noaa.map((p) => predictTide(constants, Date.parse(`${p.t.replace(' ', 'T')}:00Z`), z0) - Number(p.v))
  const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length)
  // 2.0 mm RMS and 4.0 mm at worst when this was written, on a range of about 3 m.
  expect(rms).toBeLessThan(0.003)
  expect(Math.max(...errors.map(Math.abs))).toBeLessThan(0.006)
})
