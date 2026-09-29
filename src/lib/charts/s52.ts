/**
 * ENC features ready to draw, in the spirit of S-52 (IHO's presentation
 * library), on the app's dark chart: depth areas shaded by how they stand
 * against the safety depth, the safety contour bold, soundings shallower than
 * it standing out, land, coastline, lights, buoys and dangers. A simplified
 * rendition, not the conformant PresLib: not for navigation.
 */
import type { EncCell, EncFeature } from './s57'

/** Dark-palette depth shades, from drying to deep. */
export const DEPTH_SHADES = { drying: '#2f4a2c', shallow: '#1f5f8b', medium: '#15466a', deep: '#0a2438' } as const
export const LAND = '#3a3426'

/** Buoy and beacon colours by S-57 COLOUR code (the first listed). */
const COLOURS: Record<string, string> = { '1': '#f5f5f5', '2': '#212121', '3': '#e53935', '4': '#43a047', '5': '#1e88e5', '6': '#fdd835', '11': '#fb8c00' }

export interface EncStyleOptions {
  /** Depth the boat needs, metres: anything shallower is a hazard. */
  safetyDepthM: number
  /** The deep contour: deeper than this is shaded as deep water. */
  deepM?: number
}

export interface DrawFeature {
  type: 'Feature'
  properties: Record<string, string | number | boolean>
  geometry: EncFeature['geometry'] & object
}

function depthShade(drval1: number, o: EncStyleOptions): string {
  if (drval1 < 0) return DEPTH_SHADES.drying
  if (drval1 < o.safetyDepthM) return DEPTH_SHADES.shallow
  if (drval1 < (o.deepM ?? Math.max(10, 2 * o.safetyDepthM))) return DEPTH_SHADES.medium
  return DEPTH_SHADES.deep
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
  for (const c of cells) {
    for (const f of c.features) {
      if (!f.geometry) continue
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
        out.push({ type: 'Feature', properties: { layer: 'area', cls: f.cls, color: LAND, order: 1 }, geometry: f.geometry })
      } else if (f.cls === 'DEPCNT') {
        const v = Number(f.attrs.VALDCO)
        out.push({ type: 'Feature', properties: { layer: 'line', cls: f.cls, color: '#6f9dbf', width: v === safety ? 2.4 : 0.8, safety: v === safety }, geometry: f.geometry })
      } else if (f.cls === 'COALNE' || f.cls === 'SLCONS') {
        out.push({ type: 'Feature', properties: { layer: 'line', cls: f.cls, color: '#c8b98a', width: 1.4, safety: false }, geometry: f.geometry })
      } else if (f.prim === 1) {
        const colour = COLOURS[(f.attrs.COLOUR ?? '').split(',')[0]] ?? '#b0bec5'
        const danger = f.cls === 'UWTROC' || f.cls === 'WRECKS' || f.cls === 'OBSTRN'
        out.push({
          type: 'Feature',
          properties: { layer: 'point', cls: f.cls, color: f.cls === 'LIGHTS' ? '#e040fb' : danger ? '#ff5252' : colour, radius: f.cls === 'LIGHTS' ? 3.5 : 5, name },
          geometry: f.geometry,
        })
      }
    }
  }
  return out
}
