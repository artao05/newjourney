# Map Layer Rendering Architecture

How to build the wind/wave/current layer engine, written to be implementable.
Companion to [competitor-teardown.md](competitor-teardown.md), which establishes *what*
to build and why.

---

## 1. The one important constraint

Our `WeatherCube` (`src/lib/types.ts`) is already the right shape:

```ts
interface WeatherCube {
  bbox, nx, ny, dx, dy         // regular lat/lon grid
  t0, dtMs, nt                 // time axis
  data: Record<string, Float32Array>   // 'u10','v10','gust','prmsl','hs','wdir','wper','uo','vo'
}
```

A `Float32Array` of u/v on a regular plate-carrée grid is **exactly** what a GPU particle
layer consumes. No reshaping, no re-projection, no new fetch. The renderer is the only
missing piece.

Everything below therefore takes a `WeatherCube` plus a time `t` and produces pixels.

---

## 2. Layer taxonomy

Two fundamentally different rendering problems. Conflating them is the usual mistake.

| Kind | Fields | Correct marks |
|---|---|---|
| **Vector** (has direction) | wind, gust, current, wave direction | streamlines/particles, barbs, arrows |
| **Scalar** (magnitude only) | wave height, SST, rain, MSLP, CAPE | smooth colour ramp, contours |

A vector field drawn only as a colour ramp loses direction, which for sailing is the
whole point. A scalar field drawn as arrows is nonsense. PredictWind gets this right —
note that their cloud and isobar layers have *no* display options, because there is only
one sensible way to draw them.

---

## 3. Scalar fields — do this first

Cheapest, and it unlocks wave height and SST which we already download and discard.

**Technique: texture + colour LUT, sampled bilinearly.**

1. Pack the scalar into an `R32F` (or `RGBA8`-encoded) texture, `nx × ny`, one per time
   step — or a single 3-D texture / atlas across time.
2. Upload a 1-D colour ramp as a small LUT texture.
3. Draw one screen-space quad. In the fragment shader: project the fragment to lat/lon,
   sample the data texture with `LINEAR` filtering, normalise, look up the ramp.

`LINEAR` filtering is the entire trick. It is the difference between a smooth field and
the blocky quilt that marks an amateur implementation. Blockiness is not a data-resolution
problem; it is a nearest-neighbour sampling bug.

**Time interpolation** comes free: sample two adjacent time textures and `mix()` by the
fractional position. Do this in the shader, not on the CPU.

**Colour ramps must be perceptually ordered and colour-blind safe.** For wave height and
wind speed use a sequential ramp (viridis/magma-class), not a rainbow — a rainbow ramp
invents visual edges where the data is smooth. See the `dataviz` guidance if we build a
legend component. And **the Beaufort scale is worth offering as an option** for wind, as
Expedition does: sailors read it natively.

**Land masking.** A scalar ocean field bleeding over land looks wrong and implies data
where there is none. Multiply by a land mask, or clip the layer to the water polygons —
we will already have coastline geometry from the routing obstacle work.

---

## 4. Barbs and arrows — the racer's view

Both are achievable with **plain MapLibre symbol layers**, which we already do for the
static arrow field in `RouteScreen.tsx`. No custom WebGL needed.

- Thin the grid to a readable density per zoom level (target ~15–25 marks across the
  viewport, re-thinned on zoom).
- **Arrows**: one glyph, `icon-rotate` from `atan2(u, v)`, colour by speed via an
  `interpolate` expression. This is what the current code does.
- **Barbs**: not a single rotatable glyph — a barb's *shape* encodes speed (a pennant for
  50 kn, full feathers for 10, half for 5). Generate an SVG/canvas sprite per 5-knot
  bucket at load time and pick with a data-driven `icon-image` expression. Roughly 15
  sprites covers 0–75 kn.
- Barbs must be drawn **unrotated in the vertical** at high pitch, or they become
  unreadable. Keep `icon-pitch-alignment: 'viewport'`.

One subtlety that catches people: **meteorological direction is where the wind comes
FROM.** A barb's stem points *into* the wind; an arrow glyph conventionally points the way
the wind is *going*. Those differ by 180°, and getting it wrong is invisible in testing
and obvious to a sailor. Our `windToUV`/`uvToWind` helpers in `src/lib/wind.ts` already
carry the convention and are unit-tested for it — render through them, never re-derive.

---

## 5. Streamlines / particles — the GPU layer

The visual signature of a serious weather app, and the one piece with real depth.

### Technique (GPU ping-pong advection)

1. **Wind texture.** Encode `u` → R, `v` → G, normalised against the field's own min/max,
   with the range carried alongside as metadata. This is precisely the encoding `windgl`
   uses ("R channel corresponds to x (or u), and the G channel corresponds to y (or v)…
   relative to the total observed range which must be encoded in an accompanying JSON
   file"). Our `WeatherCube` header already carries per-parameter scale factors.
2. **Particle state texture.** Store N particle positions as pixels in an RGBA texture
   (16 bits per coordinate across two channels). A 512×512 texture is 262,144 particles.
3. **Update pass.** Render a quad into the *other* particle texture; the fragment shader
   reads the current position, samples the wind texture, advances by
   `v · dt · speedFactor`, and writes the new position. Ping-pong the two textures each
   frame.
4. **Draw pass.** One `POINTS` draw call, one vertex per particle, position fetched from
   the state texture in the vertex shader. Colour by speed from a LUT.
5. **Trails.** Do *not* keep particle history. Draw the previous frame back with alpha
   slightly below 1, then draw the new points on top. The fade produces the trail for
   free, and trail length becomes a single tunable.
6. **Respawn.** Randomly reset a small fraction of particles each frame, and reset any
   that leave the domain or land in zero wind — otherwise particles pool in convergence
   zones and drain the rest of the map.

Cost is **one draw call regardless of particle count**; `mapbox/webgl-wind` states "up to
1 million wind particles at 60fps."

### Prior art, with licences

| Project | Licence | Notes |
|---|---|---|
| [`mapbox/webgl-wind`](https://github.com/mapbox/webgl-wind) | **ISC** | The canonical implementation (Agafonkin). Standalone, not a map layer. Best thing to *read*. |
| [`astrosat/windgl`](https://github.com/astrosat/windgl) | **ISC** | Mapbox custom layer. **Explicitly unmaintained** — author states it is "a nice technical demo" rather than production-ready. |
| [`illogicz/windgl-js`](https://github.com/illogicz/windgl-js) | verify | MapLibre fork of the above |
| [`geoql/maplibre-gl-wind`](https://github.com/geoql/maplibre-gl-wind) | verify | deck.gl-based; pulls in deck.gl |
| [`Oseenix/maplibre-gl-particle`](https://github.com/Oseenix/maplibre-gl-particle) | ISC | MapLibre custom layer |
| `mapbox-exif-layer` | verify | `ParticleMotion` + `SmoothRaster`; uses the native custom-layer interface so it shares MapLibre's WebGL context — reported as the most mobile-browser-friendly, and supports the globe |

**ISC is permissive and compatible with our MIT.** Both ISC options are safe to vendor.

**Recommendation: write our own custom layer, reading `webgl-wind` for the technique.**
Reasons: the maintained options either pull in deck.gl (large, and we would be shipping a
second rendering stack alongside MapLibre) or are thin demos; our data arrives as an
in-memory `Float32Array` rather than the pre-baked PNG tiles these libraries expect; and
the shader core is ~150 lines. Vendoring a dependency to avoid 150 lines of shader, then
fighting its data-loading assumptions, is the worse trade.

Implement against MapLibre's `CustomLayerInterface` so it shares the map's WebGL context
and respects the layer stack.

### Mobile reality check

This is a phone-first app. Particle layers are the single easiest way to destroy battery
life and thermal headroom on a phone in direct sun on a boat.

- Cap particle count by device: ~65k on mobile, ~250k on desktop.
- Decouple advection from the render loop — advect at 20–30 Hz, not 120 Hz on a
  high-refresh display. The Medium write-up on these packages notes animation tied
  closely to the render loop "can feel rushed," and slower updates make individual
  streamlines easier to follow. Slower is both cheaper *and* more legible.
- Pause all animation when the tab is hidden, when the layer is off-screen, and when the
  Start screen is active — during a start sequence, nothing should be spending GPU on
  decoration.
- Offer a plain arrows/barbs mode and default to it on low-end devices. Barbs are what a
  racer reads anyway.

---

## 6. Time animation — highest value per line of code

The cube already carries `nt` steps. `RouteScreen.tsx` draws time index 0 and ignores the
rest. So the data is downloaded, compressed, decoded, and then thrown away.

Needs:
- A scrubber showing the cube's time span, with the model run and valid time labelled in
  **UTC and local** (Expedition shows the display time top-left for exactly this reason).
- Play/pause with adjustable speed.
- Step buttons bound to arrow keys, matching Expedition's ↑/↓ time stepping.
- The route's own time should be linkable to the scrubber — stepping through time along a
  computed route, watching the wind the router predicted, is how a navigator builds trust
  in the answer. That is the feature that ties the map to the router.

---

## 7. Proposed module layout

```
src/lib/maplayers/
├── colormap.ts        # ramps (viridis, Beaufort, wave, SST) + LUT texture builder
├── scalarLayer.ts     # CustomLayerInterface: smooth colour field w/ time mix
├── particleLayer.ts   # CustomLayerInterface: GPU advection + trails
├── barbs.ts           # sprite generation per speed bucket + symbol layer config
├── vectorSymbols.ts   # arrow/barb thinning, rotation, colour expressions
├── legend.tsx         # colour scale + units + source attribution
└── timeline.tsx       # scrubber, play/pause, speed, UTC/local labels
```

Two hard rules:

- **The layer engine must not know about routing, polars, or tactics.** Its only inputs
  are a `WeatherCube`, a parameter name, a time, and style options. That keeps it testable
  in isolation and reusable on any screen.
- **Every layer renders its provenance.** Model, run time, resolution, and valid time
  visible on screen. Our `StackedField` already carries a `source` string per sample for
  exactly this. A field with no attribution is indistinguishable from a guess, and this
  project's whole position is that we don't do that.

---

## 8. What we are deliberately not doing

- **Our own 1 km model.** PWG/PWE is compute, not code — a real and expensive moat. We
  use HRRR (3 km), ICON-D2 (2.2 km) and AROME (1.3 km) where they cover the venue, which
  is the same class of resolution for free, just not everywhere.
- **Chlorophyll, thermocline, eddies, thermal fronts.** SeaLegs' fishing layers. Wrong
  user.
- **A "Go / Caution / Avoid" AI verdict.** The decision-support framing is right and we
  should take it. Attaching a fabricated confidence percentage to a weather forecast is
  not, and would contradict our own product principles.
- **Split-screen model comparison** — genuinely good, but P2. A single "models disagree
  here" indicator delivers most of the value for a fraction of the UI.
