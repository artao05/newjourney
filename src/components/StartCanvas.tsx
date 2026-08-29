/**
 * The chart-less start display.
 *
 * Modelled on the layout described in docs/03-algorithms/start-line-math.md §6:
 * port end left, starboard end right, laylines from each end, bias line above
 * the line, boat-length grid, COG and heading predictors — and everything
 * declutters one minute after the gun, which is the detail that marks the
 * original out as designed by someone who has actually done this.
 */

import { useEffect, useRef } from 'react'
import { LocalFrame, fromPolar, nmToM, mToNm } from '@/lib/geo'
import { courseFor, wrap360 } from '@/lib/angles'
import type {
  Boat,
  BoatState,
  StartLine,
  StartNumbers,
  TrackPoint,
  WindEstimate,
  XY,
} from '@/lib/types'

interface Props {
  line: StartLine
  state: BoatState | null
  wind: WindEstimate | null
  numbers: StartNumbers
  boat: Boat
  track: TrackPoint[]
  /** Upwind target angle for the laylines; falls back to a generic 42°. */
  targetTwa?: number
  secondsSinceGun: number | null
}

export function StartCanvas(props: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const parent = cv.parentElement
    if (!parent) return

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      const w = parent.clientWidth
      const h = parent.clientHeight
      /*
       * Nothing to draw in a box with no area, and the same guard PolarPlot,
       * CurrentChart and DepartureChart all carry. This was the last of the four
       * without it.
       *
       * Harmless here today, and only by accident: every `arc` radius below is a
       * constant, and `scale` at w === 0 collapses to 0 rather than dividing by
       * zero, so the picture degenerates to a point instead of throwing. PolarPlot
       * was not so lucky - its ring radii are derived from the width, went negative,
       * and `ctx.arc` threw IndexSizeError from inside an effect, which unmounted
       * the tree and let the error boundary replace the entire Setup screen. The
       * one radius someone later derives from `w` in here would do the same to the
       * Start screen, which is the one screen this app exists for.
       *
       * Reachable whenever the pane has not been laid out at first paint: a
       * collapsed container, a display:none ancestor, a zero-size viewport.
       */
      if (w <= 0 || h <= 0) return
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr
        cv.height = h * dpr
      }
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      render(ctx, w, h, props)
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [props])

  return <canvas ref={ref} />
}

function render(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: Props,
) {
  ctx.fillStyle = '#050d16'
  ctx.fillRect(0, 0, w, h)

  const { line, state, wind, numbers, boat, track } = p
  const declutter = p.secondsSinceGun != null && p.secondsSinceGun > 60

  if (!line.port || !line.starboard) {
    drawHint(ctx, w, h, 'Ping both ends of the line to begin')
    return
  }

  // ---- build the local frame, oriented so the line runs across the screen --
  const mid = {
    lat: (line.port.lat + line.starboard.lat) / 2,
    lon: (line.port.lon + line.starboard.lon) / 2,
  }
  const frame = new LocalFrame(mid)
  const pPort = frame.toXY(line.port)
  const pStbd = frame.toXY(line.starboard)

  // Rotate so port end is left, starboard end right (manual §6).
  const lineAng = Math.atan2(pStbd.x - pPort.x, pStbd.y - pPort.y)
  const rot = (v: XY): XY => {
    // Rotate the world so the line vector points to screen +x.
    const c = Math.cos(lineAng)
    const s = Math.sin(lineAng)
    return { x: v.x * s + v.y * c, y: -v.x * c + v.y * s }
  }

  const pts: XY[] = [rot(pPort), rot(pStbd)]
  const boatXY = state ? rot(frame.toXY(state.position)) : null
  if (boatXY) pts.push(boatXY)

  // ---- fit a view around everything of interest ---------------------------
  const lineLenNm = Math.hypot(pStbd.x - pPort.x, pStbd.y - pPort.y)
  const pad = Math.max(lineLenNm * 0.35, mToNm(40))
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const q of pts) {
    minX = Math.min(minX, q.x)
    maxX = Math.max(maxX, q.x)
    minY = Math.min(minY, q.y)
    maxY = Math.max(maxY, q.y)
  }
  minX -= pad
  maxX += pad
  minY -= pad * 1.5
  maxY += pad * 0.7

  const scale = Math.min(w / (maxX - minX), h / (maxY - minY))
  const ox = w / 2 - ((minX + maxX) / 2) * scale
  const oy = h / 2 + ((minY + maxY) / 2) * scale

  const S = (v: XY) => ({ px: ox + v.x * scale, py: oy - v.y * scale })
  const nmPerPx = 1 / scale
  const blNm = mToNm(boat.loaMetres)

  // ---- boat-length grid ---------------------------------------------------
  if (!declutter && blNm / nmPerPx > 9) {
    ctx.strokeStyle = '#0f2136'
    ctx.lineWidth = 1
    const startX = Math.floor(minX / blNm) * blNm
    for (let x = startX; x <= maxX; x += blNm) {
      const { px } = S({ x, y: 0 })
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, h)
      ctx.stroke()
    }
    const startY = Math.floor(minY / blNm) * blNm
    for (let y = startY; y <= maxY; y += blNm) {
      const { py } = S({ x: 0, y })
      ctx.beginPath()
      ctx.moveTo(0, py)
      ctx.lineTo(w, py)
      ctx.stroke()
    }
  }

  const a = S(pts[0])
  const b = S(pts[1])

  // ---- track --------------------------------------------------------------
  if (track.length > 1 && !declutter) {
    ctx.strokeStyle = 'rgba(120,170,220,0.35)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    let started = false
    for (let i = Math.max(0, track.length - 900); i < track.length; i++) {
      const q = S(rot(frame.toXY({ lat: track[i].lat, lon: track[i].lon })))
      if (!started) {
        ctx.moveTo(q.px, q.py)
        started = true
      } else ctx.lineTo(q.px, q.py)
    }
    ctx.stroke()
  }

  // ---- laylines from each end --------------------------------------------
  const targetTwa = p.targetTwa ?? 42
  if (wind && !declutter) {
    const lay = (fromEnd: XY, twaSign: 1 | -1, colour: string) => {
      const courseUp = courseFor(wind.twd, twaSign * targetTwa)
      // Draw the layline back down-course from the end.
      const dir = rot(fromPolar(wrap360(courseUp + 180), 1))
      const len = Math.max(maxX - minX, maxY - minY) * 1.5
      const s0 = S(fromEnd)
      const s1 = S({ x: fromEnd.x + dir.x * len, y: fromEnd.y + dir.y * len })
      ctx.strokeStyle = colour
      ctx.lineWidth = 1.4
      ctx.setLineDash([7, 6])
      ctx.beginPath()
      ctx.moveTo(s0.px, s0.py)
      ctx.lineTo(s1.px, s1.py)
      ctx.stroke()
      ctx.setLineDash([])
    }
    lay(pts[0], -1, 'rgba(255,77,77,0.5)')
    lay(pts[0], 1, 'rgba(53,208,127,0.34)')
    lay(pts[1], 1, 'rgba(53,208,127,0.5)')
    lay(pts[1], -1, 'rgba(255,77,77,0.34)')
  }

  // ---- the line -----------------------------------------------------------
  ctx.strokeStyle = '#e8f1fa'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(a.px, a.py)
  ctx.lineTo(b.px, b.py)
  ctx.stroke()

  // Extensions, dimmed — you can be over early past the end of the line.
  ctx.strokeStyle = 'rgba(232,241,250,0.16)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 7])
  ctx.beginPath()
  ctx.moveTo(a.px - (b.px - a.px) * 0.6, a.py - (b.py - a.py) * 0.6)
  ctx.lineTo(a.px, a.py)
  ctx.moveTo(b.px, b.py)
  ctx.lineTo(b.px + (b.px - a.px) * 0.6, b.py + (b.py - a.py) * 0.6)
  ctx.stroke()
  ctx.setLineDash([])

  // ---- bias indicator above the line -------------------------------------
  if (numbers.biasAngleDeg != null && Math.abs(numbers.biasAngleDeg) > 0.5 && !declutter) {
    const favStbd = numbers.biasAngleDeg > 0
    const end = favStbd ? b : a
    ctx.fillStyle = favStbd ? '#35d07f' : '#ff4d4d'
    ctx.beginPath()
    ctx.arc(end.px, end.py, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = '700 12px system-ui, sans-serif'
    ctx.textAlign = favStbd ? 'right' : 'left'
    ctx.fillText(
      `${Math.abs(numbers.biasAngleDeg).toFixed(0)}°  ${
        numbers.biasLengthM != null
          ? `${(numbers.biasLengthM / Math.max(1, boat.loaMetres)).toFixed(1)} BL`
          : ''
      }`,
      favStbd ? end.px - 14 : end.px + 14,
      end.py - 12,
    )
  }

  // ---- end markers --------------------------------------------------------
  const endMark = (s: { px: number; py: number }, colour: string, label: string) => {
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(s.px, s.py, 5.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = '700 10px system-ui, sans-serif'
    ctx.fillStyle = 'rgba(234,242,250,0.75)'
    ctx.textAlign = 'center'
    ctx.fillText(label, s.px, s.py + 20)
  }
  endMark(a, '#ff4d4d', 'PIN')
  endMark(b, '#35d07f', 'RC')

  // ---- wind arrow ---------------------------------------------------------
  if (wind) {
    const wDir = rot(fromPolar(wrap360(wind.twd + 180), 1))
    const cx = w - 44
    const cy = 44
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(Math.atan2(wDir.x, wDir.y))
    ctx.strokeStyle = '#4fc3f7'
    ctx.fillStyle = '#4fc3f7'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, 20)
    ctx.lineTo(0, -14)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, -20)
    ctx.lineTo(-5.5, -9)
    ctx.lineTo(5.5, -9)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
    ctx.font = '600 10px system-ui, sans-serif'
    ctx.fillStyle = '#4fc3f7'
    ctx.textAlign = 'center'
    ctx.fillText(`${wind.twd.toFixed(0)}° ${wind.tws.toFixed(0)}kn`, cx, cy + 36)
  }

  // ---- the boat -----------------------------------------------------------
  if (state && boatXY) {
    const s = S(boatXY)
    const hdg = state.heading ?? state.cog
    const hv = rot(fromPolar(hdg, 1))
    // A stationary GPS reports no course, so `hdg` can legitimately be NaN. A NaN
    // rotation makes the hull disappear, which reads as a broken app rather than
    // as an unknown heading, so the marker falls back to bow-up and the shape
    // below switches to a circle: position known, heading not.
    const known = Number.isFinite(hdg)
    const ang = known ? Math.atan2(hv.x, hv.y) : 0

    // COG predictor: where you'll be in 30 s at current SOG.
    if (state.sog > 0.2) {
      const cv = rot(fromPolar(state.cog, (state.sog * 30) / 3600))
      const tip = S({ x: boatXY.x + cv.x, y: boatXY.y + cv.y })
      ctx.strokeStyle = 'rgba(79,195,247,0.85)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(s.px, s.py)
      ctx.lineTo(tip.px, tip.py)
      ctx.stroke()
      ctx.fillStyle = 'rgba(79,195,247,0.85)'
      ctx.beginPath()
      ctx.arc(tip.px, tip.py, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Hull, scaled to real boat length so the grid means something.
    const lenPx = Math.max(14, blNm * scale)
    ctx.save()
    ctx.translate(s.px, s.py)
    ctx.rotate(ang)
    ctx.fillStyle = numbers.ocs ? '#ff4d4d' : '#ffd54a'
    ctx.beginPath()
    if (known) {
      ctx.moveTo(0, -lenPx * 0.5)
      ctx.quadraticCurveTo(lenPx * 0.19, -lenPx * 0.1, lenPx * 0.15, lenPx * 0.42)
      ctx.lineTo(-lenPx * 0.15, lenPx * 0.42)
      ctx.quadraticCurveTo(-lenPx * 0.19, -lenPx * 0.1, 0, -lenPx * 0.5)
    } else {
      // No bow, because there is no bow direction to point.
      ctx.arc(0, 0, lenPx * 0.3, 0, Math.PI * 2)
    }
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // ---- distance-below-line readout on the line ---------------------------
  if (numbers.distanceBelowLineBoatLengths != null && state && boatXY && !declutter) {
    const s = S(boatXY)
    const foot = S({ x: boatXY.x, y: 0 })
    ctx.strokeStyle = numbers.ocs ? 'rgba(255,77,77,0.8)' : 'rgba(234,242,250,0.3)'
    ctx.lineWidth = 1.2
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(s.px, s.py)
    ctx.lineTo(foot.px, foot.py)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = '700 11px system-ui, sans-serif'
    ctx.fillStyle = numbers.ocs ? '#ff4d4d' : 'rgba(234,242,250,0.72)'
    ctx.textAlign = 'left'
    ctx.fillText(
      `${Math.abs(numbers.distanceBelowLineBoatLengths).toFixed(1)} BL`,
      s.px + 8,
      (s.py + foot.py) / 2,
    )
  }

  // ---- scale bar ----------------------------------------------------------
  const barNm = niceScale((w * 0.25) * nmPerPx)
  const barPx = barNm / nmPerPx
  ctx.strokeStyle = 'rgba(234,242,250,0.4)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(14, h - 18)
  ctx.lineTo(14 + barPx, h - 18)
  ctx.moveTo(14, h - 22)
  ctx.lineTo(14, h - 14)
  ctx.moveTo(14 + barPx, h - 22)
  ctx.lineTo(14 + barPx, h - 14)
  ctx.stroke()
  ctx.font = '600 10px system-ui, sans-serif'
  ctx.fillStyle = 'rgba(234,242,250,0.55)'
  ctx.textAlign = 'left'
  ctx.fillText(`${nmToM(barNm).toFixed(0)} m`, 14, h - 25)
}

function niceScale(nm: number): number {
  const m = nmToM(nm)
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]
  for (const s of steps) if (m <= s) return mToNm(s)
  return mToNm(5000)
}

function drawHint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
) {
  ctx.font = '500 14px system-ui, sans-serif'
  ctx.fillStyle = '#5b7794'
  ctx.textAlign = 'center'
  ctx.fillText(text, w / 2, h / 2)
  ctx.strokeStyle = '#1d3550'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 8])
  ctx.beginPath()
  ctx.moveTo(w * 0.18, h / 2 + 34)
  ctx.lineTo(w * 0.82, h / 2 + 34)
  ctx.stroke()
  ctx.setLineDash([])
}
