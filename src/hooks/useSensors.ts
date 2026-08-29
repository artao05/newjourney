/**
 * Sensor plumbing: GPS, wake lock, and the simulation feed.
 *
 * Phone heading is deliberately NOT trusted above walking pace — see
 * docs/05-spec/technical-spec.md §2. A phone in a pocket or a hand gives a
 * useless magnetometer reading; COG from GPS is far better once moving.
 */

import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { BoatSim } from '@/lib/sim'
import { buildLattice } from '@/lib/polar'
import type { BoatState, LatLon } from '@/lib/types'

/** Watch the real GPS and push `BoatState` into the store. */
export function useGeolocation(enabled: boolean) {
  const setBoatState = useStore((s) => s.setBoatState)
  const setGpsError = useStore((s) => s.setGpsError)

  useEffect(() => {
    if (!enabled) return
    // Truthiness, not `in`: the property can be present and still be undefined —
    // an insecure origin is the usual way — and `in` is satisfied by a key that
    // holds nothing, so the check passed and the next line threw.
    const geo = navigator.geolocation
    if (!geo) {
      setGpsError('This device has no geolocation API.')
      return
    }
    const id = geo.watchPosition(
      (pos) => {
        setGpsError(null)
        const c = pos.coords
        const state: BoatState = {
          t: pos.timestamp,
          position: { lat: c.latitude, lon: c.longitude },
          /*
           * speed is m/s; heading is COG in degrees true, and both are null when
           * the device cannot supply them — stationary, or a platform that simply
           * does not report them.
           *
           * NaN, not 0, for the same reason `gpx.ts` uses NaN: 0 is a real
           * reading. A fabricated COG of 0 is due north, and it does not stay in
           * this file — it becomes the bow direction on the start canvas, the
           * dead-reckoned position at the gun, the TWA the tactics panel shows and
           * the VMC it ranks marks by. Every consumer that matters already tests
           * `Number.isFinite`, and every tile formatter renders a non-finite value
           * as an em dash, so NaN degrades to "we do not know" at each of them
           * while 0 degrades to a confident lie.
           */
          sog: c.speed != null && Number.isFinite(c.speed) ? c.speed * 1.94384 : NaN,
          cog: c.heading != null && Number.isFinite(c.heading) ? c.heading : NaN,
          accuracyM: c.accuracy ?? null,
          heading: null,
          bsp: null,
          heelDeg: null,
        }
        setBoatState(state)
      },
      (err) => setGpsError(err.message || 'Location unavailable'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    )
    return () => geo.clearWatch(id)
  }, [enabled, setBoatState, setGpsError])
}

/** Drive the store from the synthetic boat instead of the GPS. */
export function useSimulation(enabled: boolean, origin: LatLon) {
  const setBoatState = useStore((s) => s.setBoatState)
  const setGpsError = useStore((s) => s.setGpsError)
  const polar = useStore((s) => s.polar)
  const manualWind = useStore((s) => s.manualWind)
  const simRef = useRef<BoatSim | null>(null)

  useEffect(() => {
    if (!enabled) {
      simRef.current = null
      return
    }
    setGpsError(null)
    let lattice = null
    try {
      lattice = polar ? buildLattice(polar) : null
    } catch {
      lattice = null
    }
    const sim = new BoatSim({
      start: origin,
      twd: manualWind.twd,
      tws: manualWind.tws,
      lattice,
      current: { set: 45, drift: 0.6, source: 'simulated' },
    })
    sim.setAutopilot({ mode: 'twa', twa: 60 })
    simRef.current = sim
    ;(window as unknown as { __sim?: BoatSim }).__sim = sim

    const dt = 0.5
    const h = window.setInterval(() => {
      setBoatState(sim.step(dt))
    }, dt * 1000)
    return () => {
      window.clearInterval(h)
      simRef.current = null
    }
    // origin intentionally excluded: we don't want to teleport the sim when
    // the store's position updates from the sim itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, polar, setBoatState, setGpsError])

  return simRef
}

/** Keep the screen on. A screen that sleeps during a start sequence is a dead product. */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false

    const request = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
        if (!wl) return
        lock = await wl.request('screen')
        if (cancelled) {
          void lock.release()
          lock = null
        }
      } catch {
        /* denied or unsupported — not fatal */
      }
    }
    void request()

    const onVisible = () => {
      if (document.visibilityState === 'visible') void request()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release()
    }
  }, [enabled])
}

/** A steady tick so countdowns and derived numbers stay live. Returns epoch ms. */
export function useTick(hz = 1): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000 / hz)
    return () => window.clearInterval(h)
  }, [hz])
  return now
}
