/**
 * Expedition's own plain-text protocol: data lines and remote commands.
 *
 *   #<boat>,<var>,<val>,<var>,<val>...*XX     channel values for a boat
 *   #E,<var>,<val>...*XX / #X,<var>,<val>...  external and system channels
 *   #G,SYNC / #G,<minutes> / #G,KILL          the start countdown
 *   #L,P / #L,S / #L,P,<lat>,<lon>            the line ends
 *   #M,...  #C,...                            marks and courses
 *
 * The checksum is the XOR of every character from the `#` up to the `*`, the
 * `#` included (unlike NMEA, which leaves its `$` out): `#G,12.34` gives 62.
 * A receiver acknowledges a command with `#ACK,<the command's checksum>`.
 *
 * Variables in data lines are Expedition's channel numbers. This codec keeps
 * them as numbers; naming them needs Expedition's own channel numbering.
 */

export function expChecksum(fromHash: string): string {
  let x = 0
  for (let i = 0; i < fromHash.length; i++) x ^= fromHash.charCodeAt(i)
  return x.toString(16).toUpperCase().padStart(2, '0')
}

/** A line with its checksum and line end: `body` starts at the `#`. */
export function frame(body: string): string {
  const b = body.startsWith('#') ? body : `#${body}`
  return `${b}*${expChecksum(b)}\r\n`
}

export type ExpLine =
  | { kind: 'data'; boat: string; group: 'boat' | 'external' | 'system'; values: Array<[number, number]> }
  | { kind: 'command'; cmd: 'G' | 'L' | 'M' | 'C'; args: string[]; checksum: string }

/** One line, checked; null if it is not this protocol or its checksum is wrong. */
export function parseExpLine(line: string): ExpLine | null {
  const s = line.trim()
  if (!s.startsWith('#')) return null
  const star = s.lastIndexOf('*')
  const body = star >= 0 ? s.slice(0, star) : s
  const sum = expChecksum(body)
  if (star >= 0 && s.slice(star + 1, star + 3).toUpperCase() !== sum) return null
  const [head, ...rest] = body.slice(1).split(',')
  if (head === 'G' || head === 'L' || head === 'M' || head === 'C') {
    return { kind: 'command', cmd: head, args: rest, checksum: sum }
  }
  if (head === 'ACK') return null
  const values: Array<[number, number]> = []
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const v = Number(rest[i])
    const x = Number(rest[i + 1])
    if (Number.isInteger(v) && Number.isFinite(x)) values.push([v, x])
  }
  const group = head === 'E' ? 'external' : head === 'X' ? 'system' : 'boat'
  return { kind: 'data', boat: head, group, values }
}

/** The acknowledgement a receiver sends for a command. */
export function ack(cmd: { checksum: string }): string {
  return frame(`#ACK,${cmd.checksum}`)
}

/** What a command asks the app to do, in the app's own terms. */
export type ExpAction =
  | { do: 'gun-sync' }
  | { do: 'gun-kill' }
  | { do: 'gun-set'; minutes: number }
  | { do: 'ping'; end: 'port' | 'starboard' }
  | { do: 'set-end'; end: 'port' | 'starboard'; lat: number; lon: number }
  | { do: 'mark-next' }
  | { do: 'mark-prev' }
  | { do: 'mob' }
  | { do: 'mark-ping' }
  | { do: 'mark-query' }
  | { do: 'unsupported'; why: string }

export function actionFor(c: Extract<ExpLine, { kind: 'command' }>): ExpAction {
  const [a, b, d] = c.args
  switch (c.cmd) {
    case 'G': {
      if (a === 'SYNC') return { do: 'gun-sync' }
      if (a === 'KILL') return { do: 'gun-kill' }
      const m = Number(a)
      if (!Number.isFinite(m)) return { do: 'unsupported', why: `#G,${a}` }
      // A negative time kills the timer, as KILL does.
      return m < 0 ? { do: 'gun-kill' } : { do: 'gun-set', minutes: m }
    }
    case 'L': {
      const end = a === 'P' ? 'port' : a === 'S' ? 'starboard' : null
      if (!end) return { do: 'unsupported', why: `#L,${a}` }
      if (b == null) return { do: 'ping', end }
      const lat = Number(b)
      const lon = Number(d)
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { do: 'set-end', end, lat, lon }
        : { do: 'unsupported', why: 'a line end needs a latitude and a longitude' }
    }
    case 'M':
      if (a === 'NEXT') return { do: 'mark-next' }
      if (a === 'PREV') return { do: 'mark-prev' }
      if (a === 'MOB') return { do: 'mob' }
      if (a === 'PING' || a === 'PINGACTIVE') return { do: 'mark-ping' }
      if (a === 'QUERY') return { do: 'mark-query' }
      return { do: 'unsupported', why: `#M,${a}` }
    default:
      return { do: 'unsupported', why: `#${c.cmd},${a ?? ''}` }
  }
}
