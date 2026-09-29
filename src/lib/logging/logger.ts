/**
 * The channel logger: every live channel, once a second, one log per day.
 *
 * Rows are buffered and written in batches, so a second's work is an object in
 * memory, not a database transaction. Each row keeps only the channels that had
 * a value, which on a phone with no instruments is a dozen, not three hundred.
 * A cap on the whole log drops the oldest days first, so a season of racing
 * cannot fill the phone.
 */

import { CHANNELS } from '@/lib/channels/catalogue'
import type { ChannelValues } from '@/lib/channels/snapshot'

export interface LogRow {
  t: number
  v: Record<string, number>
}

/** Where rows are kept: IndexedDB in the app, memory in tests. */
export interface LogStore {
  append(day: string, rows: LogRow[]): Promise<void>
  days(): Promise<Array<{ day: string; rows: number }>>
  read(day: string): Promise<LogRow[]>
  deleteDay(day: string): Promise<void>
}

/** The local calendar day a time falls on, as YYYY-MM-DD: a race day, not a UTC one. */
export function dayOf(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A second's snapshot as a row: the channels that have a number, and no others. */
export function rowFrom(t: number, snap: ChannelValues, skip: ReadonlySet<string> = SKIP): LogRow {
  const v: Record<string, number> = {}
  for (const [k, x] of Object.entries(snap)) if (x != null && Number.isFinite(x) && !skip.has(k)) v[k] = x
  return { t, v }
}

/** Not logged: the clock, which is the row's own time. */
const SKIP = new Set(['time'])

/** About a week of racing at one row a second, eight hours a day. */
export const DEFAULT_CAP_ROWS = 7 * 8 * 3600

export class ChannelLogger {
  private buffer: LogRow[] = []
  private lastT = -Infinity

  constructor(
    private readonly store: LogStore,
    private readonly opts: { capRows?: number; flushRows?: number } = {},
  ) {}

  /** Adds a row, at most one a second. Returns true if it was kept. */
  record(t: number, snap: ChannelValues): boolean {
    if (t - this.lastT < 1000) return false
    const row = rowFrom(t, snap)
    if (Object.keys(row.v).length === 0) return false
    this.lastT = t
    this.buffer.push(row)
    if (this.buffer.length >= (this.opts.flushRows ?? 30)) void this.flush()
    return true
  }

  /** Writes what is buffered, a day at a time, then trims to the cap. */
  async flush(): Promise<void> {
    const rows = this.buffer
    this.buffer = []
    if (rows.length === 0) return
    const byDay = new Map<string, LogRow[]>()
    for (const r of rows) byDay.set(dayOf(r.t), [...(byDay.get(dayOf(r.t)) ?? []), r])
    for (const [day, rs] of byDay) await this.store.append(day, rs)
    await trimToCap(this.store, this.opts.capRows ?? DEFAULT_CAP_ROWS)
  }
}

/** Drops whole days, oldest first, until the log is under the cap; today is kept. */
export async function trimToCap(store: LogStore, capRows: number): Promise<string[]> {
  const days = (await store.days()).sort((a, b) => a.day.localeCompare(b.day))
  let total = days.reduce((a, d) => a + d.rows, 0)
  const dropped: string[] = []
  for (const d of days.slice(0, -1)) {
    if (total <= capRows) break
    await store.deleteDay(d.day)
    total -= d.rows
    dropped.push(d.day)
  }
  return dropped
}

const NAMES = new Map(CHANNELS.map((c) => [c.id, c.name]))

/**
 * A day's log as CSV: UTC time, then one column per channel that appears in it,
 * headed with the channel's name, in catalogue order. Empty where a second had
 * no value for that channel.
 */
export function logToCsv(rows: LogRow[]): string {
  const used = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r.v)) used.add(k)
  const cols = CHANNELS.map((c) => c.id).filter((id) => used.has(id))
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [['Utc', ...cols.map((c) => esc(NAMES.get(c) ?? c))].join(',')]
  for (const r of rows) {
    lines.push([new Date(r.t).toISOString(), ...cols.map((c) => (c in r.v ? String(r.v[c]) : ''))].join(','))
  }
  return lines.join('\n') + '\n'
}

/** For tests, and for a browser without IndexedDB: the same log, in memory. */
export class MemoryLogStore implements LogStore {
  private data = new Map<string, LogRow[]>()
  async append(day: string, rows: LogRow[]) {
    this.data.set(day, [...(this.data.get(day) ?? []), ...rows])
  }
  async days() {
    return [...this.data].map(([day, rs]) => ({ day, rows: rs.length }))
  }
  async read(day: string) {
    return [...(this.data.get(day) ?? [])]
  }
  async deleteDay(day: string) {
    this.data.delete(day)
  }
}

export interface PolarPoint {
  twa: number
  bsp: number
  tws: number
  tack: 'port' | 'starboard'
  /** Slower than the polar at this angle and wind: drawn hollow. */
  below: boolean
}

/**
 * Logged seconds as points on the polar: the ones within `bandKn` of a plotted
 * wind speed, so each point sits by the curve it should be compared with.
 */
export function polarPoints(
  rows: LogRow[],
  speedAt: (tws: number, twa: number) => number,
  speeds: number[],
  bandKn = 1,
): PolarPoint[] {
  const out: PolarPoint[] = []
  for (const r of rows) {
    const { twa, tws, bsp } = r.v
    if (twa == null || tws == null || bsp == null || !(bsp > 0.3)) continue
    if (!speeds.some((s) => Math.abs(s - tws) <= bandKn)) continue
    out.push({ twa, bsp, tws, tack: twa < 0 ? 'port' : 'starboard', below: bsp < speedAt(tws, Math.abs(twa)) })
  }
  return out
}
