/**
 * Contour lines of a forecast field: isobars, isotachs, rain.
 *
 * Marching squares on the cube's own grid at the displayed time (linear between
 * steps), with each cell's saddle settled by its centre value, and the segments
 * joined into lines so a label has somewhere to sit. A cell with a missing
 * corner draws nothing: a contour across a hole in the data would be invented.
 */
import type { WeatherCube } from '@/lib/types'

export interface ContourSpec {
  /** Distance between levels, in the field's units. */
  step: number
  /** One level drawn bold, or null. */
  bold: number | null
}

/** What a contour is drawn of: one parameter, or the speed of a u/v pair. */
export type ContourField = { param: string } | { speedOf: [string, string] }

/** The field on the grid at time `t`, linear between steps. NaN where there is no data. */
export function fieldAt(cube: WeatherCube, what: ContourField, t: number): Float32Array | null {
  const n = cube.nx * cube.ny
  const gt = cube.nt > 1 && cube.dtMs > 0 ? Math.min(cube.nt - 1, Math.max(0, (t - cube.t0) / cube.dtMs)) : 0
  const k0 = Math.min(cube.nt - 1, Math.floor(gt))
  const k1 = Math.min(cube.nt - 1, k0 + 1)
  const f = gt - k0
  const plane = (p: string, i: number): number => {
    const a = cube.data[p]
    const v0 = a[k0 * n + i]
    return f > 0 ? v0 + (a[k1 * n + i] - v0) * f : v0
  }
  const out = new Float32Array(n)
  if ('param' in what) {
    if (!cube.data[what.param]) return null
    for (let i = 0; i < n; i++) out[i] = plane(what.param, i)
  } else {
    const [pu, pv] = what.speedOf
    if (!cube.data[pu] || !cube.data[pv]) return null
    for (let i = 0; i < n; i++) out[i] = Math.hypot(plane(pu, i), plane(pv, i))
  }
  return out
}

/** The levels a step gives across the field's range, lowest first. */
export function contourLevels(values: ArrayLike<number>, step: number, maxLevels = 200): number[] {
  if (!(step > 0)) return []
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (!Number.isFinite(lo)) return []
  const out: number[] = []
  for (let l = Math.ceil(lo / step) * step; l <= hi && out.length < maxLevels; l += step) out.push(Math.round(l / step) * step)
  return out
}

type Pt = [number, number]

/** Segments of one level, in grid coordinates (i along x, j along y). */
function segments(v: ArrayLike<number>, nx: number, ny: number, level: number): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = []
  const at = (i: number, j: number) => v[j * nx + i]
  const lerp = (a: number, b: number) => (level - a) / (b - a)
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // Corners anticlockwise from the bottom left.
      const a = at(i, j)
      const b = at(i + 1, j)
      const c = at(i + 1, j + 1)
      const d = at(i, j + 1)
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) continue
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0)
      if (code === 0 || code === 15) continue
      const bottom: Pt = [i + lerp(a, b), j]
      const right: Pt = [i + 1, j + lerp(b, c)]
      const top: Pt = [i + lerp(d, c), j + 1]
      const left: Pt = [i, j + lerp(a, d)]
      const centreHigh = (a + b + c + d) / 4 >= level
      switch (code) {
        case 1: case 14: segs.push([left, bottom]); break
        case 2: case 13: segs.push([bottom, right]); break
        case 3: case 12: segs.push([left, right]); break
        case 4: case 11: segs.push([right, top]); break
        case 6: case 9: segs.push([bottom, top]); break
        case 7: case 8: segs.push([left, top]); break
        case 5:
          // a and c high: joined through the centre if it is high too.
          if (centreHigh) segs.push([left, top], [bottom, right])
          else segs.push([left, bottom], [right, top])
          break
        case 10:
          if (centreHigh) segs.push([left, bottom], [right, top])
          else segs.push([left, top], [bottom, right])
          break
      }
    }
  }
  return segs
}

/** Join segments that share ends into lines. */
function join(segs: Array<[Pt, Pt]>): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`
  const ends = new Map<string, number[]>()
  segs.forEach(([p, q], s) => {
    for (const e of [key(p), key(q)]) {
      const l = ends.get(e)
      if (l) l.push(s)
      else ends.set(e, [s])
    }
  })
  const used = new Uint8Array(segs.length)
  const lines: Pt[][] = []
  const extend = (line: Pt[], forward: boolean) => {
    for (;;) {
      const tip = forward ? line[line.length - 1] : line[0]
      const next = (ends.get(key(tip)) ?? []).find((s) => !used[s])
      if (next == null) return
      used[next] = 1
      const [p, q] = segs[next]
      const other = key(p) === key(tip) ? q : p
      if (forward) line.push(other)
      else line.unshift(other)
    }
  }
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue
    used[s] = 1
    const line: Pt[] = [segs[s][0], segs[s][1]]
    extend(line, true)
    extend(line, false)
    lines.push(line)
  }
  return lines
}

export interface ContourFeature {
  type: 'Feature'
  properties: { level: number; bold: boolean; label: string; field: string }
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> }
}

/** Contour lines of `what` at time `t`, as GeoJSON in longitude and latitude. */
export function contourFeatures(
  cube: WeatherCube,
  what: ContourField,
  t: number,
  spec: ContourSpec,
  name: string,
  decimals = 0,
): ContourFeature[] {
  const v = fieldAt(cube, what, t)
  if (!v) return []
  const out: ContourFeature[] = []
  for (const level of contourLevels(v, spec.step)) {
    const bold = spec.bold != null && Math.abs(level - spec.bold) < spec.step * 1e-6
    for (const line of join(segments(v, cube.nx, cube.ny, level))) {
      out.push({
        type: 'Feature',
        properties: { level, bold, label: level.toFixed(decimals), field: name },
        geometry: {
          type: 'LineString',
          coordinates: line.map(([gi, gj]) => [cube.bbox.west + gi * cube.dx, cube.bbox.south + gj * cube.dy]),
        },
      })
    }
  }
  return out
}
