/**
 * Venue land mask — the obstacle data the router needs to avoid land.
 *
 * This is the artefact that unblocks land avoidance. Until it existed the router
 * ran with `avoidLand` effectively disabled, because an OpenStreetMap raster
 * basemap is a picture, not geometry: a chart you can see is not a coastline a
 * router can test against. See docs/07-map-layers/competitor-teardown.md.
 *
 * ## How it was built
 *
 * 857 `natural=coastline` ways for the venue bbox were fetched from OSM via
 * Overpass, every segment was rasterised as a barrier at 0.001° (~111 m), and
 * water was flood-filled inward from a single seed in the open Gulf of Maine.
 * Anything the flood could not reach is land.
 *
 * That approach was chosen over reconstructing closed polygons because OSM
 * coastline needs ring stitching, bbox clipping and the land-on-the-left
 * orientation rule to become polygons, and every one of those steps is a place
 * to introduce a hole that a router would happily sail through. The flood fill
 * needs none of them and fails in the safe direction: a channel narrower than a
 * cell seals up and reads as land, and water the ocean cannot reach reads as
 * land too. For an obstacle mask, over-reporting land is the correct bias.
 *
 * ## Validation
 *
 * Checked against coordinates that are water *by definition* — the NOAA tide
 * station, the NOAA current station and both NDBC buoys in `venues.ts` are
 * physically moored in the water, so a mask that calls any of them land is
 * wrong. All four read as water; three inland towns read as land. Note the
 * venue *centre* reads as land, correctly: it sits on a small island in Casco
 * Bay. It is a map-centring convenience, not a position afloat.
 *
 * ## Licence
 *
 * Derived from OpenStreetMap, so this file and `portland-land.bin` are
 * **ODbL 1.0**, not MIT like the rest of the code. Distributing a derived
 * database triggers share-alike — see
 * docs/02-data-sources/licensing-matrix.md §3.
 */

import { RasterLandMask } from '@/lib/routing/land'
import type { BBox } from '@/lib/types'

export interface LandMaskMeta {
  /** Bit-grid extent. Outside this box the mask reports open water. */
  bbox: BBox
  nx: number
  ny: number
  /** Cell size in degrees, for both axes. */
  cellDeg: number
  /** Fraction of cells flagged as land, for a sanity check after loading. */
  landFraction: number
  url: string
  attribution: string
}

export const PORTLAND_LAND_MASK: LandMaskMeta = {
  bbox: { west: -70.55, south: 43.38, east: -69.8, north: 43.95 },
  nx: 750,
  ny: 570,
  cellDeg: 0.001,
  landFraction: 0.5593,
  // Relative so it resolves under the app's base path when deployed to a subpath.
  url: './venue/portland-land.bin',
  attribution: 'Coastline © OpenStreetMap contributors (ODbL)',
}

/** One bit per cell, so the byte length is fully determined by the grid. */
export function expectedBytes(meta: LandMaskMeta): number {
  return Math.ceil((meta.nx * meta.ny) / 32) * 4
}

export interface LoadedLandMask {
  meta: LandMaskMeta
  bits: Uint32Array
  mask: RasterLandMask
}

let cached: Promise<LoadedLandMask> | null = null

/**
 * Fetch and decode the venue land mask. Cached for the session.
 *
 * Rejects rather than degrading if the payload is the wrong size. A truncated
 * mask would silently read as open water past the truncation point, which is
 * the single most dangerous way this could fail — the router would confidently
 * plot a course across land it believes is sea.
 */
export function loadVenueLandMask(meta: LandMaskMeta = PORTLAND_LAND_MASK): Promise<LoadedLandMask> {
  if (cached) return cached
  cached = (async () => {
    const res = await fetch(meta.url)
    if (!res.ok) throw new Error(`land mask ${meta.url}: HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const want = expectedBytes(meta)
    if (buf.byteLength !== want) {
      throw new Error(`land mask is ${buf.byteLength} bytes, expected ${want}`)
    }
    const bits = new Uint32Array(buf)
    const mask = new RasterLandMask(meta.bbox, meta.nx, meta.ny, bits)
    return { meta, bits, mask }
  })().catch((e) => {
    // Do not cache a failure: a flaky first load should be retryable.
    cached = null
    throw e
  })
  return cached
}

/** Count set bits, to verify a freshly loaded mask matches its metadata. */
export function landFractionOf(bits: Uint32Array, nx: number, ny: number): number {
  let set = 0
  for (let i = 0; i < bits.length; i++) {
    let v = bits[i]
    // Standard SWAR popcount; this runs over ~13k words, not per route step.
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    set += (v * 0x01010101) >>> 24
  }
  return set / (nx * ny)
}
