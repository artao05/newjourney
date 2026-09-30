/**
 * ENC features ready to draw, in the spirit of S-52 (IHO's presentation
 * library), on the app's dark chart: depth areas shaded by how they stand
 * against the safety depth, the safety contour bold, soundings shallower than
 * it standing out, land, coastline, lights, buoys and dangers. A simplified
 * rendition, not the conformant PresLib: not for navigation.
 */
import { destination, distance } from '../geo'
import type { EncCell, EncFeature, EncFeature as Feature } from './s57'
import { symbolFor, symbolKey } from './symbols'

/** Dark-palette depth shades, from drying to deep. */
export const DEPTH_SHADES = { drying: '#2f4a2c', shallow: '#1f5f8b', medium: '#15466a', mediumDeep: '#15466a', deep: '#0a2438' } as const
export const LAND = '#3a3426'

/**
 * The day chart, after S-52's DAY colour table: the shoal water blue and the deep
 * water near white, buff land, grey contours and coast, magenta lights.
 */
export const DAY = {
  shades: { drying: '#9ec8a0', shallow: '#73b6ef', medium: '#98c5f2', mediumDeep: '#bad5e1', deep: '#e8f3f5' },
  land: '#e3d6a4',
  contour: '#7d898c',
  coast: '#525a5c',
  light: '#c545c3',
  danger: '#c62828',
  leg: '#525a5c',
} as const

/** Buoy and beacon colours by S-57 COLOUR code (the first listed). */
const COLOURS: Record<string, string> = { '1': '#f5f5f5', '2': '#212121', '3': '#e53935', '4': '#43a047', '5': '#1e88e5', '6': '#fdd835', '11': '#fb8c00' }

export type DisplayCategory = 'base' | 'standard' | 'all'

/**
 * S-52's display categories: Display Base can never be taken off (coast, the
 * safety contour, dangers); Standard adds the rest a chart shows by default;
 * All ("Other") adds soundings and the lesser detail.
 */
export const CATEGORY: Record<string, DisplayCategory> = {
  COALNE: 'base', SLCONS: 'base', LNDARE: 'base', DEPARE: 'base', UWTROC: 'base', WRECKS: 'base', OBSTRN: 'base',
  DEPCNT: 'standard', LIGHTS: 'standard', BOYLAT: 'standard', BOYCAR: 'standard', BOYSAW: 'standard', BOYSPP: 'standard', BOYISD: 'standard', BOYINB: 'standard',
  BCNLAT: 'standard', BCNCAR: 'standard', BCNISD: 'standard', BCNSAW: 'standard', BCNSPP: 'standard', LITFLT: 'standard', LITVES: 'standard', RESARE: 'standard', ACHARE: 'standard', BRIDGE: 'standard', LNDMRK: 'standard',
  SOUNDG: 'all',
}
const RANK: Record<DisplayCategory, number> = { base: 0, standard: 1, all: 2 }

export interface EncStyleOptions {
  /** Depth the boat needs, metres: anything shallower is a hazard. */
  safetyDepthM: number
  /** Shallow and deep contours for the four-shade scheme. */
  shallowM?: number
  deepM?: number
  /** Two shades only: shallower or deeper than the safety depth. */
  twoShades?: boolean
  /** What is drawn: base, standard (the default) or all. */
  category?: DisplayCategory
  /** The night palette: dimmer everything, for dark adaptation. */
  night?: boolean
  /** The day chart (S-52 DAY), for the app's day palette; else the dark chart. */
  day?: boolean
  /** Light descriptions (Fl(2)G 5s 8m 5M) beside lights. */
  lightText?: boolean
  /** Sector arcs and their limit lines for sectored lights. */
  sectors?: boolean
  /** Sector limit lines out to the light's nominal range, not short stubs. */
  fullLegs?: boolean
  /** Arcs at 20 mm on screen rather than S-52's 25 mm. */
  smallSectors?: boolean
  /** Object names (OBJNAM) beside points. */
  names?: boolean
  /** Hide objects too detailed for the scale shown (SCAMIN). */
  antiClutter?: boolean
  /** The scale shown, 1:n, for anti-clutter and for sizing sector arcs on screen. */
  scale?: number
}

/** S-57 LITCHR codes as charts write them. */
const LITCHR: Record<string, string> = {
  '1': 'F', '2': 'Fl', '3': 'LFl', '4': 'Q', '5': 'VQ', '6': 'UQ', '7': 'Iso', '8': 'Oc', '9': 'IQ', '10': 'IVQ', '11': 'IUQ', '12': 'Mo',
  '13': 'FFl', '14': 'Fl+LFl', '15': 'Oc+Fl', '16': 'FLFl', '17': 'Al.Oc', '18': 'Al.LFl', '19': 'Al.Fl', '20': 'Al.Gr', '25': 'Q+LFl', '26': 'VQ+LFl', '27': 'UQ+LFl', '28': 'Al', '29': 'Al.FFl',
}
const LIGHT_COLOUR: Record<string, string> = { '1': 'W', '3': 'R', '4': 'G', '5': 'Bu', '6': 'Y', '11': 'Or', '13': 'Vi' }

/**
 * A light's description as a chart writes it: character, group, colours,
 * period, height and range, such as "Fl(2)G 5s 8m 5M". Parts not given are
 * left out.
 */
export function lightDescription(a: Record<string, string>): string {
  const ch = LITCHR[(a.LITCHR ?? '').trim()] ?? ''
  const grp = (a.SIGGRP ?? '').trim()
  // A group of one, "(1)" or "()", is not written.
  const group = grp && grp !== '()' && grp !== '(1)' ? (grp.startsWith('(') ? grp : `(${grp})`) : ''
  const colours = (a.COLOUR ?? '').split(',').map((c) => LIGHT_COLOUR[c.trim()] ?? '').join('')
  const num = (v: string | undefined) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  const per = num(a.SIGPER)
  const ht = num(a.HEIGHT)
  const rng = num(a.VALNMR)
  const head = `${ch}${group}${colours && ch ? (group ? '' : ' ') + colours : colours}`.trim()
  return [head, per != null ? `${per}s` : '', ht != null ? `${Math.round(ht)}m` : '', rng != null ? `${rng}M` : ''].filter(Boolean).join(' ')
}

/** A light's sector: its arc and its two limit lines, as lines of [lon, lat], and its colour. */
export function lightSector(f: { attrs: Record<string, string>; geometry: EncFeature['geometry'] }, o: Pick<EncStyleOptions, 'fullLegs' | 'smallSectors' | 'scale'>): { arc: number[][]; legs: number[][][]; colour: string } | null {
  const g = f.geometry
  if (!g || g.type !== 'Point') return null
  const s1 = Number(f.attrs.SECTR1)
  const s2 = Number(f.attrs.SECTR2)
  if (!Number.isFinite(s1) || !Number.isFinite(s2) || f.attrs.SECTR1 === '' || f.attrs.SECTR2 === '') return null
  const at = { lat: g.coordinates[1], lon: g.coordinates[0] }
  // Sector bearings are from seaward toward the light; from the light they point the other way.
  const from = (s1 + 180) % 360
  let to = (s2 + 180) % 360
  if (to <= from) to += 360
  // S-52 draws the arc 25 mm out on screen (20 small): that many metres at the scale shown.
  const radiusNm = (((o.smallSectors ? 20 : 25) / 1000) * (o.scale ?? 20000)) / 1852
  const arc: number[][] = []
  const n = Math.max(4, Math.ceil((to - from) / 5))
  for (let i = 0; i <= n; i++) {
    const p = destination(at, from + ((to - from) * i) / n, radiusNm)
    arc.push([p.lon, p.lat])
  }
  const range = Number(f.attrs.VALNMR)
  const legNm = o.fullLegs && Number.isFinite(range) && range > 0 ? range : radiusNm * 1.6
  const legs = [from, to].map((b) => {
    const p = destination(at, b, legNm)
    return [g.coordinates, [p.lon, p.lat]]
  })
  const c = (f.attrs.COLOUR ?? '').split(',')[0]
  return { arc, legs, colour: c === '3' ? '#ff5252' : c === '4' ? '#43a047' : '#fdd835' }
}

/** The chart scale 1:n shown at a MapLibre zoom (512-pixel tiles) and latitude, at 96 dpi. */
export function scaleAtZoom(zoom: number, lat: number): number {
  return (78271.51696 * Math.cos((lat * Math.PI) / 180) * 96) / 0.0254 / 2 ** zoom
}

export interface DrawFeature {
  type: 'Feature'
  properties: Record<string, string | number | boolean>
  geometry: EncFeature['geometry'] & object
}

function depthShade(drval1: number, o: EncStyleOptions): string {
  const S = o.day ? DAY.shades : DEPTH_SHADES
  if (drval1 < 0) return S.drying
  if (o.twoShades) return drval1 < o.safetyDepthM ? S.shallow : S.deep
  if (drval1 < Math.min(o.shallowM ?? o.safetyDepthM, o.safetyDepthM)) return S.shallow
  if (drval1 < o.safetyDepthM) return S.medium
  if (drval1 < (o.deepM ?? Math.max(10, 2 * o.safetyDepthM))) return S.mediumDeep
  return S.deep
}

/** The night palette: each colour at a third of its brightness. */
export function dim(hex: string): string {
  const v = parseInt(hex.slice(1), 16)
  const c = (sh: number) => Math.round(((v >> sh) & 255) * 0.35).toString(16).padStart(2, '0')
  return `#${c(16)}${c(8)}${c(0)}`
}

/**
 * Every drawable feature of the cells, with a `layer` property saying how to
 * draw it: area, line, point, or sounding. Soundings come one to a feature,
 * each with its depth and whether it is shallower than the safety depth.
 */
export function encDrawFeatures(cells: EncCell[], o: EncStyleOptions): DrawFeature[] {
  const out: DrawFeature[] = []
  // The safety contour: the shallowest contour at or deeper than the safety depth.
  const contours = cells.flatMap((c) => c.features.filter((f) => f.cls === 'DEPCNT').map((f) => Number(f.attrs.VALDCO))).filter(Number.isFinite)
  const safety = contours.filter((v) => v >= o.safetyDepthM).sort((a, b) => a - b)[0]
  const show = RANK[o.category ?? 'standard']
  for (const c of cells) {
    for (const f of c.features) {
      if (!f.geometry) continue
      // Anything not in the table counts as Other; Display Base is always drawn.
      if (RANK[CATEGORY[f.cls] ?? 'all'] > show) continue
      // Anti-clutter: an object whose SCAMIN is smaller than the scale shown waits for a closer zoom.
      if (o.antiClutter && o.scale && CATEGORY[f.cls] !== 'base') {
        const scamin = Number(f.attrs.SCAMIN)
        if (Number.isFinite(scamin) && scamin > 0 && o.scale > scamin) continue
      }
      if (f.cls === 'SOUNDG' && f.geometry.type === 'MultiPoint') {
        for (const [lon, lat, d] of f.geometry.coordinates) {
          out.push({ type: 'Feature', properties: { layer: 'sounding', depth: Math.round(d * 10) / 10, label: d < 31 ? d.toFixed(1).replace(/\.0$/, '') : String(Math.round(d)), shallow: d < o.safetyDepthM }, geometry: { type: 'Point', coordinates: [lon, lat] } })
        }
        continue
      }
      const name = f.attrs.OBJNAM ?? ''
      if (f.cls === 'DEPARE') {
        const d1 = Number(f.attrs.DRVAL1 ?? 0)
        out.push({ type: 'Feature', properties: { layer: 'area', cls: f.cls, color: depthShade(Number.isFinite(d1) ? d1 : 0, o), order: 0 }, geometry: f.geometry })
      } else if (f.cls === 'LNDARE') {
        out.push({ type: 'Feature', properties: { layer: 'area', cls: f.cls, color: o.day ? DAY.land : LAND, order: 1 }, geometry: f.geometry })
      } else if (f.cls === 'DEPCNT') {
        const v = Number(f.attrs.VALDCO)
        out.push({ type: 'Feature', properties: { layer: 'line', cls: f.cls, color: o.day ? DAY.contour : '#6f9dbf', width: v === safety ? 2.4 : 0.8, safety: v === safety }, geometry: f.geometry })
      } else if (f.cls === 'COALNE' || f.cls === 'SLCONS') {
        out.push({ type: 'Feature', properties: { layer: 'line', cls: f.cls, color: o.day ? DAY.coast : '#c8b98a', width: 1.4, safety: false }, geometry: f.geometry })
      } else if (f.prim === 1) {
        const colour = COLOURS[(f.attrs.COLOUR ?? '').split(',')[0]] ?? '#b0bec5'
        const danger = f.cls === 'UWTROC' || f.cls === 'WRECKS' || f.cls === 'OBSTRN'
        // A symbol where there is one; the dot for the rest.
        const sym = symbolFor(f, o.night)
        out.push({
          type: 'Feature',
          properties: { layer: 'point', cls: f.cls, color: f.cls === 'LIGHTS' ? (o.day ? DAY.light : '#e040fb') : danger ? (o.day ? DAY.danger : '#ff5252') : colour, radius: f.cls === 'LIGHTS' ? 3.5 : 5, name, ...(sym ? { icon: symbolKey(sym) } : {}) },
          geometry: f.geometry,
        })
        // Text: a light's description, and other objects' names, each group on its own switch.
        const text = f.cls === 'LIGHTS' ? (o.lightText ? lightDescription(f.attrs) : '') : o.names ? name : ''
        if (text) out.push({ type: 'Feature', properties: { layer: 'text', group: f.cls === 'LIGHTS' ? 'light' : 'name', label: text }, geometry: f.geometry })
        if (f.cls === 'LIGHTS' && o.sectors) {
          const sec = lightSector(f, o)
          if (sec) {
            out.push({ type: 'Feature', properties: { layer: 'sector', color: sec.colour, part: 'arc' }, geometry: { type: 'LineString', coordinates: sec.arc as Array<[number, number]> } })
            for (const leg of sec.legs) out.push({ type: 'Feature', properties: { layer: 'sector', color: o.day ? DAY.leg : '#b0bec5', part: 'leg' }, geometry: { type: 'LineString', coordinates: leg as Array<[number, number]> } })
          }
        }
      }
    }
  }
  if (o.night) for (const x of out) if (typeof x.properties.color === 'string') x.properties.color = dim(x.properties.color)
  return out
}

// ---------------------------------------------------------- object query


function inRing(ring: Array<[number, number]>, lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function nearLine(line: Array<[number, number]>, at: { lat: number; lon: number }, nm: number): boolean {
  for (let i = 1; i < line.length; i++) {
    // Sampled along each segment: exact enough at a tap's tolerance.
    const [x0, y0] = line[i - 1]
    const [x1, y1] = line[i]
    for (let k = 0; k <= 10; k++) if (distance(at, { lat: y0 + ((y1 - y0) * k) / 10, lon: x0 + ((x1 - x0) * k) / 10 }) <= nm) return true
  }
  return false
}

/** The chart objects at a point: areas it lies in, and lines and points within `toleranceNm`. */
export function encObjectsAt(cells: EncCell[], at: { lat: number; lon: number }, toleranceNm = 0.05): Array<Feature & { cell: string }> {
  const out: Array<Feature & { cell: string }> = []
  for (const c of cells) {
    for (const f of c.features) {
      const g = f.geometry
      if (!g) continue
      let hit = false
      if (g.type === 'Polygon') hit = inRing(g.coordinates[0], at.lon, at.lat) && !g.coordinates.slice(1).some((r) => inRing(r, at.lon, at.lat))
      else if (g.type === 'LineString') hit = nearLine(g.coordinates, at, toleranceNm)
      else if (g.type === 'MultiLineString') hit = g.coordinates.some((l) => nearLine(l, at, toleranceNm))
      else if (g.type === 'Point') hit = distance(at, { lat: g.coordinates[1], lon: g.coordinates[0] }) <= toleranceNm
      else if (g.type === 'MultiPoint') hit = g.coordinates.some(([lon, lat]) => distance(at, { lat, lon }) <= toleranceNm)
      if (hit) out.push({ ...f, cell: c.name })
    }
  }
  // Points and lines first, then the areas they sit in.
  const rank = (f: Feature) => (f.prim === 1 ? 0 : f.prim === 2 ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b))
}
