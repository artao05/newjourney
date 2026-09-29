/**
 * ISO/IEC 8211, the record format S-57 electronic charts (ENC cells, `.000`)
 * are written in.
 *
 * A file is a Data Descriptive Record (the DDR, leader 'L') describing each
 * field, then Data Records ('D' or 'R'). Every record is a 24-byte leader, a
 * directory of (tag, length, position) entries, and a field area; fields end
 * with 0x1E and variable-length subfields with 0x1F. The DDR gives each field
 * its subfield labels (`*` marking a group that repeats) and its format
 * controls, such as `(A(2),I(10),3b12)`. Binary subfields (`b1n` unsigned,
 * `b2n` signed, n bytes) are little-endian, as S-57 requires.
 */

const FT = 0x1e
const UT = 0x1f

export type Value = string | number | Uint8Array | null

export interface FieldDef {
  tag: string
  name: string
  labels: string[]
  /** The labels from here on repeat, as a group (the array descriptor began with `*`). */
  repeating: boolean
  formats: string[]
}

export interface Field {
  tag: string
  /** One object per group of subfields: one for a plain field, many for a repeating one. */
  groups: Array<Record<string, Value>>
}

export interface Iso8211 {
  fields: Map<string, FieldDef>
  records: Field[][]
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const num = (b: Uint8Array, from: number, len: number) => Number(ascii(b, from, from + len))

interface Leader {
  length: number
  kind: string
  base: number
  sizeLen: number
  sizePos: number
  sizeTag: number
}

function leader(b: Uint8Array, at: number): Leader {
  if (at + 24 > b.length) throw new Error('an ISO 8211 record is cut short')
  const length = num(b, at, 5)
  if (!Number.isFinite(length) || length < 24) throw new Error('not an ISO 8211 record')
  return { length, kind: String.fromCharCode(b[at + 6]), base: num(b, at + 12, 5), sizeLen: num(b, at + 20, 1), sizePos: num(b, at + 21, 1), sizeTag: num(b, at + 23, 1) }
}

function directory(b: Uint8Array, at: number, l: Leader): Array<{ tag: string; data: Uint8Array }> {
  const out: Array<{ tag: string; data: Uint8Array }> = []
  const entry = l.sizeTag + l.sizeLen + l.sizePos
  for (let p = at + 24; b[p] !== FT && p + entry <= at + l.base; p += entry) {
    const tag = ascii(b, p, p + l.sizeTag)
    const len = num(b, p + l.sizeTag, l.sizeLen)
    const pos = num(b, p + l.sizeTag + l.sizeLen, l.sizePos)
    out.push({ tag, data: b.subarray(at + l.base + pos, at + l.base + pos + len) })
  }
  return out
}

/** `(A(2),I(10),3b12,2(b11,b24))` → one format per subfield, repeats expanded. */
export function expandFormats(fc: string): string[] {
  let s = fc.trim()
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    let rep = ''
    while (i < s.length && /\d/.test(s[i])) rep += s[i++]
    const n = rep ? Number(rep) : 1
    if (s[i] === '(') {
      let depth = 1
      let j = i + 1
      while (j < s.length && depth) {
        if (s[j] === '(') depth++
        else if (s[j] === ')') depth--
        j++
      }
      const inner = expandFormats(s.slice(i, j))
      for (let k = 0; k < n; k++) out.push(...inner)
      i = j
    } else {
      let j = i
      while (j < s.length && s[j] !== ',') {
        if (s[j] === '(') while (j < s.length && s[j] !== ')') j++
        j++
      }
      const one = s.slice(i, j)
      for (let k = 0; k < n; k++) out.push(one)
      i = j
    }
    if (s[i] === ',') i++
  }
  return out
}

function describe(tag: string, data: Uint8Array): FieldDef {
  // Field controls (9 bytes in the DDR), then name, labels and formats split by UT.
  const body = ascii(data, 9, data[data.length - 1] === FT ? data.length - 1 : data.length)
  const [name = '', desc = '', fc = ''] = body.split(String.fromCharCode(UT))
  const repeating = desc.startsWith('*')
  const labels = desc.replace(/^\*/, '').split('!').filter(Boolean)
  return { tag, name, labels, repeating, formats: fc ? expandFormats(fc) : [] }
}

function readValue(b: Uint8Array, at: number, fmt: string): { v: Value; next: number } {
  const bin = /^b([12])(\d)$/.exec(fmt)
  if (bin) {
    const n = Number(bin[2])
    let v = 0
    for (let k = n - 1; k >= 0; k--) v = v * 256 + (b[at + k] ?? 0)
    if (bin[1] === '2' && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n)
    return { v, next: at + n }
  }
  const bits = /^B\((\d+)\)$/.exec(fmt)
  if (bits) {
    const n = Number(bits[1]) / 8
    return { v: b.slice(at, at + n), next: at + n }
  }
  const fixed = /^([AIR])\((\d+)\)$/.exec(fmt)
  let end: number
  let next: number
  if (fixed) {
    end = at + Number(fixed[2])
    next = end
  } else {
    end = at
    while (end < b.length && b[end] !== UT && b[end] !== FT) end++
    next = b[end] === UT ? end + 1 : end
  }
  const text = ascii(b, at, end)
  const kind = fixed ? fixed[1] : fmt[0]
  if (kind === 'I' || kind === 'R') {
    const t = text.trim()
    return { v: t === '' ? null : Number(t), next }
  }
  return { v: text, next }
}

function readField(def: FieldDef | undefined, tag: string, data: Uint8Array): Field {
  const end = data[data.length - 1] === FT ? data.length - 1 : data.length
  if (!def || !def.formats.length) return { tag, groups: [{ '': ascii(data, 0, end) }] }
  const groups: Array<Record<string, Value>> = []
  // A field with formats but no labels (the record id, 0001) keeps its values by position.
  const labels = def.labels.length ? def.labels : def.formats.map((_, i) => (i === 0 ? '' : String(i)))
  let at = 0
  do {
    const g: Record<string, Value> = {}
    labels.forEach((label, i) => {
      const r = readValue(data, at, def.formats[i] ?? def.formats[def.formats.length - 1])
      g[label] = r.v
      at = r.next
    })
    groups.push(g)
  } while (def.repeating && at < end)
  return { tag, groups }
}

export function parse8211(input: Uint8Array | ArrayBuffer): Iso8211 {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  const fields = new Map<string, FieldDef>()
  const records: Field[][] = []
  let at = 0
  let first = true
  while (at + 24 <= b.length) {
    const l = leader(b, at)
    if (at + l.length > b.length) throw new Error('an ISO 8211 record runs past the end of the file')
    const dir = directory(b, at, l)
    if (first) {
      if (l.kind !== 'L') throw new Error('an ISO 8211 file must start with its descriptive record')
      for (const e of dir) if (e.tag !== '0000') fields.set(e.tag, describe(e.tag, e.data))
      first = false
    } else {
      records.push(dir.map((e) => readField(fields.get(e.tag), e.tag, e.data)))
    }
    at += l.length
  }
  return { fields, records }
}
