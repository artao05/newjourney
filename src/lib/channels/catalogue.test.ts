import { describe, expect, it } from 'vitest'
import { CHANNELS, CHANNEL_GROUPS, CHANNEL_SOURCES, CHANNEL_UNITS, channel } from './catalogue'

describe("the channel catalogue is Expedition's Appendix A", () => {
  it('has all 361 channels a boat can carry', () => {
    // 314 appendix entries, with Alternating 0-9, User 0-31 and Polar 5-8 / 5%-8%
    // expanded. A different count means an entry was lost or doubled.
    expect(CHANNELS).toHaveLength(361)
    expect(CHANNELS.filter((c) => c.name.startsWith('User '))).toHaveLength(32)
    expect(CHANNELS.filter((c) => c.name.startsWith('Alternating '))).toHaveLength(10)
    expect(CHANNELS.filter((c) => /^Polar [5-8]%?$/.test(c.name))).toHaveLength(8)
  })

  it('gives every channel a unique kebab-case id and a unique Expedition name', () => {
    const ids = CHANNELS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([])
    const names = CHANNELS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps Twd -90 and Twd +90 apart, which a naive slug would merge', () => {
    expect(channel('twd-minus-90')?.name).toBe('Twd -90')
    expect(channel('twd-plus-90')?.name).toBe('Twd +90')
  })

  it('uses only defined groups, units and sources', () => {
    const bad = CHANNELS.filter(
      (c) =>
        !(CHANNEL_GROUPS as readonly string[]).includes(c.group) ||
        !(CHANNEL_SOURCES as readonly string[]).includes(c.source) ||
        (c.unit !== null && !(CHANNEL_UNITS as readonly string[]).includes(c.unit)),
    )
    expect(bad.map((c) => c.id)).toEqual([])
  })

  it('holds the core channels in the units the code computes them in', () => {
    const units = Object.fromEntries(CHANNELS.map((c) => [c.id, c.unit]))
    expect(units).toMatchObject({
      twd: 'deg',
      tws: 'kn',
      sog: 'kn',
      'mark-range': 'nm',
      'start-distance-below-line': 'm',
      'start-time-to-burn': 's',
      'polar-bsp-pct': 'pct',
      latitude: 'latlon',
      time: 'datetime',
    })
  })

  it('marks what newjourney already computes, and nothing it cannot', () => {
    const today = CHANNELS.filter((c) => c.today)
    expect(today.length).toBeGreaterThanOrEqual(50)
    // Rig loads, engines, radar and other boats need hardware or a fleet feed
    // that does not exist yet. None of them can be "today".
    expect(today.filter((c) => ['rig', 'engine', 'fleet', 'sails', 'user'].includes(c.group))).toEqual([])
  })
})
