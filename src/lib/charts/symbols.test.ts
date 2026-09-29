import { describe, expect, it } from 'vitest'
import { SYMBOL_COLOURS, SYMBOL_H, SYMBOL_W, parseSymbolKey, rasterSymbol, symbolFor, symbolKey, type SymbolSpec } from './symbols'
import { encDrawFeatures } from './s52'
import type { EncCell } from './s57'

const f = (cls: string, attrs: Record<string, string> = {}) => ({ cls, attrs })

/** The pixel at CSS (x, y) from the symbol's centre, as [r, g, b, a]. */
function px(img: { width: number; data: Uint8ClampedArray }, x: number, y: number, ratio = 2): number[] {
  const i = (Math.round((y + SYMBOL_H / 2) * ratio) * img.width + Math.round((x + SYMBOL_W / 2) * ratio)) * 4
  return [...img.data.slice(i, i + 4)]
}
const hex = (c: number[]) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`

describe('chart symbols', () => {
  it('takes a buoy shape from BOYSHP, and its colours in bands', () => {
    expect(symbolFor(f('BOYLAT', { BOYSHP: '1', COLOUR: '3', CATLAM: '2' }))).toEqual({ shape: 'cone', colours: [SYMBOL_COLOURS['3']], pattern: '', topmark: '', night: false })
    expect(symbolFor(f('BOYLAT', { BOYSHP: '2', COLOUR: '4', CATLAM: '1' }))?.shape).toBe('can')
    // Without a shape a lateral buoy goes by its side: can to port, cone to starboard.
    expect(symbolFor(f('BOYLAT', { COLOUR: '4', CATLAM: '1' }))?.shape).toBe('can')
    expect(symbolFor(f('BOYLAT', { COLOUR: '3', CATLAM: '2' }))?.shape).toBe('cone')
    const north = symbolFor(f('BOYCAR', { BOYSHP: '4', COLOUR: '2,6', COLPAT: '1', CATCAM: '1' }))
    expect(north).toMatchObject({ shape: 'pillar', colours: [SYMBOL_COLOURS['2'], SYMBOL_COLOURS['6']], pattern: 'h', topmark: 'north' })
    expect(symbolFor(f('BOYCAR', { CATCAM: '4' }))?.topmark).toBe('west')
  })

  it('gives the other marks their topmarks, and safe water its vertical stripes', () => {
    expect(symbolFor(f('BOYISD', { COLOUR: '2,3,2' }))).toMatchObject({ topmark: 'isolated', pattern: 'h' })
    expect(symbolFor(f('BOYSAW', { COLOUR: '3,1' }))).toMatchObject({ shape: 'sphere', topmark: 'safe', pattern: 'v' })
    expect(symbolFor(f('BOYSPP', { COLOUR: '6', BOYSHP: '5' }))).toMatchObject({ shape: 'spar', topmark: 'special', pattern: '' })
  })

  it('puts a lateral beacon colour on its daymark: a square to port, a triangle to starboard', () => {
    expect(symbolFor(f('BCNLAT', { BCNSHP: '1', COLOUR: '4', CATLAM: '1' }))).toMatchObject({ shape: 'stake', topmark: 'port', colours: [SYMBOL_COLOURS['4']] })
    expect(symbolFor(f('BCNLAT', { COLOUR: '3', CATLAM: '2' }))).toMatchObject({ shape: 'stake', topmark: 'starboard' })
    expect(symbolFor(f('BCNCAR', { BCNSHP: '3', CATCAM: '3' }))).toMatchObject({ shape: 'tower', topmark: 'south' })
  })

  it('draws lights as flares in their colour, and dangers in their own shapes', () => {
    expect(symbolFor(f('LIGHTS', { COLOUR: '3' }))?.colours).toEqual([SYMBOL_COLOURS['3']])
    expect(symbolFor(f('LIGHTS', { COLOUR: '4' }))?.colours).toEqual([SYMBOL_COLOURS['4']])
    expect(symbolFor(f('LIGHTS', { COLOUR: '1' }))?.colours).toEqual([SYMBOL_COLOURS['6']])
    expect(symbolFor(f('UWTROC'))?.shape).toBe('rock')
    expect(symbolFor(f('WRECKS'))?.shape).toBe('wreck')
    expect(symbolFor(f('OBSTRN'))?.shape).toBe('obstruction')
    expect(symbolFor(f('MORFAC'))).toBeNull()
  })

  it('names each symbol by its whole spec, and reads the spec back', () => {
    const specs: SymbolSpec[] = [
      symbolFor(f('BOYCAR', { BOYSHP: '4', COLOUR: '2,6', CATCAM: '2' }))!,
      symbolFor(f('LIGHTS', { COLOUR: '3' }), true)!,
      symbolFor(f('BCNLAT', { COLOUR: '4', CATLAM: '1' }))!,
    ]
    for (const s of specs) expect(parseSymbolKey(symbolKey(s))).toEqual(s)
    expect(new Set(specs.map(symbolKey)).size).toBe(3)
    expect(parseSymbolKey('barb-10')).toBeNull()
    expect(parseSymbolKey('enc|nope|ffffff||||')).toBeNull()
  })

  it('draws a banded buoy: black over yellow, the topmark above, clear around', () => {
    const img = rasterSymbol(symbolFor(f('BOYCAR', { BOYSHP: '4', COLOUR: '2,6', COLPAT: '1', CATCAM: '1' }))!)
    expect(img.width).toBe(SYMBOL_W * 2)
    expect(img.height).toBe(SYMBOL_H * 2)
    // The pillar runs from 0 up to -13: black in the top half, yellow in the bottom.
    expect(hex(px(img, 0, -10))).toBe(SYMBOL_COLOURS['2'])
    expect(hex(px(img, 0, -3))).toBe(SYMBOL_COLOURS['6'])
    expect(px(img, 0, -3)[3]).toBe(255)
    // The north topmark's upper cone, black, above the body.
    expect(hex(px(img, 0, -20.5))).toBe(SYMBOL_COLOURS['2'])
    expect(px(img, 0, -20.5)[3]).toBe(255)
    // Nothing beside it.
    expect(px(img, -12, -6)[3]).toBe(0)
    expect(px(img, 12, 10)[3]).toBe(0)
  })

  it('draws safe water in vertical stripes, and the night palette darker', () => {
    const day = rasterSymbol(symbolFor(f('BOYSAW', { BOYSHP: '3', COLOUR: '3,1' }))!)
    expect(hex(px(day, -3, -5))).toBe(SYMBOL_COLOURS['3'])
    expect(hex(px(day, 3, -5))).toBe(SYMBOL_COLOURS['1'])
    const night = rasterSymbol(symbolFor(f('BOYSAW', { BOYSHP: '3', COLOUR: '3,1' }), true)!)
    const [r, g, b] = px(night, 3, -5)
    expect(r + g + b).toBeLessThan((245 * 3) / 2)
    expect(px(night, 3, -5)[3]).toBe(255)
  })

  it('points the flare to the south-east from the light', () => {
    const img = rasterSymbol(symbolFor(f('LIGHTS', { COLOUR: '4' }))!)
    expect(hex(px(img, 6, 6))).toBe(SYMBOL_COLOURS['4'])
    expect(px(img, -6, -6)[3]).toBe(0)
    expect(px(img, 6, -6)[3]).toBe(0)
  })

  it('gives chart points their symbol by name, and keeps the dot for the rest', () => {
    const cell = {
      name: 'T',
      features: [
        { objl: 17, cls: 'BOYLAT', prim: 1, attrs: { BOYSHP: '2', COLOUR: '4', CATLAM: '1' }, geometry: { type: 'Point', coordinates: [-70.2, 43.6] } },
        { objl: 84, cls: 'MORFAC', prim: 1, attrs: {}, geometry: { type: 'Point', coordinates: [-70.21, 43.6] } },
      ],
    } as unknown as EncCell
    const [buoy, mooring] = encDrawFeatures([cell], { safetyDepthM: 3, category: 'all' })
    expect(parseSymbolKey(String(buoy.properties.icon))).toMatchObject({ shape: 'can', topmark: '' })
    expect(mooring.properties.icon).toBeUndefined()
    const [nightBuoy] = encDrawFeatures([cell], { safetyDepthM: 3, category: 'all', night: true })
    expect(parseSymbolKey(String(nightBuoy.properties.icon))?.night).toBe(true)
  })
})
