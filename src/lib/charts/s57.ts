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
 *
 * Update files (.001, .002, …) change the records, not the features: each
 * record is inserted, deleted or modified (RUIN), a modified one's attributes
 * set or deleted, and runs of its pointers or coordinates inserted, deleted
 * or replaced (FSPC, VRPC, SGCC). So a cell is read into records, its updates
 * applied in sequence, and only then drawn into features.
 */
import { parse8211, type Field, type Value } from './iso8211'

/** Object classes by code: the whole S-57 3.1 catalogue (IHO S-57 Appendix A, chapter 1). */
export const OBJECT_CLASSES: Record<number, string> = {
  1: 'ADMARE', 2: 'AIRARE', 3: 'ACHBRT', 4: 'ACHARE', 5: 'BCNCAR', 6: 'BCNISD', 7: 'BCNLAT', 8: 'BCNSAW', 9: 'BCNSPP', 10: 'BERTHS', 11: 'BRIDGE', 12: 'BUISGL',
  13: 'BUAARE', 14: 'BOYCAR', 15: 'BOYINB', 16: 'BOYISD', 17: 'BOYLAT', 18: 'BOYSAW', 19: 'BOYSPP', 20: 'CBLARE', 21: 'CBLOHD', 22: 'CBLSUB', 23: 'CANALS', 24: 'CANBNK',
  25: 'CTSARE', 26: 'CAUSWY', 27: 'CTNARE', 28: 'CHKPNT', 29: 'CGUSTA', 30: 'COALNE', 31: 'CONZNE', 32: 'COSARE', 33: 'CTRPNT', 34: 'CONVYR', 35: 'CRANES', 36: 'CURENT',
  37: 'CUSZNE', 38: 'DAMCON', 39: 'DAYMAR', 40: 'DWRTCL', 41: 'DWRTPT', 42: 'DEPARE', 43: 'DEPCNT', 44: 'DISMAR', 45: 'DOCARE', 46: 'DRGARE', 47: 'DRYDOC', 48: 'DMPGRD',
  49: 'DYKCON', 50: 'EXEZNE', 51: 'FAIRWY', 52: 'FNCLNE', 53: 'FERYRT', 54: 'FSHZNE', 55: 'FSHFAC', 56: 'FSHGRD', 57: 'FLODOC', 58: 'FOGSIG', 59: 'FORSTC', 60: 'FRPARE',
  61: 'GATCON', 62: 'GRIDRN', 63: 'HRBARE', 64: 'HRBFAC', 65: 'HULKES', 66: 'ICEARE', 67: 'ICNARE', 68: 'ISTZNE', 69: 'LAKARE', 70: 'LAKSHR', 71: 'LNDARE', 72: 'LNDELV',
  73: 'LNDRGN', 74: 'LNDMRK', 75: 'LIGHTS', 76: 'LITFLT', 77: 'LITVES', 78: 'LOCMAG', 79: 'LOKBSN', 80: 'LOGPON', 81: 'MAGVAR', 82: 'MARCUL', 83: 'MIPARE', 84: 'MORFAC',
  85: 'NAVLNE', 86: 'OBSTRN', 87: 'OFSPLF', 88: 'OSPARE', 89: 'OILBAR', 90: 'PILPNT', 91: 'PILBOP', 92: 'PIPARE', 93: 'PIPOHD', 94: 'PIPSOL', 95: 'PONTON', 96: 'PRCARE',
  97: 'PRDARE', 98: 'PYLONS', 99: 'RADLNE', 100: 'RADRNG', 101: 'RADRFL', 102: 'RADSTA', 103: 'RTPBCN', 104: 'RDOCAL', 105: 'RDOSTA', 106: 'RAILWY', 107: 'RAPIDS', 108: 'RCRTCL',
  109: 'RECTRC', 110: 'RCTLPT', 111: 'RSCSTA', 112: 'RESARE', 113: 'RETRFL', 114: 'RIVERS', 115: 'RIVBNK', 116: 'ROADWY', 117: 'RUNWAY', 118: 'SNDWAV', 119: 'SEAARE', 120: 'SPLARE',
  121: 'SBDARE', 122: 'SLCONS', 123: 'SISTAT', 124: 'SISTAW', 125: 'SILTNK', 126: 'SLOTOP', 127: 'SLOGRD', 128: 'SMCFAC', 129: 'SOUNDG', 130: 'SPRING', 131: 'SQUARE', 132: 'STSLNE',
  133: 'SUBTLN', 134: 'SWPARE', 135: 'TESARE', 136: 'TS_PRH', 137: 'TS_PNH', 138: 'TS_PAD', 139: 'TS_TIS', 140: 'T_HMON', 141: 'T_NHMN', 142: 'T_TIMS', 143: 'TIDEWY', 144: 'TOPMAR',
  145: 'TSELNE', 146: 'TSSBND', 147: 'TSSCRS', 148: 'TSSLPT', 149: 'TSSRON', 150: 'TSEZNE', 151: 'TUNNEL', 152: 'TWRTPT', 153: 'UWTROC', 154: 'UNSARE', 155: 'VEGATN', 156: 'WATTUR',
  157: 'WATFAL', 158: 'WEDKLP', 159: 'WRECKS', 160: 'TS_FEB', 300: 'M_ACCY', 301: 'M_CSCL', 302: 'M_COVR', 303: 'M_HDAT', 304: 'M_HOPA', 305: 'M_NPUB', 306: 'M_NSYS', 307: 'M_PROD',
  308: 'M_QUAL', 309: 'M_SDAT', 310: 'M_SREL', 311: 'M_UNIT', 312: 'M_VDAT', 400: 'C_AGGR', 401: 'C_ASSO', 402: 'C_STAC',
}

/** Attributes by code: the whole S-57 3.1 catalogue (Appendix A, chapter 2), national and spatial ones included. */
export const ATTRIBUTES: Record<number, string> = {
  1: 'AGENCY', 2: 'BCNSHP', 3: 'BUISHP', 4: 'BOYSHP', 5: 'BURDEP', 6: 'CALSGN', 7: 'CATAIR', 8: 'CATACH', 9: 'CATBRG', 10: 'CATBUA', 11: 'CATCBL', 12: 'CATCAN',
  13: 'CATCAM', 14: 'CATCHP', 15: 'CATCOA', 16: 'CATCTR', 17: 'CATCON', 18: 'CATCOV', 19: 'CATCRN', 20: 'CATDAM', 21: 'CATDIS', 22: 'CATDOC', 23: 'CATDPG', 24: 'CATFNC',
  25: 'CATFRY', 26: 'CATFIF', 27: 'CATFOG', 28: 'CATFOR', 29: 'CATGAT', 30: 'CATHAF', 31: 'CATHLK', 32: 'CATICE', 33: 'CATINB', 34: 'CATLND', 35: 'CATLMK', 36: 'CATLAM',
  37: 'CATLIT', 38: 'CATMFA', 39: 'CATMPA', 40: 'CATMOR', 41: 'CATNAV', 42: 'CATOBS', 43: 'CATOFP', 44: 'CATOLB', 45: 'CATPLE', 46: 'CATPIL', 47: 'CATPIP', 48: 'CATPRA',
  49: 'CATPYL', 50: 'CATQUA', 51: 'CATRAS', 52: 'CATRTB', 53: 'CATROS', 54: 'CATTRK', 55: 'CATRSC', 56: 'CATREA', 57: 'CATROD', 58: 'CATRUN', 59: 'CATSEA', 60: 'CATSLC',
  61: 'CATSIT', 62: 'CATSIW', 63: 'CATSIL', 64: 'CATSLO', 65: 'CATSCF', 66: 'CATSPM', 67: 'CATTSS', 68: 'CATVEG', 69: 'CATWAT', 70: 'CATWED', 71: 'CATWRK', 72: 'CATZOC',
  73: '$SPACE', 74: '$CHARS', 75: 'COLOUR', 76: 'COLPAT', 77: 'COMCHA', 78: '$CSIZE', 79: 'CPDATE', 80: 'CSCALE', 81: 'CONDTN', 82: 'CONRAD', 83: 'CONVIS', 84: 'CURVEL',
  85: 'DATEND', 86: 'DATSTA', 87: 'DRVAL1', 88: 'DRVAL2', 89: 'DUNITS', 90: 'ELEVAT', 91: 'ESTRNG', 92: 'EXCLIT', 93: 'EXPSOU', 94: 'FUNCTN', 95: 'HEIGHT', 96: 'HUNITS',
  97: 'HORACC', 98: 'HORCLR', 99: 'HORLEN', 100: 'HORWID', 101: 'ICEFAC', 102: 'INFORM', 103: 'JRSDTN', 104: '$JUSTH', 105: '$JUSTV', 106: 'LIFCAP', 107: 'LITCHR', 108: 'LITVIS',
  109: 'MARSYS', 110: 'MLTYLT', 111: 'NATION', 112: 'NATCON', 113: 'NATSUR', 114: 'NATQUA', 115: 'NMDATE', 116: 'OBJNAM', 117: 'ORIENT', 118: 'PEREND', 119: 'PERSTA', 120: 'PICREP',
  121: 'PILDST', 122: 'PRCTRY', 123: 'PRODCT', 124: 'PUBREF', 125: 'QUASOU', 126: 'RADWAL', 127: 'RADIUS', 128: 'RECDAT', 129: 'RECIND', 130: 'RYRMGV', 131: 'RESTRN', 132: 'SCAMAX',
  133: 'SCAMIN', 134: 'SCVAL1', 135: 'SCVAL2', 136: 'SECTR1', 137: 'SECTR2', 138: 'SHIPAM', 139: 'SIGFRQ', 140: 'SIGGEN', 141: 'SIGGRP', 142: 'SIGPER', 143: 'SIGSEQ', 144: 'SOUACC',
  145: 'SDISMX', 146: 'SDISMN', 147: 'SORDAT', 148: 'SORIND', 149: 'STATUS', 150: 'SURATH', 151: 'SUREND', 152: 'SURSTA', 153: 'SURTYP', 154: '$SCALE', 155: '$SCODE', 156: 'TECSOU',
  157: '$TXSTR', 158: 'TXTDSC', 159: 'TS_TSP', 160: 'TS_TSV', 161: 'T_ACWL', 162: 'T_HWLW', 163: 'T_MTOD', 164: 'T_THDF', 165: 'T_TINT', 166: 'T_TSVL', 167: 'T_VAHC', 168: 'TIMEND',
  169: 'TIMSTA', 170: '$TINTS', 171: 'TOPSHP', 172: 'TRAFIC', 173: 'VALACM', 174: 'VALDCO', 175: 'VALLMA', 176: 'VALMAG', 177: 'VALMXR', 178: 'VALNMR', 179: 'VALSOU', 180: 'VERACC',
  181: 'VERCCL', 182: 'VERCLR', 183: 'VERCOP', 184: 'VERCSA', 185: 'VERDAT', 186: 'VERLEN', 187: 'WATLEV', 188: 'CAT_TS', 189: 'PUNITS', 300: 'NINFOM', 301: 'NOBJNM', 302: 'NPLDST',
  303: '$NTXST', 304: 'NTXTDS', 400: 'HORDAT', 401: 'POSACC', 402: 'QUAPOS',
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

export interface EncBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface EncCell {
  name: string
  edition: string
  update: string
  comf: number
  somf: number
  /** Compilation scale, 1:n (DSPM CSCL); 0 when the cell does not say. */
  scale: number
  /** Where the cell's geometry lies; null for a cell with none. */
  bounds: EncBounds | null
  features: EncFeature[]
  counts: Record<string, number>
  warnings: string[]
}

// ------------------------------------------------------------ records

interface VecPointer {
  key: string
  ornt: number
  usag: number
  topi: number
  mask: number
}

/** A vector record as held: coordinates still integers, as updates address them. */
interface VecRecord {
  rver: number
  /** [y, x] or, for a sounding array, [y, x, depth]. */
  coords: number[][]
  sounding: boolean
  pointers: VecPointer[]
}

interface FeatPointer {
  key: string
  ornt: number
  usag: number
  mask: number
}

interface FeatRecord {
  rver: number
  prim: number
  objl: number
  attrs: Array<[number, string]>
  pointers: FeatPointer[]
}

/** A cell's records, before its features are drawn from them: what updates apply to. */
export interface S57Records {
  name: string
  edition: string
  update: string
  comf: number
  somf: number
  scale: number
  vectors: Map<string, VecRecord>
  features: Map<string, FeatRecord>
  warnings: string[]
}

const field = (rec: Field[], tag: string) => rec.find((f) => f.tag === tag)
const n = (v: Value) => (typeof v === 'number' ? v : Number(v))
const keyOf = (b: Value) => {
  if (!(b instanceof Uint8Array) || b.length < 5) return ''
  return `${b[0]}:${b[1] + b[2] * 256 + b[3] * 65536 + b[4] * 16777216}`
}
/** The delete character: an update's attribute value that removes the attribute. */
const DEL = String.fromCharCode(0x7f)

const coordsOf = (rec: Field[]): { coords: number[][]; sounding: boolean } | null => {
  const sg3 = field(rec, 'SG3D')
  if (sg3) return { coords: sg3.groups.map((g) => [n(g.YCOO), n(g.XCOO), n(g.VE3D)]), sounding: true }
  const sg2 = field(rec, 'SG2D')
  if (sg2) return { coords: sg2.groups.map((g) => [n(g.YCOO), n(g.XCOO)]), sounding: false }
  return null
}
const vecPointers = (rec: Field[]): VecPointer[] =>
  (field(rec, 'VRPT')?.groups ?? []).map((g) => ({ key: keyOf(g.NAME), ornt: n(g.ORNT), usag: n(g.USAG), topi: n(g.TOPI), mask: n(g.MASK) }))
const featPointers = (rec: Field[]): FeatPointer[] =>
  (field(rec, 'FSPT')?.groups ?? []).map((g) => ({ key: keyOf(g.NAME), ornt: n(g.ORNT), usag: n(g.USAG), mask: n(g.MASK) }))
const attrsOf = (rec: Field[]): Array<[number, string]> => (field(rec, 'ATTF')?.groups ?? []).map((g) => [n(g.ATTL), String(g.ATVL ?? '')])

/**
 * Insert, delete or modify a run of a record's list, as S-57's update control
 * fields say: 1 inserts before the (1-based) index, 2 deletes the count from
 * it, 3 replaces the count from it.
 */
function splice<T>(list: T[], op: number, index: number, count: number, items: T[]): T[] {
  const at = Math.max(0, index - 1)
  if (op === 1) return [...list.slice(0, at), ...items, ...list.slice(at)]
  if (op === 2) return [...list.slice(0, at), ...list.slice(at + count)]
  if (op === 3) return [...list.slice(0, at), ...items.slice(0, count), ...list.slice(at + count)]
  return list
}

function readDataset(rec: Field[], into: { name: string; edition: string; update: string; comf: number; somf: number; scale: number }) {
  const dsid = field(rec, 'DSID')?.groups[0]
  if (dsid) {
    into.name = String(dsid.DSNM ?? '')
    into.edition = String(dsid.EDTN ?? '')
    into.update = String(dsid.UPDN ?? '')
  }
  const dspm = field(rec, 'DSPM')?.groups[0]
  if (dspm) {
    into.comf = n(dspm.COMF) || into.comf
    into.somf = n(dspm.SOMF) || into.somf
    into.scale = n(dspm.CSCL) || into.scale
  }
}

/** A base cell's (.000) records. */
export function readS57(input: Uint8Array | ArrayBuffer): S57Records {
  const f = parse8211(input)
  const r: S57Records = { name: '', edition: '', update: '', comf: 10_000_000, somf: 10, scale: 0, vectors: new Map(), features: new Map(), warnings: [] }
  let declared: { features: number; vectors: number } | null = null
  for (const rec of f.records) {
    readDataset(rec, r)
    // The cell's own count of its records (DSSI), to check the read against.
    const dssi = field(rec, 'DSSI')?.groups[0]
    if (dssi) declared = { features: n(dssi.NOMR) + n(dssi.NOCR) + n(dssi.NOGR) + n(dssi.NOLR), vectors: n(dssi.NOIN) + n(dssi.NOCN) + n(dssi.NOED) + n(dssi.NOFA) }
    const vrid = field(rec, 'VRID')?.groups[0]
    if (vrid) {
      const c = coordsOf(rec)
      r.vectors.set(`${n(vrid.RCNM)}:${n(vrid.RCID)}`, { rver: n(vrid.RVER), coords: c?.coords ?? [], sounding: c?.sounding ?? false, pointers: vecPointers(rec) })
    }
    const frid = field(rec, 'FRID')?.groups[0]
    if (frid) {
      r.features.set(`${n(frid.RCNM)}:${n(frid.RCID)}`, { rver: n(frid.RVER), prim: n(frid.PRIM), objl: n(frid.OBJL), attrs: attrsOf(rec), pointers: featPointers(rec) })
    }
  }
  if (declared && Number.isFinite(declared.features) && (declared.features !== r.features.size || declared.vectors !== r.vectors.size))
    r.warnings.push(`the cell lists ${declared.features} features and ${declared.vectors} vectors; ${r.features.size} and ${r.vectors.size} were read`)
  return r
}

const stem = (dsnm: string) => dsnm.replace(/\.\d{3}$/, '').toUpperCase()

/**
 * Apply one update file (.001, .002, …) to a cell's records, in place. It
 * must be for the same cell and edition and be the next in sequence; one that
 * is not is left out, with a warning saying why. Returns whether it applied.
 */
export function applyS57Update(base: S57Records, input: Uint8Array | ArrayBuffer): boolean {
  const f = parse8211(input)
  const ds = { name: '', edition: '', update: '', comf: base.comf, somf: base.somf, scale: base.scale }
  for (const rec of f.records) readDataset(rec, ds)
  const upd = Number(ds.update)
  const have = Number(base.update || 0)
  if (stem(ds.name) !== stem(base.name)) {
    base.warnings.push(`update ${ds.name || '(unnamed)'} is for another cell, not ${base.name}`)
    return false
  }
  if (ds.edition && base.edition && ds.edition !== base.edition) {
    base.warnings.push(`update ${ds.update} is for edition ${ds.edition}; this cell is edition ${base.edition}`)
    return false
  }
  if (upd <= have) return false
  if (upd !== have + 1) {
    base.warnings.push(`update ${upd} left out: update ${have + 1} is missing`)
    return false
  }
  for (const rec of f.records) {
    const vrid = field(rec, 'VRID')?.groups[0]
    if (vrid) {
      const key = `${n(vrid.RCNM)}:${n(vrid.RCID)}`
      const ruin = n(vrid.RUIN)
      const v = base.vectors.get(key)
      if (ruin === 1) {
        const c = coordsOf(rec)
        base.vectors.set(key, { rver: n(vrid.RVER), coords: c?.coords ?? [], sounding: c?.sounding ?? false, pointers: vecPointers(rec) })
      } else if (ruin === 2) {
        base.vectors.delete(key)
      } else if (ruin === 3) {
        if (!v) {
          base.warnings.push(`update ${upd}: vector ${key} to modify is not in the cell`)
          continue
        }
        v.rver = n(vrid.RVER)
        const vrpc = field(rec, 'VRPC')?.groups[0]
        if (vrpc) v.pointers = splice(v.pointers, n(vrpc.VPUI), n(vrpc.VPIX), n(vrpc.NVPT), vecPointers(rec))
        const sgcc = field(rec, 'SGCC')?.groups[0]
        if (sgcc) v.coords = splice(v.coords, n(sgcc.CCUI), n(sgcc.CCIX), n(sgcc.CCNC), coordsOf(rec)?.coords ?? [])
      }
    }
    const frid = field(rec, 'FRID')?.groups[0]
    if (frid) {
      const key = `${n(frid.RCNM)}:${n(frid.RCID)}`
      const ruin = n(frid.RUIN)
      const ft = base.features.get(key)
      if (ruin === 1) {
        base.features.set(key, { rver: n(frid.RVER), prim: n(frid.PRIM), objl: n(frid.OBJL), attrs: attrsOf(rec), pointers: featPointers(rec) })
      } else if (ruin === 2) {
        base.features.delete(key)
      } else if (ruin === 3) {
        if (!ft) {
          base.warnings.push(`update ${upd}: feature ${key} to modify is not in the cell`)
          continue
        }
        ft.rver = n(frid.RVER)
        // Attributes listed are set; one set to the delete character goes.
        for (const [code, value] of attrsOf(rec)) {
          ft.attrs = ft.attrs.filter(([c]) => c !== code)
          if (value !== DEL) ft.attrs.push([code, value])
        }
        const fspc = field(rec, 'FSPC')?.groups[0]
        if (fspc) ft.pointers = splice(ft.pointers, n(fspc.FSUI), n(fspc.FSIX), n(fspc.NSPT), featPointers(rec))
      }
    }
  }
  base.update = String(upd)
  return true
}

/** The features, drawn from a cell's records. */
export function assembleS57(r: S57Records): EncCell {
  const { comf, somf } = r
  const warnings = [...r.warnings]
  const lonlat = (c: number[]): [number, number] => [c[1] / comf, c[0] / comf]
  const firstPoint = (key: string) => {
    const c = r.vectors.get(key)?.coords[0]
    return c ? lonlat(c) : undefined
  }

  /** An edge's points from its beginning node to its end node. */
  const edgeLine = (key: string): Array<[number, number]> | null => {
    const e = r.vectors.get(key)
    if (!e) return null
    const begin = e.pointers.find((p) => p.topi === 1)
    const end = e.pointers.find((p) => p.topi === 2)
    const b = begin ? firstPoint(begin.key) : undefined
    const z = end ? firstPoint(end.key) : undefined
    if (!b || !z) return null
    return [b, ...e.coords.map(lonlat), z]
  }
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12

  const features: EncFeature[] = []
  for (const rec of r.features.values()) {
    const { objl, prim } = rec
    const cls = OBJECT_CLASSES[objl] ?? `OBJL${objl}`
    const attrs: Record<string, string> = {}
    for (const [code, value] of rec.attrs) attrs[ATTRIBUTES[code] ?? `ATTL${code}`] = value
    const ptrs = rec.pointers
    let geometry: Geometry | null = null
    if (prim === 1 && ptrs.length) {
      const v = r.vectors.get(ptrs[0].key)
      if (v?.sounding) geometry = { type: 'MultiPoint', coordinates: v.coords.map((c): [number, number, number] => [c[1] / comf, c[0] / comf, c[2] / somf]) }
      else if (v?.coords[0]) geometry = { type: 'Point', coordinates: lonlat(v.coords[0]) }
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
        const open = parts.filter((ring) => !same(ring[0], ring[ring.length - 1]))
        if (open.length) warnings.push(`${cls}: ${open.length} ring(s) did not close`)
        geometry = { type: 'Polygon', coordinates: parts }
      }
    }
    features.push({ objl, cls, prim, attrs, geometry })
  }
  const counts: Record<string, number> = {}
  for (const x of features) counts[x.cls] = (counts[x.cls] ?? 0) + 1
  return { name: r.name, edition: r.edition, update: r.update, comf, somf, scale: r.scale, bounds: boundsOf(features), features, counts, warnings }
}

function boundsOf(features: EncFeature[]): EncBounds | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  const at = (c: number[]) => {
    west = Math.min(west, c[0]); east = Math.max(east, c[0]); south = Math.min(south, c[1]); north = Math.max(north, c[1])
  }
  for (const f of features) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'Point') at(g.coordinates)
    else if (g.type === 'MultiPoint' || g.type === 'LineString') g.coordinates.forEach(at)
    else g.coordinates.forEach((part) => part.forEach(at))
  }
  return Number.isFinite(west) ? { west, south, east, north } : null
}

/** A base cell and its updates, in any order, into features. */
export function decodeS57(input: Uint8Array | ArrayBuffer, updates: Array<Uint8Array | ArrayBuffer> = []): EncCell {
  const r = readS57(input)
  // Updates go on in their own order, whatever order they came in.
  const ordered = updates
    .map((u) => {
      const f = parse8211(u)
      const ds = { name: '', edition: '', update: '', comf: 0, somf: 0, scale: 0 }
      for (const rec of f.records) readDataset(rec, ds)
      return { u, n: Number(ds.update) }
    })
    .sort((a, b) => a.n - b.n)
  for (const { u } of ordered) applyS57Update(r, u)
  return assembleS57(r)
}
