/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureMap, chartCaption, chartFileName, printCanvas } from './mapExport'

afterEach(() => vi.restoreAllMocks())

describe('the chart as a picture', () => {
  it('names the file by the local date and time', () => {
    expect(chartFileName(new Date(2026, 8, 29, 16, 5))).toBe('chart-2026-09-29-1605.png')
    expect(chartFileName(new Date(2026, 0, 2, 3, 4), 'route')).toBe('route-2026-01-02-0304.png')
    expect(chartCaption(new Date(2026, 8, 29, 16, 5), 'Harbour race')).toMatch(/^newjourney · Harbour race · .+ · © OpenStreetMap contributors, OpenSeaMap · not for navigation$/)
  })

  it('copies the map at its next frame, while the frame is still there', async () => {
    const drawn: unknown[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: (c: unknown) => drawn.push(c) } as unknown as CanvasRenderingContext2D)
    const src = document.createElement('canvas')
    src.width = 640
    src.height = 480
    let render: (() => void) | null = null
    let repaints = 0
    const map = { getCanvas: () => src, once: (_: 'render', fn: () => void) => (render = fn), triggerRepaint: () => repaints++ }
    const got = captureMap(map)
    // Nothing is copied until the map draws.
    expect(repaints).toBe(1)
    expect(drawn).toEqual([])
    render!()
    const c = await got
    expect([c.width, c.height]).toEqual([640, 480])
    expect(drawn).toEqual([src])
  })

  it('prints the picture alone, and tidies up after', () => {
    const c = document.createElement('canvas')
    vi.spyOn(c, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')
    const print = vi.fn()
    window.print = print
    printCanvas(c, 'The chart')
    const sheet = document.getElementById('print-sheet')!
    expect(sheet.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(document.body.classList.contains('printing')).toBe(true)
    // jsdom never loads the image; the print dialog waits for it.
    sheet.querySelector('img')!.dispatchEvent(new Event('load'))
    expect(print).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('afterprint'))
    expect(document.getElementById('print-sheet')).toBeNull()
    expect(document.body.classList.contains('printing')).toBe(false)
  })
})
