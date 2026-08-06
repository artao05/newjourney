/**
 * Dev harness for the map data layers. Mounted at `?harness`.
 *
 * Exists because WebGL that typechecks tells you nothing — a sign error in the
 * advection shader, a flipped texture v, or a broken trail blend all compile
 * perfectly and render garbage. This drives both layers with a synthetic field
 * whose correct appearance is known in advance, so a wrong result is obvious.
 *
 * The synthetic field is a vortex plus a west-to-east gradient:
 *   - particles must circulate anticlockwise around the box centre,
 *   - they must be visibly faster on the right-hand side,
 *   - the scalar field must be smooth, not blocky,
 *   - and the hole punched in the middle must stay empty, proving that a
 *     coverage gap is honoured rather than drawn as calm.
 */

import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { ParticleLayer } from '@/lib/maplayers/particleLayer'
import { ScalarLayer } from '@/lib/maplayers/scalarLayer'
import type { WeatherCube } from '@/lib/types'

const BBOX = { west: -71.6, south: 43.4, east: -69.8, north: 44.2 }
const NX = 48
const NY = 36
const NT = 6
const DT = 3_600_000

/** A vortex + gradient field with a deliberate no-data hole. */
function syntheticCube(): WeatherCube {
  const cells = NX * NY
  const u = new Float32Array(cells * NT)
  const v = new Float32Array(cells * NT)
  const hs = new Float32Array(cells * NT)
  const gust = new Float32Array(cells * NT)

  for (let t = 0; t < NT; t++) {
    // Rotate the vortex over time so the time scrubber visibly does something.
    const phase = (t / NT) * Math.PI * 2
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = t * cells + j * NX + i
        const fx = i / (NX - 1) - 0.5
        const fy = j / (NY - 1) - 0.5
        const r = Math.hypot(fx, fy)

        // A circular hole in the middle: no coverage.
        if (r < 0.08) {
          u[idx] = NaN
          v[idx] = NaN
          hs[idx] = NaN
          gust[idx] = NaN
          continue
        }

        // Anticlockwise vortex, strengthening toward the east.
        const gradient = 0.4 + (i / (NX - 1)) * 1.6
        const swirl = 22 * gradient
        u[idx] = -fy * swirl + 3 * Math.cos(phase)
        v[idx] = fx * swirl + 3 * Math.sin(phase)
        hs[idx] = 0.4 + r * 7 + Math.sin(phase) * 0.5
        gust[idx] = Math.hypot(u[idx], v[idx]) * 1.3
      }
    }
  }

  return {
    model: 'synthetic',
    run: new Date(0).toISOString(),
    bbox: BBOX,
    nx: NX,
    ny: NY,
    dx: (BBOX.east - BBOX.west) / (NX - 1),
    dy: (BBOX.north - BBOX.south) / (NY - 1),
    t0: Date.now(),
    dtMs: DT,
    nt: NT,
    params: ['u10', 'v10', 'hs', 'gust'],
    data: { u10: u, v10: v, hs, gust },
  }
}

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#08131f' } }],
}

export function LayerHarness() {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const particleRef = useRef<ParticleLayer | null>(null)
  const scalarRef = useRef<ScalarLayer | null>(null)
  const cubeRef = useRef<WeatherCube>(syntheticCube())

  const [step, setStep] = useState(0)
  const [showParticles, setShowParticles] = useState(true)
  const [showScalar, setShowScalar] = useState(true)
  const [speed, setSpeed] = useState(0.35)
  const [fade, setFade] = useState(0.955)
  const [status, setStatus] = useState('initialising')
  const [fps, setFps] = useState(0)

  useEffect(() => {
    if (!container.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [(BBOX.west + BBOX.east) / 2, (BBOX.south + BBOX.north) / 2],
      zoom: 8,
      attributionControl: false,
    })
    mapRef.current = map

    map.on('error', (e) => setStatus(`map error: ${e.error?.message ?? 'unknown'}`))

    map.on('load', () => {
      try {
        const scalar = new ScalarLayer({ id: 'harness-scalar', param: 'hs', domain: [0, 8] })
        const particles = new ParticleLayer({ id: 'harness-particles', count: 65536 })
        map.addLayer(scalar as unknown as maplibregl.LayerSpecification)
        map.addLayer(particles as unknown as maplibregl.LayerSpecification)
        scalarRef.current = scalar
        particleRef.current = particles
        const t = cubeRef.current.t0
        scalar.setData(cubeRef.current, t)
        particles.setData(cubeRef.current, t)
        setStatus('layers added')
        // Exposed for console tuning and for the automated checks below.
        ;(window as unknown as Record<string, unknown>).__harness = {
          map,
          scalar,
          particles,
          cube: cubeRef.current,
        }
      } catch (err) {
        setStatus(`layer error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    return () => {
      map.remove()
      mapRef.current = null
      particleRef.current = null
      scalarRef.current = null
    }
  }, [])

  // Push the selected time step into both layers.
  useEffect(() => {
    const cube = cubeRef.current
    const t = cube.t0 + step * cube.dtMs
    scalarRef.current?.setData(cube, t)
    particleRef.current?.setData(cube, t)
  }, [step])

  useEffect(() => {
    particleRef.current?.setVisible(showParticles)
  }, [showParticles])

  useEffect(() => {
    scalarRef.current?.setVisible(showScalar)
  }, [showScalar])

  useEffect(() => {
    particleRef.current?.setOptions({ speedFactor: speed, fadeOpacity: fade })
  }, [speed, fade])

  // Crude FPS counter — the number that decides whether this ships to a phone.
  useEffect(() => {
    let frames = 0
    let raf = 0
    let last = performance.now()
    const tick = () => {
      frames++
      const now = performance.now()
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="app">
      <div className="topbar">
        <span className="chip">
          <span className="dot dot--pulse" /> harness
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <span className="chip" id="harness-status">
            {status}
          </span>
          <span className="chip" id="harness-fps">
            {fps} fps
          </span>
        </span>
      </div>

      {/*
        `minHeight` is load-bearing. With `flex: 1; min-height: 0` the control
        panel below grew and collapsed the map to zero height, which renders a
        blank pane at a healthy 60 fps and looks exactly like a broken shader.
      */}
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 320 }}>
        <div ref={container} className="map" />
        <div className="legend" style={{ pointerEvents: 'none' }}>
          <div>
            <b>Expected</b>
          </div>
          <div>anticlockwise swirl</div>
          <div>faster to the east</div>
          <div>smooth, not blocky</div>
          <div>hole in the centre</div>
        </div>
      </div>

      <div className="panel" style={{ paddingTop: 8, flexShrink: 0, overflowY: 'auto', maxHeight: '45%' }}>
        <div className="seg" style={{ marginBottom: 8 }}>
          <button aria-pressed={showParticles} onClick={() => setShowParticles((v) => !v)}>
            particles
          </button>
          <button aria-pressed={showScalar} onClick={() => setShowScalar((v) => !v)}>
            scalar field
          </button>
        </div>
        <div className="field field--wide" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <label>time step {step + 1}/{NT}</label>
          <input
            id="harness-step"
            type="range"
            min={0}
            max={NT - 1}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
          />
        </div>
        <div className="field field--wide" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <label>speed {speed.toFixed(2)}</label>
          <input
            type="range"
            min={0.05}
            max={1.5}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </div>
        <div className="field field--wide" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <label>trail {fade.toFixed(3)}</label>
          <input
            type="range"
            min={0.8}
            max={0.995}
            step={0.005}
            value={fade}
            onChange={(e) => setFade(Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  )
}
