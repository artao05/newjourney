/**
 * What leaving later costs you: one bar per departure, height = time lost.
 *
 * Plotted as cost *relative to the winner* rather than absolute ETA, because the
 * absolute numbers are all within a few percent of each other and a chart of them
 * is a flat line with a barely visible wobble. The decision is "how much worse is
 * this than the best", so that is the axis.
 *
 * Two things here are not decoration:
 *
 *  - The shaded band from zero up to the sweep's `stepFloorS`. Bars inside it
 *    differ by less than the router's own time step, so they have not been
 *    meaningfully distinguished — and because it is drawn as a band, bars inside
 *    it *look* indistinguishable, which is the truth. Without it a 4-minute bar
 *    next to a 0-minute bar reads as a real finding.
 *  - Failed departures get a marked full-height slot rather than being omitted.
 *    A gap in a bar chart reads as "nothing to see", when it actually means "no
 *    route at all from here" — which is the strongest possible reason not to leave
 *    then.
 *
 * Canvas scaffold (DPR clamp, ResizeObserver, module-level render, theme from CSS
 * variables) follows src/components/CurrentChart.tsx.
 */

import { useEffect, useRef } from 'react'
import type { DepartureSweep } from '@/lib/routing/departure'
import type { Millis } from '@/lib/types'

interface Props {
  sweep: DepartureSweep
  /** Departure currently selected, highlighted if present. */
  selected?: Millis | null
  height?: number
}

interface Theme {
  ink: string
  inkDim: string
  inkFaint: string
  line: string
  lineBright: string
  good: string
  bad: string
  accent: string
}

function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement)
  const v = (n: string, fallback: string) => s.getPropertyValue(n).trim() || fallback
  return {
    ink: v('--ink', '#eaf2fa'),
    inkDim: v('--ink-dim', '#8ba7c2'),
    inkFaint: v('--ink-faint', '#5b7794'),
    line: v('--line', '#1d3550'),
    lineBright: v('--line-bright', '#2f5578'),
    good: v('--stbd', '#35d07f'),
    bad: v('--port', '#ff4d4d'),
    accent: v('--accent', '#ffd54a'),
  }
}

export function DepartureChart({ sweep, selected = null, height = 148 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const parent = cv.parentElement
    if (!parent) return

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      const w = parent.clientWidth
      if (w <= 0) return
      cv.width = w * dpr
      cv.height = height * dpr
      cv.style.width = `${w}px`
      cv.style.height = `${height}px`
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      render(ctx, w, height, sweep, selected)
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [sweep, selected, height])

  return <canvas ref={ref} style={{ display: 'block' }} />
}

function fmtHm(ms: Millis): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Minutes, or hours and minutes once it stops fitting. */
function fmtCost(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

function render(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sweep: DepartureSweep,
  selected: Millis | null,
) {
  const c = readTheme()
  ctx.clearRect(0, 0, w, h)

  const padL = 30
  const padR = 8
  const padT = 16
  const padB = 26
  const plotW = Math.max(1, w - padL - padR)
  const plotH = Math.max(1, h - padT - padB)
  const n = sweep.options.length
  if (n === 0) return

  /*
   * The y range has to cover the failures too, and a failure has no cost. Giving
   * them the full height is the honest reading: no route from here at all is
   * worse than the worst route that exists.
   */
  const worstCost = sweep.options.reduce((m, d) => (d.costS != null ? Math.max(m, d.costS) : m), 0)
  // Never let the floor band fill the plot — if the whole spread is inside the
  // step, the band should read as "all of this is noise", not blank out the chart.
  const yMax = Math.max(60, worstCost, (sweep.stepFloorS ?? 0) * 1.35)
  const Y = (costS: number) => padT + plotH - (Math.min(costS, yMax) / yMax) * plotH
  const baseY = padT + plotH

  const slot = plotW / n
  const barW = Math.max(3, Math.min(28, slot * 0.68))

  // ---- the resolution floor, behind everything -----------------------------
  if (sweep.stepFloorS != null && sweep.stepFloorS > 0) {
    const top = Y(sweep.stepFloorS)
    ctx.fillStyle = c.lineBright
    ctx.globalAlpha = 0.22
    ctx.fillRect(padL, top, plotW, baseY - top)
    ctx.globalAlpha = 1
    ctx.strokeStyle = c.lineBright
    ctx.lineWidth = 1
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(padL, top)
    ctx.lineTo(padL + plotW, top)
    ctx.stroke()
    ctx.setLineDash([])
    // Only label it when there is room; the band is the message, the text is a
    // gloss on it.
    if (baseY - top > 13) {
      ctx.fillStyle = c.inkDim
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('below the router’s own resolution', padL + 4, top + 10)
    }
  }

  // ---- y axis --------------------------------------------------------------
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillStyle = c.inkFaint
  for (const frac of [0, 0.5, 1]) {
    const costS = yMax * frac
    const y = Y(costS)
    ctx.fillText(fmtCost(costS), padL - 5, y + 3)
    if (frac > 0) {
      ctx.strokeStyle = c.line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
    }
  }
  ctx.textAlign = 'left'
  ctx.fillStyle = c.inkDim
  ctx.fillText('min lost', padL, padT - 5)

  // ---- bars ----------------------------------------------------------------
  const bestAt = sweep.best?.departAt ?? null
  // Label every departure if they fit, otherwise every other one.
  const labelEvery = slot >= 34 ? 1 : slot >= 20 ? 2 : 3
  sweep.options.forEach((d, i) => {
    const cx = padL + slot * (i + 0.5)
    const x = cx - barW / 2
    const isBest = bestAt != null && d.departAt === bestAt
    const isSel = selected != null && d.departAt === selected

    if (d.costS == null) {
      // No route from this departure. Hatched full height, and marked.
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, padT, barW, plotH)
      ctx.clip()
      ctx.strokeStyle = c.bad
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 1
      for (let k = -plotH; k < barW + plotH; k += 5) {
        ctx.beginPath()
        ctx.moveTo(x + k, baseY)
        ctx.lineTo(x + k + plotH, padT)
        ctx.stroke()
      }
      ctx.restore()
      ctx.globalAlpha = 1
      ctx.strokeStyle = c.bad
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, padT + 0.5, barW - 1, plotH - 1)
      ctx.fillStyle = c.bad
      ctx.font = '600 10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('✕', cx, padT + plotH / 2 + 3)
    } else {
      const top = Y(d.costS)
      // A zero-cost winner still needs to be visible as a bar.
      const barH = Math.max(2, baseY - top)
      ctx.fillStyle = isBest ? c.good : c.ink
      ctx.globalAlpha = isBest ? 0.95 : 0.5
      ctx.fillRect(x, baseY - barH, barW, barH)
      ctx.globalAlpha = 1
      if (isBest) {
        ctx.fillStyle = c.good
        ctx.font = '600 9px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('BEST', cx, Math.max(padT - 5, baseY - barH - 4))
      }
    }

    if (isSel) {
      ctx.strokeStyle = c.accent
      ctx.lineWidth = 1.5
      ctx.strokeRect(x - 2.5, padT - 1.5, barW + 5, plotH + 3)
    }

    if (i % labelEvery === 0) {
      ctx.fillStyle = isBest ? c.good : c.inkFaint
      ctx.font = isBest ? '600 9px system-ui, sans-serif' : '9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(fmtHm(d.departAt), cx, h - 14)
    }
  })

  // ---- baseline ------------------------------------------------------------
  ctx.strokeStyle = c.lineBright
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padL, baseY)
  ctx.lineTo(padL + plotW, baseY)
  ctx.stroke()

  ctx.fillStyle = c.inkFaint
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('departure time (local)', padL + plotW / 2, h - 3)
}
