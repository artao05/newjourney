/**
 * Test fixtures: ISO 8211 records built byte by byte, and S-57 field bodies,
 * so the chart readers can be tested without a real cell (13.1b).
 */
export const FT = 0x1e
export const UT = 0x1f
export const enc = (s: string) => [...s].map((c) => c.charCodeAt(0))
const pad = (n: number, w: number) => enc(String(n).padStart(w, '0'))

/** Little-endian, signed if negative. */
export const le = (v: number, n: number) => {
  const x = v < 0 ? v + 2 ** (8 * n) : v
  return Array.from({ length: n }, (_, i) => Math.floor(x / 256 ** i) & 255)
}

export function record(kind: 'L' | 'D', fields: Array<[string, number[]]>): number[] {
  const sizeLen = 4
  const sizePos = 5
  const sizeTag = 4
  const dir: number[] = []
  const area: number[] = []
  for (const [tag, data] of fields) {
    dir.push(...enc(tag), ...pad(data.length, sizeLen), ...pad(area.length, sizePos))
    area.push(...data)
  }
  dir.push(FT)
  const base = 24 + dir.length
  const length = base + area.length
  const lead = [
    ...pad(length, 5), ...enc(kind === 'L' ? '3' : ' '), ...enc(kind), ...enc(kind === 'L' ? 'E1 ' : '   '), ...enc(kind === 'L' ? '06' : '  '),
    ...pad(base, 5), ...enc(kind === 'L' ? ' ! ' : '   '), ...pad(sizeLen, 1), ...pad(sizePos, 1), 48, ...pad(sizeTag, 1),
  ]
  return [...lead, ...dir, ...area]
}

export const ddrField = (controls: string, name: string, desc: string, fc: string) => [...enc(controls), ...enc(name), UT, ...enc(desc), UT, ...enc(fc), FT]

/** The S-57 fields a small cell uses, as a DDR. */
export function s57Ddr(): number[] {
  return record('L', [
    ['0000', [...enc('0000;&   '), ...enc('S-57 TEST'), FT]],
    ['0001', ddrField('0100;&   ', 'ISO 8211 Record Identifier', '', '(b12)')],
    ['DSID', ddrField('1600;&   ', 'Data set identification field', 'RCNM!RCID!EXPP!INTU!DSNM!EDTN!UPDN', '(b11,b14,2b11,3A)')],
    ['DSPM', ddrField('1600;&   ', 'Data set parameter field', 'RCNM!RCID!HDAT!VDAT!SDAT!CSCL!DUNI!HUNI!PUNI!COUN!COMF!SOMF', '(b11,b14,3b11,b14,4b11,2b14)')],
    ['VRID', ddrField('1600;&   ', 'Vector record identifier field', 'RCNM!RCID!RVER!RUIN', '(b11,b14,b12,b11)')],
    ['VRPT', ddrField('2600;&   ', 'Vector record pointer field', '*NAME!ORNT!USAG!TOPI!MASK', '(B(40),4b11)')],
    ['SG2D', ddrField('2600;&   ', '2-D coordinate field', '*YCOO!XCOO', '(2b24)')],
    ['SG3D', ddrField('2600;&   ', '3-D coordinate (sounding array) field', '*YCOO!XCOO!VE3D', '(3b24)')],
    ['FRID', ddrField('1600;&   ', 'Feature record identifier field', 'RCNM!RCID!PRIM!GRUP!OBJL!RVER!RUIN', '(b11,b14,2b11,2b12,b11)')],
    ['FOID', ddrField('1600;&   ', 'Feature object identifier field', 'AGEN!FIDN!FIDS', '(b12,b14,b12)')],
    ['ATTF', ddrField('2600;&   ', 'Feature record attribute field', '*ATTL!ATVL', '(b12,A)')],
    ['FSPT', ddrField('2600;&   ', 'Feature record to spatial record pointer field', '*NAME!ORNT!USAG!MASK', '(B(40),3b11)')],
    ['FSPC', ddrField('1600;&   ', 'Feature record to spatial record pointer control field', 'FSUI!FSIX!NSPT', '(b11,2b12)')],
    ['VRPC', ddrField('1600;&   ', 'Vector record pointer control field', 'VPUI!VPIX!NVPT', '(b11,2b12)')],
    ['SGCC', ddrField('1600;&   ', 'Coordinate control field', 'CCUI!CCIX!CCNC', '(b11,2b12)')],
  ])
}

export const name = (rcnm: number, rcid: number) => [rcnm, ...le(rcid, 4)]
