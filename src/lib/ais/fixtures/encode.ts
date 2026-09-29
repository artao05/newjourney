/**
 * Test fixtures: AIS payloads built field by field to the ITU-R M.1371 layouts,
 * armoured and framed as AIVDM sentences with their checksums.
 */
export type Field = [bits: number, value: number | string]

const TEXT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?'

export function payloadBits(fields: Field[]): number[] {
  const out: number[] = []
  for (const [n, v] of fields) {
    if (typeof v === 'string') {
      const chars = n / 6
      const padded = v.toUpperCase().padEnd(chars, '@').slice(0, chars)
      for (const ch of padded) {
        const k = TEXT.indexOf(ch)
        for (let b = 5; b >= 0; b--) out.push((k >> b) & 1)
      }
    } else {
      const x = v < 0 ? v + 2 ** n : v
      for (let b = n - 1; b >= 0; b--) out.push(Math.floor(x / 2 ** b) % 2)
    }
  }
  return out
}

function armour(bits: number[]): { payload: string; fill: number } {
  const fill = (6 - (bits.length % 6)) % 6
  const all = [...bits, ...new Array(fill).fill(0)]
  let s = ''
  for (let i = 0; i < all.length; i += 6) {
    let v = 0
    for (let b = 0; b < 6; b++) v = v * 2 + all[i + b]
    s += String.fromCharCode(v < 40 ? v + 48 : v + 56)
  }
  return { payload: s, fill }
}

const withChecksum = (body: string) => {
  let x = 0
  for (let i = 1; i < body.length; i++) x ^= body.charCodeAt(i)
  return `${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`
}

/** One message as sentences, split every `perSentence` characters. */
export function sentences(fields: Field[], o: { channel?: string; seq?: number; own?: boolean; perSentence?: number } = {}): string[] {
  const { payload, fill } = armour(payloadBits(fields))
  const per = o.perSentence ?? 60
  const chunks: string[] = []
  for (let i = 0; i < payload.length; i += per) chunks.push(payload.slice(i, i + per))
  return chunks.map((c, i) =>
    withChecksum(`!AI${o.own ? 'VDO' : 'VDM'},${chunks.length},${i + 1},${chunks.length > 1 ? (o.seq ?? 3) : ''},${o.channel ?? 'A'},${c},${i === chunks.length - 1 ? fill : 0}`),
  )
}

export const ll = (deg: number, scale = 600000) => Math.round(deg * scale)
