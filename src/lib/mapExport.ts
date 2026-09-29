/**
 * The chart as a picture: saved as a PNG, or printed. The map draws with
 * WebGL and does not keep its drawing buffer, so the picture is taken inside
 * a render, while the frame is still there, then copied with a caption strip
 * under it (what, when, and that it is not for navigation).
 */

interface MapLike {
  getCanvas(): HTMLCanvasElement
  once(ev: 'render', fn: () => void): unknown
  triggerRepaint(): void
}

/** A copy of the map as drawn, taken at its next frame. */
export function captureMap(map: MapLike): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    map.once('render', () => {
      const src = map.getCanvas()
      const out = document.createElement('canvas')
      out.width = src.width
      out.height = src.height
      const ctx = out.getContext('2d')
      if (!ctx) {
        reject(new Error('this browser cannot copy the chart'))
        return
      }
      ctx.drawImage(src, 0, 0)
      resolve(out)
    })
    map.triggerRepaint()
  })
}

/** The chart with a strip under it saying what it is. */
export function withCaption(chart: HTMLCanvasElement, caption: string, ratio = window.devicePixelRatio || 1): HTMLCanvasElement {
  const strip = Math.round(28 * ratio)
  const out = document.createElement('canvas')
  out.width = chart.width
  out.height = chart.height + strip
  const ctx = out.getContext('2d')
  if (!ctx) return chart
  ctx.fillStyle = '#08131f'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(chart, 0, 0)
  ctx.fillStyle = '#eaf2fa'
  ctx.font = `${Math.round(13 * ratio)}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(caption, Math.round(10 * ratio), chart.height + strip / 2)
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** chart-2026-09-29-1640.png, in local time. */
export function chartFileName(at: Date, stem = 'chart'): string {
  return `${stem}-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.png`
}

export function chartCaption(at: Date, what: string): string {
  // The base map's licences ask for its credit wherever the picture goes.
  return `newjourney · ${what} · ${at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · © OpenStreetMap contributors, OpenSeaMap · not for navigation`
}

export async function downloadCanvas(c: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('this browser cannot save the chart')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Print the picture alone: it goes in a sheet only print shows (see
 * styles.css, @media print), and comes out again once printing is done.
 */
export function printCanvas(c: HTMLCanvasElement, title: string): void {
  document.getElementById('print-sheet')?.remove()
  const sheet = document.createElement('div')
  sheet.id = 'print-sheet'
  const img = document.createElement('img')
  img.src = c.toDataURL('image/png')
  img.alt = title
  sheet.append(img)
  document.body.append(sheet)
  document.body.classList.add('printing')
  const done = () => {
    document.body.classList.remove('printing')
    sheet.remove()
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  // The picture must be decoded before the print dialog takes the page.
  const go = () => window.print()
  if (img.complete) go()
  else img.onload = go
}
