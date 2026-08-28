/**
 * Predicted tidal current at a station: the curve, and when it turns.
 *
 * The one question this answers is "when does the current change direction", which
 * is why slack is drawn as a hard vertical line and not left for the reader to
 * infer from where a curve happens to cross an axis.
 *
 * Signed along the station's flood/ebb axis — flood above the line, ebb below —
 * because at a reversing station the harmonic prediction *is* one signed number on
 * a fixed axis. Drawing it as a rotating vector would invent a continuity the
 * prediction does not contain. See src/lib/tides/coops.ts.
 *
 * Canvas scaffold (DPR clamp, ResizeObserver, module-level render) follows
 * src/components/PolarPlot.tsx, but takes its colours from the CSS variables in
 * styles.css rather than hardcoding hexes.
 */

import { useEffect, useRef } from 'react'
import type { CurrentPrediction } from '@/lib/tides/coops'
import type { Millis } from '@/lib/types'

interface Props {
  prediction: CurrentPrediction
  /** Time to mark, shared with the map and the timeline. */
  t: Millis
  /** Total width of the visible window, hours. */
  windowHours?: number
  height?: number
}

interface Theme {
  ink: string
  inkDim: string
  inkFaint: string
  line: string
  lineBright: string
  flood: string
  ebb: string
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
    // Flood makes for starboard-green and ebb for port-red purely so the two
    // halves are instantly separable; it carries no port/starboard meaning.
    flood: v('--stbd', '#35d07f'),
    ebb: v('--port', '#ff4d4d'),
    accent: v('--accent', '#ffd54a'),
  }
}

const HOUR = 3_600_000

export function CurrentChart({ prediction, t, windowHours = 12, height = 132 }: Props) {
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
      render(ctx, w, height, prediction, t, windowHours)
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [prediction, t, windowHours, height])

  return <canvas ref={ref} style={{ display: 'block' }} />
}

function fmtLocalHour(ms: Millis): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', hour12: true }).replace(' ', '')
}

function fmtHm(ms: Millis, utc: boolean): string {
  const d = new Date(ms)
  return utc
    ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function render(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: CurrentPrediction,
  t: Millis,
  windowHours: number,
) {
  const c = readTheme()
  ctx.clearRect(0, 0, w, h)

  const padL = 34
  const padR = 8
  const padT = 14
  const padB = 18
  const plotW = Math.max(1, w - padL - padR)
  const plotH = Math.max(1, h - padT - padB)

  /*
   * Floor the span, the way `plotW` and `plotH` are floored just above.
   *
   * A zero or negative window makes `t0 === t1`, so every x projection divides by
   * zero and NaN reaches `moveTo`. That does not throw and does not warn — a
   * non-finite coordinate simply draws nothing — so the chart would come out blank
   * with no error anywhere to explain it. One minute rather than something larger
   * so a caller asking for a genuinely short window still gets what it asked for.
   */
  const half = (Math.max(1 / 60, windowHours) * HOUR) / 2
  const t0 = t - half
  const t1 = t + half

  // Symmetric y range so the zero line sits in the middle and flood/ebb are
  // visually comparable. Floor at 1 kn so a neap day is not magnified into drama.
  let peak = 0.5
  for (const s of p.series) {
    if (s.t < t0 || s.t > t1) continue
    peak = Math.max(peak, Math.abs(s.kn))
  }
  const yMax = Math.max(1, Math.ceil(peak * 2) / 2)

  const X = (ms: Millis) => padL + ((ms - t0) / (t1 - t0)) * plotW
  const Y = (kn: number) => padT + plotH / 2 - (kn / yMax) * (plotH / 2)
  const zeroY = Y(0)

  // ---- hour gridlines -----------------------------------------------------
  ctx.strokeStyle = c.line
  ctx.lineWidth = 1
  ctx.font = '9px system-ui, sans-serif'
  ctx.fillStyle = c.inkFaint
  ctx.textAlign = 'center'
  const step = windowHours <= 6 ? 1 : windowHours <= 14 ? 2 : 4
  const firstHour = Math.ceil(t0 / HOUR) * HOUR
  for (let ms = firstHour; ms <= t1; ms += step * HOUR) {
    const x = X(ms)
    ctx.beginPath()
    ctx.moveTo(x, padT)
    ctx.lineTo(x, padT + plotH)
    ctx.stroke()
    ctx.fillText(fmtLocalHour(ms), x, h - 6)
  }

  // ---- y axis -------------------------------------------------------------
  ctx.textAlign = 'right'
  for (const kn of [yMax, yMax / 2, 0, -yMax / 2, -yMax]) {
    const y = Y(kn)
    ctx.fillStyle = c.inkFaint
    ctx.fillText(Math.abs(kn).toFixed(1), padL - 5, y + 3)
  }

  // ---- the curve, split at the zero line ---------------------------------
  const inWindow = p.series.filter((s) => s.t >= t0 - HOUR && s.t <= t1 + HOUR)
  if (inWindow.length > 1) {
    const fill = (sign: 1 | -1, colour: string) => {
      ctx.beginPath()
      ctx.moveTo(X(inWindow[0].t), zeroY)
      for (const s of inWindow) {
        const clipped = sign > 0 ? Math.max(0, s.kn) : Math.min(0, s.kn)
        ctx.lineTo(X(s.t), Y(clipped))
      }
      ctx.lineTo(X(inWindow[inWindow.length - 1].t), zeroY)
      ctx.closePath()
      ctx.fillStyle = colour
      ctx.globalAlpha = 0.22
      ctx.fill()
      ctx.globalAlpha = 1
    }
    fill(1, c.flood)
    fill(-1, c.ebb)

    ctx.beginPath()
    inWindow.forEach((s, i) => {
      const x = X(s.t)
      const y = Y(s.kn)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = c.ink
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  // ---- zero line ----------------------------------------------------------
  ctx.strokeStyle = c.lineBright
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padL, zeroY)
  ctx.lineTo(padL + plotW, zeroY)
  ctx.stroke()

  // ---- events: slack is the headline -------------------------------------
  const visible = p.events.filter((e) => e.t >= t0 && e.t <= t1)
  for (const e of visible) {
    const x = X(e.t)
    if (e.type === 'slack') {
      ctx.strokeStyle = c.accent
      ctx.lineWidth = 1.4
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, padT)
      ctx.lineTo(x, padT + plotH)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = c.accent
      ctx.font = '600 9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('SLACK', x, padT - 4)
      ctx.fillStyle = c.inkDim
      ctx.font = '9px system-ui, sans-serif'
      ctx.fillText(fmtHm(e.t, false), x, zeroY - 4)
    } else {
      const y = Y(e.kn)
      ctx.fillStyle = e.kn >= 0 ? c.flood : c.ebb
      ctx.beginPath()
      ctx.arc(x, y, 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '600 9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`${Math.abs(e.kn).toFixed(1)}`, x, e.kn >= 0 ? y - 6 : y + 12)
    }
  }

  // ---- flood / ebb axis labels -------------------------------------------
  ctx.font = '600 9px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = c.flood
  ctx.fillText(`FLOOD ${Math.round(p.floodDir)}°`, padL + 3, padT + 9)
  ctx.fillStyle = c.ebb
  ctx.fillText(`EBB ${Math.round(p.ebbDir)}°`, padL + 3, padT + plotH - 3)

  // ---- the displayed time -------------------------------------------------
  const xNow = X(t)
  if (xNow >= padL && xNow <= padL + plotW) {
    ctx.strokeStyle = c.ink
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(xNow, padT - 2)
    ctx.lineTo(xNow, padT + plotH + 2)
    ctx.stroke()
  }
}
