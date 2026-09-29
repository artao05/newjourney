/**
 * S-57 electronic navigational charts (ENC cells) into features.
 *
 * A cell's vector records hold the geometry: isolated nodes (points and
 * sounding arrays), connected nodes, and edges between two connected nodes
 * with the points along them. Its feature records hold the objects (a depth
 * area, a buoy, a light), each an object class code, attributes by code, and
 * pointers to the vector records it is drawn from: a node for a point, edges
 * in order (each forward or reversed) for a line, and rings of edges for an
 * area. Coordinates are integers over COMF, soundings over SOMF (DSPM).
 */
import { parse8211, type Field, type Value } from './iso8211'

/** Object classes by code, the ones a sailor's chart draws most. */
export const OBJECT_CLASSES: Record<number, string> = {
  4: 'ACHARE', 5: 'BCNCAR', 7: 'BCNLAT', 11: 'BRIDGE', 14: 'BOYCAR', 15: 'BOYINB', 16: 'BOYISD', 17: 'BOYLAT', 18: 'BOYSAW', 19: 'BOYSPP',
  30: 'COALNE', 42: 'DEPARE', 43: 'DEPCNT', 71: 'LNDARE', 74: 'LNDMRK', 75: 'LIGHTS', 86: 'OBSTRN', 112: 'RESARE', 122: 'SLCONS',
  129: 'SOUNDG', 153: 'UWTROC', 159: 'WRECKS', 302: 'M_COVR', 308: 'M_QUAL',
}

/** Attributes by code: the ones the display and the depth checks need. */
export const ATTRIBUTES: Record<number, string> = {
  75: 'COLOUR', 87: 'DRVAL1', 88: 'DRVAL2', 116: 'OBJNAM', 174: 'VALDCO', 179: 'VALSOU',
}

export type Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: Array<[number, number, number]> }
  | { type: 'LineString'; coordinates: Array<[number, number]> }
  | { type: 'MultiLineString'; coordinates: Array<Array<[number, number]>> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }

export interface EncFeature {
  objl: number
  /** The class acronym, or `OBJL<n>` for one not in the table. */
  cls: string
  prim: number
  attrs: Record<string, string>
  geometry: Geometry | null
}

export interface EncCell {
  name: string
  edition: string
  update: string
  comf: number
  somf: number
  features: EncFeature[]
  counts: Record<string, number>
  warnings: string[]
}

interface Vec {
  coords: Array<[number, number]>
  soundings?: Array<[number, number, number]>
  pointers: Array<{ key: string; topi: number }>
}

const field = (rec: Field[], tag: string) => rec.find((f) => f.tag === tag)
const n = (v: Value) => (typeof v === 'number' ? v : Number(v))
const keyOf = (b: Value) => {
  if (!(b instanceof Uint8Array) || b.length < 5) return ''
  return `${b[0]}:${b[1] + b[2] * 256 + b[3] * 65536 + b[4] * 16777216}`
}

export function decodeS57(input: Uint8Array | ArrayBuffer): EncCell {
  const f = parse8211(input)
  const warnings: string[] = []
  let name = ''
  let edition = ''
  let update = ''
  let comf = 10_000_000
  let somf = 10
  const vectors = new Map<string, Vec>()
  const featureRecs: Field[][] = []

  for (const rec of f.records) {
    const dsid = field(rec, 'DSID')?.groups[0]
    if (dsid) {
      name = String(dsid.DSNM ?? '')
      edition = String(dsid.EDTN ?? '')
      update = String(dsid.UPDN ?? '')
    }
    const dspm = field(rec, 'DSPM')?.groups[0]
    if (dspm) {
      comf = n(dspm.COMF) || comf
      somf = n(dspm.SOMF) || somf
    }
    const vrid = field(rec, 'VRID')?.groups[0]
    if (vrid) {
      const key = `${n(vrid.RCNM)}:${n(vrid.RCID)}`
      const v: Vec = { coords: [], pointers: [] }
      for (const g of field(rec, 'SG2D')?.groups ?? []) v.coords.push([n(g.XCOO) / comf, n(g.YCOO) / comf])
      const sg3 = field(rec, 'SG3D')
      if (sg3) v.soundings = sg3.groups.map((g) => [n(g.XCOO) / comf, n(g.YCOO) / comf, n(g.VE3D) / somf])
      for (const g of field(rec, 'VRPT')?.groups ?? []) v.pointers.push({ key: keyOf(g.NAME), topi: n(g.TOPI) })
      vectors.set(key, v)
    }
    if (field(rec, 'FRID')) featureRecs.push(rec)
  }

  /** An edge's points from its beginning node to its end node. */
  const edgeLine = (key: string): Array<[number, number]> | null => {
    const e = vectors.get(key)
    if (!e) return null
    const begin = e.pointers.find((p) => p.topi === 1)
    const end = e.pointers.find((p) => p.topi === 2)
    const b = begin ? vectors.get(begin.key)?.coords[0] : undefined
    const z = end ? vectors.get(end.key)?.coords[0] : undefined
    if (!b || !z) return null
    return [b, ...e.coords, z]
  }
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12

  const features: EncFeature[] = []
  for (const rec of featureRecs) {
    const frid = field(rec, 'FRID')!.groups[0]
    const objl = n(frid.OBJL)
    const prim = n(frid.PRIM)
    const cls = OBJECT_CLASSES[objl] ?? `OBJL${objl}`
    const attrs: Record<string, string> = {}
    for (const g of field(rec, 'ATTF')?.groups ?? []) {
      const code = n(g.ATTL)
      attrs[ATTRIBUTES[code] ?? `ATTL${code}`] = String(g.ATVL ?? '')
    }
    const ptrs = (field(rec, 'FSPT')?.groups ?? []).map((g) => ({ key: keyOf(g.NAME), ornt: n(g.ORNT), usag: n(g.USAG) }))
    let geometry: Geometry | null = null
    if (prim === 1 && ptrs.length) {
      const v = vectors.get(ptrs[0].key)
      if (v?.soundings) geometry = { type: 'MultiPoint', coordinates: v.soundings }
      else if (v?.coords[0]) geometry = { type: 'Point', coordinates: v.coords[0] }
    } else if (prim === 2 || prim === 3) {
      const parts: Array<Array<[number, number]>> = []
      let cur: Array<[number, number]> = []
      for (const p of ptrs) {
        let line = edgeLine(p.key)
        if (!line) {
          warnings.push(`${cls}: an edge it points to is not in the cell`)
          continue
        }
        if (p.ornt === 2) line = [...line].reverse()
        if (cur.length && same(cur[cur.length - 1], line[0])) cur.push(...line.slice(1))
        else {
          if (cur.length) parts.push(cur)
          cur = [...line]
        }
        // An area's ring is done when it closes; the next edge starts another.
        if (prim === 3 && cur.length > 3 && same(cur[0], cur[cur.length - 1])) {
          parts.push(cur)
          cur = []
        }
      }
      if (cur.length) parts.push(cur)
      if (prim === 2) geometry = parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : parts.length ? { type: 'MultiLineString', coordinates: parts } : null
      else if (parts.length) {
        const open = parts.filter((r) => !same(r[0], r[r.length - 1]))
        if (open.length) warnings.push(`${cls}: ${open.length} ring(s) did not close`)
        geometry = { type: 'Polygon', coordinates: parts }
      }
    }
    features.push({ objl, cls, prim, attrs, geometry })
  }
  const counts: Record<string, number> = {}
  for (const x of features) counts[x.cls] = (counts[x.cls] ?? 0) + 1
  return { name, edition, update, comf, somf, features, counts, warnings }
}
