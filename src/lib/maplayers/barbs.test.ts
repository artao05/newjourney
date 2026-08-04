/**
 * Wind barb tests.
 *
 * These assert the *convention*, because that is the part that cannot be checked
 * by looking at the map: a mirrored barb, or one rotated by 180°, is a perfectly
 * plausible-looking picture and a wrong one. See
 * docs/07-map-layers/render-architecture.md §4.
 *
 * Only the SVG string and the bucketing are exercised. `barbToImageData` needs a
 * browser canvas by design, and its one testable property here is that it says
 * so instead of throwing a ReferenceError.
 */

import { describe, expect, it } from 'vitest'
import {
  CALM_ID,
  barbIdForSpeed,
  barbImageExpression,
  barbLayout,
  barbToImageData,
  buildBarbSprites,
} from './barbs'

const SPRITES = buildBarbSprites()
const SIZE = SPRITES[0].width

const byId = (id: string) => {
  const s = SPRITES.find((x) => x.id === id)
  if (!s) throw new Error(`no sprite ${id}`)
  return s
}

interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
}

function lines(svg: string): Seg[] {
  const out: Seg[] = []
  const re = /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    out.push({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] })
  }
  return out
}

function polygons(svg: string): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  const re = /<polygon points="([^"]+)"/g
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    out.push(
      m[1]
        .trim()
        .split(/\s+/)
        .map((p) => {
          const [x, y] = p.split(',')
          return [+x, +y] as [number, number]
        }),
    )
  }
  return out
}

/** The vertical shaft: the only line with x1 === x2. */
function shaft(svg: string): Seg {
  const s = lines(svg).find((l) => l.x1 === l.x2)
  if (!s) throw new Error('no shaft')
  return s
}

/** Everything except the shaft. */
const feathers = (svg: string): Seg[] => lines(svg).filter((l) => l.x1 !== l.x2)

describe('barbIdForSpeed', () => {
  it('buckets to the nearest 5 knots, with calm below 3', () => {
    const cases: Array<[number, string]> = [
      [0, CALM_ID],
      [2, CALM_ID],
      [2.99, CALM_ID],
      [3, 'barb-05'],
      [5, 'barb-05'],
      [7.4, 'barb-05'],
      [7.5, 'barb-10'],
      [10, 'barb-10'],
      [12.4, 'barb-10'],
      [12.5, 'barb-15'],
      [47, 'barb-45'],
      [50, 'barb-50'],
      [52, 'barb-50'],
      [52.5, 'barb-55'],
      [75, 'barb-75'],
      [120, 'barb-75'],
    ]
    for (const [kn, id] of cases) expect(barbIdForSpeed(kn), `${kn} kn`).toBe(id)
  })

  it('treats a non-finite speed as calm rather than inventing a stem', () => {
    expect(barbIdForSpeed(NaN)).toBe(CALM_ID)
    expect(barbIdForSpeed(-4)).toBe(CALM_ID)
  })

  it('only ever names a sprite that exists', () => {
    const ids = new Set(SPRITES.map((s) => s.id))
    for (let kn = 0; kn <= 130; kn += 0.25) {
      expect(ids.has(barbIdForSpeed(kn)), `${kn} kn`).toBe(true)
    }
  })
})

describe('barbLayout', () => {
  it('decomposes speed into pennants, full barbs and half barbs', () => {
    expect(barbLayout(2)).toEqual({ pennants: 0, fulls: 0, halves: 0 })
    expect(barbLayout(5)).toEqual({ pennants: 0, fulls: 0, halves: 1 })
    expect(barbLayout(10)).toEqual({ pennants: 0, fulls: 1, halves: 0 })
    expect(barbLayout(15)).toEqual({ pennants: 0, fulls: 1, halves: 1 })
    // 47 kn rounds to 45: four full barbs and a half. Not a pennant.
    expect(barbLayout(47)).toEqual({ pennants: 0, fulls: 4, halves: 1 })
    expect(barbLayout(50)).toEqual({ pennants: 1, fulls: 0, halves: 0 })
    expect(barbLayout(52)).toEqual({ pennants: 1, fulls: 0, halves: 0 })
    expect(barbLayout(65)).toEqual({ pennants: 1, fulls: 1, halves: 1 })
    expect(barbLayout(75)).toEqual({ pennants: 1, fulls: 2, halves: 1 })
  })

  it('always sums back to the bucket speed', () => {
    for (let kn = 3; kn <= 75; kn += 0.5) {
      const l = barbLayout(kn)
      const total = l.pennants * 50 + l.fulls * 10 + l.halves * 5
      expect(total, `${kn} kn`).toBe(Math.min(75, Math.round(kn / 5) * 5))
      expect(l.halves).toBeLessThanOrEqual(1)
      expect(l.fulls).toBeLessThanOrEqual(4)
    }
  })
})

describe('buildBarbSprites', () => {
  it('covers 0..75+ kn in 5-knot buckets', () => {
    expect(SPRITES).toHaveLength(16)
    expect(SPRITES[0].id).toBe(CALM_ID)
    expect(SPRITES[SPRITES.length - 1].id).toBe('barb-75')
    expect(new Set(SPRITES.map((s) => s.id)).size).toBe(SPRITES.length)
  })

  it('has contiguous bands with no gap and no overlap', () => {
    expect(SPRITES[0].minKn).toBe(0)
    for (let i = 1; i < SPRITES.length; i++) {
      expect(SPRITES[i].minKn, SPRITES[i].id).toBe(SPRITES[i - 1].maxKn)
    }
    expect(SPRITES[SPRITES.length - 1].maxKn).toBe(Infinity)
  })

  it('agrees with barbIdForSpeed on every band', () => {
    for (const s of SPRITES) {
      const inside = Number.isFinite(s.maxKn) ? (s.minKn + s.maxKn) / 2 : 90
      expect(barbIdForSpeed(inside), s.id).toBe(s.id)
      expect(barbIdForSpeed(s.minKn), `${s.id} lower edge`).toBe(s.id)
    }
  })

  it('draws calm as a bare circle with no stem', () => {
    const svg = byId(CALM_ID).svg
    expect(svg).toContain('<circle')
    expect(lines(svg)).toHaveLength(0)
    expect(polygons(svg)).toHaveLength(0)
  })

  it('gives a 47 kn wind four full barbs and one half barb', () => {
    const svg = byId(barbIdForSpeed(47)).svg
    expect(polygons(svg)).toHaveLength(0)
    const f = feathers(svg)
    expect(f).toHaveLength(5)
    // The half barb is the short one, and it is the innermost feather.
    const lengths = f.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1))
    const full = Math.max(...lengths)
    expect(lengths.filter((l) => l > full * 0.9)).toHaveLength(4)
    const half = f[f.length - 1]
    expect(Math.hypot(half.x2 - half.x1, half.y2 - half.y1)).toBeCloseTo(full / 2, 2)
  })

  it('draws a pennant for 50 kn and keeps pennants outermost', () => {
    const p50 = polygons(byId('barb-50').svg)
    expect(p50).toHaveLength(1)
    expect(feathers(byId('barb-50').svg)).toHaveLength(0)

    const svg75 = byId('barb-75').svg
    const p75 = polygons(svg75)
    expect(p75).toHaveLength(1)
    expect(feathers(svg75)).toHaveLength(3) // 2 full + 1 half
    // Outermost means nearest the tip, and the tip is the small-y end.
    const pennantY = Math.min(...p75[0].map(([, y]) => y))
    for (const f of feathers(svg75)) expect(f.y1).toBeGreaterThan(pennantY)
  })

  it('insets a lone half barb from the tip', () => {
    // A 5 kn half barb drawn at the very tip reads as a full barb at a glance.
    const tip = shaft(byId('barb-05').svg).y2
    const half = feathers(byId('barb-05').svg)[0]
    expect(half.y1).toBeGreaterThan(tip)
    // The 10 kn full barb, by contrast, sits on the tip.
    expect(feathers(byId('barb-10').svg)[0].y1).toBeCloseTo(tip, 6)
  })

  it('points the stem up from a centred station, so icon-rotate is the FROM direction', () => {
    for (const s of SPRITES) {
      if (s.id === CALM_ID) continue
      const st = shaft(s.svg)
      expect(st.x1, s.id).toBeCloseTo(SIZE / 2, 6)
      expect(st.y1, s.id).toBeCloseTo(SIZE / 2, 6) // station at the centre
      expect(st.y2, s.id).toBeLessThan(st.y1) // and the shaft runs up
    }
  })

  it('hangs every feather off the right of the stem (northern hemisphere)', () => {
    const c = SIZE / 2
    for (const s of SPRITES) {
      for (const f of feathers(s.svg)) {
        expect(f.x1, s.id).toBeCloseTo(c, 6)
        expect(f.x2, s.id).toBeGreaterThan(c)
      }
      for (const p of polygons(s.svg)) {
        expect(Math.max(...p.map(([x]) => x)), s.id).toBeGreaterThan(c)
        expect(Math.min(...p.map(([x]) => x)), s.id).toBeCloseTo(c, 6)
      }
    }
  })

  it('keeps all ink inside the sprite box', () => {
    for (const s of SPRITES) {
      expect(s.width).toBe(SIZE)
      expect(s.height).toBe(SIZE)
      const pts: number[][] = [
        ...lines(s.svg).flatMap((l) => [
          [l.x1, l.y1],
          [l.x2, l.y2],
        ]),
        ...polygons(s.svg).flat(),
      ]
      for (const [x, y] of pts) {
        expect(x, s.id).toBeGreaterThanOrEqual(0)
        expect(x, s.id).toBeLessThanOrEqual(SIZE)
        expect(y, s.id).toBeGreaterThanOrEqual(0)
        expect(y, s.id).toBeLessThanOrEqual(SIZE)
      }
    }
  })

  it('honours size, colour and stroke width', () => {
    const custom = buildBarbSprites({ size: 64, color: '#ff00aa', strokeWidth: 3 })
    expect(custom[0].width).toBe(64)
    expect(custom[0].svg).toContain('width="64"')
    expect(custom[0].svg).toContain('#ff00aa')
    const s50 = custom.find((s) => s.id === 'barb-50')
    expect(s50?.svg).toContain('stroke-width="3"')
    expect(shaft(custom[1].svg).x1).toBeCloseTo(32, 6)
  })

  it('produces well-formed standalone SVG', () => {
    for (const s of SPRITES) {
      expect(s.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), s.id).toBe(true)
      expect(s.svg.endsWith('</svg>'), s.id).toBe(true)
      expect(s.svg, s.id).toContain(`viewBox="0 0 ${SIZE} ${SIZE}"`)
      expect(s.svg, s.id).not.toContain('NaN')
    }
  })
})

describe('barbImageExpression', () => {
  const expr = barbImageExpression('kn')

  it('is a step expression on the given property', () => {
    expect(expr[0]).toBe('step')
    expect(expr[1]).toEqual(['get', 'kn'])
    expect(expr[2]).toBe(CALM_ID)
  })

  it('has ascending break points starting at the calm threshold', () => {
    const breaks = expr.slice(3).filter((_, i) => i % 2 === 0) as number[]
    expect(breaks[0]).toBe(3)
    expect(breaks[1]).toBe(7.5)
    expect(breaks).toHaveLength(15)
    for (let i = 1; i < breaks.length; i++) expect(breaks[i]).toBeGreaterThan(breaks[i - 1])
  })

  it('evaluates to the same sprite as barbIdForSpeed', () => {
    // Hand-evaluate the `step` semantics: the base output, then the last break
    // that the input has reached.
    const evalStep = (kn: number): string => {
      let out = expr[2] as string
      for (let i = 3; i < expr.length; i += 2) {
        if (kn >= (expr[i] as number)) out = expr[i + 1] as string
      }
      return out
    }
    for (let kn = 0; kn <= 100; kn += 0.25) {
      expect(evalStep(kn), `${kn} kn`).toBe(barbIdForSpeed(kn))
    }
  })
})

describe('barbToImageData', () => {
  it('fails with a clear message outside a browser', async () => {
    await expect(barbToImageData(SPRITES[0])).rejects.toThrow(/browser/)
  })
})
