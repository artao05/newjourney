import { describe, expect, it } from 'vitest'
import { SAT_TILES, latestRadar } from './overlays'

describe('radar and satellite overlays', () => {
  it('takes the newest past radar frame as a tile URL', () => {
    const index = {
      version: '2.0',
      host: 'https://tilecache.rainviewer.com',
      radar: { past: [{ time: 1790690400, path: '/v2/radar/aaa' }, { time: 1790691000, path: '/v2/radar/bbb' }], nowcast: [] },
    }
    expect(latestRadar(index)).toEqual({ tiles: 'https://tilecache.rainviewer.com/v2/radar/bbb/256/{z}/{x}/{y}/2/1_1.png', time: 1790691000_000 })
    expect(latestRadar({ host: 'x', radar: { past: [] } })).toBeNull()
    expect(latestRadar(null)).toBeNull()
  })

  it('asks GIBS for the latest GOES-East image in web-mercator tiles', () => {
    expect(SAT_TILES).toMatch(/GOES-East_ABI_GeoColor\/default\/default\/GoogleMapsCompatible_Level7\/\{z\}\/\{y\}\/\{x\}/)
  })
})
