/** Test fixture: a tiny S-57 cell built to the layout (see s57.test.ts). */
import { FT, UT, enc, le, name, record, s57Ddr } from './iso8211'

export const COMF = 10_000_000
export const SOMF = 10
const xy = (lat: number, lon: number) => [...le(Math.round(lat * COMF), 4), ...le(Math.round(lon * COMF), 4)]
const id = (n: number): [string, number[]] => ['0001', [...le(n, 2), FT]]
const vrid = (rcnm: number, rcid: number, ruin = 1, rver = 1): [string, number[]] => ['VRID', [rcnm, ...le(rcid, 4), ...le(rver, 2), ruin, FT]]
const vrpt = (...p: Array<[number, number, number]>): [string, number[]] => ['VRPT', [...p.flatMap(([rcnm, rcid, topi]) => [...name(rcnm, rcid), 255, 255, topi, 255]), FT]]
const frid = (rcid: number, prim: number, objl: number, ruin = 1, rver = 1): [string, number[]] => ['FRID', [100, ...le(rcid, 4), prim, 1, ...le(objl, 2), ...le(rver, 2), ruin, FT]]
const fspt = (...p: Array<[number, number, number]>): [string, number[]] => ['FSPT', [...p.flatMap(([rcnm, rcid, ornt]) => [...name(rcnm, rcid), ornt, 1, 255]), FT]]
const attf = (...a: Array<[number, string]>): [string, number[]] => ['ATTF', [...a.flatMap(([code, v]) => [...le(code, 2), ...enc(v), UT]), FT]]

/** An update control field: 1 insert before the index, 2 delete, 3 modify. */
const ctl = (tag: 'FSPC' | 'VRPC' | 'SGCC', op: number, index: number, count: number): [string, number[]] => [tag, [op, ...le(index, 2), ...le(count, 2), FT]]
const dsid = (dsnm: string, edtn: string, updn: string): [string, number[]] => ['DSID', [10, ...le(1, 4), 1, 1, ...enc(dsnm), UT, ...enc(edtn), UT, ...enc(updn), UT, FT]]
/** The delete character: an update's attribute value that removes the attribute. */
export const DEL = String.fromCharCode(0x7f)

export function cell(): Uint8Array {
  const recs = [
    s57Ddr(),
    record('D', [id(1), dsid('US5ME11M.000', '7', '2')]),
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

/**
 * Update 3 to that cell (it is at update 2): the light turns green and loses
 * its name, the broken feature goes, a buoy on a new node comes in, edge 21's
 * second point moves north, and the coastline takes edge 21 on after edge 20.
 */
export function update3(): Uint8Array {
  const recs = [
    s57Ddr(),
    record('D', [id(1), dsid('US5ME11M.003', '7', '3')]),
    record('D', [id(2), frid(1, 1, 75, 3, 2), attf([75, '4'], [116, DEL])]),
    record('D', [id(3), frid(5, 2, 999, 2, 2)]),
    record('D', [id(4), vrid(110, 3), ['SG2D', [...xy(43.63, -70.22), FT]]]),
    record('D', [id(5), frid(6, 1, 17), attf([75, '3'], [4, '2']), fspt([110, 3, 255])]),
    record('D', [id(6), vrid(130, 21, 3, 2), ctl('SGCC', 3, 2, 1), ['SG2D', [...xy(43.64, -70.2), FT]]]),
    record('D', [id(7), frid(3, 2, 30, 3, 2), ctl('FSPC', 1, 2, 1), fspt([130, 21, 1])]),
  ]
  return new Uint8Array(recs.flat())
}

/** An update file of the given cell name, edition and number, turning the new buoy (from update 3) to colour `colour`. */
export function buoyUpdate(dsnm: string, edtn: string, updn: number, colour: string): Uint8Array {
  const recs = [s57Ddr(), record('D', [id(1), dsid(dsnm, edtn, String(updn))]), record('D', [id(2), frid(6, 1, 17, 3, 2), attf([75, colour])])]
  return new Uint8Array(recs.flat())
}
