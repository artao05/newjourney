/**
 * Colour ramps, GPU lookup textures, and the layer catalogue.
 *
 * Implements docs/07-map-layers/render-architecture.md §3 ("Colour ramps must be
 * perceptually ordered and colour-blind safe") and §7 (module layout).
 *
 * Two ideas run through this file:
 *
 *   1. **No rainbows for continuous fields.** A rainbow ramp puts sharp
 *      lightness reversals at arbitrary values, so the eye reads a contour where
 *      the data is perfectly smooth. `wind` is viridis, `wave` is magma-class:
 *      both are monotonic in lightness and both survive the common colour-vision
 *      deficiencies. The one ramp built out of rainbow hues is `beaufort`, and
 *      it is `discrete` — there the edges the eye sees are the real class
 *      boundaries, which is the whole point of the scale.
 *   2. **Stops carry units, not fractions.** `ColorStop.value` is in knots,
 *      metres, °C, hPa — never 0..1. That lets a stop sit on a threshold a
 *      sailor already knows (20 kn = first reef, 34 kn = gale) and it makes the
 *      legend labels fall out for free.
 */

import type { ColorRamp, LayerSpec, RampSampler } from './types'

// ------------------------------------------------------------------ internals

/**
 * Per-stop alpha, 0-255, indexed parallel to `ramp.stops`.
 *
 * `ColorStop` in types.ts is a fixed contract and carries no alpha, and only
 * one ramp needs it: precipitation has to be fully transparent at zero so a dry
 * chart is not fogged grey (§3). So alpha lives beside the ramp in a WeakMap
 * rather than widening the shared type. A ramp built anywhere else is opaque,
 * which is the documented default.
 */
const ALPHA = new WeakMap<ColorRamp, number[]>()

/** `[value, hex]`, or `[value, hex, alpha0to255]`. */
type StopTuple = readonly [number, string] | readonly [number, string, number]

function hexRgb(hex: string): [number, number, number] {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function defineRamp(
  id: string,
  label: string,
  unit: string,
  stops: readonly StopTuple[],
  discrete = false,
): ColorRamp {
  const ramp: ColorRamp = {
    id,
    label,
    unit,
    stops: stops.map(([value, hex]) => ({ value, rgb: hexRgb(hex) })),
    discrete,
  }
  const alpha = stops.map((s) => (s.length === 3 ? s[2] : 255))
  if (alpha.some((a) => a !== 255)) ALPHA.set(ramp, alpha)
  return ramp
}

interface Sample {
  rgb: [number, number, number]
  /** 0-255, straight (not premultiplied). */
  a: number
}

const mix = (a: number, b: number, f: number): number => Math.round(a + (b - a) * f)

/**
 * The one place a value becomes a colour. Clamps outside the stop range, and
 * for a `discrete` ramp returns the class colour with no interpolation at all.
 *
 * NaN clamps to the low end. That is a deliberate last resort, not a feature:
 * missing data must be rejected *before* it reaches a ramp, because a colour is
 * indistinguishable from a real reading once it is on screen. `sampleCube`
 * returns `null` for a hole precisely so the caller can skip it
 * (docs/05-spec/technical-spec.md §4).
 */
function lookup(ramp: ColorRamp, value: number): Sample {
  const stops = ramp.stops
  const alpha = ALPHA.get(ramp)
  const aAt = (i: number): number => alpha?.[i] ?? 255
  if (stops.length === 0) return { rgb: [0, 0, 0], a: 0 }

  const last = stops.length - 1
  if (!Number.isFinite(value) || value <= stops[0].value) {
    return { rgb: [...stops[0].rgb], a: aAt(0) }
  }
  if (value >= stops[last].value) return { rgb: [...stops[last].rgb], a: aAt(last) }

  let i = 0
  while (i < last && stops[i + 1].value <= value) i++
  if (ramp.discrete) return { rgb: [...stops[i].rgb], a: aAt(i) }

  const s0 = stops[i]
  const s1 = stops[i + 1]
  const span = s1.value - s0.value
  const f = span > 0 ? (value - s0.value) / span : 0
  return {
    rgb: [
      mix(s0.rgb[0], s1.rgb[0], f),
      mix(s0.rgb[1], s1.rgb[1], f),
      mix(s0.rgb[2], s1.rgb[2], f),
    ],
    a: mix(aAt(i), aAt(i + 1), f),
  }
}

/** CSS colour for a sample. `rgb()` when opaque, so gradients stay readable. */
function css(s: Sample): string {
  const [r, g, b] = s.rgb
  if (s.a >= 255) return `rgb(${r}, ${g}, ${b})`
  return `rgba(${r}, ${g}, ${b}, ${Number((s.a / 255).toFixed(3))})`
}

// --------------------------------------------------------------------- ramps

/**
 * viridis, sampled at eight points. Perceptually uniform and the safest
 * available choice for colour-vision deficiency.
 *
 * The stop *values* are deliberately not evenly spaced. Even spacing over
 * 0-50 kn spends half the ramp on wind nobody races in; these anchors put the
 * colour resolution where a sailor needs to tell 12 from 16 kn, and still reach
 * the top of the ramp at storm force so the same ramp serves the gust layer
 * without saturating. The cost is that the ramp is uniform in colour but not in
 * value — acceptable, and the legend shows the real numbers either way.
 */
const WIND = defineRamp('wind', 'Wind speed', 'kn', [
  [0, '#440154'],
  [5, '#46337e'],
  [10, '#365c8d'],
  [15, '#277f8e'],
  [20, '#1fa187'],
  [28, '#4ac16d'],
  [36, '#9fda3a'],
  [50, '#fde725'],
])

/**
 * The Beaufort scale, force 0-12, as a discrete ramp.
 *
 * Stop values are the *lower bound* of each force in knots — the standard
 * boundaries 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64 — so `makeSampler`
 * returns the colour of the force the value actually falls in. Expedition
 * offers this and sailors read it natively: "F5, reef the main" carries more
 * than "18.4 kn".
 *
 * This is the one ramp built from rainbow hues, and that is correct here: the
 * visual edges a rainbow invents are, in this case, exactly the class
 * boundaries the scale is made of.
 */
const BEAUFORT = defineRamp(
  'beaufort',
  'Beaufort force',
  'kn',
  [
    [0, '#c8e8f0'], // F0  calm
    [1, '#96d9ec'], // F1  light air
    [4, '#5cc8e8'], // F2  light breeze
    [7, '#35b0e0'], // F3  gentle breeze
    [11, '#3fc47f'], // F4  moderate breeze
    [17, '#8fd646'], // F5  fresh breeze
    [22, '#d8dc3c'], // F6  strong breeze
    [28, '#ffc02e'], // F7  near gale
    [34, '#ff8f2e'], // F8  gale
    [41, '#ff5c33'], // F9  strong gale
    [48, '#ff3355'], // F10 storm
    [56, '#e0338f'], // F11 violent storm
    [64, '#b03cc8'], // F12 hurricane
  ],
  true,
)

/**
 * Significant wave height, 0-8 m. magma-class: monotonic in lightness, so the
 * field reads as a height even in greyscale, and weighted towards the low end
 * because that is where sea state actually lives.
 */
const WAVE = defineRamp('wave', 'Wave height', 'm', [
  [0, '#180f3d'],
  [0.5, '#451077'],
  [1, '#721f81'],
  [1.5, '#9f2f7f'],
  [2, '#cd4071'],
  [3, '#f1605d'],
  [4, '#fd9668'],
  [5.5, '#feca8d'],
  [8, '#fcfdbf'],
])

/**
 * Sea surface temperature, °C. Diverging is right here and only here: unlike
 * wind speed, SST has a meaningful middle — the point where the water is
 * neither notably warm nor notably cold for the region — and a diverging ramp
 * shows the *front*, which is the feature anyone looking at SST is looking for.
 */
const SST = defineRamp('sst', 'Sea surface temp', '°C', [
  [0, '#2166ac'],
  [5, '#4393c3'],
  [10, '#92c5de'],
  [13, '#d1e5f0'],
  [15, '#f7f7f7'],
  [17, '#fddbc7'],
  [20, '#f4a582'],
  [25, '#d6604d'],
  [30, '#b2182b'],
])

/**
 * Precipitation, mm/h. Fully transparent at zero and still nearly transparent
 * through drizzle, so a dry chart stays a chart. An opaque "no rain" colour
 * fogs the coastline and the route underneath it for no information at all.
 */
const RAIN = defineRamp('rain', 'Precipitation', 'mm/h', [
  [0, '#4fc3f7', 0],
  [0.1, '#7fd4ff', 40],
  [0.5, '#4fc3f7', 110],
  [2, '#3d9be0', 180],
  [5, '#4a6fe0', 220],
  [10, '#7a4fd6', 245],
  [20, '#c04fd6', 255],
])

/**
 * Surface current, 0-5 kn.
 *
 * Runs light-to-saturated rather than dark-to-light, because current is a
 * vector layer drawn as thin arrow glyphs (see `LAYERS.current`): every colour
 * in it has to survive being one and a half pixels wide on a near-black chart.
 * A viridis-style dark end would simply disappear at exactly the drifting
 * currents that decide a light-air race.
 */
const CURRENT = defineRamp('current', 'Current', 'kn', [
  [0, '#bfeef7'],
  [0.5, '#7fddf0'],
  [1, '#4fc3f7'],
  [1.5, '#3fa0f0'],
  [2, '#5c7ff0'],
  [3, '#8a5ce8'],
  [4, '#c04fd6'],
  [5, '#ff4dc4'],
])

/**
 * Mean sea level pressure, hPa. Diverging about 1013, warm for low and cool for
 * high, matching the synoptic-chart habit of a red L and a blue H.
 *
 * Currently unused: the pressure layer was removed from `LAYERS` because a
 * full-screen MSLP field is not something an inshore racer sails on. Kept, like
 * `SST`, so the ramp is ready if a synoptic view ever earns its place.
 */
const PRESSURE = defineRamp('pressure', 'Pressure', 'hPa', [
  [980, '#e05cc0'],
  [995, '#f0879f'],
  [1005, '#f6c6b0'],
  [1013, '#e8e8ea'],
  [1020, '#a8d0e8'],
  [1030, '#5fa8dd'],
  [1040, '#2f6fb8'],
])

export const RAMPS: Record<string, ColorRamp> = {
  wind: WIND,
  beaufort: BEAUFORT,
  wave: WAVE,
  sst: SST,
  rain: RAIN,
  current: CURRENT,
  pressure: PRESSURE,
}

/**
 * Beaufort force for a wind speed in knots, 0-12.
 *
 * Exported because the number is worth showing as text next to the colour, and
 * because deriving it from the ramp at every call site would duplicate the
 * boundary table — the classic way to end up with two disagreeing versions.
 */
export function beaufortForce(kn: number): number {
  const stops = BEAUFORT.stops
  if (!Number.isFinite(kn)) return 0
  let f = 0
  while (f + 1 < stops.length && kn >= stops[f + 1].value) f++
  return f
}

// ------------------------------------------------------------------ samplers

/**
 * Linear-interpolated lookup, clamped outside the stop range. Discrete ramps
 * return the class colour unblended.
 *
 * This is for legends, one-off symbol colours and tests. Do not call it per
 * pixel or per particle — that is what `rampToLUT` and a texture are for.
 */
export function makeSampler(ramp: ColorRamp): RampSampler {
  return (value: number) => lookup(ramp, value).rgb
}

/**
 * Flat RGBA bytes for a 1-D WebGL LUT texture, `width` entries wide.
 *
 * Exactly `width * 4` bytes, straight (non-premultiplied) alpha, ready for
 * `texImage2D(..., gl.RGBA, gl.UNSIGNED_BYTE, lut)` with a `width × 1` target
 * and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` left at its default of false. Entry `i`
 * is the ramp evaluated at `domain[0] + (domain[1] - domain[0]) * i/(width-1)`,
 * so the shader normalises its sample into 0..1 against the same domain and
 * reads the LUT with `LINEAR` filtering.
 */
export function rampToLUT(
  ramp: ColorRamp,
  domain: [number, number],
  width = 256,
): Uint8Array {
  const w = Math.floor(width)
  if (!(w >= 1)) throw new Error(`rampToLUT: width must be >= 1, got ${width}`)
  const [lo, hi] = domain
  const out = new Uint8Array(w * 4)
  for (let i = 0; i < w; i++) {
    const f = w > 1 ? i / (w - 1) : 0
    const s = lookup(ramp, lo + (hi - lo) * f)
    const o = i * 4
    out[o] = s.rgb[0]
    out[o + 1] = s.rgb[1]
    out[o + 2] = s.rgb[2]
    out[o + 3] = s.a
  }
  return out
}

// -------------------------------------------------------------- legend / map

/** Position of a value within the domain, as a clamped percentage. */
function pct(value: number, lo: number, hi: number): number {
  if (hi === lo) return 0
  const f = ((value - lo) / (hi - lo)) * 100
  return f < 0 ? 0 : f > 100 ? 100 : f
}

/** Trim to 2 dp without a trailing `.00`, so gradient strings stay short. */
const p2 = (x: number): string => Number(x.toFixed(2)).toString()

/**
 * A `linear-gradient` matching what `rampToLUT` would produce over the same
 * domain, for the legend colour bar.
 *
 * Discrete ramps emit doubled stops so each class is a hard-edged block: a
 * Beaufort legend that fades between forces is claiming a precision the scale
 * does not have.
 */
export function rampToCssGradient(ramp: ColorRamp, domain: [number, number]): string {
  const [lo, hi] = domain
  if (ramp.stops.length === 0) return 'linear-gradient(to right, transparent, transparent)'
  if (hi === lo) {
    const c = css(lookup(ramp, lo))
    return `linear-gradient(to right, ${c}, ${c})`
  }

  const parts: string[] = []
  if (ramp.discrete) {
    // One block per class that intersects the domain. `from` walks the visible
    // part of each class; the last one runs out to 100%.
    let from = 0
    for (let i = 0; i < ramp.stops.length; i++) {
      const next = ramp.stops[i + 1]
      const to = next ? pct(next.value, lo, hi) : 100
      if (to <= from) continue
      const c = css(lookup(ramp, Math.max(lo, ramp.stops[i].value)))
      parts.push(`${c} ${p2(from)}%`, `${c} ${p2(to)}%`)
      from = to
      if (from >= 100) break
    }
  } else {
    parts.push(`${css(lookup(ramp, lo))} 0%`)
    for (const s of ramp.stops) {
      const at = pct(s.value, lo, hi)
      if (at <= 0 || at >= 100) continue
      parts.push(`${css(lookup(ramp, s.value))} ${p2(at)}%`)
    }
    parts.push(`${css(lookup(ramp, hi))} 100%`)
  }
  return `linear-gradient(to right, ${parts.join(', ')})`
}

/**
 * A MapLibre expression colouring a symbol layer by a numeric feature property
 * — the arrow and barb colours in §4.
 *
 * Continuous ramps produce `interpolate`; discrete ramps produce `step`, which
 * is the same reasoning as the gradient above (a Beaufort arrow is force 5 or
 * force 6, never 5.4). Both clamp to `domain`, so the expression and the legend
 * beside it cannot disagree.
 */
export function rampToMapLibreExpression(
  ramp: ColorRamp,
  domain: [number, number],
  property: string,
): unknown[] {
  const [lo, hi] = domain
  const get = ['get', property]
  if (ramp.stops.length === 0) return ['literal', 'transparent']

  if (ramp.discrete) {
    const expr: unknown[] = ['step', get, css(lookup(ramp, lo))]
    for (const s of ramp.stops) {
      if (s.value <= lo || s.value > hi) continue
      expr.push(s.value, css(lookup(ramp, s.value)))
    }
    return expr
  }

  // `interpolate` requires strictly ascending inputs, so the domain ends are
  // pushed first/last and any stop landing on them is dropped.
  const expr: unknown[] = ['interpolate', ['linear'], get, lo, css(lookup(ramp, lo))]
  for (const s of ramp.stops) {
    if (s.value <= lo || s.value >= hi) continue
    expr.push(s.value, css(lookup(ramp, s.value)))
  }
  if (hi > lo) expr.push(hi, css(lookup(ramp, hi)))
  return expr
}

// -------------------------------------------------------------------- layers

/**
 * The layer catalogue: what we can draw from a `WeatherCube`, and how.
 *
 * `kind` decides the renderer, not the parameter name — a vector field drawn as
 * a colour ramp loses the direction, which for sailing is the whole point, and a
 * scalar field drawn as arrows is nonsense (§2). `defaultMode` on the vector
 * layers follows PredictWind: streamlines for wind because the gradient is what
 * you are reading, arrows for current because a 0.4 kn set needs a legible
 * direction more than it needs a pretty animation.
 *
 * There is deliberately no `sst` layer even though the ramp exists: no fetcher
 * populates an SST parameter yet (`src/lib/weather/openmeteo.ts` requests u10,
 * v10, gust, prmsl, hs, wdir, wper, uo, vo). Adding a layer whose parameter is
 * never present would render an empty field with a confident legend, which is
 * the exact failure this project refuses. Add the entry with the fetcher.
 *
 * `gust` and `pressure` had layers and no longer do. Neither earned a full-screen
 * field: a gust is a number you want at a point, not a wash of colour, and mean
 * sea-level pressure tells an inshore racer nothing they can sail on. Both are
 * still fetched and both still appear in the tap-to-inspect readout, and `gust`
 * remains a routing constraint (`WeatherField.gust`, used by the isochrone
 * kernel), so nothing downstream lost data — only two chips went away. The
 * `pressure` ramp is kept below for the same reason as `sst`.
 */
export const LAYERS: Record<string, LayerSpec> = {
  wind: {
    id: 'wind',
    label: 'Wind',
    kind: 'vector',
    params: ['u10', 'v10'],
    ramp: 'wind',
    domain: [0, 40],
    unit: 'kn',
    defaultMode: 'particles',
  },
  waveHeight: {
    id: 'waveHeight',
    label: 'Wave height',
    kind: 'scalar',
    params: ['hs'],
    ramp: 'wave',
    domain: [0, 8],
    unit: 'm',
  },
  current: {
    id: 'current',
    label: 'Current',
    kind: 'vector',
    params: ['uo', 'vo'],
    ramp: 'current',
    domain: [0, 5],
    unit: 'kn',
    defaultMode: 'arrows',
  },
}

/**
 * Order the layer picker shows, wind first because it is why anyone opens the tab.
 *
 * Lives here rather than in the screen so it sits beside `LAYERS` and can be
 * checked against it in a test: the picker looks up `LAYERS[id]` and skips a miss,
 * so a stale id here would make a chip disappear without any error.
 */
export const LAYER_ORDER = ['wind', 'waveHeight', 'current'] as const

/** The ramp a layer names, or the wind ramp if it names one we do not have. */
export function rampFor(layer: LayerSpec): ColorRamp {
  return RAMPS[layer.ramp] ?? WIND
}
