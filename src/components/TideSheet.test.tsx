/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TideSheet } from './TideSheet'

const real = globalThis.fetch
afterEach(() => {
  cleanup()
  localStorage.clear()
  globalThis.fetch = real
})

describe('the tide sheet', () => {
  it("shows the nearest station's tide above chart datum, with its highs and lows", async () => {
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      asked.push(url)
      const body = url.includes('stations.json')
        ? { stations: [{ id: '8443970', name: 'Boston', lat: 42.354, lng: -71.05, state: 'MA' }, { id: '8418150', name: 'Portland', lat: 43.658, lng: -70.244, state: 'ME' }] }
        : url.includes('/harcon.json')
          ? { HarmonicConstituents: [{ name: 'M2', amplitude: 1.4, phase_GMT: 100 }] }
          : { datums: [{ name: 'MSL', value: 1.5 }, { name: 'MLLW', value: 0 }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    render(<TideSheet at={{ lat: 43.6, lon: -70.25 }} onClose={() => {}} now={Date.UTC(2026, 8, 29, 12)} />)
    const now = await screen.findByLabelText('Tide now')
    expect(now.textContent).toMatch(/^\d\.\d\d m above chart datum \(MLLW\), (rising|falling)$/)
    expect((screen.getByLabelText('Station') as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/^Portland, ME · \d\.\d nm$/)
    const rows = within(screen.getByRole('table', { name: 'Highs and lows' })).getAllByRole('row')
    // Seven turns or so in a day and a half of semidiurnal tide, highs near 2.9 m and lows near 0.1 m.
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const r of rows) {
      const h = Number(r.textContent!.match(/(-?\d+\.\d\d) m$/)![1])
      expect(r.textContent!.startsWith('High') ? h : 3 - h).toBeGreaterThan(2.7)
    }
    // Another station is a choice away.
    fireEvent.change(screen.getByLabelText('Station'), { target: { value: '1' } })
    await waitFor(() => expect(asked.filter((u) => u.includes('8443970/harcon'))).toHaveLength(1))
  })

  it('says why when NOAA cannot be reached', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    render(<TideSheet at={{ lat: 43.6, lon: -70.25 }} onClose={() => {}} now={Date.UTC(2026, 8, 29, 12)} />)
    expect((await screen.findByText('offline')).className).toBe('warnbox')
  })
})
