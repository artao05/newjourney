/**
 * Sharing, end to end: this copy of the app (startSharing, the store) and
 * another (a ShareLink of its own), through a real bridge.
 */
import { afterEach, expect, it } from 'vitest'
import { startBridge, type Bridge } from '../../bridge/bridge'
import { peerReadings, ShareLink, type Shared } from '@/lib/share'
import { useStore } from '@/state/store'
import { startSharing } from './useShare'

const until = async (ok: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let bridge: Bridge | null = null
let stop: (() => void) | null = null
afterEach(async () => {
  stop?.()
  stop = null
  await bridge?.stop()
  bridge = null
})

it('sends the course as it changes, takes one in without sending it back, and passes instruments on', async () => {
  bridge = await startBridge({ port: 0, inputs: [] })
  const url = `ws://127.0.0.1:${bridge.port}`
  useStore.setState((s) => ({ course: { ...s.course, marks: [] }, activeMarkIndex: 0 }))
  stop = startSharing({ on: true, url, send: ['course', 'start'], receive: ['course', 'start', 'instruments'], channels: [] })
  await until(() => useStore.getState().shareStatus.status === 'connected')

  // The other copy.
  const got: Shared[] = []
  let otherUp = false
  const other = new ShareLink(url, { id: 'other', onShared: (m) => got.push(m), onStatus: (s) => (otherUp = s === 'connected') })
  other.start()
  await until(() => otherUp)

  useStore.getState().addMark('Windward', { lat: 43.66, lon: -70.2 })
  const hasWindward = () => got.some((m) => m.topic === 'course' && (m.data as { marks: Array<{ name: string }> }).marks.some((x) => x.name === 'Windward'))
  await until(hasWindward)

  // Taken in: the other copy's course replaces ours, and is not sent back to it.
  const before = got.length
  other.send('course', { marks: [{ id: 'm9', name: 'Leeward', position: { lat: 43.62, lon: -70.21 }, roundTo: 'port' }], activeMarkIndex: 0 })
  await until(() => useStore.getState().course.marks.map((m) => m.name).join() === 'Leeward')
  await new Promise((r) => setTimeout(r, 400))
  expect(got.length).toBe(before)
  expect(useStore.getState().shareStatus.lastIn).not.toBeNull()

  // Its instruments reach the peer source.
  const readings: unknown[] = []
  const off = peerReadings.subscribe((r) => readings.push(r))
  other.send('instruments', { awa: -30, aws: 17 })
  await until(() => readings.length > 0)
  expect(readings).toEqual([{ awa: -30, aws: 17 }])
  off()
  other.stop()
})

it('sends only the instrument channels chosen', async () => {
  bridge = await startBridge({ port: 0, inputs: [] })
  const url = `ws://127.0.0.1:${bridge.port}`
  const got: Shared[] = []
  let up = false
  const other = new ShareLink(url, { id: 'other', onShared: (m) => got.push(m), onStatus: (s) => (up = s === 'connected') })
  other.start()
  useStore.getState().setInstrumentReading({ awa: -30, aws: 17, bsp: 6.2, depthM: 12 })
  stop = startSharing({ on: true, url, send: ['instruments'], receive: [], channels: ['awa', 'aws'] })
  await until(() => up && got.some((m) => m.topic === 'instruments'), 5000)
  expect(got.find((m) => m.topic === 'instruments')!.data).toEqual({ awa: -30, aws: 17 })
  useStore.getState().setInstrumentReading(null)
  other.stop()
})
