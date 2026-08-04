/**
 * Polar tables, derived targets, and the routing lattice.
 *
 * Spec:
 *   docs/03-algorithms/polars-and-vpp.md      §1 interpolation, §2 targets, §4 height
 *   docs/02-data-sources/polars.md            §2.5 parametric generation, §4 validation
 *   docs/01-expedition-analysis/feature-inventory.md §8 file format
 *
 * Everything the router and every tactical number depends on ultimately comes through
 * `polarSpeed` (correct, slow) or `PolarLattice.speed` (approximate, O(1), used in the
 * routing inner loop). Keep them agreeing to within a few hundredths of a knot.
 */

import { clamp, toRad, wrap180 } from './angles'
import type {
  Degrees,
  Knots,
  PolarLattice,
  PolarTable,
  SignedDegrees,
  Targets,
} from './types'

type PolarRow = PolarTable['rows'][number]

// ------------------------------------------------------------- interpolation

/**
 * Cached PCHIP tangents, keyed by the row object.
 *
 * Rows are treated as immutable once a table is loaded — every code path here either
 * builds a fresh row or leaves an existing one alone. The cache is keyed weakly so a
 * discarded table's derivatives are collected with it. The length check below is a
 * cheap guard against a caller who mutates anyway.
 */
const SLOPE_CACHE = new WeakMap<PolarRow, Float64Array>()

/**
 * One-sided end tangent with the standard monotonicity limiter.
 *
 * The unlimited three-point formula can point the wrong way at an end point, which is
 * exactly where polar rows are steepest (close-hauled) — so it is clamped to zero if it
 * disagrees with the adjacent secant, and to 3x the secant if the data turns over.
 */
function endSlope(h0: number, h1: number, d0: number, d1: number): number {
  let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (s * d0 <= 0) s = 0
  else if (d0 * d1 < 0 && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0
  return s
}

/**
 * Fritsch-Carlson monotone-cubic (PCHIP) tangents for one polar row.
 *
 * Why not a natural cubic spline: it overshoots between knots and invents boat speed the
 * boat does not have, and the router will find that speed and route to exploit it. The
 * harmonic-mean interior tangent below bounds |d_i| by 3x the smaller adjacent secant,
 * which is the Fritsch-Carlson sufficient condition for the Hermite cubic to stay inside
 * its bracketing values. See docs/03-algorithms/polars-and-vpp.md §1.
 */
function pchipSlopes(x: readonly number[], y: readonly number[]): Float64Array {
  const n = x.length
  const d = new Float64Array(n)
  if (n < 2) return d
  const h = new Float64Array(n - 1)
  const delta = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i]
    delta[i] = h[i] > 0 ? (y[i + 1] - y[i]) / h[i] : 0
  }
  if (n === 2) {
    d[0] = delta[0]
    d[1] = delta[0]
    return d
  }
  for (let i = 1; i < n - 1; i++) {
    const dm = delta[i - 1]
    const dp = delta[i]
    if (dm * dp <= 0) {
      // Local extremum: a zero tangent is what stops the cubic bulging past the knot.
      d[i] = 0
      continue
    }
    const w1 = 2 * h[i] + h[i - 1]
    const w2 = h[i] + 2 * h[i - 1]
    d[i] = (w1 + w2) / (w1 / dm + w2 / dp)
  }
  d[0] = endSlope(h[0], h[1], delta[0], delta[1])
  d[n - 1] = endSlope(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3])
  return d
}

function slopesFor(row: PolarRow): Float64Array {
  const n = Math.min(row.twa.length, row.bsp.length)
  let s = SLOPE_CACHE.get(row)
  if (s === undefined || s.length !== n) {
    // A row whose two arrays disagree in length is malformed (validatePolar rejects it);
    // truncating rather than reading past the end keeps NaN out of the routing loop.
    s = pchipSlopes(
      n === row.twa.length ? row.twa : row.twa.slice(0, n),
      n === row.bsp.length ? row.bsp : row.bsp.slice(0, n),
    )
    SLOPE_CACHE.set(row, s)
  }
  return s
}

/**
 * Boat speed for one TWS row at an absolute TWA, PCHIP within the row.
 *
 * Off the ends we do not extrapolate. Below the first breakpoint — the no-go zone, where
 * the table makes no claim at all — the speed ramps linearly to zero at TWA 0. A hard
 * step to zero would be more literal, but it puts a multi-knot cliff in the middle of the
 * surface the router optimises over, which no lattice can represent and no line search
 * can cross sensibly. The ramp is steeply penalised in VMG terms, so the router never
 * chooses to sail there; `deriveTargets` additionally refuses to report a target outside
 * the table's own angular domain, which is where a ramp could otherwise leak a fabricated
 * pointing angle. Above the last breakpoint (conventionally 180) we hold the last value.
 */
function rowSpeed(row: PolarRow, a: Degrees): Knots {
  const x = row.twa
  const y = row.bsp
  const n = Math.min(x.length, y.length)
  if (n === 0) return 0
  if (a <= x[0]) return x[0] > 0 ? Math.max(0, y[0]) * (a / x[0]) : Math.max(0, y[0])
  if (a >= x[n - 1]) return Math.max(0, y[n - 1])
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (x[mid] <= a) lo = mid
    else hi = mid
  }
  const h = x[lo + 1] - x[lo]
  if (h <= 0) return Math.max(0, y[lo])
  const d = slopesFor(row)
  const t = (a - x[lo]) / h
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const v = h00 * y[lo] + h10 * h * d[lo] + h01 * y[lo + 1] + h11 * h * d[lo + 1]
  return v > 0 ? v : 0
}

/**
 * Boat speed from a ragged polar table.
 *
 * PCHIP across TWA within each bracketing row, then linear between the two rows in TWS.
 * Linear in TWS is deliberate: rows are usually 2 kn apart, the surface is close to
 * linear at that spacing, and a cubic across rows would reintroduce the overshoot we
 * just spent PCHIP avoiding.
 *
 * Below the lowest row the speed is scaled linearly toward zero — real boats do worse
 * than linear when it goes light, so this errs on the pessimistic side of "we do not
 * know". Above the highest row the top row is held: never extrapolate upward, or the
 * router will discover a 40-knot storm is the fast way to the mark.
 */
export function polarSpeed(p: PolarTable, tws: Knots, twa: SignedDegrees): Knots {
  const rows = p.rows
  const n = Math.min(p.tws.length, rows.length)
  if (n === 0) return 0
  if (!(tws > 0)) return 0
  const a = Math.abs(wrap180(twa))
  const t0 = p.tws[0]
  if (tws <= t0) {
    const v0 = rowSpeed(rows[0], a)
    return t0 > 0 ? v0 * (tws / t0) : v0
  }
  if (tws >= p.tws[n - 1]) return rowSpeed(rows[n - 1], a)
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (p.tws[mid] <= tws) lo = mid
    else hi = mid
  }
  const span = p.tws[lo + 1] - p.tws[lo]
  const alpha = span > 0 ? (tws - p.tws[lo]) / span : 0
  const vLo = rowSpeed(rows[lo], a)
  const vHi = rowSpeed(rows[lo + 1], a)
  return vLo + (vHi - vLo) * alpha
}

// ------------------------------------------------------------------- targets

/** TWA reported when there is no wind at all, so the UI has something sane to draw. */
const NO_WIND_UP_TWA = 45
const NO_WIND_DOWN_TWA = 150

/** Golden-section maximiser on a bracket assumed to hold a single interior optimum. */
function goldenMax(f: (x: number) => number, a: number, b: number): number {
  const R = 0.6180339887498949
  let lo = a
  let hi = b
  let c = hi - R * (hi - lo)
  let d = lo + R * (hi - lo)
  let fc = f(c)
  let fd = f(d)
  for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
    if (fc > fd) {
      hi = d
      d = c
      fd = fc
      c = hi - R * (hi - lo)
      fc = f(c)
    } else {
      lo = c
      c = d
      fc = fd
      d = lo + R * (hi - lo)
      fd = f(d)
    }
  }
  return (lo + hi) / 2
}

/**
 * Coarse 0.5-degree sweep, then a golden-section refine inside the winning half-degree.
 *
 * `sign` is +1 upwind (maximise VMG) and -1 downwind (minimise it). Scanning the
 * *interpolated* curve rather than the table points is the whole point: Expedition's
 * warning about targets hopping between adjacent table rows when you edit one is a
 * direct consequence of reading targets off the knots.
 */
function scanTarget(
  p: PolarTable,
  tws: Knots,
  lo: Degrees,
  hi: Degrees,
  sign: 1 | -1,
): { twa: Degrees; bsp: Knots; vmg: Knots } {
  const f = (a: Degrees) => sign * polarSpeed(p, tws, a) * Math.cos(toRad(a))
  let bestTwa = lo
  let bestVal = -Infinity
  for (let a = lo; a <= hi + 1e-9; a += 0.5) {
    const v = f(a)
    if (v > bestVal) {
      bestVal = v
      bestTwa = a
    }
  }
  if (!(bestVal > 0)) {
    // No wind, or a table that claims no speed anywhere. Report neutral angles at zero
    // speed rather than a spurious 0.5-degree "target".
    const twa = sign > 0 ? NO_WIND_UP_TWA : NO_WIND_DOWN_TWA
    return { twa, bsp: 0, vmg: 0 }
  }
  const a0 = Math.max(lo, bestTwa - 0.5)
  const b0 = Math.min(hi, bestTwa + 0.5)
  const twa = b0 > a0 ? goldenMax(f, a0, b0) : bestTwa
  const bsp = polarSpeed(p, tws, twa)
  return { twa, bsp, vmg: bsp * Math.cos(toRad(twa)) }
}

/**
 * The angular range this table actually has data for at a given wind speed.
 *
 * Outside it `rowSpeed` ramps or holds, which is right for the router (it wants a
 * continuous surface) and wrong for a target (which the sailor reads as an instruction).
 * Taking the tightest/widest angle common to the bracketing rows keeps `deriveTargets`
 * from ever reporting "point at 49°" for a table whose first entry is 80°.
 */
function twaDomain(p: PolarTable, tws: Knots): [Degrees, Degrees] {
  const n = Math.min(p.tws.length, p.rows.length)
  let lo = 0
  let hi = 180
  if (n === 0) return [lo, hi]
  const consider = (row: PolarRow) => {
    const m = Math.min(row.twa.length, row.bsp.length)
    if (m === 0) return
    if (row.twa[0] > lo) lo = row.twa[0]
    if (row.twa[m - 1] < hi) hi = row.twa[m - 1]
  }
  if (tws <= p.tws[0]) consider(p.rows[0])
  else if (tws >= p.tws[n - 1]) consider(p.rows[n - 1])
  else {
    let a = 0
    let b = n - 1
    while (b - a > 1) {
      const mid = (a + b) >> 1
      if (p.tws[mid] <= tws) a = mid
      else b = mid
    }
    consider(p.rows[a])
    consider(p.rows[a + 1])
  }
  return [lo, hi]
}

/**
 * Upwind and downwind VMG targets at one wind speed.
 *
 * Targets are derived, never stored — see docs/03-algorithms/polars-and-vpp.md §2.
 * `upTwa` doubles as the no-go angle, which is why it must come off the interpolated
 * curve: every layline and every implicit-tacking substitution in the router reads it.
 *
 * `downVmg` is signed, and therefore negative: VMG = bsp * cos(twa) with twa > 90.
 * Take the absolute value for display.
 */
export function deriveTargets(p: PolarTable, tws: Knots): Targets {
  const [domainLo, domainHi] = twaDomain(p, tws)
  const up = scanTarget(p, tws, clamp(Math.max(0.5, domainLo), 0.5, 90), 90, 1)
  const down = scanTarget(p, tws, 90, clamp(Math.min(179.5, domainHi), 90, 179.5), -1)
  return {
    tws,
    upTwa: up.twa,
    upBsp: up.bsp,
    upVmg: up.vmg,
    downTwa: down.twa,
    downBsp: down.bsp,
    downVmg: down.vmg,
  }
}

// ------------------------------------------------------------------- lattice

/**
 * Precompute the polar onto a regular grid for O(1) lookup.
 *
 * The router evaluates boat speed millions of times per solve; a ragged-table lookup
 * costs two binary searches and two Hermite evaluations, a lattice lookup costs four
 * array reads. Defaults are TWS 0-50 kn in 0.5 kn steps x TWA 0-180 deg in 1 deg steps
 * = 101 x 181 floats = 73 KB, which is the single cheapest routing optimisation there
 * is. See docs/03-algorithms/polars-and-vpp.md §1.
 */
export function buildLattice(
  p: PolarTable,
  opts?: { twsMax?: number; twsStep?: number; twaStep?: number },
): PolarLattice {
  const twsStep = clamp(opts?.twsStep ?? 0.5, 0.05, 5)
  const twaStep = clamp(opts?.twaStep ?? 1, 0.1, 10)
  const twsMax = clamp(opts?.twsMax ?? 50, 5, 200)
  const twsCount = Math.max(2, Math.round(twsMax / twsStep) + 1)
  const twaCount = Math.max(2, Math.round(180 / twaStep) + 1)
  const grid = new Float32Array(twsCount * twaCount)
  const targets: Targets[] = new Array(twsCount)
  for (let i = 0; i < twsCount; i++) {
    const tws = i * twsStep
    const base = i * twaCount
    for (let j = 0; j < twaCount; j++) {
      grid[base + j] = polarSpeed(p, tws, j * twaStep)
    }
    targets[i] = deriveTargets(p, tws)
  }
  // Everything `speed` closes over is a const captured once, so the hot path allocates
  // nothing and reads no mutable state.
  const invTwsStep = 1 / twsStep
  const invTwaStep = 1 / twaStep
  const twsTop = twsStep * (twsCount - 1)
  const twaTop = twaStep * (twaCount - 1)
  const iLast = twsCount - 2
  const jLast = twaCount - 2

  return {
    table: p,
    twsMax: twsTop,
    twsStep,
    twaStep,
    grid,
    twsCount,
    twaCount,
    targets,

    speed(tws: Knots, twa: SignedDegrees): Knots {
      let a = twa < 0 ? -twa : twa
      if (a > twaTop) a = twaTop
      else if (!(a >= 0)) a = 0
      let s = tws
      if (s > twsTop) s = twsTop
      else if (!(s >= 0)) s = 0
      const fi = s * invTwsStep
      let i0 = fi | 0
      if (i0 > iLast) i0 = iLast
      const ti = fi - i0
      const fj = a * invTwaStep
      let j0 = fj | 0
      if (j0 > jLast) j0 = jLast
      const tj = fj - j0
      const b0 = i0 * twaCount + j0
      const b1 = b0 + twaCount
      const v00 = grid[b0]
      const v01 = grid[b0 + 1]
      const v10 = grid[b1]
      const v11 = grid[b1 + 1]
      const lower = v00 + (v01 - v00) * tj
      const upper = v10 + (v11 - v10) * tj
      return lower + (upper - lower) * ti
    },

    targetsAt(tws: Knots): Targets {
      let i = Math.round((tws > 0 ? tws : 0) * invTwsStep)
      if (i < 0) i = 0
      else if (i >= twsCount) i = twsCount - 1
      return targets[i]
    },
  }
}

// ------------------------------------------------------- wind height scaling

/** Default Hellmann exponent at sea; the manual's range is 0.11-0.14. */
export const HELLMANN_DEFAULT = 0.12

/**
 * TWS(h) / TWS(10 m) = (h / 10)^a — the power-law wind profile.
 *
 * Designer polars are referenced to 10 m and instruments read at the masthead, so the
 * two disagree by ~9 % on a 20 m rig. Expedition makes the sailor compute this and type
 * a percentage into "Scale winds"; we ask for mast height once in boat setup and never
 * show a percentage. Getting it wrong silently poisons every downstream number.
 * See docs/03-algorithms/polars-and-vpp.md §4.
 */
export function heightScaleFactor(mastHeightM: number, hellmann?: number): number {
  if (!(mastHeightM > 0) || !Number.isFinite(mastHeightM)) return 1
  const a = clamp(hellmann ?? HELLMANN_DEFAULT, 0, 0.5)
  return Math.pow(mastHeightM / 10, a)
}

/**
 * Re-index a 10 m-referenced table onto masthead wind speeds.
 *
 * Boat speeds are untouched; only the TWS each row is labelled with moves. Doing it this
 * way — rather than scaling the incoming wind — means the table can be handed straight to
 * a lookup driven by masthead instrument readings. Already-masthead tables are returned
 * unchanged (copied) so this is safe to call unconditionally.
 */
export function scaleTableToMasthead(p: PolarTable, mastHeightM: number): PolarTable {
  const copy: PolarTable = {
    name: p.name,
    tws: p.tws.slice(),
    rows: p.rows.map((r) => ({ twa: r.twa.slice(), bsp: r.bsp.slice() })),
    reference: p.reference,
    source: p.source,
  }
  if (p.reference === 'masthead') return copy
  const k = heightScaleFactor(mastHeightM)
  copy.tws = copy.tws.map((t) => Math.round(t * k * 1000) / 1000)
  copy.reference = 'masthead'
  return copy
}

// ------------------------------------------------------------------- parsing

function stripComment(line: string): string {
  const bang = line.indexOf('!')
  return (bang >= 0 ? line.slice(0, bang) : line).trim()
}

function commentOf(line: string): string {
  const bang = line.indexOf('!')
  return bang >= 0 ? line.slice(bang + 1).trim() : ''
}

/** Shortest decimal that survives a parse/serialise round trip at polar precision. */
function num(x: number): string {
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * Sort, fold and de-duplicate one row's breakpoints.
 *
 * Files in the wild carry TWA past 180 for the port side; folding to 360-twa and keeping
 * the faster of any duplicate pair merges a two-sided table into the symmetric one the
 * rest of the code assumes.
 */
function normaliseRow(pairs: Array<[number, number]>): PolarRow {
  const byAngle = new Map<number, number>()
  for (const [rawTwa, rawBsp] of pairs) {
    if (!Number.isFinite(rawTwa) || !Number.isFinite(rawBsp)) continue
    let a = Math.abs(rawTwa) % 360
    if (a > 180) a = 360 - a
    const v = rawBsp > 0 ? rawBsp : 0
    const prev = byAngle.get(a)
    if (prev === undefined || v > prev) byAngle.set(a, v)
  }
  const angles = [...byAngle.keys()].sort((a, b) => a - b)
  return { twa: angles, bsp: angles.map((a) => byAngle.get(a) as number) }
}

function finishTable(
  name: string,
  source: string | undefined,
  reference: PolarTable['reference'],
  raw: Array<{ tws: number; pairs: Array<[number, number]> }>,
): PolarTable {
  const byTws = new Map<number, Array<[number, number]>>()
  for (const r of raw) {
    if (!Number.isFinite(r.tws) || r.tws < 0) continue
    const existing = byTws.get(r.tws)
    if (existing) existing.push(...r.pairs)
    else byTws.set(r.tws, r.pairs.slice())
  }
  const tws = [...byTws.keys()].sort((a, b) => a - b)
  return {
    name,
    tws,
    rows: tws.map((t) => normaliseRow(byTws.get(t) as Array<[number, number]>)),
    reference,
    source,
  }
}

/**
 * Read Expedition's native polar format.
 *
 * First column TWS, then (TWA, BSP) pairs, rows may differ in length, `!` comments.
 * This is the de-facto interchange format — anyone with Expedition or Deckman data can
 * paste their file straight in. See feature-inventory.md §8. We also round-trip our own
 * `!Polar:` / `!Source:` / `!Reference:` header comments, which the format itself does
 * not define but which cost nothing and keep the table's identity attached to the file.
 */
export function parseExpeditionPolar(text: string, name?: string): PolarTable {
  const raw: Array<{ tws: number; pairs: Array<[number, number]> }> = []
  let embeddedName: string | undefined
  let source: string | undefined
  let reference: PolarTable['reference'] = '10m'
  for (const line of text.split(/\r?\n/)) {
    const comment = commentOf(line)
    if (comment !== '') {
      const m = /^(polar|name|source|reference)\s*:\s*(.+)$/i.exec(comment)
      if (m) {
        const key = m[1].toLowerCase()
        const value = m[2].trim()
        if ((key === 'polar' || key === 'name') && embeddedName === undefined) {
          embeddedName = value
        } else if (key === 'source' && source === undefined) {
          source = value
        } else if (key === 'reference' && /masthead/i.test(value)) {
          reference = 'masthead'
        }
      }
    }
    const body = stripComment(line)
    if (body === '') continue
    const f = body.split(/[\s,;]+/).map(Number)
    if (f.length < 3 || f.some(Number.isNaN)) continue
    const pairs: Array<[number, number]> = []
    for (let i = 1; i + 1 < f.length; i += 2) pairs.push([f[i], f[i + 1]])
    raw.push({ tws: f[0], pairs })
  }
  if (raw.length === 0) throw new Error('parseExpeditionPolar: no data rows found')
  return finishTable(name ?? embeddedName ?? 'Polar', source, reference, raw)
}

/**
 * Write Expedition's native polar format, tab separated.
 *
 * Stable under repeated parse/serialise so a table can be saved, edited in Notepad and
 * reloaded without drifting.
 */
export function serialiseExpeditionPolar(p: PolarTable): string {
  const out: string[] = []
  out.push(`!Polar: ${p.name}`)
  if (p.source) out.push(`!Source: ${p.source}`)
  if (p.reference === 'masthead') out.push('!Reference: masthead')
  out.push('!TWS\tTWA\tBSP\tTWA\tBSP\t...')
  const n = Math.min(p.tws.length, p.rows.length)
  for (let i = 0; i < n; i++) {
    const row = p.rows[i]
    const cells: string[] = [num(p.tws[i])]
    const m = Math.min(row.twa.length, row.bsp.length)
    for (let j = 0; j < m; j++) {
      cells.push(num(row.twa[j]), num(row.bsp[j]))
    }
    out.push(cells.join('\t'))
  }
  return out.join('\n') + '\n'
}

function detectDelimiter(lines: string[]): RegExp {
  let tab = 0
  let semi = 0
  let comma = 0
  for (const l of lines) {
    for (const ch of l) {
      if (ch === '\t') tab++
      else if (ch === ';') semi++
      else if (ch === ',') comma++
    }
  }
  if (tab >= semi && tab >= comma && tab > 0) return /\t/
  if (semi >= comma && semi > 0) return /;/
  if (comma > 0) return /,/
  return /\s+/
}

function maxFinite(xs: number[]): number {
  let m = -Infinity
  for (const x of xs) if (Number.isFinite(x) && x > m) m = x
  return m
}

/**
 * Read a rectangular CSV polar — qtVlm `.pol`, ORC exports, anything Excel produced.
 *
 * Orientation is sniffed rather than assumed: TWA runs to 180 and TWS effectively never
 * does, so whichever axis exceeds 90 is the angle axis. The corner label (`twa\tws`) is
 * used as a tie-break, and qtVlm's convention (TWA down the side) is the fallback.
 * Delimiter is whichever of tab / `;` / `,` dominates the file.
 */
export function parseCsvPolar(text: string, name?: string): PolarTable {
  const all = text.split(/\r?\n/)
  let embeddedName: string | undefined
  for (const l of all) {
    const m = /^(polar|name)\s*:\s*(.+)$/i.exec(commentOf(l))
    if (m && embeddedName === undefined) embeddedName = m[2].trim()
  }
  const lines = all.map(stripComment).filter((l) => l !== '')
  if (lines.length < 2) throw new Error('parseCsvPolar: need a header row and at least one data row')
  const delim = detectDelimiter(lines)
  const cells = lines.map((l) => l.split(delim).map((c) => c.trim()))
  const header = cells[0]
  const headerNums = header.slice(1).map(Number)
  const firstCol = cells.slice(1).map((r) => Number(r[0]))
  const headerMax = maxFinite(headerNums)
  const colMax = maxFinite(firstCol)

  let headerIsTwa: boolean
  if (headerMax > 90 && !(colMax > 90)) headerIsTwa = true
  else if (colMax > 90 && !(headerMax > 90)) headerIsTwa = false
  else {
    // Ambiguous (a table that stops at 90, say). Fall back to the corner label: the
    // axis named first in `twa\tws` is the row axis.
    const corner = (header[0] ?? '').toLowerCase()
    const iTwa = corner.indexOf('twa')
    const iTws = corner.indexOf('tws')
    headerIsTwa = iTws >= 0 && (iTwa < 0 || iTws < iTwa)
  }

  const raw: Array<{ tws: number; pairs: Array<[number, number]> }> = []
  if (headerIsTwa) {
    // Columns are TWA, rows are TWS.
    for (let r = 1; r < cells.length; r++) {
      const row = cells[r]
      const tws = Number(row[0])
      if (!Number.isFinite(tws)) continue
      const pairs: Array<[number, number]> = []
      for (let c = 0; c < headerNums.length; c++) {
        const bsp = Number(row[c + 1])
        if (Number.isFinite(headerNums[c]) && Number.isFinite(bsp)) {
          pairs.push([headerNums[c], bsp])
        }
      }
      if (pairs.length > 0) raw.push({ tws, pairs })
    }
  } else {
    // Columns are TWS, rows are TWA — the qtVlm layout.
    for (let c = 0; c < headerNums.length; c++) {
      const tws = headerNums[c]
      if (!Number.isFinite(tws)) continue
      const pairs: Array<[number, number]> = []
      for (let r = 1; r < cells.length; r++) {
        const twa = Number(cells[r][0])
        const bsp = Number(cells[r][c + 1])
        if (Number.isFinite(twa) && Number.isFinite(bsp)) pairs.push([twa, bsp])
      }
      if (pairs.length > 0) raw.push({ tws, pairs })
    }
  }
  if (raw.length === 0) throw new Error('parseCsvPolar: no numeric data found')
  return finishTable(name ?? embeddedName ?? 'Polar', undefined, '10m', raw)
}

/**
 * Sniff the format and parse.
 *
 * The tell is that an Expedition row alternates TWA, BSP after the leading TWS, so the
 * odd-indexed fields (angles, up to 180) are much larger than the even-indexed ones
 * (speeds); in a rectangular CSV every field after the first is a speed and the two are
 * comparable. That beats guessing from delimiters, which both formats share.
 */
export function parsePolar(text: string, name?: string): PolarTable {
  const lines = text.split(/\r?\n/).map(stripComment).filter((l) => l !== '')
  if (lines.length === 0) throw new Error('parsePolar: empty input')
  const first = lines[0].split(/[\s,;]+/)
  if (first.length > 1 && Number.isNaN(Number(first[0]))) return parseCsvPolar(text, name)

  let expedition = 0
  let voted = 0
  for (const l of lines) {
    const f = l.split(/[\s,;]+/).map(Number)
    if (f.length < 3 || f.some(Number.isNaN)) continue
    voted++
    if (f.length % 2 === 0) continue
    let maxOdd = -Infinity
    let maxEven = -Infinity
    for (let i = 1; i < f.length; i += 2) if (f[i] > maxOdd) maxOdd = f[i]
    for (let i = 2; i < f.length; i += 2) if (f[i] > maxEven) maxEven = f[i]
    if (maxOdd > maxEven * 1.5) expedition++
  }
  return expedition * 2 >= voted && expedition > 0
    ? parseExpeditionPolar(text, name)
    : parseCsvPolar(text, name)
}

// ------------------------------------------------------- parametric generation

export type BoatType = 'dinghy' | 'sportboat' | 'keelboat' | 'cruiser' | 'multihull'

export interface BoatDims {
  loaM: number
  lwlM?: number
  beamM?: number
  dispKg?: number
  sailAreaM2?: number
  type: BoatType
}

const FT_PER_M = 1 / 0.3048

/** Classic displacement hull speed, 1.34 * sqrt(LWL in feet), knots. */
export function hullSpeedKn(lwlM: number): Knots {
  return 1.34 * Math.sqrt(Math.max(0.01, lwlM) * FT_PER_M)
}

/** Sail area / displacement ratio in the usual imperial-derived units. */
function sailAreaDispRatio(sailAreaM2: number, dispKg: number): number | undefined {
  if (!(sailAreaM2 > 0) || !(dispKg > 0)) return undefined
  const saFt2 = sailAreaM2 * 10.7639
  const volFt3 = (dispKg / 1025) * 35.3147
  return saFt2 / Math.pow(volFt3, 2 / 3)
}

/** Displacement / length ratio, long tons per (0.01 * LWL ft)^3. */
function dispLengthRatio(dispKg: number, lwlM: number): number | undefined {
  if (!(dispKg > 0) || !(lwlM > 0)) return undefined
  const tons = dispKg / 1016.047
  const lwlFt = lwlM * FT_PER_M
  return tons / Math.pow(0.01 * lwlFt, 3)
}

interface TypeTemplate {
  /** LWL as a fraction of LOA when the caller does not know LWL. */
  lwlFrac: number
  /** Displacement-mode asymptote, as a multiple of hull speed. */
  dispFactor: number
  /** Best speed once fully powered up / planing, as a multiple of hull speed. */
  maxFactor: number
  /** Wind-speed constant of the displacement response curve, knots. */
  kChar: number
  /** TWS at which the boat starts to plane or fly, and the span to full plane. */
  twsPlane: Knots
  planeSpan: Knots
  /** TWA at which the planing bonus starts to apply, and the span to full effect. */
  planeTwa: Degrees
  planeTwaSpan: Degrees
  /** Fraction of the planing bonus still available dead downwind. */
  ddwPlaneFloor: number
  /** Hard speed ceiling as a multiple of hull speed — the §4 validation gate. */
  ceilFactor: number
  /** Reference SA/D and D/L for the type, used to scale a boat off the archetype. */
  sadRef: number
  dlRef: number
  /** Plausible target windows, docs/02-data-sources/polars.md §4. */
  upTwaRange: readonly [Degrees, Degrees]
  downTwaRange: readonly [Degrees, Degrees]
  /** Displacement-mode shape: TWA -> speed as a fraction of the displacement peak. */
  shape: ReadonlyArray<readonly [Degrees, number]>
}

/**
 * Shape templates by boat type.
 *
 * Hand-authored from the characteristic shape of each family — not copied from any
 * licensed polar set. Calibrated so the archetype boat of each type (Laser, J/70, J/105,
 * a 40 ft production cruiser, an F18) lands within roughly 10 % of its real numbers at
 * the angles a sailor would check.
 *
 * `shape` is the **displacement-mode** curve, so its upwind values are high relative to
 * the peak; the planing bonus is added on top and weighted by angle, because that is what
 * actually happens — nothing planes upwind, and almost nothing planes dead downwind. A
 * single shape scaled by one peak speed cannot represent that, and gets a Laser wrong at
 * both ends of the wind range.
 *
 * Each list straddles the VMG optima on both sides so the derived target lands in the
 * interior of the interpolated curve rather than on a knot.
 */
const TEMPLATES: Record<BoatType, TypeTemplate> = {
  // Archetype: ILCA 7. Plans downwind from ~10 kn, hull-speed limited upwind.
  dinghy: {
    lwlFrac: 0.95,
    dispFactor: 1.19,
    maxFactor: 1.87,
    kChar: 4.4,
    twsPlane: 10,
    planeSpan: 11,
    planeTwa: 50,
    planeTwaSpan: 45,
    ddwPlaneFloor: 0.35,
    ceilFactor: 2.2,
    sadRef: 27,
    dlRef: 70,
    upTwaRange: [38, 55],
    downTwaRange: [130, 180],
    shape: [
      [35, 0.62],
      [40, 0.74],
      [45, 0.85],
      [50, 0.9],
      [60, 0.95],
      [70, 0.98],
      [80, 1.0],
      [90, 1.0],
      [100, 1.0],
      [110, 0.99],
      [120, 0.96],
      [135, 0.9],
      [150, 0.83],
      [165, 0.77],
      [180, 0.74],
    ],
  },
  // Archetype: J/70. Asymmetric kite, so downwind is hot and dead downwind is dreadful.
  sportboat: {
    lwlFrac: 0.92,
    dispFactor: 1.2,
    maxFactor: 2.4,
    kChar: 4.6,
    twsPlane: 10,
    planeSpan: 12,
    planeTwa: 55,
    planeTwaSpan: 45,
    ddwPlaneFloor: 0.15,
    ceilFactor: 2.8,
    sadRef: 26,
    dlRef: 114,
    upTwaRange: [36, 50],
    downTwaRange: [120, 165],
    shape: [
      [32, 0.58],
      [36, 0.7],
      [40, 0.8],
      [45, 0.87],
      [52, 0.93],
      [60, 0.96],
      [70, 0.98],
      [80, 1.0],
      [90, 1.0],
      [100, 1.0],
      [110, 0.99],
      [120, 0.97],
      [135, 0.93],
      [150, 0.84],
      [165, 0.72],
      [180, 0.64],
    ],
  },
  // Archetype: J/105. Surfs in breeze but never really planes.
  keelboat: {
    lwlFrac: 0.85,
    dispFactor: 1.04,
    maxFactor: 1.7,
    kChar: 4.0,
    twsPlane: 12,
    planeSpan: 14,
    planeTwa: 60,
    planeTwaSpan: 50,
    ddwPlaneFloor: 0.5,
    ceilFactor: 2.0,
    sadRef: 23.5,
    dlRef: 144,
    upTwaRange: [35, 50],
    downTwaRange: [130, 180],
    shape: [
      [32, 0.54],
      [36, 0.66],
      [40, 0.75],
      [45, 0.82],
      [52, 0.89],
      [60, 0.93],
      [70, 0.96],
      [80, 0.98],
      [90, 1.0],
      [100, 1.0],
      [110, 1.0],
      [120, 0.98],
      [135, 0.93],
      [150, 0.84],
      [165, 0.72],
      [180, 0.66],
    ],
  },
  // Archetype: a 12 m production cruiser. Points poorly, runs deep, rarely surfs.
  cruiser: {
    lwlFrac: 0.82,
    dispFactor: 0.98,
    maxFactor: 1.27,
    kChar: 5.0,
    twsPlane: 18,
    planeSpan: 16,
    planeTwa: 60,
    planeTwaSpan: 50,
    ddwPlaneFloor: 0.7,
    ceilFactor: 1.7,
    sadRef: 19.5,
    dlRef: 192,
    upTwaRange: [40, 60],
    downTwaRange: [135, 180],
    shape: [
      [36, 0.55],
      [40, 0.63],
      [45, 0.72],
      [50, 0.79],
      [60, 0.88],
      [70, 0.93],
      [80, 0.96],
      [90, 0.99],
      [100, 1.0],
      [110, 1.0],
      [120, 0.98],
      [135, 0.93],
      [150, 0.86],
      [165, 0.79],
      [180, 0.75],
    ],
  },
  // Archetype: Formula 18. An apparent-wind machine: the bonus applies upwind too, and
  // the speed collapses if you try to sail it deep.
  multihull: {
    lwlFrac: 0.96,
    dispFactor: 1.3,
    maxFactor: 3.5,
    kChar: 4.6,
    twsPlane: 2,
    planeSpan: 26,
    planeTwa: 10,
    planeTwaSpan: 50,
    ddwPlaneFloor: 0.18,
    ceilFactor: 4.2,
    sadRef: 45,
    dlRef: 54,
    upTwaRange: [35, 55],
    downTwaRange: [110, 160],
    shape: [
      [35, 0.55],
      [40, 0.7],
      [45, 0.8],
      [50, 0.87],
      [60, 0.95],
      [70, 0.99],
      [80, 1.0],
      [90, 1.0],
      [100, 0.99],
      [110, 0.97],
      [120, 0.93],
      [135, 0.85],
      [150, 0.7],
      [165, 0.56],
      [180, 0.5],
    ],
  },
}

/** TWS rows of a generated table. Below 4 kn the light-air ramp in `polarSpeed` takes over. */
const GENERATED_TWS: readonly Knots[] = [4, 6, 8, 10, 12, 14, 16, 20, 25, 30]

function smoothstep(x: number): number {
  const u = clamp(x, 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * How much of the planing bonus is available at this angle.
 *
 * Rises off zero somewhere past close-hauled — nothing planes upwind, which is why a
 * planing boat's upwind speed barely moves between 14 and 25 knots of breeze — and falls
 * away again toward dead downwind, where you have to give up apparent wind to get there.
 * The falling limb is what makes the generated downwind target angle move hotter as the
 * wind builds, which is the behaviour a real polar shows and a fixed shape cannot.
 */
function planeWeight(t: TypeTemplate, twa: Degrees): number {
  const rise = smoothstep((twa - t.planeTwa) / t.planeTwaSpan)
  const fall = 1 - (1 - t.ddwPlaneFloor) * smoothstep((twa - 130) / 50)
  return rise * fall
}

/**
 * Boat speed at one point of a generated polar: a saturating displacement curve, plus an
 * angle-weighted planing bonus that switches in over a wind band. One saturating curve
 * alone is wrong for planing boats at both ends — it hands a Melges 24 nine knots in six
 * of breeze and a Laser six knots upwind in twenty.
 */
function generatedSpeed(
  t: TypeTemplate,
  vHull: Knots,
  kChar: number,
  maxFactor: number,
  tws: Knots,
  twa: Degrees,
  ratio: number,
): Knots {
  const vDisp = vHull * t.dispFactor * (1 - Math.exp(-Math.pow(tws / kChar, 1.15)))
  const bonus =
    vHull *
    Math.max(0, maxFactor - t.dispFactor) *
    smoothstep((tws - t.twsPlane) / t.planeSpan) *
    planeWeight(t, twa)
  return ratio * (vDisp + bonus) * lightAirFactor(twa, tws)
}

/**
 * Light-air penalty at the angular extremes.
 *
 * Drifting conditions cost you disproportionately deep and disproportionately tight:
 * you cannot hold a kite by the lee at 2 knots and you cannot point. Applying it here
 * rather than by warping the shape keeps the effect monotone in TWS, which matters
 * because validatePolar checks exactly that.
 */
function lightAirFactor(twa: Degrees, tws: Knots): number {
  const lightness = clamp((7 - tws) / 7, 0, 1)
  const deep = clamp((twa - 110) / 70, 0, 1)
  const tight = clamp((55 - twa) / 25, 0, 1)
  return 1 - lightness * (0.28 * deep + 0.18 * tight)
}

/**
 * Build a plausible polar from boat dimensions alone.
 *
 * This is **not** measured data and must never be presented as such — it exists so that
 * a sailor who has never heard the word "polar" can route their first leg in 60 seconds
 * (docs/02-data-sources/polars.md §2.5, "the single most important onboarding decision
 * in the product"). Hull speed anchors the asymptote, a per-type shape template sets the
 * angles, and SA/D and D/L nudge light-air response and top-end speed when known. Every
 * adjustment is clamped so bad inputs produce a dull polar rather than an absurd one.
 */
export function generatePolar(dims: BoatDims, name?: string): PolarTable {
  const t = TEMPLATES[dims.type]
  if (t === undefined) throw new Error(`generatePolar: unknown boat type ${String(dims.type)}`)
  if (!Number.isFinite(dims.loaM) || !(dims.loaM > 0)) {
    throw new Error('generatePolar: loaM must be a positive length in metres')
  }
  const lwl =
    dims.lwlM !== undefined && dims.lwlM > 0 ? Math.min(dims.lwlM, dims.loaM) : dims.loaM * t.lwlFrac
  const vHull = hullSpeedKn(lwl)

  const sad = dims.sailAreaM2 !== undefined && dims.dispKg !== undefined
    ? sailAreaDispRatio(dims.sailAreaM2, dims.dispKg)
    : undefined
  const dl = dims.dispKg !== undefined ? dispLengthRatio(dims.dispKg, lwl) : undefined

  let kChar = t.kChar
  let maxFactor = t.maxFactor
  if (sad !== undefined && sad > 0) {
    // More sail per tonne means the boat comes alive earlier and tops out higher.
    kChar *= clamp(Math.pow(t.sadRef / sad, 0.35), 0.75, 1.35)
    maxFactor *= clamp(Math.pow(sad / t.sadRef, 0.15), 0.88, 1.15)
  }
  if (dl !== undefined && dl > 0) {
    maxFactor *= clamp(Math.pow(t.dlRef / dl, 0.1), 0.92, 1.1)
  }
  // Never let a nudge push the generated boat through its own validation ceiling.
  maxFactor = Math.min(maxFactor, t.ceilFactor * 0.92)
  const ceiling = vHull * t.ceilFactor

  const rows: PolarRow[] = GENERATED_TWS.map((tws) => {
    const twa: Degrees[] = []
    const bsp: Knots[] = []
    for (const [angle, r] of t.shape) {
      const v = Math.min(generatedSpeed(t, vHull, kChar, maxFactor, tws, angle, r), ceiling)
      twa.push(angle)
      bsp.push(Math.round(Math.max(0, v) * 100) / 100)
    }
    return { twa, bsp }
  })

  return {
    name: name ?? `${dims.type} ${Math.round(dims.loaM * 10) / 10} m (generated)`,
    tws: GENERATED_TWS.slice(),
    rows,
    reference: '10m',
    source: 'generated: parametric from dimensions, not measured (docs/02-data-sources/polars.md §2.5)',
  }
}

// ---------------------------------------------------------------- validation

export interface PolarIssue {
  severity: 'error' | 'warning'
  message: string
}

/** Generic target windows when the caller does not tell us what kind of boat this is. */
const GENERIC_UP_RANGE: readonly [Degrees, Degrees] = [30, 60]
const GENERIC_DOWN_RANGE: readonly [Degrees, Degrees] = [110, 180]
/** Absolute speed ceiling with no dimensions to work from — a foiling AC75 sanity bound. */
const GENERIC_CEILING_KN = 60

/**
 * Sanity checks from docs/02-data-sources/polars.md §4.
 *
 * A polar can be silently wrong in ways that still produce plausible-looking routes, and
 * the user will believe the route. Errors are things that make the table unusable;
 * warnings are things a human should look at — a real polar *can* fall off at the top
 * end as the boat de-powers, so that is flagged, not rejected.
 */
export function validatePolar(p: PolarTable, dims?: Partial<BoatDims>): PolarIssue[] {
  const issues: PolarIssue[] = []
  const err = (message: string) => issues.push({ severity: 'error', message })
  const warn = (message: string) => issues.push({ severity: 'warning', message })

  const n = Math.min(p.tws.length, p.rows.length)
  if (p.tws.length !== p.rows.length) {
    err(`table has ${p.tws.length} wind speeds but ${p.rows.length} rows`)
  }
  if (n === 0) {
    err('table has no wind speed rows')
    return issues
  }

  const template = dims?.type !== undefined ? TEMPLATES[dims.type] : undefined
  const lwl =
    dims?.lwlM !== undefined && dims.lwlM > 0
      ? dims.lwlM
      : dims?.loaM !== undefined && dims.loaM > 0 && template
        ? dims.loaM * template.lwlFrac
        : undefined
  const ceiling =
    lwl !== undefined && template ? hullSpeedKn(lwl) * template.ceilFactor : GENERIC_CEILING_KN

  // --- structure, and the §4 "non-zero at TWS = 0 -> reject" rule
  for (let i = 0; i < n; i++) {
    const tws = p.tws[i]
    const row = p.rows[i]
    if (!Number.isFinite(tws) || tws < 0) {
      err(`row ${i}: wind speed ${tws} is not a valid TWS`)
      continue
    }
    if (i > 0 && !(tws > p.tws[i - 1])) {
      err(`row ${i}: wind speeds must strictly increase (${p.tws[i - 1]} then ${tws})`)
    }
    if (row.twa.length !== row.bsp.length) {
      err(`row ${i} (${tws} kn): ${row.twa.length} angles but ${row.bsp.length} speeds`)
    }
    const m = Math.min(row.twa.length, row.bsp.length)
    if (m < 2) {
      warn(`row ${i} (${tws} kn): only ${m} breakpoint(s), interpolation will be flat`)
    }
    let maxBsp = 0
    for (let j = 0; j < m; j++) {
      const a = row.twa[j]
      const v = row.bsp[j]
      if (!Number.isFinite(a) || a < 0 || a > 180) {
        err(`row ${i} (${tws} kn): TWA ${a} is outside 0..180`)
      } else if (j > 0 && !(a > row.twa[j - 1])) {
        err(`row ${i} (${tws} kn): TWA must strictly increase (${row.twa[j - 1]} then ${a})`)
      }
      if (!Number.isFinite(v) || v < 0) {
        err(`row ${i} (${tws} kn): boat speed ${v} at TWA ${a} is not a valid speed`)
        continue
      }
      if (v > maxBsp) maxBsp = v
      if (v > ceiling) {
        err(
          `row ${i} (${tws} kn): ${v.toFixed(2)} kn at TWA ${a} exceeds the ` +
            `${ceiling.toFixed(1)} kn ceiling for this hull`,
        )
      }
    }
    if (tws === 0 && maxBsp > 0) {
      err(`row ${i}: the table claims ${maxBsp.toFixed(2)} kn of boat speed in zero wind`)
    }
    if (tws > 0 && m > 0 && maxBsp === 0) {
      warn(`row ${i} (${tws} kn): every boat speed is zero`)
    }
    // --- pronounced dents are almost always bad data.
    //
    // Deliberately *not* a plain "below the chord" test: a catamaran's deep-angle tail
    // is genuinely convex (speed collapses past 135 then flattens), and flagging that
    // trains the user to ignore the warnings. A dent is either a real local minimum —
    // the classic mistyped digit — or a point buried far under its own chord.
    for (let j = 1; j < m - 1; j++) {
      const x0 = row.twa[j - 1]
      const x1 = row.twa[j]
      const x2 = row.twa[j + 1]
      const v = row.bsp[j]
      if (!(x2 > x0) || maxBsp <= 0) continue
      const chord = row.bsp[j - 1] + ((row.bsp[j + 1] - row.bsp[j - 1]) * (x1 - x0)) / (x2 - x0)
      const localMin = v < Math.min(row.bsp[j - 1], row.bsp[j + 1]) * 0.98
      if (localMin || (chord > 0.1 && v < chord * 0.75)) {
        warn(
          `row ${i} (${tws} kn): dent at TWA ${x1} — ${v.toFixed(2)} kn sits ` +
            `${(100 * (1 - v / Math.max(chord, 1e-6))).toFixed(0)}% below its neighbours`,
        )
      }
    }
  }

  // --- monotone in TWS up to de-powering, compared only where both rows have data
  for (let i = 1; i < n; i++) {
    const lower = p.rows[i - 1]
    const upper = p.rows[i]
    if (lower.twa.length === 0 || upper.twa.length === 0) continue
    const from = Math.max(lower.twa[0], upper.twa[0])
    const to = Math.min(lower.twa[lower.twa.length - 1], upper.twa[upper.twa.length - 1])
    let worst = 0
    let worstTwa = 0
    for (const a of upper.twa) {
      if (a < from || a > to) continue
      const drop = rowSpeed(lower, a) - rowSpeed(upper, a)
      if (drop > worst) {
        worst = drop
        worstTwa = a
      }
    }
    if (worst > 0.05) {
      warn(
        `${p.tws[i]} kn is up to ${worst.toFixed(2)} kn slower than ${p.tws[i - 1]} kn ` +
          `(worst at TWA ${worstTwa}) — fine if the boat de-powers, otherwise bad data`,
      )
    }
  }

  // --- derived targets must land somewhere a sailor would recognise
  const upRange = template ? template.upTwaRange : GENERIC_UP_RANGE
  const downRange = template ? template.downTwaRange : GENERIC_DOWN_RANGE
  let upFlagged = false
  let downFlagged = false
  for (let i = 0; i < n; i++) {
    const tws = p.tws[i]
    if (tws < 6 || tws > 20) continue
    const t = deriveTargets(p, tws)
    if (!upFlagged && (t.upTwa < upRange[0] || t.upTwa > upRange[1])) {
      upFlagged = true
      warn(
        `upwind target ${t.upTwa.toFixed(1)}° at ${tws} kn is outside the plausible ` +
          `${upRange[0]}–${upRange[1]}° window`,
      )
    }
    if (!downFlagged && (t.downTwa < downRange[0] || t.downTwa > downRange[1])) {
      downFlagged = true
      warn(
        `downwind target ${t.downTwa.toFixed(1)}° at ${tws} kn is outside the plausible ` +
          `${downRange[0]}–${downRange[1]}° window`,
      )
    }
  }

  return issues
}
