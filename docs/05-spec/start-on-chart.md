# Start on the chart — implementation plan

**Status:** draft, for review
**Date:** 2026-08-05
**Supersedes in practice:** the chartless Tier 0 start view in `technical-spec.md` §"Delivery tiers", row 1

---

## 1. Why

The start view today (`src/components/StartCanvas.tsx`) draws into a rotated local
frame built at the line midpoint. Pin left, RC right, wind up, auto-fit to the
line and the boat. It is a good abstract diagram and it is not attached to
anything: no shore, no shoal, no channel, no mark, no committee boat in a place
you can recognise. A sailor on a start line is looking at a breakwater and a
green can, and the display shares no vocabulary with what they see.

Grounding the start line on real geography is what makes the numbers usable, and
it is the only way the start view can share a surface with weather, current and
routing rather than sitting beside them.

## 2. Shape of the change

There are two map surfaces today and each owns its own MapLibre instance:
`WeatherScreen` and `RouteScreen`. `RouteScreen` even re-implements wind arrows
(`windFC` → `wind-arrows`) that duplicate `src/lib/maplayers`. Start and Race are
chartless — Start draws an abstract canvas, Race is a numbers grid.

The target is **one chart surface with mode overlays**:

```
ChartSurface                    owns map, cube, model, timeline, basemap, venue layers
├── StartOverlay                line, laylines, ends, bias, boat, burn chrome
├── RaceOverlay                 active mark, laylines to it, course, tactical tiles
├── RouteOverlay                isochrones, route, sensitivity, marks
└── WeatherOverlay              scalar field, streamlines, barbs, probe, legend
```

Tabs stay as they are. Switching tab switches the overlay and the camera
behaviour; the map instance is not torn down.

Race folds in for the same reason Start does. It already owns the course —
`addMark`, `replaceMarks`, `makeWLCourse`, `activeMarkIndex` — and edits it
through form controls, and it already computes distance-to-layline for the active
mark and can only report it as a number. On the chart those become direct
manipulation and drawn geometry. **Race is not in the six phases below**: it is
the same pattern applied a second time, and it should follow once `StartOverlay`
has proved the shape rather than being designed speculatively alongside it.

## 3. Decisions this plan makes

These are the review surface. Each has a recommendation; disagreement here
changes the phases below.

| # | Question | Recommendation |
|---|---|---|
| D1 | Map orientation at start scale | **North-up**, `bearing = 0`, matching every other surface and a paper chart. The shore stays where the shore is. Costs the canvas's pin-left/RC-right convention; §6 covers what has to replace it. Line-up is deferred, not forbidden. |
| D2 | What renders as "the ground" at start zoom | **OSM raster**, as the style already has. The shipped masks cannot do this job — see §4. |
| D3 | Weather field at start zoom | **Suppress the field.** Show one wind vector plus a value at the line. The field is one grid cell at that scale; drawing it implies structure that is not in the data. |
| D4 | The time axis during a start | **Pin to gun time, not now.** Bias and favoured end computed from the forecast at the gun. This is the feature that justifies the merge. |
| D5 | Fate of `StartCanvas` | **Retire the screen, keep the module** until Phase 6 parity is signed off, then delete. Do not maintain two start renderers indefinitely. |
| D6 | Offline start | Accept that start-scale chart detail needs network in this milestone. Venue-pack tiles are a separate piece of work. See §7. |

## 4. The grounding problem, measured

"Grounded" cannot mean the assets already shipped, at least not at start scale:

| Asset | Cell size | Cells across a 500 m start view |
|---|---|---|
| `portland-land.bin` | 0.001° ≈ 111 m N–S, 80 m E–W | ~5 |
| `portland-depth.bin` | 1/240° ≈ 463 m N–S, 336 m E–W | ~1 |

A five-cell staircase is not a coastline. Both assets remain correct and useful
at **venue zoom** (a depth/land layer over Casco Bay) and as **logic** layers —
land avoidance for routing, a shoal warning under the line — but neither can be
the picture a sailor orients against 200 m off a breakwater.

So the visual chart at start zoom is the OSM raster already in `STYLE`, with its
existing desaturation. That means the start view needs network for full detail,
which §7 addresses honestly rather than pretending otherwise.

## 5. Phases

Each phase is independently shippable and leaves the app working.

### Phase 0 — extract the chart surface

Pull the map lifecycle out of `WeatherScreen` into `src/components/ChartSurface.tsx`:
map init, basemap style, `ScalarLayer`/`ParticleLayer` registration, barb sprite
loading, cube fetch and model selection, timeline state, `moveend` plumbing.
Expose the map through a context so overlays can add their own sources.

`WeatherScreen` becomes `WeatherOverlay` rendered inside it and must be visually
identical afterwards. Nothing else changes in this phase.

- Touches: `WeatherScreen.tsx` (split), new `ChartSurface.tsx`, new `useChartMap()` context.
- Done when: the Weather tab is pixel-equivalent and the cube is fetched once for the surface, not per screen.

### Phase 1 — start geometry as a pure module

New `src/lib/startline/geo.ts`, in the style of the rest of `src/lib`: pure,
typed, tested, no React and no MapLibre.

```
lineFeature(line)                     → LineString, pin → RC
lineExtensions(line, factor)          → the dashed over-early extensions
laylineFeatures(line, twd, targetTwa) → four LineStrings from the two ends
endFeatures(line, numbers)            → PIN / RC points, favoured end flagged
biasFeature(line, numbers)            → the bias marker anchored to the favoured end
```

All of it derived from `StartLine`, `WindEstimate` and `StartNumbers`, which
`computeStart` already produces. `computeStart` itself needs no change.

- Touches: new `src/lib/startline/geo.ts`, new `geo.test.ts`.
- Done when: unit tests cover a square line, a 20°-biased line, and a line with a null end.

### Phase 2 — StartOverlay renders on the map

New `src/components/StartOverlay.tsx` plus `useStartLayers(map)`:

- GeoJSON sources for line, extensions, laylines, ends, bias, track.
- A transparent canvas over the map, projecting through `map.project()`, for the
  things that need pixel and metric maths every tick: the boat hull scaled to
  `loaMetres`, the COG predictor, the distance-below-line tick, the boat-length
  grid, the GPS accuracy circle (§6).
- The hero, burn bar, tiles and PING/timer actions move over unchanged from
  `StartScreen`, as absolutely-positioned chrome.
- The declutter-60-seconds-after-gun rule applies to both the map layers and the
  canvas.

- Touches: new `StartOverlay.tsx`, `useStartLayers.ts`, `StartScreen.tsx` (becomes a thin host), `App.tsx`.

### Phase 3 — camera, and the orientation cues north-up requires

- `fitBounds` over line + boat + 35% pad, matching the canvas's framing rule.
  Bearing stays 0.
- Re-fit on ping and on a "recentre" control, **not** continuously — a camera
  that chases the boat during a start is unusable.
- Ship the two cues from §6 that replace the lost line-up convention: the
  pre-start side shading and the persistent wind vector.
- **Carry the rotation fix anyway.** `wx-barbs`, `wx-arrows` and
  `wx-speed-labels` are declared `rotation-alignment: 'viewport'` with
  `icon-rotate: ['get', PROP_FROM]` (`WeatherScreen.tsx:171`, `:190`). Viewport
  alignment makes those rotations relative to the screen, so at any non-zero
  bearing every barb and arrow is wrong by exactly the bearing — and still looks
  plausible. North-up as a default does not avoid this: MapLibre enables
  `dragRotate` and touch rotation by default, so the bug is reachable on the
  Weather tab today, before any of this work lands. Move them to `'map'`
  alignment. `ScalarLayer` and `ParticleLayer` are fine — both project through
  `defaultProjectionData.mainMatrix`, and the particle trail buffer already
  clears on camera move.

- Done when: a barb over the line reads the same compass direction after a two-finger rotate as before it.

### Phase 4 — weather at gun time

- Sample the cube at `course.startLine.gunTime` rather than `Date.now()` and feed
  that wind into `computeStart`, so bias, favoured end and laylines describe the
  start you are sailing rather than the one you are sitting in.
- Show both when they differ: "bias now −4°, at gun −11°" is a tactical fact.
- Zoom rule from D3: above the start-scale threshold, suppress the field and show
  a single wind vector at the line with its source and uncertainty.
- Tidal current from the NOAA station stays a number, not a field — the existing
  caveat in `WeatherScreen` applies unchanged.

- Done when: scrubbing the timeline visibly swings the layline pair and the favoured end.

### Phase 5 — interactions

- Drag PIN/RC on the map to correct a mis-ping. `mousedown` on the layer +
  `map.dragPan.disable()`, the pattern already used for the streamline drag in
  `2642aa0`.
- Tap-to-place when an end is unset; `map.on('click')` becomes mode-dependent so
  it no longer unconditionally sets the weather probe.
- PING stays a button — it reads GPS, not the map.
- Layout budget: layer chips collapse to a single "Layers" chip in start mode;
  the timeline yields the bottom band to the start actions and collapses to a
  gun-relative scrubber.

### Phase 6 — retire the canvas

Delete `StartCanvas.tsx` and the chartless path once Phase 2–5 parity is signed
off against the feature list in `docs/03-algorithms/start-line-math.md` §6.

## 6. What north-up costs, and what pays for it

The canvas's rotated frame did four jobs for free that a north-up chart does not.
Each needs an explicit replacement, and none of them is optional.

1. **Which side is "below" the line.** In the canvas, below is always down. On a
   north-up chart the pre-start side can be any direction, and "am I over?" is
   the question the screen exists to answer. Replace with a shaded band on the
   pre-start side of the line — subtle when clear, and the whole band flips to
   the OCS colour when `numbers.ocs`. This is new work with no canvas equivalent.
2. **Where the wind is.** Line-up on a square line is wind-up, so the canvas
   could put the wind arrow in a corner as a reminder. North-up cannot. The wind
   vector becomes a persistent, anchored element with its source and
   uncertainty, not decoration.
3. **Pin left, RC right.** Gone. The end labels and the port/starboard colouring
   already in `StartCanvas` carry the whole load now, so they must survive the
   port to map layers rather than being simplified away.
4. **Symmetric laylines.** They now sit at whatever angle they really are, which
   is arguably more honest and definitely harder to read at a glance. The
   favoured-end marker does more work as a result — keep it prominent.

What north-up buys is the thing this milestone exists for: the shore does not
move. A transit — sighting the pin against a shore feature to judge the line — is
still worth drawing as an extension of the line to the coastline, just as a
diagonal rather than straight off the side of the screen.

Line-up remains implementable later as a toggle, since Phase 3 fixes the symbol
alignment that would otherwise break it. It is deferred, not designed out.

## 7. What grounding exposes that the canvas hid

The canvas has no absolute reference, so GPS error is invisible in it. On a real
chart it is not: a ±6 m fix on a 6.93 m boat, at a zoom where one boat length is
40 px, will visibly place the boat on the wrong side of a pier. This is not a
regression — it is the truth becoming visible — but it must be drawn rather than
left for the user to discover.

- Render the accuracy circle from `state.accuracyM` under the hull, always.
- Keep `bowPosition()` in the loop: the GPS is `bowToGpsMetres` aft of the bow and
  at this scale that offset is a third of a boat length.
- Distance-below-line stays in boat lengths as the primary unit. Metres are
  precision the fix does not have.

## 8. Costs and risks

**Bundle.** `App.tsx:26` code-splits MapLibre precisely because "the start-line
user never opens it… the dockside 3G connection this app is actually used on."
This plan makes ~800 kB of JS mandatory for the beachhead feature. Mitigation:
precache the chunk in `public/sw.js` so it is a first-visit cost only, and keep
the Start tab's first paint independent of the cube fetch — timer, hero and PING
must work before any tile or forecast arrives.

**Network at the line.** Per D2/D6, start-scale detail comes from OSM raster
tiles. Offline, the view degrades to the shipped 111 m land mask and the start
geometry, which is honest but coarse. A real offline answer is a venue tile pack
from the NOAA ENC service already declared in `venues.ts` — separate work, worth
its own ADR, and the reason D6 is stated as an acceptance rather than a fix.

**Depth datum.** If the depth layer is shown near the line, `bathymetry.ts`'s
measured caveats travel with it: GEBCO is MSL-referenced and Portland MSL sits
1.51 m above MLLW, so low water leaves about a metre and a half less than shown,
and 18 m errors are documented at a known buoy. It is a display layer. It never
becomes a depth check.

**Two renderers in flight.** Phases 2–5 leave `StartCanvas` alive but unrouted.
Phase 6 is not optional cleanup; skipping it leaves the start logic with two
divergent presentations.

## 9. Settled during review

- **Orientation: north-up** (D1). A rotating chart is disorienting for anyone
  reading the shore, which is the whole point of grounding the view. §6 records
  what that costs and what replaces it.
- **Race folds into the chart surface**, after Start rather than alongside it
  (§2).

## 10. Open questions

1. Does an ADR get written for the surface extraction, or does this plan stand as
   the record once approved?
2. §6 item 1 — the pre-start shading — has no prior art in this codebase and is
   load-bearing for "am I over?". Worth prototyping before Phase 2 is scoped.
