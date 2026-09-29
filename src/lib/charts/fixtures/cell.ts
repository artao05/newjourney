/** Test fixture: a tiny S-57 cell built to the layout (see s57.test.ts). */
import { FT, UT, enc, le, name, record, s57Ddr } from './iso8211'

export const COMF = 10_000_000
export const SOMF = 10
const xy = (lat: number, lon: number) => [...le(Math.round(lat * COMF), 4), ...le(Math.round(lon * COMF), 4)]
const id = (n: number): [string, number[]] => ['0001', [...le(n, 2), FT]]
const vrid = (rcnm: number, rcid: number): [string, number[]] => ['VRID', [rcnm, ...le(rcid, 4), ...le(1, 2), 1, FT]]
const vrpt = (...p: Array<[number, number, number]>): [string, number[]] => ['VRPT', [...p.flatMap(([rcnm, rcid, topi]) => [...name(rcnm, rcid), 255, 255, topi, 255]), FT]]
const frid = (rcid: number, prim: number, objl: number): [string, number[]] => ['FRID', [100, ...le(rcid, 4), prim, 1, ...le(objl, 2), ...le(1, 2), 1, FT]]
const fspt = (...p: Array<[number, number, number]>): [string, number[]] => ['FSPT', [...p.flatMap(([rcnm, rcid, ornt]) => [...name(rcnm, rcid), ornt, 1, 255]), FT]]
const attf = (...a: Array<[number, string]>): [string, number[]] => ['ATTF', [...a.flatMap(([code, v]) => [...le(code, 2), ...enc(v), UT]), FT]]

export function cell(): Uint8Array {
  const recs = [
    s57Ddr(),
    record('D', [id(1), ['DSID', [10, ...le(1, 4), 1, 1, ...enc('US5ME11M.000'), UT, ...enc('7'), UT, ...enc('2'), UT, FT]]]),
    record('D', [id(2), ['DSPM', [20, ...le(1, 4), 2, 17, 23, ...le(20000, 4), 1, 1, 1, 1, ...le(COMF, 4), ...le(SOMF, 4), FT]]]),
    // Nodes: an isolated node for the light, a sounding array, two connected nodes.
    record('D', [id(3), vrid(110, 1), ['SG2D', [...xy(43.62, -70.21), FT]]]),
    record('D', [id(4), vrid(110, 2), ['SG3D', [...xy(43.61, -70.2), ...le(123, 4), ...xy(43.6, -70.19), ...le(45, 4), FT]]]),
    record('D', [id(5), vrid(120, 10), ['SG2D', [...xy(43.6, -70.25), FT]]]),
    record('D', [id(6), vrid(120, 11), ['SG2D', [...xy(43.65, -70.25), FT]]]),
    // Edge 20 runs node 10 to node 11; edge 21 goes from node 10 round and back to it.
    record('D', [id(7), vrid(130, 20), vrpt([120, 10, 1], [120, 11, 2]), ['SG2D', [...xy(43.62, -70.26), FT]]]),
    record('D', [id(8), vrid(130, 21), vrpt([120, 10, 1], [120, 10, 2]), ['SG2D', [...xy(43.6, -70.2), ...xy(43.63, -70.2), FT]]]),
    // Features.
    record('D', [id(9), frid(1, 1, 75), attf([75, '3'], [116, 'Portland Head Light']), fspt([110, 1, 255])]),
    record('D', [id(10), frid(2, 1, 129), fspt([110, 2, 255])]),
    record('D', [id(11), frid(3, 2, 30), fspt([130, 20, 2])]),
    record('D', [id(12), frid(4, 3, 42), attf([87, '5'], [88, '10']), fspt([130, 21, 1])]),
    record('D', [id(13), frid(5, 2, 999), fspt([130, 99, 1])]),
  ]
  return new Uint8Array(recs.flat())
}
