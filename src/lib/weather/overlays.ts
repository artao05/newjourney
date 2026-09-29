/** Radar and satellite imagery for the Weather chart. */

/**
 * Radar from RainViewer (free with attribution for non-commercial use, D5), the
 * latest frame; satellite from NASA GIBS, GOES-East GeoColor, the latest image.
 * Both to zoom 7 and stretched past it, which is their real resolution.
 */
export const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json'
export const SAT_TILES =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.jpeg'

/** The newest radar frame in a RainViewer index, as a tile URL and a time. */
export function latestRadar(index: unknown): { tiles: string; time: number } | null {
  const j = index as { host?: string; radar?: { past?: Array<{ time: number; path: string }> } } | null
  const past = j?.radar?.past ?? []
  const last = past[past.length - 1]
  if (!j?.host || !last?.path || !Number.isFinite(last.time)) return null
  return { tiles: `${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`, time: last.time * 1000 }
}
