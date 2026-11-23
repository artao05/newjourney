/**
 * Forecasts for the wind overlay, the router and the simulator.
 *
 * Two sources, both ending as a WeatherCube read through the engine's CubeField:
 *  - demo: a made-up but physically plausible afternoon sea breeze, so the app
 *    works offline and the simulator always has interesting wind;
 *  - live: Open-Meteo through the engine's fetchWindCube (src/lib/weather).
 *
 * On top of the forecast, the simulator adds short-period oscillations and
 * puffs (`localWind`), the shifts a forecast model is too coarse to show and a
 * racing sailor has to play.
 */
import { CubeField, fetchWindCube } from '@/lib/weather'
import { emptyCubeData, cubeIndex, uvFromWind, windFromUv } from '@/lib/weather/cube'
import type { BBox, LatLon, WeatherCube, WeatherField } from '@/lib/types'

export type ForecastSource = 'demo' | 'live'

export interface Forecast {
  source: ForecastSource
  cube: WeatherCube
  field: WeatherField
  label: string
}

const HOUR = 3_600_000

/** Start of the current hour, so the demo forecast lines up with the clock. */
export function hourFloor(t: number): number {
  return Math.floor(t / HOUR) * HOUR
}

/**
 * A sea breeze: light southerly in the morning building to about 16 kn and
 * veering through the afternoon, with more pressure offshore (east) and a
 * lighter, backed band near the shore (west). Gust ratio 1.3.
 */
export function demoCube(center: LatLon, t0: number, hours = 24): WeatherCube {
  const span = 0.7
  const bbox: BBox = {
    west: center.lon - span * 1.4,
    east: center.lon + span * 1.4,
    south: center.lat - span,
    north: center.lat + span,
  }
  // About 1.2 nm between grid points, fine enough to show pressure lanes on a racecourse.
  const nx = 81
  const ny = 57
  const nt = hours + 1
  const dx = (bbox.east - bbox.west) / (nx - 1)
  const dy = (bbox.north - bbox.south) / (ny - 1)
  const data = emptyCubeData(['u10', 'v10', 'gust'], nt, ny, nx)
  const localHour0 = new Date(t0).getHours()

  for (let it = 0; it < nt; it++) {
    const hour = (localHour0 + it) % 24
    // Sea breeze strength through the day: 0 at night, peaks ~15:00.
    const sb = Math.max(0, Math.sin(((hour - 9) / 10) * Math.PI))
    const base = 5 + 11 * sb
    // Veers from 195 to 230 as the breeze matures, backs again at night.
    const dirBase = 195 + 35 * sb + 6 * Math.sin((it / 7) * Math.PI)
    for (let iy = 0; iy < ny; iy++) {
      const fy = iy / (ny - 1) - 0.5
      for (let ix = 0; ix < nx; ix++) {
        const fx = ix / (nx - 1) - 0.5
        // More wind offshore (east), a lighter band inshore; a gentle wave of
        // pressure that drifts north through the day.
        const lon = bbox.west + ix * dx
        const lat = bbox.south + iy * dy
        // Lanes of pressure a few miles across, drifting slowly with the breeze.
        const lanes =
          0.16 * Math.sin(lon * 95 + lat * 40 + it * 0.45) * Math.cos(lat * 70 - it * 0.3) +
          0.08 * Math.sin(lon * 210 - lat * 160 + it * 0.8)
        const pressure = 1 + 0.4 * fx + 0.12 * Math.sin(fy * 6 + it * 0.35) + lanes
        const speed = Math.max(1.5, base * pressure)
        const dir = dirBase - 9 * fx + 5 * Math.sin(fy * 4 + it * 0.25) + 6 * lanes * 10 * 0.5
        const { u, v } = uvFromWind(speed, dir)
        const k = cubeIndex({ nx, ny } as WeatherCube, ix, iy, it)
        data.u10![k] = u
        data.v10![k] = v
        data.gust![k] = speed * 1.3
      }
    }
  }
  return { model: 'demo-seabreeze', run: new Date(t0).toISOString(), bbox, nx, ny, dx, dy, t0, dtMs: HOUR, nt, params: ['u10', 'v10', 'gust'], data }
}

export function demoForecast(center: LatLon, now = Date.now()): Forecast {
  const cube = demoCube(center, hourFloor(now))
  return { source: 'demo', cube, field: new CubeField(cube, 'Demo sea breeze'), label: 'Demo sea breeze (offline)' }
}

export async function liveForecast(bbox: BBox, signal?: AbortSignal): Promise<Forecast> {
  const cube = await fetchWindCube({ bbox, hours: 48, stepDeg: 0.1, ...(signal ? { signal } : {}) })
  return { source: 'live', cube, field: new CubeField(cube, 'Open-Meteo'), label: `Open-Meteo ${cube.model}` }
}

export interface WindAt {
  twd: number
  tws: number
}

export function forecastWind(f: Forecast, p: LatLon, t: number): WindAt | null {
  const w = f.field.wind(p.lat, p.lon, t)
  if (!w) return null
  const { speed, dir } = windFromUv(w.u, w.v)
  return { twd: dir, tws: speed }
}

/**
 * What the boat actually feels: the forecast plus the shifts and puffs that
 * come and go on a racecourse. Deterministic in (position, time, seed), so
 * every boat in a simulated fleet sails the same wind.
 */
export function localWind(f: Forecast, p: LatLon, t: number, seed = 1): WindAt | null {
  const w = forecastWind(f, p, t)
  if (!w) return null
  const s = t / 1000
  // Oscillating shifts: ~±7 degrees with a period of about 4-6 minutes.
  const osc =
    6 * Math.sin((2 * Math.PI * s) / 290 + seed) + 2.5 * Math.sin((2 * Math.PI * s) / 113 + seed * 2.3)
  // Puffs: patches of pressure that drift downwind (about 1 nm across).
  const puffPhase = (p.lat * 60 * 1.7 + p.lon * 60 * 1.1) * Math.PI - s / 95
  const puff = 1 + 0.12 * Math.sin(puffPhase) * Math.cos(s / 210 + seed)
  return { twd: (w.twd + osc + 360) % 360, tws: Math.max(0.5, w.tws * puff) }
}
