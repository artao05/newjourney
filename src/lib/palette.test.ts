import { describe, expect, it } from 'vitest'
import type maplibregl from 'maplibre-gl'
import { CHART_BASE, dayTone, followPalette, paletteForSun, tone, tonePaint, type Palette } from './palette'

const lightness = (hex: string) => {
  const v = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => x / 255)
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
}

describe('the day palette', () => {
  it('turns light text dark and dark grounds light, keeping the hue', () => {
    expect(lightness(dayTone('#eaf2fa'))).toBeLessThan(0.1)
    expect(lightness(dayTone('#04101c'))).toBeGreaterThan(0.9)
    // Yellow stays yellow, just dark enough to read on white.
    const gold = dayTone('#ffd54a')
    expect(lightness(gold)).toBeLessThanOrEqual(0.42 + 1e-9)
    const v = parseInt(gold.slice(1), 16)
    expect((v >> 16) & 255).toBeGreaterThan(v & 255)
    // Short hex, and alpha kept.
    expect(dayTone('#fff')).toBe('#000000')
    expect(dayTone('rgba(255, 77, 77, 0.35)')).toMatch(/^rgba\(\d+,\d+,\d+,0\.35\)$/)
  })

  it('leaves anything that is not a colour, and every colour on dusk and night', () => {
    expect(dayTone('transparent')).toBe('transparent')
    expect(tone('#eaf2fa', 'dusk')).toBe('#eaf2fa')
    expect(tone('#eaf2fa', 'night')).toBe('#eaf2fa')
    expect(tonePaint(['case', ['get', 'on'], '#ffffff', '#000000'], 'day')).toEqual(['case', ['get', 'on'], '#000000', '#ffffff'])
  })
})

/** A map with just enough of MapLibre: layers and their paint. */
function fakeMap(layers: Array<{ id: string; type: string; paint: Record<string, unknown> }>) {
  const handlers: Array<() => void> = []
  return {
    layers,
    getStyle: () => ({ layers: layers.map(({ id, type }) => ({ id, type })) }),
    getPaintProperty: (id: string, prop: string) => layers.find((l) => l.id === id)!.paint[prop],
    setPaintProperty: (id: string, prop: string, v: unknown) => {
      layers.find((l) => l.id === id)!.paint[prop] = v
    },
    on: (_: string, f: () => void) => handlers.push(f),
    off: () => undefined,
  }
}

describe('the palette by the sun', () => {
  it('is day with the sun up, dusk in civil twilight, night below 6°', () => {
    expect([paletteForSun(20), paletteForSun(0), paletteForSun(-3), paletteForSun(-6), paletteForSun(-6.1)]).toEqual(['day', 'day', 'dusk', 'dusk', 'night'])
  })
})

describe('a map kept in the palette', () => {
  it('tones every colour for day and puts its own back for dusk, base map included', () => {
    const m = fakeMap([
      { id: 'osm', type: 'raster', paint: { 'raster-opacity': 0.55, 'raster-brightness-max': 0.75 } },
      { id: 'route', type: 'line', paint: { 'line-color': '#4fc3f7', 'line-width': 3 } },
      { id: 'labels', type: 'symbol', paint: { 'text-color': '#eaf2fa', 'text-halo-color': '#04101c' } },
    ])
    let p: Palette = 'day'
    const f = followPalette(m as unknown as maplibregl.Map, () => p, { osm: CHART_BASE })
    expect(m.layers[1].paint['line-color']).toBe(dayTone('#4fc3f7'))
    expect(m.layers[2].paint['text-color']).toBe(dayTone('#eaf2fa'))
    expect(m.layers[0].paint['raster-opacity']).toBe(CHART_BASE.day['raster-opacity'])
    expect(m.layers[1].paint['line-width']).toBe(3)
    p = 'dusk'
    f.apply()
    expect(m.layers[1].paint['line-color']).toBe('#4fc3f7')
    expect(m.layers[2].paint['text-halo-color']).toBe('#04101c')
    expect(m.layers[0].paint['raster-opacity']).toBe(0.55)
  })

  it('takes a colour the code sets later as the layer’s own', () => {
    const m = fakeMap([{ id: 'route', type: 'line', paint: { 'line-color': '#4fc3f7' } }])
    let p: Palette = 'day'
    const f = followPalette(m as unknown as maplibregl.Map, () => p)
    m.setPaintProperty('route', 'line-color', '#ff4d4d')
    f.apply()
    expect(m.layers[0].paint['line-color']).toBe(dayTone('#ff4d4d'))
    p = 'dusk'
    f.apply()
    expect(m.layers[0].paint['line-color']).toBe('#ff4d4d')
  })
})
