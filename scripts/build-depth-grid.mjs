/**
 * Build the venue bathymetry asset: `public/venue/portland-depth.bin`.
 *
 *   node scripts/build-depth-grid.mjs
 *
 * Fetches a GEBCO_2020 subset from NOAA CoastWatch ERDDAP as CSV and packs it
 * into a raw Int16 grid, decimetres of elevation above mean sea level, positive
 * up, row-major, rows south-to-north and columns west-to-east — the same axis
 * order as `WeatherCube` and as the land mask, so one mental model covers all
 * three.
 *
 * Committed rather than run once and forgotten, because the asset is a
 * derivative of someone else's data and provenance has to be reproducible: this
 * file *is* the recipe. See src/data/bathymetry.ts for what consumes it and
 * docs/02-data-sources/charts-and-bathymetry.md §5 for why GEBCO and what it may
 * and may not be used for.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Deliberately the land mask's box, not the venue's forecast box.
 *
 * The forecast bbox in venues.ts is padded at fetch time and a depth layer that
 * stopped short of the visible chart edge would read as "no data here" over real
 * water. Matching the land mask also means the two venue assets agree on their
 * own extent, which makes them checkable against each other.
 */
const BOX = { west: -70.55, south: 43.38, east: -69.8, north: 43.95 }

const DATASET = 'GEBCO_2020'
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap'

/** Int16 decimetres, so the representable range is ±3276.7 m. */
const DM_LIMIT = 3276
const MISSING = -32768

const url =
  `${ERDDAP}/${DATASET}.csv?elevation` +
  `%5B(${BOX.south}):(${BOX.north})%5D%5B(${BOX.west}):(${BOX.east})%5D`

console.log(`fetching ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`ERDDAP ${res.status} ${res.statusText}`)
const csv = await res.text()

// Two header lines: column names, then units.
const lines = csv.split('\n')
if (!lines[0].startsWith('latitude,longitude,elevation')) {
  throw new Error(`unexpected columns: ${lines[0]}`)
}
if (!lines[1].includes('degrees_north') || !lines[1].trim().endsWith('m')) {
  throw new Error(`unexpected units: ${lines[1]}`)
}

/** Distinct axis values, in the order ERDDAP emitted them (both ascending). */
const lats = []
const lons = []
const seenLat = new Set()
const seenLon = new Set()
const rows = []
for (let i = 2; i < lines.length; i++) {
  const line = lines[i].trim()
  if (!line) continue
  const [latS, lonS, elevS] = line.split(',')
  const lat = Number(latS)
  const lon = Number(lonS)
  // A blank elevation is ERDDAP's rendering of the fill value.
  const elev = elevS === '' || elevS === 'NaN' ? NaN : Number(elevS)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`bad row: ${line}`)
  if (!seenLat.has(lat)) {
    seenLat.add(lat)
    lats.push(lat)
  }
  if (!seenLon.has(lon)) {
    seenLon.add(lon)
    lons.push(lon)
  }
  rows.push({ lat, lon, elev })
}

const ny = lats.length
const nx = lons.length
if (rows.length !== nx * ny) {
  throw new Error(`got ${rows.length} rows, expected ${nx} x ${ny} = ${nx * ny}`)
}
for (const [name, axis] of [['lat', lats], ['lon', lons]]) {
  for (let i = 1; i < axis.length; i++) {
    if (axis[i] <= axis[i - 1]) throw new Error(`${name} axis is not ascending at ${i}`)
  }
}

// One cell size for both axes, as the grid is a regular 15 arc-second lattice.
const dLat = (lats[ny - 1] - lats[0]) / (ny - 1)
const dLon = (lons[nx - 1] - lons[0]) / (nx - 1)
if (Math.abs(dLat - dLon) > 1e-9) {
  throw new Error(`non-square cells: dLat ${dLat}, dLon ${dLon}`)
}

const latIndex = new Map(lats.map((v, i) => [v, i]))
const lonIndex = new Map(lons.map((v, i) => [v, i]))

const grid = new Int16Array(nx * ny)
grid.fill(MISSING)
let water = 0
let minElev = Infinity
let maxElev = -Infinity
for (const { lat, lon, elev } of rows) {
  const j = latIndex.get(lat)
  const i = lonIndex.get(lon)
  const at = j * nx + i
  if (!Number.isFinite(elev)) continue
  if (Math.abs(elev) > DM_LIMIT) {
    // Refuse rather than wrap an Int16 and ship a shoal where a trench is.
    throw new Error(`elevation ${elev} m exceeds the ±${DM_LIMIT} m encoding limit`)
  }
  grid[at] = Math.round(elev * 10)
  if (elev < minElev) minElev = elev
  if (elev > maxElev) maxElev = elev
  if (elev < 0) water++
}

const out = resolve(HERE, '..', 'public', 'venue', 'portland-depth.bin')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength))

const waterFraction = water / (nx * ny)
console.log(`wrote ${out} — ${grid.byteLength} bytes`)
console.log(`
export const PORTLAND_DEPTH_GRID: DepthGridMeta = {
  bbox: { west: ${lons[0]}, south: ${lats[0]}, east: ${lons[nx - 1]}, north: ${lats[ny - 1]} },
  nx: ${nx},
  ny: ${ny},
  cellDeg: ${dLat},
  waterFraction: ${waterFraction.toFixed(4)},
  url: './venue/portland-depth.bin',
  attribution: 'Bathymetry: GEBCO 2020 Grid (GEBCO Compilation Group)',
}
`)
console.log(`elevation range ${minElev} .. ${maxElev} m`)
console.log(`deepest water ${-minElev} m; water cells ${water} / ${nx * ny}`)
