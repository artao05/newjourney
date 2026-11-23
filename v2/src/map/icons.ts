/** A boat seen from above, bow up, drawn once per colour for the map's symbol layer. */
export function boatImage(color: string, own: boolean): ImageData {
  const w = own ? 40 : 32
  const h = own ? 64 : 52
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const cx = w / 2
  ctx.beginPath()
  ctx.moveTo(cx, 3)
  ctx.bezierCurveTo(w - 4, h * 0.3, w - 5, h * 0.7, w - 8, h - 4)
  ctx.lineTo(8, h - 4)
  ctx.bezierCurveTo(5, h * 0.7, 4, h * 0.3, cx, 3)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = own ? 3 : 2
  ctx.strokeStyle = own ? '#ffffff' : '#0b1724'
  ctx.stroke()
  // Mast and boom.
  ctx.fillStyle = '#0b1724'
  ctx.beginPath()
  ctx.arc(cx, h * 0.38, own ? 3 : 2.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#0b1724'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx, h * 0.38)
  ctx.lineTo(cx, h * 0.82)
  ctx.stroke()
  return ctx.getImageData(0, 0, w, h)
}
