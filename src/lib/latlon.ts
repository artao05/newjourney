/**
 * Reading a position the way people write one.
 *
 * Sailors copy positions from sailing instructions, chart plotters, VHF calls and
 * race websites, and every source writes them differently:
 *
 *   43.6589, -70.2051                 decimal degrees, signed
 *   43.6589N 70.2051W                 decimal degrees, hemispheres
 *   43 39.534 N, 070 12.306 W         degrees and decimal minutes (the chart plotter's)
 *   43°39.534'N 070°12.306'W          the same, with symbols
 *   43°39'32.0"N 70°12'18.4"W         degrees, minutes, seconds
 *   N 43 39.534 W 070 12.306          hemisphere first
 *
 * parseLatLon reads all of these and returns null, never a guess, for anything it
 * cannot place with certainty: a latitude past 90, minutes of 60 or more, or a
 * hemisphere letter that contradicts a sign.
 */

import type { LatLon } from '@/lib/types'

interface Part {
  value: number
  hemi: 'N' | 'S' | 'E' | 'W' | null
}

/** One coordinate: signed decimal degrees, or D M.m, or D M S, with an optional hemisphere. */
function parsePart(raw: string): Part | null {
  let s = raw.trim().toUpperCase()
  let hemi: Part['hemi'] = null
  const lead = /^([NSEW])\s*/.exec(s)
  const trail = /\s*([NSEW])$/.exec(s)
  if (lead) {
    hemi = lead[1] as Part['hemi']
    s = s.slice(lead[0].length)
  } else if (trail) {
    hemi = trail[1] as Part['hemi']
    s = s.slice(0, s.length - trail[0].length)
  }
  // Symbols become separators: ° ' " ′ ″ and the ASCII d/m/s some sites use.
  s = s.replace(/[°º˚d]/gi, ' ').replace(/[′'m]/gi, ' ').replace(/[″"s]/gi, ' ').trim()
  const nums = s.split(/[\s,]+/).filter(Boolean)
  if (nums.length === 0 || nums.length > 3) return null
  if (!nums.every((n) => /^[+-]?\d+(\.\d+)?$/.test(n))) return null
  const [d, m = '0', sec = '0'] = nums
  const deg = Number(d)
  const min = Number(m)
  const secs = Number(sec)
  // Only the degrees may carry a sign or a fraction when minutes follow.
  if (nums.length > 1 && (d.includes('.') || /^[+-]?\d+$/.test(d) === false)) return null
  if (nums.length > 1 && (min < 0 || min >= 60 || m.startsWith('-') || m.startsWith('+'))) return null
  if (nums.length > 2 && (secs < 0 || secs >= 60 || m.includes('.'))) return null
  const sign = deg < 0 || d.startsWith('-') ? -1 : 1
  const value = sign * (Math.abs(deg) + min / 60 + secs / 3600)
  if (hemi && sign < 0) return null // "-43 N" contradicts itself
  return { value, hemi }
}

/** Split "A, B" or "A B" into the latitude and longitude halves. */
function halves(input: string): [string, string] | null {
  const s = input.trim()
  if (s.includes(',') && s.split(',').length === 2) {
    const [a, b] = s.split(',')
    return [a, b]
  }
  // Split before the second hemisphere letter when one leads ("N 43 39 W 70 12").
  const leadHemis = /^([NS])\s*([^EW]+)([EW].*)$/i.exec(s)
  if (leadHemis) return [leadHemis[1] + ' ' + leadHemis[2], leadHemis[3]]
  // Split after the first trailing hemisphere letter ("43 39.5 N 70 12.3 W").
  const trailHemi = /^(.*?[NS])\s+(.+)$/i.exec(s)
  if (trailHemi) return [trailHemi[1], trailHemi[2]]
  // Two bare decimal numbers.
  const two = s.split(/\s+/)
  if (two.length === 2) return [two[0], two[1]]
  return null
}

/**
 * One coordinate on its own, as a CSV column holds it: "50 42.69n", "01 35.52w",
 * "-70.2051". A hemisphere letter must suit the axis, and the value its range.
 */
export function parseCoordinate(text: string, axis: 'lat' | 'lon'): number | null {
  const p = parsePart(text)
  if (!p) return null
  const letters = axis === 'lat' ? ['N', 'S'] : ['E', 'W']
  if (p.hemi && !letters.includes(p.hemi)) return null
  const v = p.hemi === 'S' || p.hemi === 'W' ? -p.value : p.value
  return Math.abs(v) <= (axis === 'lat' ? 90 : 180) ? v : null
}

export function parseLatLon(input: string): LatLon | null {
  const h = halves(input)
  if (!h) return null
  const a = parsePart(h[0])
  const b = parsePart(h[1])
  if (!a || !b) return null
  // The latitude is the one marked N/S, or the first when neither is marked.
  let latP = a
  let lonP = b
  if ((a.hemi === 'E' || a.hemi === 'W') && (b.hemi === 'N' || b.hemi === 'S')) {
    latP = b
    lonP = a
  }
  if (latP.hemi === 'E' || latP.hemi === 'W' || lonP.hemi === 'N' || lonP.hemi === 'S') return null
  const lat = latP.hemi === 'S' ? -latP.value : latP.value
  const lon = lonP.hemi === 'W' ? -lonP.value : lonP.value
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null
  return { lat, lon }
}
