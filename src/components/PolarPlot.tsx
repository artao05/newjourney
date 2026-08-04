/**
 * A polar diagram.
 *
 * This exists because sailors can spot a wrong polar visually in one second and
 * cannot spot it in a table — see docs/02-data-sources/polars.md §4. Showing the
 * curve at import time is the cheapest validation we have.
 */

import { useEffect, useRef } from 'react'
import type { PolarLattice } from '@/lib/types'

interface Props {
  lattice: PolarLattice | null
  /** Wind speeds to draw. */
  speeds?: number[]
  height?: number
}

const DEFAULT_SPEEDS = [6, 10, 14, 20]
const COLOURS = ['#4fc3f7', '#35d07f', '#ffd54a', '#ff8a4a', '#ff4d4d']

export function PolarPlot({ lattice, speeds = DEFAULT_SPEEDS, height = 230 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !lattice) return
    const parent = cv.parentElement
    if (!parent) return

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      const w = parent.clientWidth
      const h = height
      cv.width = w * dpr
      cv.height = h * dpr
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      render(ctx, w, h, lattice, speeds)
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [lattice, speeds, height])

  if (!lattice) return null
  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={ref} style={{ display: 'block' }} />
    </div>
  )
}

function render(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lat: PolarLattice,
  speeds: number[],
) {
  ctx.clearRect(0, 0, w, h)

  // Find the fastest speed we'll draw, to scale the radius.
  let vmax = 0
  for (const tws of speeds) {
    for (let a = 0; a <= 180; a += 2) vmax = Math.max(vmax, lat.speed(tws, a))
  }
  if (vmax <= 0) return
  vmax = Math.ceil(vmax)

  const cx = w / 2
  const cy = h - 16
  const R = Math.min(w / 2 - 26, h - 34)
  const rOf = (v: number) => (v / vmax) * R
  // 0° TWA points up; the diagram is mirrored so both tacks show.
  const pt = (twa: number, v: number) => {
    const a = (twa * Math.PI) / 180
    return { x: cx + Math.sin(a) * rOf(v), y: cy - Math.cos(a) * rOf(v) }
  }

  // ---- speed rings --------------------------------------------------------
  ctx.strokeStyle = '#16304a'
  ctx.fillStyle = '#5b7794'
  ctx.font = '9px system-ui, sans-serif'
  ctx.lineWidth = 1
  const ringStep = vmax <= 8 ? 2 : vmax <= 16 ? 4 : 5
  for (let v = ringStep; v <= vmax; v += ringStep) {
    ctx.beginPath()
    ctx.arc(cx, cy, rOf(v), Math.PI, 2 * Math.PI)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillText(`${v}`, cx, cy - rOf(v) + 10)
  }

  // ---- angle spokes -------------------------------------------------------
  for (let a = 0; a <= 180; a += 30) {
    const p = pt(a, vmax)
    ctx.strokeStyle = a === 0 || a === 180 ? '#1d3550' : '#12283f'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    if (a % 60 === 0 && a !== 0) {
      ctx.fillStyle = '#5b7794'
      ctx.textAlign = a < 90 ? 'left' : a > 90 ? 'right' : 'center'
      const q = pt(a, vmax * 1.06)
      ctx.fillText(`${a}°`, q.x, q.y)
    }
  }

  // ---- the curves ---------------------------------------------------------
  speeds.forEach((tws, i) => {
    const colour = COLOURS[i % COLOURS.length]
    ctx.strokeStyle = colour
    ctx.lineWidth = 2
    ctx.beginPath()
    let started = false
    for (let a = 0; a <= 180; a += 1) {
      const v = lat.speed(tws, a)
      const p = pt(a, v)
      if (!started) {
        ctx.moveTo(p.x, p.y)
        started = true
      } else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()

    // Target points — the whole reason the diagram is worth looking at.
    const t = lat.targetsAt(tws)
    for (const [twa, bsp] of [
      [t.upTwa, t.upBsp],
      [t.downTwa, t.downBsp],
    ] as const) {
      const p = pt(twa, bsp)
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
      ctx.fill()
    }

    // Legend
    ctx.fillStyle = colour
    ctx.textAlign = 'left'
    ctx.font = '600 10px system-ui, sans-serif'
    ctx.fillText(`${tws} kn`, 6, 14 + i * 13)
  })

  ctx.fillStyle = '#5b7794'
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('dots = VMG targets', w - 6, 14)
}
