/**
 * The colour scale for a map data layer.
 *
 * Implements the second hard rule of docs/07-map-layers/render-architecture.md
 * §7: "Every layer renders its provenance." A colour field with no scale is
 * decoration, and one with no attribution is indistinguishable from a guess —
 * which is the one thing this project has decided it will not ship.
 *
 * Two deliberate details:
 *
 *   - The bar is painted from `rampToCssGradient` over the *same* domain the
 *     shader gets from `rampToLUT`. One source of truth, so the legend cannot
 *     drift from the pixels it is explaining.
 *   - When `source` is missing the component says so out loud rather than
 *     rendering a clean scale with no attribution, the same reasoning as the
 *     em-dash in `Tile.tsx`: an admitted gap beats an invisible one.
 */

import { useMemo } from 'react'
import { makeSampler, rampToCssGradient } from '@/lib/maplayers/colormap'
import type { ColorRamp } from '@/lib/maplayers/types'

interface Props {
  ramp: ColorRamp
  domain: [number, number]
  label: string
  unit: string
  source?: string
  compact?: boolean
}

interface Tick {
  /** Position along the bar, 0-100. */
  at: number
  text: string
}

/** Decimals that suit the domain's span — enough to separate ticks, no more. */
function decimalsFor(span: number): number {
  const s = Math.abs(span)
  if (s >= 20) return 0
  if (s >= 2) return 1
  return 2
}

/** Trim trailing zeros: 2 rather than 2.0, but 0.5 stays 0.5. */
const fmt = (x: number, dp: number): string => Number(x.toFixed(dp)).toString()

/**
 * Drop ticks that would collide. Both ends always survive: the top of the scale
 * is the number a sailor checks first, and a bar labelled only in the middle is
 * worse than one labelled sparsely.
 */
function thin(candidates: Tick[], minGap: number): Tick[] {
  if (candidates.length <= 2) return candidates
  const last = candidates[candidates.length - 1]
  const kept: Tick[] = [candidates[0]]
  for (let i = 1; i < candidates.length - 1; i++) {
    const t = candidates[i]
    if (t.at - kept[kept.length - 1].at < minGap) continue
    if (last.at - t.at < minGap) continue
    kept.push(t)
  }
  kept.push(last)
  return kept
}

const BAR_HEIGHT = 9

export function Legend({ ramp, domain, label, unit, source, compact }: Props) {
  const [lo, hi] = domain
  const dp = decimalsFor(hi - lo)

  /**
   * Discrete ramps get one block per class, sized by how much of the domain the
   * class actually covers. Equal-width blocks would be tidier and would lie: a
   * Beaufort force 0 spans one knot and a force 4 spans six.
   */
  const blocks = useMemo(() => {
    if (!ramp.discrete || hi <= lo) return null
    const sample = makeSampler(ramp)
    const out: Array<{ key: number; weight: number; color: string }> = []
    for (let i = 0; i < ramp.stops.length; i++) {
      const from = Math.max(lo, ramp.stops[i].value)
      const to = Math.min(hi, ramp.stops[i + 1]?.value ?? hi)
      if (to <= from) continue
      const [r, g, b] = sample(ramp.stops[i].value)
      out.push({ key: i, weight: to - from, color: `rgb(${r}, ${g}, ${b})` })
    }
    return out
  }, [ramp, lo, hi])

  const gradient = useMemo(() => rampToCssGradient(ramp, [lo, hi]), [ramp, lo, hi])

  const ticks = useMemo(() => {
    if (hi <= lo) return [{ at: 0, text: fmt(lo, dp) }]
    const pct = (v: number) => ((v - lo) / (hi - lo)) * 100
    const n = compact ? 3 : 5
    const candidates: Tick[] = ramp.discrete
      ? // Class boundaries, because those are the numbers the scale is made of.
        [
          { at: 0, text: fmt(lo, dp) },
          ...ramp.stops
            .filter((s) => s.value > lo && s.value <= hi)
            .map((s) => ({ at: pct(s.value), text: fmt(s.value, dp) })),
        ]
      : Array.from({ length: n }, (_, i) => {
          const f = i / (n - 1)
          return { at: f * 100, text: fmt(lo + (hi - lo) * f, dp) }
        })
    const kept = thin(candidates, compact ? 24 : 14)
    // The unit rides on the top tick instead of repeating on every one.
    const top = kept[kept.length - 1]
    if (top) kept[kept.length - 1] = { at: top.at, text: `${top.text} ${unit}` }
    return kept
  }, [ramp, lo, hi, dp, unit, compact])

  return (
    <div className="legend">
      <div style={{ marginBottom: 5 }}>
        <b>{label}</b>
      </div>

      {blocks ? (
        <div
          style={{
            display: 'flex',
            gap: 1,
            height: BAR_HEIGHT,
            background: 'var(--line)',
            border: '1px solid var(--line)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          {blocks.map((b) => (
            <div key={b.key} style={{ flexGrow: b.weight, background: b.color }} />
          ))}
        </div>
      ) : (
        <div
          style={{
            height: BAR_HEIGHT,
            background: gradient,
            border: '1px solid var(--line)',
            borderRadius: 3,
          }}
        />
      )}

      <div style={{ position: 'relative', height: 14, marginTop: 2 }}>
        {ticks.map((t) => (
          <span
            key={`${t.at}-${t.text}`}
            style={{
              position: 'absolute',
              left: `${t.at}%`,
              // Nudge the ends inward so neither label hangs off the bar.
              transform: `translateX(${t.at <= 0 ? 0 : t.at >= 100 ? -100 : -50}%)`,
              whiteSpace: 'nowrap',
              fontSize: 10,
              lineHeight: '14px',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t.text}
          </span>
        ))}
      </div>

      <div
        style={{
          fontSize: 9.5,
          lineHeight: 1.35,
          color: source ? 'var(--ink-faint)' : 'var(--warn)',
          marginTop: 2,
        }}
      >
        {source ?? 'source unknown'}
      </div>
    </div>
  )
}
