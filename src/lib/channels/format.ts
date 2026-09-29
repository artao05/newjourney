/**
 * How a channel's value reads in a number box.
 *
 * One formatter for every channel, keyed on the catalogue's unit, so a bearing
 * looks the same in every box, log header and alarm. Missing values come back as
 * null for the caller to show as a dash. Nothing here invents a zero.
 */

import type { ChannelDef } from './catalogue'
import { fmtClock, fmtDuration, fmtFixed } from '@/components/Tile'
import { lengthUnit, toLength, type Units } from '@/lib/units'

export interface FormattedValue {
  text: string
  unit: string
}

/**
 * Angles that are signed, where the sign carries the side (port or starboard,
 * left or right). Everything else in degrees is a bearing, shown 000-359.
 */
const SIGNED_ANGLE =
  /(^|-)(twa|awa|mwa|heel|leeway|bias-angle|delta|rudder|variation|trim|rake|keel-angle|twist|entry|exit|turn-to-mark|tab|board|deflector|lead)(-|$)/

export function isSignedAngle(id: string): boolean {
  return SIGNED_ANGLE.test(id)
}

/** Degrees and decimal minutes, the way a chart plotter writes a position. */
export function fmtDmm(deg: number, isLon: boolean): string {
  const hemi = isLon ? (deg < 0 ? 'W' : 'E') : deg < 0 ? 'S' : 'N'
  const a = Math.abs(deg)
  let d = Math.floor(a)
  let m = (a - d) * 60
  // Round first, so 59.9996' becomes the next whole degree, not 60.000'.
  if (Math.round(m * 1000) / 1000 >= 60) {
    d += 1
    m = 0
  }
  const dd = String(d).padStart(isLon ? 3 : 2, '0')
  return `${dd}°${m.toFixed(3).padStart(6, '0')}'${hemi}`
}

function speedLike(v: number): string {
  return fmtFixed(v, Math.abs(v) < 10 ? 2 : 1)
}

export function formatChannel(
  def: Pick<ChannelDef, 'id' | 'unit'>,
  value: number | null | undefined,
  units: Units = 'metric',
): FormattedValue | null {
  if (value == null || !Number.isFinite(value)) return null
  switch (def.unit) {
    case 'deg': {
      if (isSignedAngle(def.id)) {
        const r = Math.round(value)
        return { text: r > 0 ? `+${r}` : fmtFixed(r, 0), unit: '°' }
      }
      const r = ((Math.round(value) % 360) + 360) % 360
      return { text: String(r).padStart(3, '0'), unit: '°' }
    }
    case 'deg/s':
      return { text: fmtFixed(value, 1), unit: '°/s' }
    case 'kn':
      return { text: speedLike(value), unit: 'kn' }
    case 'nm':
      return { text: speedLike(value), unit: 'nm' }
    case 'm': {
      const v = toLength(value, units)
      return { text: fmtFixed(v, Math.abs(v) >= 100 ? 0 : 1), unit: lengthUnit(units) }
    }
    case 's':
      return {
        text: (Math.abs(value) < 3600 ? fmtClock(value) : fmtDuration(value)) ?? '—',
        unit: '',
      }
    case 'pct':
      return { text: fmtFixed(value, 0), unit: '%' }
    case 'degC':
      return { text: fmtFixed(value, 1), unit: '°C' }
    case 'hPa':
      return { text: fmtFixed(value, 0), unit: 'hPa' }
    case 'kPa':
      return { text: fmtFixed(value, 0), unit: 'kPa' }
    case 'kg/m3':
      return { text: fmtFixed(value, 3), unit: 'kg/m³' }
    case 'V':
      return { text: fmtFixed(value, 1), unit: 'V' }
    case 'A':
      return { text: fmtFixed(value, 1), unit: 'A' }
    case 'rpm':
      return { text: fmtFixed(value, 0), unit: 'rpm' }
    case 'load':
      return { text: fmtFixed(value, 2), unit: '' }
    case 'latlon':
      return { text: fmtDmm(value, /long/.test(def.id)), unit: '' }
    case 'datetime': {
      const d = new Date(value)
      const two = (n: number) => String(n).padStart(2, '0')
      return { text: `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`, unit: '' }
    }
    default:
      return { text: String(Math.round(value * 100) / 100), unit: '' }
  }
}
