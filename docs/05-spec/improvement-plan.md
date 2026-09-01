# Improvement plan — everything except the chart surface

**Status:** living document, reviewed on a loop
**First written:** 2026-08-05
**Does not own:** the chart-surface milestone. `ChartSurface`, `StartOverlay`, the
Race fold-in, the symbol `rotation-alignment` fix and the retirement of
`StartCanvas` all belong to [start-on-chart.md](start-on-chart.md), which is in
flight. Anything that plan claims is deliberately absent below, referenced rather
than restated.

This is a plan for the *rest* of the app: the data underneath the chart, the
router, and the parts of the codebase that have no safety net.

---

## 0. Pass 34 — 2026-08-29 — wrap360 fabricated north from NaN

Detection method: **error-path analysis** — tracing what happens when inputs are
null, NaN, zero, or out-of-range through every function that returns them.

### The bug

`wrap360(NaN)` returned `0`. The function's `%`, `>=`, `+`, and `<` operators all
produce NaN or `false` for NaN input, and the final `s < 360 ? s : 0` fell through
to the default — which is `0`, i.e. north.

This turned every unknown bearing into a confident due-north. The path through the
app: a stationary GPS reports `cog: NaN` (no heading at zero speed), `heading` is
null (no compass), so `state.heading ?? state.cog` is NaN. `twaFrom(NaN, twd)`
cascaded through `angdiff` → `wrap180` → `wrap360` and emerged as `180` — dead
downwind — because `wrap360(NaN) - 180 = 0 - 180 = -180`, and `wrap180` maps that
to `+180`. The tactical display showed TWA 180°, with matching downwind target
speeds and negative VMG, when every one of those fields should have been null.

### Same root cause, second site

`computeStart` had no NaN guard on its wind input. `computeTactics` already had
one (`i.wind && Number.isFinite(i.wind.twd) && Number.isFinite(i.wind.tws)`), but
`computeStart` passed `i.wind` through unchecked. The `wrap360` fix exposed this:
once NaN propagated instead of being swallowed, the start-line bias and approach
calculations produced NaN distances. The same guard was applied.

### Three more sites in the same family

`computeTactics` also leaked NaN through:
- **VMC** (line 439): `state.sog * Math.cos(angdiff(mark, state.cog) * DEG)` —
  `0 * NaN = NaN`, not 0, so a stationary boat with NaN COG showed NaN VMC.
- **Laylines**: `computeLaylines` built `fromPolar(state.cog, 1)` — NaN direction
  vectors bypassed `rayIntersect`'s parallel-ray guard (`Math.abs(NaN) < ε` is false),
  and NaN distances passed `!== null`.

Both now stay null when COG is non-finite.

### Also fixed: departure sweep cap overflow

`planDepartures` with `maxSolves = 1` produced 2 departures because
`step = ceil(span / (cap-1 || 1))` set `step = span`, giving
`count = floor(span/span) + 1 = 2`. Capped with `Math.min(cap, count)`.

Ten mutations across all sites, nine caught (the tenth is an equivalent rewrite
of the step formula). Suite 891 → 894 / 41 files.

### Passes 35–37 — clean

- **Pass 35** (error paths in routing/weather/polar): all well-guarded. Zero-wind,
  all-MISSING cubes, boundary time fractions, single-row polars — all handled. Also
  scanned for weak test assertions; strengthened three `not.toBeNull()` checks in
  `tactics.test.ts` to specific value assertions.

- **Pass 36** (constants and configuration verification): every checkable physical
  constant is correct — Earth radius, NM definition, ft→m, GEBCO resolution, tidal
  datum arithmetic, missing sentinels. One cosmetic inconsistency (m/s-to-knots
  truncated to 5 vs 7 decimal places in two files), immaterial at 0.00002 kn.

- **Pass 37** (GPX import/export NaN handling): correct. `deriveMotion` uses NaN for
  missing SOG/COG, handles non-monotonic timestamps, and the first-point-borrows
  rule avoids a leading NaN hole. Import validates lat/lon and skips non-finite times.

Suite 894 / 41 files.

### Pass 38 — cross-module contract violations

Detection method: tracing the "null, not NaN" contract across module boundaries —
where one module returns NaN for missing data and the caller's null-guard passes it
through because `NaN !== null` is true.

Two bugs, same pattern:

1. **NaN sog leaks through VMC.** `computeTactics` computed VMC as
   `state.sog * Math.cos(…)`. When `sog` is NaN (stationary GPS, no speed fix),
   `0 * NaN = NaN` — but the guard only checked `Number.isFinite(state.cog)`, not
   sog. Fixed by adding `&& Number.isFinite(state.sog)` to the VMC guard.

2. **NaN position leaks through mark geometry.** `bearing()` and `distance()` return
   NaN for NaN lat/lon, and NaN passes the `!== null` guard that protects
   `markBearing` and `markRange`. Fixed with an early return:
   `if (!Number.isFinite(state.position.lat) || !Number.isFinite(state.position.lon)) return`.

Two mutations, both killed. Suite 894 / 41 files.

### Pass 39 — semantic regression check

Verified that the fixes from passes 34–38 introduced no regressions:

- All `wrap360` callers feed it `Math.atan2` output or computed bearings — never
  raw Infinity. The new NaN return path is unreachable from normal inputs.
- `RaceScreen.tsx` uses optional chaining (`t?.twa`, etc.) and `Tile` renders an
  em-dash for null/non-finite values — the expanded null returns are handled.
- `computeStart`'s wind guard replaced all downstream `i.wind` references — no
  stale references remain.
- `RouteScreen.tsx`'s `.twa.toFixed(0)` operates on `RouteLeg.twa` (non-nullable
  `SignedDegrees` from the routing engine), not `TacticalNumbers.twa`.

Zero regressions.

### Pass 40 — mutable aliasing / defensive copy

No bugs. Every store setter creates a new reference (`.slice()`, spread). The
isochrone kernel's scratch objects (`pa`, `pb` in `NodeStore`) are class-private and
never escape. `computeTactics` and `computeStart` return fresh objects from factory
functions. No component captures a mutable ref that becomes stale.

### Pass 41 — boundary value analysis

Detection method: **boundary value analysis** — testing at mathematical extremes
(antimeridian, poles, zero speed, -0, single-element collections).

**Bug: `bboxOf` produced globe-spanning boxes for antimeridian crossings.** Points
at lon 170 and -170 (20° apart via ±180) produced a bbox spanning 340° the long way.
This fed `gridDims` a 340° span, so the weather field got ~5× fewer cells per degree
over the actual route. The `DenseField.sample()` method and `RasterLandMask.isLand()`
already use `wrap180` for longitude indexing and would work correctly once given the
right bbox — the bug was only in `bboxOf` and the `dLon` computation.

Fix: compute the bbox in both [-180,180] and [0,360] coordinate frames and pick the
tighter one. Added `lonSpan(west, east)` helper that returns the correct span when
`west > east` (crossing). Updated `DenseField`, `gridDims`, `Recorder`, and
`RasterLandMask` to use `lonSpan` for `dLon`.

Five mutations, two killed (the `bboxOf` dual-frame detection and the `lonSpan`
wrapping). Three downstream mutations survived — `lonSpan(w, e)` and `e - w` are
identical for non-crossing boxes, and no test uses antimeridian data.

Also noted (not fixed — low impact for current use):
- `LocalFrame.toLatLon` divides by unguarded `cosLat` (wrong at lat > 89°)
- `rhumbBearing` at lat=90 produces `atan2(x, Infinity)` = 0

Suite 898 / 41 files.

### Passes 42–44 — clean

- **Pass 42** (temporal coupling / initialization order): no bugs. The worker
  protocol is stateless per-message. Store derivations happen in null-safe `useMemo`
  hooks. The one historical temporal coupling bug (stale `landPack` closure in
  `RouteScreen`) was already fixed.

- **Pass 43** (resource leak / cleanup): no bugs. Every `setInterval` has a matching
  `clearInterval`. Every `addEventListener` has a matching `removeEventListener`.
  Workers are terminated on cancel/dispose. AbortControllers are aborted in cleanup.
  `watchPosition` is cleared. ResizeObservers are disconnected.

- **Pass 44** (async race conditions): no bugs. Weather fetches use either busy-flag
  button guards or cancelled flags. `RoutingClient` terminates the old worker on
  re-entry. Zustand actions are synchronous with no async gap between get/set. Map
  operations after awaits guard via `mapRef.current` null checks.

Suite 898 / 41 files. **Third plateau** — passes 39–44 (six strategies) with only
pass 41 (antimeridian bbox) finding a real bug.

### Passes 45–46 — clean

- **Pass 45** (numeric precision / catastrophic cancellation): no bugs. Haversine
  uses the stable `atan2(sqrt, sqrt)` form. Interpolation uses `a + (b-a)*t` with
  clamped fractions. Time arithmetic at epoch ~1.7e12 ms has ULP ~0.0002 ms — step
  accumulation over 3000 steps produces at most 1.5 ms drift, negligible against
  60-second minimum steps. Tidal interpolation stays in-range by construction.

- **Pass 46** (physics model / specification conformance): no bugs. Wind triangle
  vectors are correct (FROM convention, subtraction for true→apparent). VMG uses BSP
  (water speed), VMC uses SOG (ground speed) — both correct. PCHIP preserves
  monotonicity (Fritsch-Carlson). Polar returns 0 at TWA=0 and is symmetric via
  `Math.abs(wrap180(twa))`. Heel correction is anemometer tilt compensation, not a
  speed reduction. Current effect correctly subtracts ground velocity.

### Passes 47–48 — clean

- **Pass 47** (PWA / service worker correctness): no bugs. Weather APIs are correctly
  excluded from caching. Venue assets (bathymetry, land mask) are cached with
  stale-while-revalidate. Tile cache has FIFO eviction at 1200 entries. No retry
  loops on failed fetches. Update flow uses skipWaiting + clients.claim — no reload
  loop risk.

- **Pass 48** (type safety / assertion audit): no bugs. Zero `any` or `!` in
  production `src/lib/` code. Every `as` cast is backed by structural guards (JSON
  parse), browser API contracts (WebGL), or logical guarantees (Map.get after set).

Suite 898 / 41 files.

### Pass 49 — state persistence / shallow merge

Detection method: **state persistence schema migration** — checking what happens when
persisted localStorage data has a stale schema (missing new fields).

**Bug: Zustand's default shallow merge destroyed nested defaults.** The `persist`
middleware does `{ ...current, ...persisted }` — a shallow spread. When old
localStorage had `settings: { units: 'imperial' }` (missing `keepAwake`), the entire
default `settings` object was replaced, leaving `keepAwake` as `undefined`. Same for
`boat`, `course`, and `course.startLine`.

Fix: extracted `mergePersistedState` that deep-merges each nested object individually:
`boat`, `course` (including `startLine`), and `settings`. Added `version: 1` to the
persist config for future schema migrations.

Four mutations, three killed (settings, boat, startLine). The fourth ("remove merge
config") survived because the test calls the function directly; an integration test
through Zustand hydration would kill it but is disproportionate.

### Passes 50–51 — clean

- **Pass 50** (test quality audit): no tests give false confidence. No tautological
  assertions, no mock-only tests, no suspicious tolerances, no flaky time dependence.
  Mocks are scoped to browser APIs unavailable in Node; every assertion tests real
  production logic.

- **Pass 51** (security audit): no XSS, injection, or credential exposure. No
  `innerHTML` or `dangerouslySetInnerHTML`. GPX export escapes user strings. API
  responses are typed as `unknown` and structurally validated. No API keys in source.

Suite 903 / 41 files.

### Passes 52–56 — clean

- **Pass 52** (UI rendering edge cases): no bugs. `Tile` component handles
  null/NaN/Infinity with `Number.isFinite` guard, rendering "---". No `{0 && ...}`
  conditional rendering traps. `StartCanvas` bails on missing endpoints.
  `screens.test.tsx` enforces dashes-not-zeros invariant.

- **Pass 53** (error boundary coverage): no bugs. `ErrorBoundary` wraps every screen
  tab individually. Worker crashes terminate and resolve with error result.
  `.toFixed()` calls are null-guarded. No unguarded throw paths in render.

- **Pass 54** (routing kernel deep dive): no algorithmic bugs. Pruning uses spatial
  buckets (no 359°→0° wrap issue). Parent pointers are monotonically decreasing (no
  infinite loop in reconstruction). Backward pass correctly reverses time and wind
  sampling. Multi-leg time threading is correct. Sensitivity band clamps negative
  loss to 0.

- **Pass 55** (dependency vulnerability audit): one high-severity CVE in `nanoid`
  (transitive via vite→postcss). Not used in app code — dev-only, no action needed.

- **Pass 56** (map layer lifecycle): no bugs. Sources added before layers, cleanup
  removes layers then sources. Custom WebGL layers properly delete all GPU resources
  in `onRemove`. Layer ordering uses `beforeId` for correct stacking.

- **Pass 57** (dead code analysis): `wind.ts` exports (`apparentToTrue`,
  `trueToApparent`, `apparentAngleAndSpeed`) and tidal functions (`velocityAt`,
  `flowAt`) are dead in production. By design — library code for future instrument
  integration (Signal K) and tidal overlay. No action needed.

- **Pass 58** (API response edge cases): `fetchPointForecast` in
  `src/lib/weather/openmeteo.ts` silently returns empty arrays when the API
  returns an HTTP 200 error body (`error: true`). Not a bug — `App.tsx` line 104
  already guards with `if (cancelled || forecast.t.length === 0) return`, so the
  empty result is harmless. No action needed.

- **Pass 59** (Vite build correctness): **one bug found and fixed.** The dev-only
  `LayerHarness` component was `lazy()`-imported at module scope, causing Rollup to
  emit a 4.5 KB chunk (`LayerHarness-*.js` + 16 KB sourcemap) in the production
  build. Never loaded at runtime, but shipped to the server. Fixed by wrapping the
  `lazy()` call in `import.meta.env.DEV` so the dynamic import is tree-shaken.
  Production build verified clean — chunk eliminated. Also: 15 `console.log` calls
  ship to production — intentional for field debugging a PWA.

- **Pass 60** (locale-dependent behavior): no bugs. Number parsing uses
  `<input type="number">` (locale-invariant `.value`). Number display uses
  `.toFixed()` (locale-invariant per ECMA-262). Date display uses
  `toLocaleTimeString()` intentionally. `toLowerCase()` is only on ASCII protocol
  strings (no Turkish İ risk). All sorts use explicit numeric comparators.

- **Pass 61** (accessibility audit): no functional bugs. Several minor a11y gaps
  (missing `aria-label` on wind sliders, missing labels on lat/lon inputs, `div`
  with `onClick` without keyboard support, no `aria-selected` on active tab).
  Quality-of-life for assistive technology, not code defects — phone-first sailing
  instrument's primary use is on-water with touch.

- **Pass 62** (React rendering correctness): no bugs. Zustand subscriptions via
  `getState()` avoid stale closures. All effects have proper cleanup (GPS watch,
  compass listener, rAF timer). Keys use stable `mark.id`. No state-after-unmount
  risk because results go to global store, not component-local state.

- **Pass 63** (WebWorker communication): no bugs. Worker messages are correctly
  serializable (plain objects, typed arrays). Error handling sends errors back via
  message, main thread shows via `setRouteError()`. One minor smell: worker ref
  lost on tab unmount orphans an idle worker. Not a functional issue.

- **Pass 64** (PWA offline behavior): **one bug found and fixed.** The service
  worker cached tile error responses (404, 500) in the tile cache. A rate-limited
  or errored tile would persist offline until evicted by the 1200-entry LRU.
  Fixed by adding `if (res.ok)` guard before `cache.put()`. Test added and
  mutation-tested (removing the guard fails the new test).

- **Pass 65** (CSS/layout correctness): no bugs. Uses `dvh` (no `100vh`), respects
  safe-area insets, coordinated z-indexes, `min-height: 0` on flex items, 16px input
  font (no iOS zoom). One smell: missing horizontal safe-area insets in landscape,
  mitigated by portrait-lock in the PWA manifest.

- **Pass 66** (GPX import/export roundtrip): **one UX bug found and fixed.** The
  file input was not reset after GPX import, so re-importing the same file did
  nothing (browser `onChange` doesn't fire when value unchanged). Fixed with
  `e.target.value = ''` in `finally`.

- **Pass 67** (extreme coordinates): no bugs in the sailing domain (±85° lat, any
  longitude). All edge cases guarded: `bboxOf` clamps lat to ±89.9°, routing kernel
  clamps to ±89°, `cosLat` floored at 0.02 in router and 0.1 in `bboxOf`. `clampUnit`
  prevents NaN from `acos`/`asin`. Two theoretical issues at exact poles (LocalFrame
  and rhumbBearing) are unreachable in practice.

- **Pass 68** (timer/animation precision): no bugs. Countdown uses wall-clock
  `Date.now() - gunTime` with rAF display — no drift. GPS timestamps from hardware,
  no fixed-rate assumption. Simulation uses `setInterval` with minor drift but is
  dev-only.

- **Pass 69** (state consistency / impossible states): no bugs. All mutation paths
  maintain invariants. `activeMarkIndex` clamped on every course change. Route
  invalidated on every mark mutation. `clearCourse` resets all course-dependent
  state. No impossible state reachable through the UI.

- **Pass 70** (map interaction correctness): no bugs. Coordinate convention `[lon,lat]`
  consistent throughout. Source/layer cleanup correct (layers before sources). Map
  init guarded against StrictMode double-mount. Custom WebGL layers clean up all
  GPU resources. ResizeObserver handles container resize.

- **Pass 71** (canvas rendering correctness): no bugs. All 4 canvas components
  handle Retina DPI via `devicePixelRatio`. Canvas cleared before each frame. Zero
  size guarded. Text rendered in logical pixels after `ctx.scale(dpr, dpr)`.

- **Pass 72** (weather data interpolation): no bugs. Wind direction interpolation
  uses U/V components (correct for circular data — 350°↔10° interpolates through
  north). Temporal/spatial boundaries clamp to edge values. NaN cells rejected by
  routing kernel. Units knots throughout (API queried with `wind_speed_unit=kn`).

- **Pass 73** (polar lookup edge cases): no bugs. TWA=0° returns 0 speed (no irons).
  Symmetry via `Math.abs(twa)`. TWS=0 handled (router rejects <0.5 kn). Above-max
  TWS extrapolates linearly. VMG optimals computed by brute-force scan. Lattice O(1)
  lookup with bounded indices.

- **Pass 74** (start line geometry edge cases): no bugs. All edge cases handled
  correctly: one end pinged (returns partial data), both ends same point (early
  return), boat over line/OCS (UI shows OCS state), zero speed (null propagation),
  no wind (bias fields null), wind perpendicular to line (0° bias, `'even'`). The
  GPS approach's `Math.abs(hit.t)` for boats pointing away is a documented design
  choice.

- **Pass 75** (tidal prediction): no bugs. Harmonic computation delegated to NOAA
  CO-OPS API. Timestamps parsed as explicit UTC. Units converted at parse boundary
  (feet→metres). Datum chain correct (MLLW→MSL offset tested with sign-inversion
  anchors). Missing/error data returns null, not fallback. Slack detection uses NOAA
  published events, not re-derived.

- **Pass 76** (depth/bathymetry): no bugs. Bilinear interpolation with correct
  boundary handling. Datum chain documented and tested. Land cells return null, not
  0. Depth is advisory-only (not a routing constraint — GEBCO too coarse). Metres
  throughout, no unit mixing.

- **Pass 77** (wind time shift leaks into current/wave queries): **BUG.** The
  `hydrate()` function in `isochrone.ts` computed a single shifted time `tq` and
  used it for wind, current, and wave queries. The wind time shift is a
  user-facing control for offsetting the forecast in time ("what if the breeze
  fills an hour late?"), but current is tidal (phase-locked to the moon) and
  waves are not wind-offset either. With a non-zero shift, routing would sample
  current at the wrong phase of the tide — potentially a 6-knot error in a strong
  tidal stream. Fix: compute `tNoShift = clamp(tBase, ...)` and use it for
  current and wave queries. Currently dormant (`windTimeShiftS` hardcoded to 0 in
  the UI) but would have produced silently wrong routes the day a time-shift
  control was wired up. Test pins the fix with a spy that records query timestamps
  and verifies the shift relationship. Mutation test (revert to `tq`): caught.

- **Pass 78** (error boundary and lazy-import recovery): **BUG.** `React.lazy()`
  caches a rejected import forever. After a chunk-load failure (realistic on
  dockside 3G), clicking "TRY AGAIN" in the ErrorBoundary resets the boundary's
  error state, but React immediately re-throws the cached rejection without
  retrying the `import()`. The Route and Weather tabs become permanently broken
  for the session. Fix: move the `lazy()` calls inside `App` via `useMemo` keyed
  on a `lazyGen` counter; the ErrorBoundary's `onReset` callback bumps the
  counter, which creates a fresh lazy wrapper whose factory will actually call
  `import()` again. Test pins that `onReset` is called on retry.

- **Pass 79** (Zustand state transitions): no bugs. All actions read state via
  `get()` synchronously, no interleaving possible. Persist middleware deep-merges
  nested objects. All mutations create new references. No over-selecting.

- **Pass 80** (worker messaging protocol): no bugs. Messages are ID-matched,
  errors caught in-band, stale replies filtered, buffers cloned (not transferred),
  only structured-clone-safe data crosses the boundary.

- **Pass 81** (MapLibre GL layer lifecycle): no bugs. Layers removed before
  sources in correct order. `load` event gates all additions. `addImage` guarded
  by `hasImage`. All event listeners cleaned up. GL resources (textures, buffers,
  programs) freed in `onRemove`.

- **Pass 82** (URL/query string handling): no bugs. Negative lat/lon safe in
  query strings. NOAA uses `URLSearchParams`. No credentials in URLs. Responses
  validated before use.

- **Pass 83** (geolocation/sensor edge cases): no bugs. Null GPS fields → NaN
  with `Number.isFinite` guards at every consumer. `watchPosition` throttled.
  Permission denied shows a useful message. GPS/simulation hooks mutually
  exclusive with proper cleanup.

- **Pass 84** (departure sweep correctness): no bugs. Time window iteration
  correct with inclusive endpoints. Results in chronological order. Winner chosen
  by minimum elapsed time (consistent with stated purpose). Weather field reused
  safely across start times. Edge cases (zero window, all-equal, partial failures)
  handled.

- **Pass 85** (CSS layout on small screens): **BUG.** The tidal current panel
  header in `WeatherScreen.tsx` is a non-wrapping flex row whose chips (current
  speed, turn time, toggle button) overflow on 375px phones. The parent has
  `overflow: hidden`, so the toggle button is silently clipped — the user cannot
  collapse the chart and cannot read when the current turns. Fix: add
  `flexWrap: 'wrap'` to both the header row and the chip span, matching the
  pattern used by the layer selector chips at the top of the same screen.

- **Pass 86** (forecast data freshness): no bugs. 15-minute refresh with
  position-driven re-fetch on 0.01° movement. Stale forecast retained on network
  error with visible warning. All timestamps UTC millis throughout. Mode switching
  cancels in-flight fetches and clears wind history.

- **Pass 87** (storage/persistence edge cases): no bugs. Persisted data under
  1 KB, bounded arrays excluded from persistence, corrupt JSON handled by
  Zustand's rehydration, incognito mode degrades gracefully, schema evolution
  deep-merges new fields.

- **Pass 88** (Vite/TypeScript build config): no bugs. Path aliases consistent,
  `es2022` target appropriate, no Node.js modules in client, strict mode enabled.

- **Pass 89** (route computation race condition): **BUG.** Double-tapping ROUTE
  causes the first computation's cancelled result (`ok: false`) to set
  `routeError('routing cancelled')` after the second computation already cleared
  it. The stale error persists over a correct route. Additionally, the first
  run's `finally` block clears the second run's busy/spinner state. Fix: add a
  `runIdRef` counter; each `run()` increments it and checks before setting state.
  Superseded runs silently discard their results.

- **Pass 90** (departure sweep race conditions): no bugs. The sweep reuses the
  same `runIdRef` guard as the route. The `RoutingClient` cancels in-progress
  work on a new request. Sweep and route share a single busy state, so only one
  can run at a time.

- **Pass 91** (timeline playback step): **BUG.** The `step()` function used
  `Math.round` to snap fractional slider positions before adding the delta.
  When `Math.round` rounds toward the direction of travel, the step overshoots
  by one whole forecast hour (e.g., from index 2.5 forward: round→3, +1=4,
  skipping hour 3). The play timer already used `Math.floor` correctly. Fix:
  use `Math.floor` for forward steps and `Math.ceil` for backward steps, with
  the same epsilon the timer uses.

- **Pass 92** (sensitivity analysis antimeridian): **BUG.** `sensitivityFC()`
  computed grid cell width as `east - west`, which produces a negative `dx` for
  bounding boxes crossing ±180°. The routing kernel uses `lonSpan()` which
  handles the wrap. Fix: use `lonSpan(west, east)` and `wrap180()` on computed
  longitudes. Currently dormant (Portland venue only) but would produce an
  invisible or misplaced sensitivity band for any cross-dateline route.

- **Pass 93** (weather cube construction and data integrity): no bugs. `emptyCubeData`
  fills every `Float32Array` with NaN, not zero. `planeScalar` drops NaN corners and
  renormalizes weights; `sampleCube` returns null if an entire time-slice is missing.
  Single-point grids (nx=1 or ny=1) produce fx=fy=0 correctly. Time axis monotonic
  by construction (t0 + i*dtMs). Delta-t codec predictor correctly not updated on
  MISSING sentinels.

- **Pass 94** (wind estimation from GPS): no bugs. `apparentToTrue` vector math
  correct (boat-frame decomposition, atan2 reconstruction). `estimateCurrent`
  navigation convention (x=sin, y=cos) consistent with `vecBearing(atan2(x,y))`.
  All trig uses DEG/RAD constants. Division-by-zero guarded (leeway rejects
  bsp≤0.5, heel rejects |cos|<0.09). Speeds from `Math.hypot` (non-negative),
  directions through `wrap360` ([0,360)).

- **Pass 95** (track recording edge cases): no bugs. `pushTrack` caps at 20,000
  points with `slice(1)`. StartCanvas guards `track.length > 1` before drawing.
  `clearTrack` sets `track: []` without touching `recording`, so recording continues
  into the fresh array. Rapid toggle produces at most one duplicate point at the
  boundary. Track not persisted (intentional — documented and tested).

- **Pass 96** (map touch/gesture interaction conflicts): no bugs. Overlay uses
  `pointer-events: none` on container, `auto` on children. No custom touch handlers.
  No draggable map features. Sheets block passthrough with opaque backgrounds.
  MapLibre pinch-zoom works unimpeded in exposed map areas.

- **Pass 97** (GPX import/export data fidelity): no bugs. `esc()` covers all five
  XML metacharacters. `getElementsByTagName` handles namespaced files. Empty tracks
  (waypoints only) produce empty `trackPoints` array without crash. `toFixed(6)`
  preserves 0.11m precision through roundtrip. `Date.parse` handles timezone offsets.
  `deriveMotion` is O(n) with no recursion.

- **Pass 98** (service worker and PWA update lifecycle): no bugs. Hand-written SW
  with `skipWaiting`/`clients.claim`. Content-hashed assets prevent mixed-version
  resources. Weather fetches bypass SW (cross-origin). Default-deny `isCacheable()`
  prevents accidental forecast caching. Offline update check fails silently.

- **Pass 99** (NOAA CO-OPS API error handling): no bugs. 200-with-error-body
  detected in both `readCp` and `readPredictions`. Timezone explicitly UTC via
  `time_zone=gmt` and `Date.UTC`. Gaps return null, not fallback. Station IDs
  are hardcoded constants. Negative datum depths handled deliberately.

- **Pass 100** (isochrone routing kernel deep audit): no bugs. DDA land walk with
  dilation catches narrow-island hops. Goal detection includes exact bearing in
  the heading fan, with 2-step grace after first finish. Node pool is append-only
  so parent pointers never dangle. Label-setting pruning uses an admissible lower
  bound (`t + remain/vmax`). Current integration is correct vector sum with
  crab-angle solver for goal approach.

- **Pass 101** (React hook dependency arrays): **BUG.** `useSimulation` captured
  `manualWind.twd` and `manualWind.tws` at construction but never called
  `BoatSim.setWind()` when the store values changed. The `eslint-disable` comment
  for the intentionally-excluded `origin` also masked the missing `manualWind`
  dependency. Changing wind direction or speed in Setup while the sim was running
  had no effect — the simulated boat sailed in the original wind forever. All
  downstream tactical numbers (polar %, VMG, laylines) became wrong because they
  compared actual performance against targets computed at the displayed (new) wind
  but the sim was still sailing in the original wind. Fix: a separate `useEffect`
  that forwards wind changes to the running sim via `setWind()`, without recreating
  it (which would teleport the boat back to origin). Mutation test (remove the
  effect): caught.

- **Pass 102** (concurrent tab switching during async operations): no bugs. Weather
  fetches guarded by `cancelled` flags and `AbortController`. Route computation
  terminates worker on unmount. GL resources freed in `onRemove`. Re-mount starts
  fresh via ref guards.

- **Pass 103** (number formatting edge cases): **BUG.** Compass bearings display
  "360°" when `.toFixed(0)` rounds values in [359.5, 360). `wrap360()` guarantees
  [0, 360) but `.toFixed()` rounds independently, producing an impossible compass
  reading. Affects 9 display sites: top-bar wind chip, race TWD/bearing/steer tiles,
  route legs table (TWD + heading), weather probe popup (wind + current direction),
  start canvas wind label. Hit roughly 1 in 720 real wind updates. Fix: `fmtDeg()`
  helper that re-wraps after rounding (`Math.round(a) % 360`). Mutation test (remove
  `% 360`): caught.

- **Pass 104** (polar table parsing and interpolation edge cases): no bugs. PCHIP
  interpolation prevents overshoot (Fritsch-Carlson tangents force zero at extrema).
  Below-table extrapolation is linear-to-zero (non-negative). Duplicate TWA/TWS
  entries merged keeping the faster value. Port/starboard symmetry via `Math.abs(twa)`.
  Single-row polars produce linear interpolation.

- **Pass 105** (LocalFrame projection at high latitudes): no bugs. Cosine scaling
  at 60°N gives sub-centimetre error at start-line scale. `destination()` uses
  great-circle (correct for routing). Haversine `atan2(sqrt,sqrt)` form stable
  down to 1m. `bearing()` is initial great-circle (correct convention). `lonSpan()`
  antimeridian and `west===east` cases both correct.

- **Pass 106** (Zustand selector stability): no bugs. All 62 `useStore` calls
  select single fields (no inline objects). No circular effect dependencies.
  Persist whitelist excludes all transient state. Deep-merge rehydration handles
  schema evolution. `shallow` comparator correctly omitted (no multi-field selectors).

- **Pass 107** (depth advisory and bathymetry edge cases): no bugs. Datum chain
  MSL→MLLW signs pinned by three anchor tests. Grid boundary returns null with
  explicit warnings (never silently assumes deep). Under-keel arithmetic correct
  including aground case. Drying heights handled by datum correction producing
  negative depths at low water.

### Passes 108–110 — WebGL particle layer

- **Pass 108 — inverted north-south particle advection (BUG).** The advection
  shader negated `velocity.y` (`-velocity.y`), a leftover from the
  mapbox/webgl-wind reference code where texture row 0 was north. Our cube
  stores rows south-to-north, so `pos.y=0` is the south edge; a positive
  v-wind (northward) must increase `pos.y`, not decrease it. In practice,
  particles drifted in the wrong direction on any wind with a significant
  meridional component, masked in mid-latitude westerlies where the zonal
  component dominates. Fixed by removing the negation; test reads the shader
  source to verify the sign. Mutation (reintroduce `-velocity.y`): caught.

- **Pass 109 — start line geometry: CLEAN.** Full audit of sign conventions,
  null handling, current correction, parallel-heading edge case, tack naming.
  No bugs found; the code is well-tested and consistent.

- **Pass 110 — particle colormap vs legend mismatch (BUG).** The shader
  normalised speed by `length(u_wind_max)` — the per-frame data maximum — but
  the colour ramp LUT was built against a fixed domain (e.g. [0, 40] kn). A
  15 kn wind in a 19.2 kn field rendered colours corresponding to ~31 kn.
  Fixed with a new `u_domain_max` uniform fed from the layer's configured
  domain; `setColorRamp` now accepts an optional domain max. Uniform coverage
  test added (catches any shader gaining a uniform the draw call doesn't set).

### Passes 111–113 — clean

- **Pass 111 — polar table interpolation: CLEAN.** Full audit of PCHIP slopes,
  Hermite basis, buildLattice grid, polarSpeed boundaries, targetTwa/VMG
  optimization, generatePolar physics, and numeric edge cases. No bugs.

- **Pass 112 — tidal prediction: CLEAN.** Datum sign conventions walked by hand
  (MSL↔MLLW agrees with anchor tests). API parsing, UTC time handling,
  interpolation binary search, and edge cases (negative zero, null, out-of-range)
  all verified correct.

- **Pass 113 — timeline playback + state: CLEAN.** Playback timer lifecycle,
  speed changes mid-play, time bounds clamping, state consistency (single source
  of truth via ChartValue context), display formatting (UTC/local), and React
  lifecycle (ref-based interval, effect cleanup) all verified correct.

### Passes 114–116

- **Pass 114 — error boundary falsy values (BUG).** `!error` treated thrown
  falsy values (`0`, `''`, `false`) as "no error", rendering children again and
  causing an infinite render loop → white screen. Changed to `error === null`
  to match only the initial state sentinel. Test added; mutation (revert to
  `!error`) caught.

- **Pass 115 — wind estimation pipeline: CLEAN.** Apparent-to-true and inverse,
  heel correction, leeway, current estimation, ground-to-true wind and inverse,
  UV component conversion, sign conventions, and circular averaging all verified
  correct. Round-trip tests cover all functions.

- **Pass 116 — colormap +Infinity mapping (BUG).** `lookup(ramp, Infinity)`
  was caught by the `!Number.isFinite(value)` guard and mapped to the low-end
  color (dark purple for wind) instead of the high-end (bright yellow). Changed
  guard to `!(value > stops[0].value)` so NaN and -Infinity clamp low but
  +Infinity falls through to the high-end clamp. Test added; mutation caught.

### Passes 117–119

- **Pass 117 — departure sweep endpoint drop (BUG).** `planDepartures` silently
  dropped the window endpoint when the natural grid count equalled `maxSolves`.
  A 23.5h window at 1h step with cap=24 produced 24 points ending at T+23h,
  missing the T+23.5h endpoint entirely — no warning. Fixed by replacing the
  last grid point with the endpoint (when length > 1). Test added; mutation
  caught.

- **Pass 118 — GPX missing lat/lon attribute (BUG).** `readPt` parsed
  `Number(el.getAttribute('lat'))` — when `lat` is absent, `getAttribute`
  returns `null`, `Number(null)` is `0`, `Number.isFinite(0)` is `true`, so
  the waypoint silently landed at 0°N (Gulf of Guinea) instead of being
  rejected. Fixed by checking for null/empty attribute strings before
  coercing. Test added; mutation caught.
- **Pass 119 — bathymetry + depth data: CLEAN.** Grid layout (row-major
  south-to-north), sign convention (GEBCO elevation flipped to depth via
  `-v / 10`), bilinear interpolation boundaries, NaN handling, datum algebra
  (MSL-to-MLLW correction verified at three anchor points), depth advisory
  sampling stride, and unit discipline (metres throughout) all correct.
- **Pass 120 — Zustand store persistence: CLEAN.** `partialize` whitelist
  excludes all ephemeral state. `mergePersistedState` deep-merges `boat`,
  `course`, and `settings` with correct spread order. All 62+ `useStore`
  selectors use single-field form (`s => s.foo`), so no unnecessary
  re-renders. `removeMark` index adjustment covers all five edge cases.
  `pushWind`/`pushTrack` history caps are bounded and tested. `setWindMode`
  clears history only on actual source change.

- **Pass 121 — isochrone goal hop bypasses land mask (BUG).** The goal hop
  — the code that detects when the boat can finish onto a mark within one
  time step — never checked `land.crosses()`. The main expansion loop
  checked every candidate segment, but the goal hop skipped it entirely.
  A mark behind a narrow headland or breakwater could be "reached" by
  sailing straight through the land. Fixed by adding `land.crosses(pa,
  goal)` to the goal hop condition. Test added; mutation caught.
- **Pass 122 — tide + CO-OPS data pipeline: CLEAN.** No harmonic engine
  in-codebase (delegates to NOAA API). UTC handling via `Date.UTC`
  correct. Datum formula verified at three anchor points. API response
  parsing handles NOAA's 200-with-error-body, empty arrays, unparseable
  rows. Interpolation boundary conditions correct (single-point, exact
  match, outside range → null).
- **Pass 123 — weather cube + forecast interpolation: CLEAN.** Grid
  indexing south-to-north consistent across cube, field, openmeteo, and
  vectorSymbols. Temporal boundaries reject out-of-range, handle single
  time step. Wind interpolated as U/V components (not speed/direction).
  Missing discipline: NaN throughout, MISSING sentinel in encode/decode.
  Longitude wrap handles ±180/360 boundaries. Domain bounds → null.
- **Pass 124 — React hook lifecycle: CLEAN.** All 25+ effects across
  hooks and screens verified: every timer/listener/subscription has
  cleanup. Async operations use cancelled flags or AbortController. No
  stale closures (excluded deps documented). No ref-vs-state confusion.
  Zustand selectors stable (single-field form).
- **Pass 125 — polar table + performance model: CLEAN.** PCHIP monotone
  cubic correct (Fritsch-Carlson). VMG = BSP×cos(TWA) with correct sign.
  Golden-section target search constrained to correct quadrants (upwind
  [0.5,90], downwind [90,179.5]). Symmetry via `abs(wrap180(twa))`.
  Zero wind guarded by `!(tws > 0)`. Lattice bilinear bounds safe.

- **Pass 126 — land mask + DDA ray walk: CLEAN.** Amanatides-Woo DDA is
  textbook-correct for horizontal, vertical, zero-length, and diagonal
  rays. Slab clipping (commit 3a97719) verified. Both endpoints checked.
  Budget bounded by grid dimensions after clipping. Dilation + polygon
  fallback eliminates false negatives. Property test (400 random segments
  vs 3001-sample brute force) confirms zero missed land.
- **Pass 127 — start line + race tactics: CLEAN.** Bias formula
  `angdiff(twd, squareWind)` correct. Signed distance convention (positive
  = pre-start side) verified. OCS detection correct. Layline geometry
  ray intersection handles parallel case. Beat split decomposition
  verified algebraically. VMC optimum sweep correct. Apparent-to-true
  wind vector decomposition and round-trip invariant verified. NaN
  propagation: all external input paths guarded, fuzz test confirms.
- **Pass 128 — ScalarLayer DEPTH_TEST not restored (BUG).** `render()`
  disabled `gl.DEPTH_TEST` without saving/restoring it, while correctly
  handling `BLEND` and `SCISSOR_TEST`. Any subsequent layer expecting
  depth testing found it silently disabled. Fixed by adding
  save/restore matching the existing pattern. Test extended; mutation
  caught.
- **Pass 129 — fmtDuration/fmtClock negative-zero display (BUG x2).**
  `fmtDuration(-0.4)` returned `"-0s"` and `fmtClock(-0.9)` returned
  `"-0:00"` — sign was read from the raw input, magnitude was rounded
  independently. At the gun crossing the timer passes through small
  negative fractions between frames, producing a confusing flash of
  "-0s". Fixed by suppressing the sign when the rounded magnitude is
  zero. Tests added; mutations caught.

- **Pass 130 — PWA service worker + offline: CLEAN.** Four-rule caching
  strategy verified: forecasts never cached, tiles network-first with
  1200-entry cap, navigation network-first for deploy freshness,
  hashed assets cache-first forever. Error responses never cached.
  Install/activate lifecycle correct. Zustand persistence limited to
  config only, well within localStorage limits.
- **Pass 131 — type safety + runtime guards: CLEAN.** All ~40 `as`
  casts in production code justified (Map.get after own-key iteration,
  WebGL spec matches, JSON with structural validation). All `!` in test
  files only. Zero `any` in production. All JSON.parse sites defended.
  Array index access bounded. External data boundaries (NOAA, Open-Meteo,
  GPX, polar CSV) all validated with `Number.isFinite`.
- **Pass 132 — geodesy + coordinate math: CLEAN.** Haversine uses stable
  `atan2(sqrt, sqrt)` form. Bearing `atan2(y,x)` argument order correct.
  Antipodal points stable (swept -89 to +89). Date line crossing handled
  via `wrap180(dLon)` in all functions. LocalFrame cos-lat scaling
  correct. Segment intersection Cramer's rule signs verified
  algebraically. `clampUnit` guards all asin/acos calls.

- **Pass 133 — route worker + message protocol: CLEAN.** Structured
  clone handles all data types. Single-pending-request invariant with
  monotonic IDs prevents stale results. Errors propagated in-band (never
  rejected promises). Transferables deliberately not used (documented:
  main thread needs the forecast data). Worker lifecycle clean with
  React useEffect cleanup. Progress throttled at 100ms.
- **Pass 134 — vector field + wind barbs: CLEAN.** Barb encoding matches
  WMO standard (verified 0-100kn at 0.25kn resolution). Direction
  convention correct: `atan2(-u,-v)` recovers FROM bearing, barbs point
  into wind, arrows point downwind. Thinning anchors to grid multiples
  for pan stability. Grid-to-map uses south-to-north convention. Calm
  symbol (bare circle) for TWS < 3kn. Missing data drops sample, never
  fabricates calm.
- **Pass 135 — Open-Meteo API + data ingest: CLEAN.** URL construction
  correct. Response parsing handles bare and model-suffixed variables.
  Wind u/v signs correct (meteorological FROM convention). Grid
  construction south-to-north matches cube indexing. Unit conversions
  verified (km/h, m/s, mph → kn). Error handling degrades gracefully
  (marine failure → wind-only with note). Cache key avoids quantization
  collision bug.

- **Pass 136 — isochrone sensitivity band: CLEAN.** Loss formula
  `T_f(p) - T_b(p)` algebraically verified (ETA cancels). Forward
  recorder tracks earliest arrival, backward tracks latest departure.
  Both grids share identical dimensions. Color mapping includes loss=0
  cells. Land/unreachable cells filtered by isFinite. Backward wind
  sampled at correct (earlier) time. GeoJSON CCW winding per RFC 7946.
- **Pass 137 — venue pack + config loading: CLEAN.** Single venue
  (Portland) with all 12 required fields. Bbox, depth grid, land mask
  bounds all consistent. Promise-level cache with retry on failure.
  Datum constant cross-file equality tested. Grid dimensions match
  bbox extent.
- **Pass 138 — cube encode/decode + delta coding: CLEAN.** Delta
  predictor along time axis, correctly skipped for MISSING values.
  Sentinel -32768 cannot collide with valid residuals (range capped at
  ±16383). Quantization fits all physical weather ranges. Header
  alignment padding correct. Round-trip exact at quantized level.
  Endianness explicit (DataView + manual byte shuffle).
- **Pass 139 — map interaction + touch events: CLEAN.** No custom
  touch/pointer handlers; all interaction via MapLibre's built-in event
  system. Marks from GPS/computation, not map taps. Single click handler
  (weather probe) delegates projection to MapLibre. All event listeners
  cleaned up on unmount.

- **Pass 140 — departure advice + sweep UI: CLEAN.** Step-floor check
  correctly prioritized over fraction check. Chart maps costS to Y-axis
  with minute labels. Best bar highlighted green with "BEST" label.
  Failed departures shown as hatched bars with red "X". Cancellation
  terminates worker and resolves in-band. Departure times in local,
  ETA in UTC — consistent throughout.

- **Pass 141 — canvas rendering + DPR: CLEAN.** All four canvas
  components follow correct DPR pattern (buffer × dpr, setTransform,
  CSS display size). save/restore used correctly. ResizeObservers
  cleaned up. No input event handlers on canvases (pure display).
  Text sizes in CSS pixels. No rAF loops.
- **Pass 142 — error boundary throw null/undefined (BUG x2).** Pass
  114's fix (`error === null`) left two holes: `throw null` matched
  the sentinel and re-rendered children in an infinite loop;
  `throw undefined` caused `.message` access on undefined inside the
  boundary's own render. Both produce white screens. Fixed by switching
  to a `hasError` boolean flag (React-recommended pattern) and typing
  `error` as `unknown` with `instanceof Error` guards. Tests added;
  mutations caught.
- **Pass 143 — isochrone multi-leg routing: CLEAN.** Leg transition
  resets frontier correctly via passStamp. Time chains through
  `out.finishT`. Tack resets at mark (correct — rounding is forced).
  Backward pass iterates in reverse with correct polarity. Total
  elapsed time accumulated correctly. Close-mark guard at 1e-6 nm.

- **Pass 144 — simulation turn speed loss frame-rate bug (BUG).** The
  turn loss factor already encoded the step size (`turn` is clamped to
  `rot*dtS`), but the speed reduction multiplied by `dtS` again, giving
  O(dt²) dependence. At dtS=0.5 a hard turn shed ~20% speed; at
  dtS=2.0 the same manoeuvre shed ~85%. Fixed by removing the extra
  `* dtS`. Test added (convergence across step sizes); mutation caught.
- **Pass 145 — depth advisory + under-keel: CLEAN.** Sign convention
  correct (positive = clearance, negative = aground). Tidal correction
  uses each leg's arrival time. Stride always samples destination.
  Threshold 2m documented as deliberately wide (GEBCO error = 18m at
  check point). Draft validated positive at input. Missing data produces
  explicit warnings, not silence.
- **Pass 146 — implicit tacking logic: CLEAN.** Trigger condition
  correct (TWA inside no-go zone). Effective speed `VMG/cos(TWA)`
  verified algebraically, continuous at boundary. Current added as
  separate ground-velocity vector (correct — uniform push on zigzag).
  Tack penalty at step boundaries only (deliberate design). Symmetric
  thresholds with no discontinuity.
- **Pass 147 — route GeoJSON + map overlays: CLEAN.** All coordinates
  consistently [lon, lat]. Isochrones as open arcs (not closed polygons).
  Beat segments correctly extracted. Layer z-order correct. Source/layer
  cleanup via setData(emptyFC) or explicit removal. GPX uses lat/lon
  attributes per spec.
- **Pass 148 — tab navigation + screen transitions: CLEAN.** Tab
  switching, error boundary isolation across screens, lazy-loaded screen
  suspense fallback, active-tab indicator state. No bugs found.
- **Pass 149 — compass bearing display seam bug (BUG).** The "TWD to
  lay" tile's sub-label computed the wind-shift direction via raw
  subtraction (`twdToLay - twd`) instead of `angdiff`. When bearings
  straddle the 0/360 boundary the display shows the wrong direction and
  a wildly inflated magnitude: `twd=350, twdToLay=10` → "left 340°"
  instead of "right 20°". Added `fmtShift(from, to)` helper to
  `angles.ts` using `angdiff`, replaced inline subtraction in
  `RaceScreen.tsx`. Four tests cover clockwise, anticlockwise, seam, and
  zero cases. Mutation: replacing `angdiff(to, from)` with `to - from`
  triggers the seam test. **Committed `85123e2`.**
- **Pass 150 — routing time step + wind shift: CLEAN.** Checked that
  isochrone kernel handles wind field changes between time steps
  correctly, and that step-size variation doesn't alter the route. No
  bugs found.

- **Pass 151 — polar speed lookup + interpolation: CLEAN.** Bilinear
  interpolation at all boundary TWA/TWS values correct. Out-of-range
  inputs clamped or wrapped properly. `targetsAt` snap-to-nearest
  correct. PCHIP slopes, Hermite basis, golden-section maximizer all
  verified. No bugs found.
- **Pass 152 — PWA service worker caching: CLEAN.** All four caching
  rules (weather exclusion, tiles network-first, navigation fallback,
  asset stale-while-revalidate) correct. Cache versioning cleanup in
  `activate` handler correct. `trimCache` FIFO eviction correct. No
  `navigator.onLine` needed — SW handles offline transparently.
- **Pass 153 — Zustand store persist + rehydration: CLEAN.** Partialize
  correctly excludes transient state. Deep merge for nested persisted
  objects. Single-field selectors throughout. No direct mutation. Mark
  index correctly shifted on removal. All course-mutating actions
  spread `COURSE_CHANGED`.

- **Pass 154 — weather cube delta decoding: CLEAN.** Delta
  encode/decode symmetric. Row order south-to-north consistent with
  texture mapping. Time indexing clamps correctly at boundaries.
  MISSING sentinel (-32768) cannot collide with quantised deltas.
  Dateline-crossing bbox handled via `normaliseLon` shifts.
- **Pass 155 — DDA land mask ray walk: CLEAN.** Horizontal/vertical
  rays, cell-boundary starts, same-cell rays, budget clipping, and
  antimeridian wrapping all correct. Row order matches weather cube.
  Corner tie-breaking safe due to dilation. Property test covers 400
  random segments.
- **Pass 156 — GPX import/export roundtrip: CLEAN.** XML escaping
  covers all five metacharacters. DOMParser error detection via
  `parsererror`. Coordinate precision faithful to 6 dp. Empty/single
  waypoints handled. Namespace correct. Pass 118 lat fix equally
  covers lon. Null island (0,0) passes correctly.

- **Pass 157 — tactics computation edge cases: CLEAN.** Layline
  bearing wrapping correct near 0/360. VMG sign correct for all
  quadrants. Time-to-mark guards against zero speed/distance. TWD-to-lay
  formula verified with round-trip test. Current triangle solved
  correctly. Null propagation isolated via `attempt()` pattern.
- **Pass 158 — departure sweep planner: CLEAN.** Time grid uses
  index-multiply (no float drift). Widening/endpoint fixup correct.
  Resolution-floor warning fires correctly. Advice thresholds adapt to
  passage length. Worker rebuilds context per sweep.
- **Pass 159 — start line timer logic: CLEAN.** Countdown sign
  transition correct. Time-to-line via ray intersection, reach, and
  tack approaches all correct. Bisection convergence provable. Burn
  sign follows Expedition convention. Line bias via `angdiff`
  correct. OCS detection correct. `makeStartLine` orientation and
  bias verified.

- **Pass 160 — ParticleLayer GL state leak (BUG).** Same class as
  pass 128: `render()` disabled `DEPTH_TEST` and `STENCIL_TEST`
  without saving/restoring, leaking state to subsequent MapLibre
  layers. Added save/restore pattern matching ScalarLayer. Test
  extended to check all four caps for ParticleLayer. **Committed
  `7634afd`.**
- **Pass 161 — geodesy edge cases: CLEAN.** Haversine, bearing,
  destination, crossTrack, LocalFrame, wrap360, signedDistanceToLine,
  rhumb functions, rayIntersect, bboxOf/lonSpan all verified at edge
  cases including same-point, antipodal, antimeridian, and poles. No
  callers depend on old wrap360 behavior.
- **Pass 162 — wind history + estimation: CLEAN.** Circular buffer
  eviction correct (900 cap). `meanBearing` uses sin/cos circular
  mean. `stdBearing` uses Mardia-Jupp formula with R>=1 guard. NaN
  filtered before stats. Mode-change clears cross-source history.
  Timestamps consistently milliseconds.

- **Pass 163 — isochrone backward sensitivity: CLEAN.** Backward pass
  timing, wind sampling, fan centering, goal hop with current
  correction, recorder keep-max convention, multi-leg pool
  accumulation, and numerical guards all verified. Forward/backward
  consistency tested by §10.5.
- **Pass 164 — COG predictor NaN coordinates (BUG).** GPS can report
  valid speed with `heading=null` (slow drift). This produced
  `cog=NaN`, feeding NaN into canvas `lineTo`/`arc`. Added
  `Number.isFinite(state.cog)` guard to the COG predictor in
  `StartCanvas.tsx`. Test exercises `{ cog: NaN, sog: 4.6 }` via
  `expectNothingUndrawable`. **Committed `1ef84e1`.**
- **Pass 165 — particle layer colour ramp off-by-one (BUG).** The
  `fract()`-based 2D unwrap wrapped `v_speed_t=1.0` back to column 0,
  mapping max-speed particles to LUT entry 240 instead of 255.
  Replaced with explicit index-to-texel-centre arithmetic using
  `mod()`/`floor()` with `+0.5` offset. Last 15 LUT entries were
  previously unreachable. **Committed `c7e9144`.**

- **Pass 166 — isochrone current integration: CLEAN.** Velocity
  triangle correct. Current set/drift convention consistent with UV
  components. Time sampling uses `tNoShift` (wind shift does not drag
  current). Goal hop crab angle iteration correct for both forward
  and backward passes. Strong-current guard prevents impossible
  solutions.
- **Pass 167 — React hooks dependency arrays: CLEAN.** All 5 screens
  and 4 custom hooks audited. Every `useEffect`, `useMemo`,
  `useCallback` has correct deps. One ESLint suppression justified.
  All cleanup functions present for intervals, observers, and event
  listeners.
- **Pass 168 — glutil texture/buffer helpers: CLEAN.** RGBA format
  consistent with data layout. 16-bit encode/decode matches shader.
  Texture unit assignments collision-free across both layers. Particle
  position packing self-consistent. Mercator bbox mapping correct for
  south-to-north convention.

- **Pass 169 — isochrone heading fan + VMG injection: CLEAN.** Fan
  centring correct for forward/backward. VMG injection covers all four
  tack/gybe headings. Gybing substitution continuous at boundary.
  Duplicate angles harmless (bucket pruning). Fan widens on stall up
  to full circle. Backward pass correctly mirrored.
- **Pass 170 — beat segment overlay terminal endpoint (BUG).** The
  beat extraction collected only beating legs' positions, dropping the
  non-beating leg that terminates each run. A dead-upwind route's
  final tacking segment appeared solid; a lone beat leg was invisible.
  Extracted `extractBeatSegments` with correct endpoint inclusion.
  Seven tests. **Committed `eac158d`.**
- **Pass 171 — venue data + tile sources: CLEAN.** BBox ordering
  correct. Tile URL templates correct. Attribution present. Land
  mask / depth grid extents encompass venue. Datum coupling tested.
  No hardcoded coordinates outside venue config.
- **Pass 172 — fmtAgo "24 h" display (BUG).** At 23h 30m the raw
  hours (23.5) passed the `< 24` check but `Math.round` produced 24,
  displaying "24 h" instead of "1 day". Used rounded value for both
  decision and display, matching the minutes branch pattern.
  **Committed `a9e3588`.**

- **Pass 173 — isochrone pruning bucket: CLEAN.** Label table
  open-addressed hashing with stamp invalidation. Key uniquely encodes
  (ix, iy, tack). Dominance criterion admissible for both forward and
  backward. Pool append-only, no dangling parents. Bucket size scales
  with time step. Label reset between passes correct.
- **Pass 174 — map layer lifecycle: CLEAN.** All GL resources cleaned
  up in `onRemove`. Double-remove safe. Texture/buffer leaks prevented
  on repeated `setData`. GL state save/restore complete. Async data
  gated on `ready` flag. Screen-switch unmount removes layers/sources.
- **Pass 175 — bathymetry depth lookup: CLEAN.** Grid coordinate
  system south-to-north correct. Bilinear interpolation boundary
  clamping correct. Sign convention positive-down consistent. Tidal
  correction formula verified at three anchor points. Under-keel
  returns null for missing data. Outside-grid returns null.

- **Pass 176 — tide prediction interpolation: CLEAN.** Binary search
  + linear interp correct. UTC parsing via `Date.UTC`. Returns null
  outside prediction window. Units conversion at parse boundary.
  Cache keyed correctly; failed promises evicted. Datum arithmetic
  anchored at three real-world tide levels.
- **Pass 177 — worker message protocol: CLEAN.** Route/sweep types
  discriminated correctly. Cube data deliberately cloned (not
  transferred). Error handling in-band on both sides. Cancellation by
  termination, no race. Land raster validation rejects truncated
  arrays. Progress throttled. Message IDs prevent stale resolution.
- **Pass 178 — CSS layout + responsive: CLEAN.** Viewport meta
  includes `viewport-fit=cover`. Safe-area insets via env() with
  fallbacks. Tile grid uses `fr` units. No uncontrolled horizontal
  overflow. Only two z-index values, no conflicts. No broken
  dimensions or conflicting positions.

- **Pass 179 — isochrone multi-mark route: CLEAN.** Leg transition
  correctly swaps arrival/departure semantics at marks. Finish nodes
  placed at exact mark coordinates. Backward pass chains in reverse
  via `anchor`. Route reconstruction leg-isolated via `parent = -1`
  roots. `elapsedS` reflects total passage.
- **Pass 180 — timeline playback controls: CLEAN.** Play interval
  correctly cleaned up on unmount and re-render. Slider respects
  forecast window. Playback wraps at end. Keyboard handlers cleaned
  up. `onChangeRef` pattern avoids stale closures. Degenerate inputs
  (dtMs=0, NaN) handled.
- **Pass 181 — sun position + twilight: CLEAN.** Standard NOAA
  low-precision algorithm. Julian day, declination, RA, GMST all
  correct. `clampUnit` guards polar latitudes. 5-minute cache bucket
  negligible error for -6° twilight threshold. Workers get own module
  copy.

- **Pass 182 — polar plot downwind VMG off-canvas (BUG).** The
  canvas origin sat near the bottom (`cy = h - 16`), so any TWA past
  90° projected below the visible area. Downwind VMG target dots
  (TWA 130-150°) were completely invisible. Centred origin at `h/2`
  and constrained radius to `h/2 - 18`. Ring arcs now full circle.
  **Committed `58a08ee`.**
- **Pass 183 — weather fetch + model select: CLEAN.** API URL
  construction correct. Response parsing handles multi-point and
  single-point. Grid dimensions derived correctly. Cache keyed on
  model+bbox+step. Model switch cancels stale fetch. Unit conversion
  factors correct. u/v sign conventions opposite for wind vs current.
- **Pass 184 — store course mark mutation: CLEAN.** `removeMark`
  index shifting correct for all cases. `addMark` does not change
  active index (intentional). All mutations spread `COURSE_CHANGED`.
  No off-by-one in index arithmetic.

- **Pass 185 — isochrone tack penalty at goal hop + multi-leg
  (BUG x2).** (1) The goal hop skipped tack/gybe penalties, letting
  candidates reach the mark penalty-free. (2) Multi-leg routes lost
  the finish tack at mark boundaries, making the first step of each
  leg penalty-free. Added penalty computation to goal hop and
  `initialTack`/`initialTwa` propagation between legs. Test verifies
  the optimizer avoids a 300s gybe penalty by adjusting approach
  angle. **Committed `b06c5da`.**
- **Pass 186 — current chart y-axis label rounding (BUG).** When
  `yMax` is an odd multiple of 0.5, the midpoint tick (e.g. 0.75 kn)
  was formatted as "0.8" via `toFixed(1)`. Changed to use two decimal
  places for quarter-knot values. **Committed `cc62876`.**
- **Pass 187 — Vite config + build: CLEAN.** Path aliases consistent.
  Worker format matches instantiation. PWA manifest correct. Env
  guards prevent debug code leaking. Source maps enabled. Build
  output uses relative paths.

- **Pass 188 — route screen UI state: CLEAN.** `runIdRef` prevents
  stale results. `busy` prevents concurrent operations. Beat segment
  extraction includes terminal endpoint. Sensitivity overlay uses
  same grid mapping as recorder. Sweep cleared on course change.
  Depth advisory correctly filters land cells.
- **Pass 189 — type narrowing safety: CLEAN.** All ~60 `as`
  assertions justified (WebGL, MapLibre, validated JSON). No `!`
  assertions. Discriminated unions fully covered. `find` results
  guarded. No dangerous optional chaining. GPS and NOAA data
  validated with `Number.isFinite`.
- **Pass 190 — isochrone max-TWS avoidance: CLEAN.** Constraint
  kills entire node before expansion. Dead-end candidates cannot
  propagate or reach goal. Full-domain exceedance returns clean error.
  Backward pass uses same constraint. One-step overshoot is inherent
  to the method.

- **Pass 191 — directTimeS night polar factor: BUG FOUND.**
  `directTimeS` always used the daytime polar factor, ignoring
  `polarPctNight`. Routes spanning night hours showed a systematically
  optimistic baseline, understating the value of routing.
  Fixed by passing both `polarDay` and `polarNight` and selecting via
  `isNight` at each step, matching the routing engine.
  Commit `870df0c`.
- **Pass 192 — DepartureChart canvas rendering: CLEAN.** X-axis
  time mapping correct (local). Y-axis cost scale correct with
  floor clamp. Best highlight uses identity comparison on Millis.
  Failed departures render at full height without affecting scale.
  DPR handling correct (clamped at 2.5). No click handler (by design).
  ResizeObserver cleanup correct.

- **Pass 193 — Legend discrete ramp ticks: BUG FOUND.**
  Discrete-ramp tick generation only placed ticks at class boundary
  stops. When the domain high end exceeded the last stop (e.g. depth
  domain [0, 40] with last stop at 30 m), the rightmost portion of the
  bar was unlabelled. Fixed by appending a domain-end tick at 100%
  when no stop equals `hi`. Commit `4543a42`.
- **Pass 194 — tidal current interpolation: CLEAN.** Binary search
  bracket correct. 1D signed velocity model makes circular
  interpolation unnecessary. Slack water crossings smooth. Returns
  null outside prediction window. Datum correction formula correct.
- **Pass 195 — PWA service worker: CLEAN.** Four caching rules
  correct. Weather API excluded by both hostname and origin checks.
  Tile cache trimmed at 1200. Cache invalidation purges old versions.
  Navigation precache covers all routes. skipWaiting safe because
  only dev-mode lazy imports exist.

- **Pass 196 — Zustand persist hydration: CLEAN.** Partialize
  whitelist correct (ephemeral state excluded, user config included).
  Deep-merge fills new fields from defaults. Synchronous hydration
  prevents flash. Version 1 with no migration needed yet.
- **Pass 197 — GPX round-trip fidelity: CLEAN.** Coordinate
  precision via toFixed(6). XML metacharacter escaping correct.
  Namespace handling works for default xmlns. Missing coords/names
  handled. DOMParser error detection via parsererror check. Wpt/rtept
  dedup by position key.
- **Pass 198 — weather cube binary decode: CLEAN.** Delta predictor
  reset per-param correct. Row order consistent (south-to-north).
  Quantization range guarantees deltas fit Int16. Byte shuffle
  sign-extension correct. Missing value handling preserves predictor.
  Round-trip tolerance matches quantization error.

- **Pass 199 — polar lattice interpolation: CLEAN.** PCHIP
  monotone cubic slopes correct. TWA=0 ramp to zero, TWA=180 held.
  TWS extrapolation: linear toward zero below, held above. Sign
  convention via abs(wrap180). Target scan golden-section correct.
  Bilinear lattice boundary clamping correct. NaN guards present.
- **Pass 200 — departure sweep grid: CLEAN.** Evenly spaced with
  endpoint correction. Both from/to always covered. Each departure
  gets its own startTime. Best by shortest elapsed, ties broken by
  earliest. Failed departures recorded with error. Widening cap
  emits warning. No shared mutable state.
- **Pass 201 — ScalarLayer blend function leak: BUG FOUND.**
  `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` was set without saving
  the previous blend function, corrupting it for later layers in
  the same frame. Fixed by saving/restoring `BLEND_SRC_RGB` and
  `BLEND_DST_RGB`. Same class as passes 128 and 160.
  Commit `e2163ef`.

- **Pass 202 — Haversine geodesy edge cases: CLEAN.** Antipodal
  atan2 formulation stable. Poles produce correct conventional
  bearings. Zero distance returns exactly 0. Destination round-trip
  correct. LocalFrame cosLat documented as out-of-scope at poles.
  Antimeridian wrapping correct. Rhumb line pole degeneration handled.
- **Pass 203 — computeTactics VMG gating: BUG FOUND.** VMG
  (BSP * cos(TWA)) was gated behind the polar lattice even though
  it is a pure kinematic value. Boats without a polar file saw no
  VMG. Moved VMG computation before the polar block. Commit `ac664a5`.
- **Pass 204 — StartCanvas rendering: CLEAN.** Coordinate transform
  with cos(lat) correct. Port/starboard colours match convention.
  Pass 164 NaN guard intact. Laylines originate from line ends at
  correct TWA. DPR capped at 2.5. Timer declutter at 60s. View
  fitting preserves aspect ratio with asymmetric padding.

- **Pass 205 — weather field stacking: CLEAN.** Fallback per
  parameter correct. Temporal/spatial coverage falls through. Current
  stacked separately from wind. Source labels propagate. Coverage
  union bbox correct. ScaledField time-shift intentionally skips
  current/waves.
- **Pass 206 — backward pass isNight time: BUG FOUND.** The
  backward pass sampled wind at `pt - dtMs` but checked `isNight`
  at `pt`, applying the wrong polar factor at dawn/dusk transitions.
  Fixed by extracting `sampleT` and using it for both `f.sample()`
  and `isNight()`. Commit `efe0b59`.
- **Pass 207 — store selectors memoization: CLEAN.** All components
  use single-field selectors. No inline object creation. Actions are
  referentially stable. useMemo dependencies correct. Deep-merge
  handles missing persisted keys. Partialize excludes action
  functions via JSON serialization.

- **Pass 208 — DDA land mask walk: CLEAN.** Amanatides-Woo
  traversal correct for all four quadrants. Raster-box slab clip
  correct. Budget sufficient. cos(lat) not needed in cell space.
  Diagonal corner miss covered by dilation invariant. Conservative
  fallback prevents false negatives.
- **Pass 209 — BoatSim noise frame-rate: BUG FOUND.** Wind noise
  random walk increment scaled with `dtS` instead of `sqrt(dtS)`,
  making equilibrium variance proportional to step size (11x at
  dtS=5 vs dtS=0.5). Same class as the old turn-loss dtS² bug.
  Commit `0e25a09`.
- **Pass 210 — ParticleLayer blend function leak: BUG FOUND.**
  Same class as ScalarLayer pass 201 — `blendFunc` set without
  saving/restoring `BLEND_SRC_RGB`/`BLEND_DST_RGB`. Fourth GL
  state leak found across passes 128, 160, 201, 210.
  Commit `d13ef6a`.

- **Pass 211 — RouteScreen UI state: CLEAN.** runIdRef correctly
  guards against stale results. Departure sync uses strict numeric
  equality. Time-saved sign convention correct. Error display
  shows prominently. Sensitivity overlay tied to data presence.
- **Pass 212 — depth advisory logic: CLEAN.** Draft subtraction
  and tidal height correct. Stride-based sampling with final-leg
  guard. Missing depth/tide produce correct warnings. Units
  consistently metres. Concerns sort defensible.
- **Pass 213 — Tile component formatting: CLEAN.** fmtAgo boundary
  at 90s/90min intentional. fmtClock handles negative/-0/NaN.
  dp guard excludes non-finite before toFixed. Tone suppressed
  when value unknown. Sub renders only when truthy. fmtSigned
  handles -0 correctly.

- **Pass 214 — wind estimation logic: CLEAN.** Manual wind sets
  correct WindEstimate with uncertaintyDeg 8. Forecast quantizes
  lat/lon to 0.01°. History capped at 900, cleared on mode switch.
  u/v conventions consistent. No GPS-derived wind inversion yet.
- **Pass 215 — isochrone time step selection: CLEAN.** Distance
  heuristic and byCount formula correct. GRIB cadence acts as
  ceiling. Resolution presets modulate correctly. Step clamped
  to [minStepS, 21600]. Per-route (not per-leg) step is a design
  choice, not a bug thanks to goalHop.
- **Pass 216 — start line geometry: CLEAN.** Perpendicular distance
  to infinite line (intentional, documented). Sign convention
  correct (positive = pre-start side). Time-to-line uses abs(t)
  for reciprocal case. Line bias angdiff correct. LocalFrame at
  100m scale sub-mm accurate. Current correction with two
  fixed-point iterations. Turn/acceleration model verified.

- **Pass 217 — isochrone goal hop: CLEAN.** Crab-angle iteration
  correct for both forward/backward. Distance threshold gates on
  one time step. Time computation units consistent. Current
  decomposition verified. Tack penalty applied correctly (pass 185
  fix intact). Multi-leg transition carries tack/TWA state.
- **Pass 218 — weather fetch retry: CLEAN.** Single-fetch with
  cache-eviction retry design intentional. Abort signal propagated.
  Response validation checks ok + reason. URL construction safe.
  Cache deduplication via pending promise. Unit conversion handles
  all variants. Marine degradation graceful. Grid planning
  convergent with 32-iteration guard.
- **Pass 219 — isochrone pruning buckets: CLEAN.** Cell key
  collision-free within Int32. Cell size adapts to route scale.
  Tack keying gated on penalty presence. A*-style f-score pruning
  admissible. Eviction updates score atomically. VMG injection
  prevents fan from missing optimal headings. Frontier budget
  controls bucket floor.

- **Pass 220 — DenseField trilinear interpolation: CLEAN.** Spatial
  bilinear clamping correct at boundaries. Temporal edge clamp
  degenerates correctly. nx/ny/nt=1 cases valid. Antimeridian
  wrap180 correct. Wind rotation matrix verified. Current uses
  unshifted time. Gap fill dilation non-cascading.
- **Pass 221 — CurrentChart rendering: CLEAN.** Time window floored
  at 1/60 h. Y-axis symmetric, snaps to 0.5 kn multiples. Pass
  186 label fix intact. Flood/ebb clip correct. Now marker always
  visible. DPR capped at 2.5. Canvas state (alpha, dash, font)
  properly managed. Edge padding for smooth curves.
- **Pass 222 — App component lifecycle: CLEAN.** GPS clearWatch
  in cleanup. Simulation interval cleared. Wake lock released with
  cancelled guard. Abort controller for forecast. Track push capped
  at 20k. GPS and simulation mutually exclusive. All dependency
  arrays correct (one documented suppression).
- **Pass 223 — isochrone route reconstruction: CLEAN.** Parent
  chain walk terminates (root parent = -1, indices strictly
  increase). `appendLegs` leg field extraction correct — child
  stores departing conditions from parent position. Multi-leg join
  pops stale arrival entry safely. Current set/drift from velocity
  components correct. Isochrone ring arrays freshly allocated.
- **Pass 224 — Open-Meteo cube build: CLEAN.** Response parsing
  handles all variable combinations. Delta coding round-trips
  correctly. South-to-north row order preserved through encode/
  decode. Pressure level interpolation bounded. Hourly/3-hourly
  cadence detection robust.
- **Pass 225 — SetupScreen validation: CLEAN.** Form validation
  covers required fields. Polar file parsing error handling
  graceful. State persistence through Zustand partialize correct.
  Navigation guard prevents incomplete setup.
- **Pass 226 — GPX import/export round-trip: CLEAN.** Missing
  name/desc elements get safe defaults. XML metacharacters escaped
  via `esc()`. Coordinates use 6-decimal precision. DOMParser
  error path throws. Round-trip deduplication correct. `deriveMotion`
  uses NaN for unknowable velocities.
- **Pass 227 — departure sweep grid: CLEAN.** Time grid counts
  inclusive endpoints correctly. Widening formula preserves both
  endpoints. Zero-length and reversed windows produce single-element
  arrays. Pure epoch-ms arithmetic, no timezone traps. Solver
  failures recorded per-departure without aborting. Synchronous
  execution, no race conditions.
- **Pass 228 — polar CSV empty cells → zero speed: BUG FOUND.**
  `Number('')` returns 0 in JavaScript, so empty cells in ORC/qtVlm
  CSV polars silently injected zero-speed entries. The PCHIP
  interpolation would route around those angles. Fixed with a
  `cellNum()` helper that returns NaN for empty/undefined strings.
  Commit `8a29fbb`.

- **Pass 229 — service worker caching: CLEAN.** Four-rule strategy
  correct: forecasts never cached, tiles network-first with
  TILE_LIMIT=1200 trim, hashed assets cache-forever, navigation
  network-first with shell fallback. skipWaiting/clients.claim
  lifecycle correct. Opaque responses excluded.
- **Pass 230 — Zustand store selectors: CLEAN.** All 14 consumer
  files use single-field selectors. partialize whitelist matches
  intended persistence scope. mergePersistedState deep-merges for
  schema evolution. No in-place mutation. Derived values in useMemo,
  not stored.
- **Pass 231 — start line geometry: CLEAN.** Distance-to-line sign
  convention consistent (positive = pre-start, negative = OCS).
  Bias computation wind-relative only (by design). GPS approach
  uses SOG, polar approaches use BSP with current correction.
  Zero-length line guarded. NaN guards from pass 34 still protect
  all paths.

- **Pass 232 — tidal current prediction: CLEAN.** velocityAt/
  waterLevelAt return null outside prediction window. Linear
  interpolation on 6-min samples (worst-case chord error ~4mm).
  Flood/ebb direction binary, not interpolated. Slack threshold
  configurable. NOAA error payloads caught. Datum arithmetic
  pinned by anchor-point tests.
- **Pass 233 — error boundary lifecycle: CLEAN.** hasError boolean
  flag correct. Recovery via reset() calls onReset before clearing
  state. Key-based isolation per tab. Lazy component retry bumps
  lazyGen for fresh import. Fallback UI depends only on props/state,
  not crashed child tree. Handles falsy/non-Error thrown values.
- **Pass 234 — weather cube delta encoding: CLEAN.** First timestep
  absolute, subsequent deltas. Quantization scales in JSON header.
  Byte-plane shuffle uses manual bitwise ops (endian-independent).
  NaN mapped to sentinel MISSING=-32768, predictor skipped on holes.
  Wave direction wrap produces large but in-range Int16 deltas.
  Round-trip within half quantization step.

- **Pass 235 — solar position and isNight: CLEAN.** NOAA low-
  precision algorithm with equation of center. Julian Date from
  Unix ms correct. Elevation-based threshold (-6° civil twilight),
  no time heuristic. 5-minute memoization bucket drift documented.
  clampUnit on asin, wrap360 on GMST. Extreme latitudes handled
  by construction.
- **Pass 236 — haversine geodesy: CLEAN.** Haversine uses atan2
  (stable near antipodes). bearing(identical) returns 0 convention.
  destination wraps longitude via wrap180. clampUnit guards every
  asin/acos. signedDistanceToLine has len<1e-12 guard. Earth
  radius R_NM=3440.065 consistent everywhere.
- **Pass 237 — land mask DDA walk: CLEAN.** Slab-test clipping
  (commit 3a97719) clips parametric [t0,t1] to raster box. Step
  direction correct all four quadrants. Axis-aligned rays use
  Infinity for perpendicular axis. Budget = |dx|+|dy|+2, bounded
  by grid size after clipping. Row-major y-outer indexing consistent.
  Antimeridian wrap via wrap180. South-to-north row order.

- **Pass 238 — polar canvas rendering: CLEAN.** Coordinate
  transform (sin/cos) maps TWA 0→top, clockwise. DPR scaling via
  setTransform. Radial auto-scale with zero-floor guard. Target
  dots use same pt() as curve. Canvas cleared fully before redraw.
  ResizeObserver disconnected on unmount.
- **Pass 239 — isochrone tack/gybe penalty: CLEAN.** Penalty as
  added ms on dtMs. No double-counting (per-candidate vs parent).
  Zero penalty disables tack tracking (useTack=false). Root penalty
  blocked by parentTack!==0 guard. Multi-leg carries tack via
  prevTack. Backward pass memoryless (no penalties). TWA=180 always
  +180 via wrap180.
- **Pass 240 — format helpers consistency: CLEAN.** fmtClock handles
  negatives with sign suppression at zero crossing. fmtDeg maps
  360→"0". Null/NaN/Infinity→'—' everywhere. Time-to-burn sign
  flipped once consistently. toFixed locale-independent. fmtAgo
  23.5h→"1 day" correct.

- **Pass 241 — ScalarLayer texture upload: CLEAN.** RGBA/UNSIGNED_BYTE
  format consistent with shader sampler. 16-bit R/G encoding linear
  in each channel, so GPU LINEAR interpolation is mathematically
  correct. Texture dimensions match data grid. CLAMP_TO_EDGE +
  LINEAR. Old textures deleted before new upload. onRemove cleans
  all resources. All 9 uniforms assigned.
- **Pass 242 — layline computation: CLEAN.** Uses polar target TWA,
  not current TWA. Current correction via headingToMakeGood with
  foul-tide guard. Oscillation band from stdBearing. Distance
  along COG track divided by SOG (not VMG). twdToLay inverts
  course=TWD-TWA correctly. Overstanding produces null.
- **Pass 243 — simulation Euler integrator: CLEAN.** Position
  update uses start-of-step latitude for cos(lat). Current vector-
  summed in ground frame. sqrt(dtS) noise scaling (pass 209 fix)
  intact. Time accumulation no drift. Speed clamped non-negative.
  mulberry32 PRNG deterministic. Units consistently knots.

- **Pass 244 — route worker protocol: CLEAN.** Discriminated
  unions with type/kind tags. Monotonic id guards stale results.
  Worker crash recovery via onerror + lazy restart. Supersession
  terminates old worker. Progress throttled at 100ms. Errors posted
  in-band (promises never reject). rebuildField/rebuildLattice
  reconstruct domain objects. ArrayBuffer cloned (not transferred)
  by design.
- **Pass 245 — depth advisory logic: CLEAN.** Datum arithmetic
  correct (depthBelowMsl + waterAboveMllw - mslAboveMllw). MLLW
  consistent. Tide correction direction correct. Missing tide
  returns null, increments legsWithoutTide. Draft subtracted for
  underKeel. Advisory is pure annotation, no routing side effects.
- **Pass 246 — wind history tracking: CLEAN.** Fixed 900-entry
  FIFO buffer. stdBearing returns 0 for <2 samples. boundsFrom
  floors at nominal uncertainty for asserted sources. History
  cleared on wind mode change. Non-finite twd filtered. Not
  persisted (excluded from partialize).

- **Pass 247 — PCHIP interpolation: CLEAN.** Fritsch-Carlson
  monotonicity via weighted harmonic mean. Endpoint slopes use
  three-point one-sided formula with two-part limiter. No overshoot
  (tested at 0.1° resolution). Linear fallback for 2 points.
  Division-by-zero guarded. Extrapolation: ramp-to-zero below,
  hold above.
- **Pass 248 — venue asset loading: CLEAN.** Fetch errors checked
  via res.ok. Binary length validated against expected bytes.
  Promise-level caching with retry on failure. Worker validates
  land raster bit array length. Depth grid Int16 decimetres with
  DEPTH_MISSING=-32768. Tidal stations verified inside bbox.
  Graceful degradation on all failure paths.
- **Pass 249 — ParticleLayer lifecycle: CLEAN.** Single framebuffer
  created in onAdd, deleted in onRemove. Ping-pong textures swapped
  correctly. No rAF — uses map.triggerRepaint. Viewport change
  clears trail buffers. Particle count adaptive to viewport area.
  Zero wind guarded (magMax floor, shader 1e-6 divisor). FBO
  unconditionally unbound after render.

- **Pass 250 — isochrone goal hop: CLEAN.** Time = dist/closing
  with current decomposed into along/perpendicular. Crab angle
  via 4 fixed-point iterations. Land intersection checked. Upwind
  handled via implicit-tacking VMG/cos(twa). Tack/gybe penalty
  applied. Distance threshold: hours <= dtH. Zero distance guarded.
- **Pass 251 — sensitivity backward pass: CLEAN.** dir=-1 swaps
  origin/goal, anchors at forward ETA. sampleT = pt - dtMs for
  backward. Forward recorder keepMax:false, backward keepMax:true.
  Multi-leg iterates in reverse. Backward fan mirrors heading.
  Loss = max(0, (tf-tb)/60000) in minutes.
- **Pass 252 — color ramp generation: CLEAN.** Stops strictly
  ascending. Linear sRGB interpolation on perceptually-uniform
  palettes. 256-texel LUT. Discrete ramps produce flat bands.
  Legend CSS gradient uses same lookup as GPU LUT. Zero-width
  domain fills solid color. Alpha straight-to-premultiplied in
  shader. NaN returns low-end color.

- **Pass 253 — isochrone fan heading: CLEAN.** Directed cone
  centered on goal bearing, widens to 360° when stalled. VMG
  injection adds all four target angles (port/stbd × up/down).
  Fan array 128 entries, finest preset uses 77. Pruning buckets
  key on (cell, tack). Wrapping arithmetic sound for [-180, 540).
- **Pass 254 — Open-Meteo URL params: CLEAN.** All required
  variables requested. forecast_hours capped [1,384]. planGrid
  adjusts step to stay under 1600-point cap. Coordinates toFixed(4).
  timeformat=unixtime (UTC). Missing variables fill NaN. Cache
  key includes model/bbox/step/hours/layers. Marine failure degrades
  to wind-only with note.
- **Pass 255 — DenseField wind rotation: CLEAN.** No grid-north
  rotation needed (Open-Meteo provides true-north speed/direction).
  uvFromWind negates both components (meteorological FROM-direction).
  Trilinear: bilinear at k0 and k0+1, linear blend ft. Single-
  timestep ft=0. Direction from interpolated u/v, not interpolated
  angles. Wave direction uses circular sin/cos interpolation.

- **Pass 256 — implicit tacking VMG substitution: CLEAN.**
  VMG/cos(TWA) correctly projects upwind VMG onto desired heading.
  Downwind mirrors through 180°. Transition smooth at target TWA
  (both formulas yield BSP_target). cos>1e-6 guard structurally
  unreachable but correct. Current added as separate vector after
  effective speed. Dead-upwind test within 0.092%.
- **Pass 257 — track recording buffer: CLEAN.** Capped at 20k
  points via sliding window. Not persisted (excluded from
  partialize). Lat/lon stored as raw doubles. Canvas draws last
  900 points. Timestamps stored for speed/distance. Recording
  exits early when no GPS fix.
- **Pass 258 — water speed from SOG: CLEAN.** waterSpeed is scalar
  BSP fallback (BSP or SOG, clamped non-negative). Vector math
  in estimateCurrent: vecSub(fromPolar(cog,sog), fromPolar(course,
  bsp)). Gates on rate-of-turn to avoid corrupt estimates during
  tacks. headingToMakeGood null when BSP=0 or foul tide.

- **Pass 259 — wind estimation logic: CLEAN.** Apparent-to-true
  vector subtraction in correct frame (x-forward, y-starboard).
  FROM/TOWARD convention consistent (wind flips +180, current
  doesn't). TWS always non-negative (Math.hypot). BSP=0 gives
  TW=AW. uvFromWind in cube.ts and windToUV in wind.ts use
  identical math. History cleared on source change.
- **Pass 260 — RouteScreen useEffect: CLEAN.** Seven effects with
  correct dependency arrays. runIdRef pattern prevents stale results.
  Forecast loaded inline, not from stale closure. canRoute disables
  button when no marks. Worker dispose on unmount. Cube passed via
  structured clone (not transfer) by design. windFC reads time
  index 0.
- **Pass 261 — rhumb line functions: CLEAN.** Standard Mercator
  isometric-latitude formula. Stretch ratio q falls back to
  cos(lat1) when |dpsi|<1e-12. Antimeridian handled by wrap180.
  wrap360 guarantees bearing in [0,360). Poles degrade to NaN
  via non-finite guard.

- **Pass 262 — Tile negative zero display: BUG FOUND.**
  `toFixed` produces "-0.0" for small negatives that round to zero.
  Added `fmtFixed()` helper that strips the sign when the formatted
  string parses back to negative zero via `Object.is(+s, -0)`.
  Commit `66b4404`.
- **Pass 263 — GeoJSON sensitivity output: CLEAN.** Polygons
  correctly wound counter-clockwise (SW,SE,NE,NW,SW). Loss
  clamped non-negative. Grid cell indexing consistent between
  recorder and renderer. Zero-loss cells included (optimal
  corridor). Valid FeatureCollection for MapLibre fill layer.
- **Pass 264 — multi-model cube merge: CLEAN.** No grid merge —
  StackedField resolves per-parameter at query time. First
  provider covering the point wins. Shorter horizons fall through
  via null return. Per-parameter fallthrough tested. Promise-based
  cache deduplication with failure eviction.

- **Pass 265 — isochrone time step adaptation: CLEAN.** Five
  distance tiers with per-resolution values. byCount adapts to
  expected duration. Clamped by minStepS (60-300s) and MAX_STEP_S
  (6h). GRIB cadence ceiling. maxSteps hard cap 3000. Forward
  and backward use identical step magnitude. Convergence test
  confirms halving refines monotonically.
- **Pass 266 — CurrentChart canvas: CLEAN.** Y-axis symmetric
  around zero with 1kn floor. X-axis centered on now. Flood green,
  ebb red, 22% opacity fills. DPR clamped at 2.5. Empty/single-
  point series handled. ResizeObserver cleaned up. Time labels
  locale-aware. Y-axis label precision adapts (1 or 2 dp).
- **Pass 267 — Expedition polar format: CLEAN.** Ragged rows
  parsed independently. Split regex /[\s,;]+/ handles mixed
  delimiters. Comment lines stripped via !-prefix. TWA/BSP pairing
  correct with trailing value silently dropped. Negative TWA
  folded via abs()%360. Output consistent with CSV parser via
  shared finishTable.

- **Pass 268 — NodeStore pool growth: CLEAN.** Growth doubles via
  `cap *= 2`. All 14 parallel arrays grown together with correct
  subarray copy. Float64 for lat/lon/t, Float32 for angles/speeds.
  Alloc index incremented after ensure(). No reset — pool grows
  monotonically because route reconstruction walks parent indices.
  OOM cap checked per step (400K/1.2M/3M presets).
- **Pass 269 — WeatherScreen layer management: CLEAN.** Scalar and
  particle layers added in correct order. Parameter switch triggers
  synchronous reconfiguration (no flash). Color ramp rebuilt from
  `rampFor(layer)`. Particle speed texture re-encoded on time
  change. Unmount removes all owned layers/sources. Timeline
  play timer wraps, pauses on tab hide, tears down on dependency
  change.
- **Pass 270 — manoeuvre() TWA=0 boundary: BUG FOUND.**
  `Math.sign(0)` returns 0 (not 1), so `Math.sign(fromTwa) ===
  Math.sign(toTwa)` falsely detected a side-change whenever either
  TWA was exactly zero. The routing kernel and start-line module
  applied spurious tack penalties on dead-upwind starboard-side
  hops. Fixed: `(fromTwa >= 0) === (toTwa >= 0)`, matching
  tackOf()'s convention. Commit `7d52f16`.

- **Pass 271 — departure sweep bounds: CLEAN.** Endpoints
  inclusive via post-loop fixup. Non-dividing steps handled by
  append-or-replace. Single-point and reversed ranges degenerate
  correctly. Widening formula `ceil(span/(cap-1))` distributes
  evenly. maxSolves cap (24) prevents runaway. All timestamps
  raw epoch ms — no timezone concern.
- **Pass 272 — color ramp 16-bit encoding: CLEAN.** R/G encode
  `round(norm*65535)`, hi byte R, lo byte G. Shader decoder
  matches. Domain maps texel 0→min, 255→max via `i/(w-1)`.
  Straight alpha in LUT, premultiplied at render time with
  correct blend func. Discrete mode fencepost verified by
  exhaustive Beaufort test. NaN→discard via alpha<0.5. Single-
  color domain uses `max(1e-6,range)` denominator guard.
- **Pass 273 — GPX import/export round-trip: CLEAN.** All five
  XML special chars escaped. Mark names pass through esc() —
  no injection vector. Coordinates preserved at 6dp (~0.11m).
  Parser handles wpt/rtept/trkpt with deduplication. Empty GPX
  returns empty arrays. Non-numeric coords rejected by isFinite
  guard. BOM-prefixed XML parsed correctly by DOMParser.

- **Pass 274 — Zustand persist merge: CLEAN.** partialize
  whitelist covers all user-configured state, excludes live
  sensor data and actions. Deep merge handles nested boat/course/
  settings. Missing fields fall back to defaults via `...c` base.
  Version 1 with no migrate — discards stale on mismatch.
  Synchronous localStorage read prevents rehydration race.
- **Pass 275 — BoatSim PRNG seeding: CLEAN.** mulberry32 matches
  reference implementation for seeds 0/1/12345/42/0xFFFFFFFF.
  Odd increment 0x6D2B79F5 guarantees full 2^32 period. Noise
  scales with sqrt(dtS) for correct Brownian motion. Wind noise
  bounded ±12°. Speed clamped ≥0. Euler integration stable at
  operational 0.5s step (tau≥6). Current adds via sin/cos.
- **Pass 276 — PWA service worker caching: CLEAN.** Default-deny
  isCacheable allowlist excludes forecasts. Tile cache FIFO eviction
  at TILE_LIMIT=1200. Hashed assets cache-forever via regex.
  Navigation network-first with cache fallback. skipWaiting +
  clients.claim for immediate activation. POST excluded via
  method check. Old caches purged on activate.

- **Pass 277 — ErrorBoundary reset logic: CLEAN.** hasError flag
  correctly set/cleared. getDerivedStateFromError captures error.
  Retry resets state and bumps lazyGen counter for fresh lazy
  wrappers. Key-based isolation per tab. Fallback handles falsy
  thrown values (null/0/undefined). Topbar/tabbar outside all
  boundaries. Async errors correctly not claimed.
- **Pass 278 — tidal current interpolation: CLEAN.** Linear
  interpolation between 6-min samples with correct fraction.
  Returns null outside predicted window. Datum conversion
  (MSL-MLLW) sign-correct with anchor tests. Positive =
  flood, negative = ebb. Binary search maintains lo≤t<hi
  invariant. Feet→metres at boundary with 0.3048 constant.
- **Pass 279 — route worker crash recovery: BUG FOUND.**
  `onerror` handler unconditionally captured `this.pending`
  before checking worker identity. A stale crash event from a
  replaced worker stole the new request's pending promise and
  resolved it with the old worker's error — the new worker's
  result was silently dropped. Fixed: moved identity guard
  `this.worker !== worker` to early return at top of handler.
  Commit `aea6a91`.

- **Pass 280 — start line geometry edges: CLEAN.** Zero-length
  line guarded with lineLenNm>1e-9. Infinite-line convention for
  distance and crossing. Orient determined empirically from
  pre-start reference. Wind-parallel gives max bias via sin(90)=1.
  Zero speed returns null. LocalFrame applies cos(lat) correction.
  OCS detected when belowNm<0. Time-to-burn = timeToLine - timeToGun.
- **Pass 281 — DenseField trilinear interpolation: CLEAN.** Grid
  index clamped to [0,n-2] so i0+1 always in range. Antimeridian
  via normaliseLon tries ±360. NaN corners skipped with weight
  renorm. South-to-north row order consistent. Time boundary
  correct with ft=0 short-circuit. Delta coding with MISSING
  sentinel. U/V interpolated separately. 1x1 grid handled.
- **Pass 282 — PCHIP polar interpolation: CLEAN.** Fritsch-Carlson
  weighted harmonic mean with zero slope at extrema. Zero-length
  intervals guarded. Sorted by normaliseRow on import. Hermite
  basis h00/h10/h01/h11 correct with h-scaled tangents. Below
  first TWA ramps to zero. TWS linear between rows. Single column
  handled. Negative speeds clamped. Two points reduces to linear.

- **Pass 283 — Open-Meteo response parsing: CLEAN.** Hourly arrays
  aligned via alignTimes(). Nulls left as NaN from emptyCubeData.
  Wind direction via uvFromWind with meteorological "from"
  convention. Unit conversion from declared response unit, not
  assumed. Truncated responses handled via actual time axis.
  Grid layout y-outer/x-inner matches cube indexing. Wave
  direction uses circular interpolation.
- **Pass 284 — apparent wind computation: CLEAN.** Vector
  decomposition in boat frame correct (not naive angle subtraction).
  atan2 handles all quadrants. AWA sign positive=starboard.
  Zero TWS returns TWA=0 (atan2(0,0)=0). Boat outruns wind gives
  TWA=180. estimateCurrent uses fromPolar with bearing convention.
  headingToMakeGood solves crab-angle triangle. Radians/degrees
  consistent. wrap360 for TWD, wrap180 for TWA.
- **Pass 285 — haversine geodesy edges: CLEAN.** distance(p,p)
  exactly 0. bearing(p,p) returns 0 (atan2(0,0)). Antimeridian
  via wrap180 on longitude delta. clampUnit on asin/acos args.
  Numerically stable atan2(sqrt,sqrt) form. Earth radius
  3440.065nm correct. crossTrack positive=starboard. destination
  round-trip tested. Pole singularity produces defined result.

- **Pass 286 — isochrone goal hop: CLEAN.** Goal fires when
  remaining distance closeable in one step. Arrival time
  interpolated via dGoal/hopClosing. Crab-angle iteration (4
  fixed-point steps) handles cross-current. Land mask checked on
  hop segment. Multi-leg carries arrival time/tack/TWA forward.
  Backward pass uses dir=-1 with consistent sign changes.
  Convergence cone widens 100→180° with stall counter.
- **Pass 287 — tactics layline computation: CLEAN.** Layline
  bearings = TWD∓targetTWA, symmetric in symmetric wind. Ray
  intersection geometry correct (parallel→null, overstanding→null).
  Times via distance/SOG. Oscillation band from stdBearing.
  TWD-to-lay round-trips. Downwind uses gybe angles when
  angsep(bearing,TWD)≥90. No mark → laylines=null.
- **Pass 288 — DDA land mask walk: CLEAN.** Amanatides-Woo
  voxel traversal with correct dx=0/dy=0 degenerate handling.
  Slab-based clip to raster box (commit 3a97719) makes budget
  structurally unreachable. Scanline rasterisation uses even-odd
  fill with hole support. Coordinate mapping via wrap180 for
  short-way-around. Conservative fallback on budget exhaustion.

- **Pass 289 — solar position isNight: CLEAN.** NOAA low-precision
  algorithm verified against known positions (London solstice,
  equator equinox). Julian day from Unix ms correct. EoT constants
  1.915/0.020 standard. Obliquity 23.439-0.0000004n. Polar day
  and night verified at lat 89.9. Civil twilight threshold -6°.
  Hour angle from GMST (UTC). Continuous across midnight boundary.
  5-min memoization bucket introduces ~0.02° error.
- **Pass 290 — fan heading construction: CLEAN.** Fan sweeps ±half
  around goal bearing, widening 100→180° on stall. Fixed step
  per resolution preset (5/8/12°). All four VMG angles injected
  via fanPushInCone. Dead zone handled by effective() with
  implicit-tacking VMG substitute. Direct course at k=0. 0/360
  wrap correct. Forward/backward use same buildFan with 180°
  centre flip.
- **Pass 291 — tack/gybe penalty routing: CLEAN.** Penalty in
  seconds ×1000 for ms domain. Fires once per side-change, not
  per step. manoeuvre() classifies tack vs gybe. Goal hop applies
  same penalty. Bucket key includes tack state for fair domination.
  Penalty baked into arrival time. Backward pass skips penalties
  (useTack = isFwd). Zero penalty → memoryless case.

- **Pass 292 — Tile component rendering: CLEAN.** Null/0 distinction
  via Number.isFinite guard. fmtClock handles negatives with
  Math.abs + sign prefix. String vs number values via type check.
  Tone class only when known. fmtFixed never called with NaN/Inf
  (Tile guards first). fmtAgo minute boundaries correct.
- **Pass 293 — StackedField resolution: CLEAN.** First provider
  returning non-null wins. Per-parameter resolution (wind from A,
  current from B). Short-horizon returns null → fallthrough. gust()
  uses `!== null` not truthiness (avoids zero-is-falsy). coverage()
  computes union bbox. dtMs returns min positive cadence. Priority
  stable for object lifetime.
- **Pass 294 — useSensors GPS lifecycle: CLEAN.** clearWatch on
  unmount. Permission denied → gpsError, no retry loop. Uses
  pos.timestamp not Date.now(). maximumAge: 1000 rejects stale.
  Speed m/s→kn via ×1.94384. COG from GPS course, compass heading
  null. NaN-not-zero for absent sensors. Wake lock cleanup correct.

- **Pass 295 — bucket pruning dominance: CLEAN.** Key from
  injective (ix,iy,tack) encoding within Int32 range. A*-like
  f=g+h score with admissible heuristic. Tack partitions buckets
  when penalties active. Open-addressing label table with
  stamp-checked probing. Adaptive bucket size = stepTravel/4.
  wrap180 handles antimeridian. fn=0 reported as clean failure.
- **Pass 296 — wind history tracking: CLEAN.** Append-and-trim
  array capped at 900 entries (15min @ 1Hz). stdBearing uses
  circular stats for 0/360 wrapping. <2 entries → nominal
  fallback. Cleared on windMode change. Excluded from persist
  partialize. Chronological by construction.
- **Pass 297 — ParticleLayer GL state: CLEAN.** Saves/restores
  blend, blend funcs, viewport, scissor, depth, stencil. Pass
  210 blend fix still in place. Ping-pong correct (screen and
  particle). Fade uses OVERWRITE + quantized decay. onRemove
  deletes all 7 textures, 2 buffers, 1 FBO, 3 programs.
  setData deletes old textures before creating new. clearPending
  invalidates stale trails on visibility restore.

- **Pass 298 — ScalarLayer GL lifecycle: CLEAN.** Saves/restores
  blend, blend funcs, scissor, depth. Pass 201 blend fix in place.
  setColorRamp deletes old texture. Domain uniform with 1e-6
  division guard. 16-bit R/G round-trip exact, LINEAR filtering
  correct. NaN → alpha=0 → discard. Temporal blend via mix() of
  two encoded time steps. onRemove deletes 3 textures, 2 buffers,
  1 program.
- **Pass 299 — route reconstruction: CLEAN.** Parent chain walks
  i≥0, terminates at -1 sentinel. Second pass fills root-to-finish
  order. Field attribution reads conditions from next node (segment
  departure convention). Multi-leg pops stale arrival row.
  distanceNm from P.dist[nxt]. Infinite loop impossible (parent<i
  by construction).
- **Pass 300 — Expedition polar parser: CLEAN.** Mixed delimiters
  via /[\s,;]+/ split. Comment lines stripped via !-prefix.
  Ragged rows self-contained with TWS + (TWA,BSP) pairs. Trailing
  unpaired TWA silently dropped. Negative TWA via abs()%360.
  finishTable shared with CSV path. Format sniffing via majority
  vote on angle>1.5×speed. NaN/Inf rejected by isFinite.

- **Pass 301 — glutil texture helpers: CLEAN.** createTexture
  sets CLAMP_TO_EDGE, caller-provided filter, RGBA/UNSIGNED_BYTE.
  No resource tracker (caller-managed). Shader error handling
  extracts info log. QUAD vertices two CCW triangles. Texture
  unit binding via TEXTURE0+unit (consecutive by spec).
  encodeScalarField constant-value → range=1. encodeVectorField
  A=0 for missing.
- **Pass 302 — colormap Beaufort stops: CLEAN.** Boundaries
  [0,1,4,7,11,17,22,28,34,41,48,56,64] match published scale.
  Strictly ascending, no gaps/overlaps. Discrete mode returns
  class color without interpolation. Continuous mode linear
  interpolation verified numerically. Below-first and above-last
  clamped. NaN → first stop. Wind uses viridis (CVD-safe,
  luma-monotone verified). Legend proportional discrete blocks.
- **Pass 303 — store action atomicity: CLEAN.** Every multi-field
  action uses single set() call. addMark/replaceMarks/clearCourse
  bundle COURSE_CHANGED with index update. removeMark clamps
  and shifts activeMarkIndex atomically. setWindMode conditionally
  clears history in same set(). No TOCTOU — JS single-threaded,
  get() evaluated before set() executes.

- **Pass 304 — wind shift time-to-line: CLEAN.** effectiveWind
  flows to computeTactics → laylines and markTime. Polar speed
  updates with shifted TWS. wrap360 on TWD+shift. Speed clamped
  ≥0.5kn. Spread creates new object (no mutation). useMemo deps
  complete. Negative shift displays correctly (no prefix, own sign).
- **Pass 305 — validatePolar constraints: CLEAN.** Catches empty
  tables, duplicate/non-increasing TWS, non-increasing TWA,
  negative BSP, TWA outside [0,180], positive BSP at TWS=0.
  Error messages include row index and values. finishTable merges
  duplicate TWS. normaliseRow keeps fastest BSP per angle.
  Validation called in SetupScreen via useMemo.
- **Pass 306 — LocalFrame flat-earth math: CLEAN.** cos(lat)
  applied to longitude. NM/deg = R_NM×DEG ≈ 60.04 (0.067% over
  definitional). toLatLon exactly inverts toXY (DEG×RAD=1).
  Southern hemisphere: cos(-lat)=cos(lat). Frame centered on
  line midpoint. All XY computations share same frame instance.
  Error documented with table, pinned by 4 tests.
- **Pass 307 — rhumb line antimeridian: CLEAN.** rhumbDistance
  and rhumbBearing use wrap180(dLon) for short-arc selection —
  verified 179.9→-179.9 yields 0.2° not 359.8°. Mercator psi
  pole singularity inherent, not a bug. Stretch ratio fallback
  cos(φ1) at |dψ|<1e-12 is correct L'Hopital limit. lonSpan
  handles all quadrants. Trig units consistent (DEG/RAD).
  rhumbDestination not implemented (no callers). Short-distance
  numerical stability fine via Math.hypot.
- **Pass 308 — polar canvas rendering: CLEAN.** PolarPlot
  polar-to-cartesian correct (sin/cos with TWA=0 at top,
  clockwise). DPR scaling follows buffer×DPR / CSS÷DPR /
  setTransform pattern, capped at 2.5. ResizeObserver cleanup
  on unmount. vmax≤0 early return handles zero-speed polars.
  Speed scale ceils max across all wind speeds. VMG targets
  rendered as dots (design intent). 0-180 TWA range in 1°
  steps with 30° spokes.
- **Pass 309 — forecast cache dedup: CLEAN.** Promise itself
  cached for dedup. Failed fetch .catch() evicts entry with
  identity guard (cache.get(key)?.cube === pending) preventing
  stale eviction of newer entry. Cache key includes model,
  bbox (q6-rounded), stepDeg, hours, waves, current. Expiry
  at next hour boundary. clearWeatherCache() exported. 429
  treated as error, evicted. Unbounded Map acceptable — only
  button-press/model-change callers, single-digit entries.
- **Pass 310 — departure sweep arithmetic: CLEAN.** Both
  endpoints included (explicit last<to guard). Widened step
  via Math.ceil(span/(cap-1)). Endpoint fix prevents FP
  rounding skip. Cost = elapsedS - best.elapsedS (non-negative).
  Single-departure (from===to) returns exactly one solve.
  Zero-length window, all-fail, attempted vs succeeded all
  correct. spreadS = slowest-best range. stepFloorS = max
  timeStepS among successes. 47 tests pass.
- **Pass 311 — Mercator mesh vertices: CLEAN.** mercatorX/Y
  implement standard Web Mercator normalisation. UV v maps
  0=south to 1=north matching cube row order and texImage2D
  bottom-to-top storage. 64 strips × 2 triangles × 3 vertices
  = 384 verts, no off-by-one. CULL_FACE disabled so winding
  irrelevant. CLAMP_TO_EDGE prevents antimeridian bleed.
  Particle layer linear mix(mercY) is sub-pixel at coastal
  scale — deliberate simplification vs scalar layer's 64-strip
  approach.
- **Pass 312 — wind barb symbol generation: CLEAN.** FROM
  convention correct: windToUV uses -sin/-cos, uvToWind uses
  atan2(-u,-v). Three rendering paths (barbs icon-rotate fromDeg,
  arrows text-rotate towardDeg-90 for ➤, canvas rotate) all
  produce correct bearing. Calm (<3kn) renders bare circle.
  Strong wind caps at 75kn bucket. Speed already in knots from
  ingest (toKnots in openmeteo.ts). Feathers on right side.
  wrap360 handles 360/0 discontinuity. strideFor adapts density
  to zoom. Missing data dropped by thinVectorField.
- **Pass 313 — GPX import/export roundtrip: CLEAN.** esc()
  covers all five XML special chars via callback (no double-
  replace risk). toFixed(6) export / Number() import preserves
  sub-mm precision. Missing name defaults to 'Mark'. Missing
  time skips trackpoint. parsererror detected for malformed XML.
  Namespace-prefix gap theoretical only (GPX 1.1 uses default
  namespace). Roundtrip test exercises &, ", <, > in names.
- **Pass 314 — tide station selection: CLEAN.** No dynamic
  nearest-station lookup — stations hardcoded per venue in
  venues.ts. velocityAt/waterLevelAt use binary search + linear
  interpolation. Edge cases: empty→null, out-of-window→null,
  single-element guarded. Datum sign correct: depthBelowMsl +
  waterAboveMllw - mslAboveMllw, pinned by 3 anchor tests.
  flowAt uses NOAA meanFloodDir/meanEbbDir (TOWARD convention).
  All times UTC: requests time_zone=gmt, parsing Date.UTC(),
  formatting getUTC*. FEET_TO_M=0.3048 at parse boundary.
- **Pass 315 — simulation Euler integration: CLEAN.** t +=
  dtS*1000 correct. Displacement via dtS/3600 * speed(kn) →
  NM, then LocalFrame.toLatLon inverts correctly. Polar lookup
  swaps args to match lattice API. Current vector same sin/cos
  convention. mulberry32 PRNG deterministic (3 repro tests).
  Wiener noise sqrt(dtS), OU decay pow(0.995,dtS). Zero wind
  → zero speed via min(1,tws/12). Dead upwind → 0.4kn
  steerageway. Turn rate clamped, no O(dt²) frame-rate bug.
- **Pass 316 — color ramp 16-bit encoding:** agent hit rate
  limit mid-run. Re-scheduled as pass 319.
- **Pass 317 — error boundary lifecycle: CLEAN.**
  getDerivedStateFromError sets hasError+error. componentDidCatch
  logs screen name and stack. Fallback UI safely extracts message
  from any thrown value (Error, string, number, null, undefined)
  via String(error ?? 'unknown error'). Retry clears state and
  invokes onReset (bumps lazyGen for genuine chunk retry). Key
  prop causes full unmount/mount (fresh initial state). Suspense
  inside ErrorBoundary (correct nesting). No components in
  fallback that could throw. 11 test cases pin all paths.
- **Pass 318 — service worker caching rules: CLEAN.** Forecasts
  excluded by open-meteo.com hostname guard + default-deny
  isCacheable allowlist. Tiles network-first with TILE_LIMIT
  eviction (oldest by Cache API insertion order). Hashed assets
  cache-forever via /assets/ regex. Navigation network-first
  with offline fallback. Activate handler deletes old-version
  caches. Cache names prefixed nj-portland-v1-. Stale tiles
  served on network failure via .catch(→caches.match). SW
  registered with relative path matching base:'./'. Precache
  is minimal shell (index.html, manifest); assets cached on
  demand.
- **Pass 319 — color ramp 16-bit encoding: CLEAN.** Encode:
  q=round(norm×65535), R=q>>8, G=q&0xff, alpha=0 for NaN.
  Decode: (c.r×255×256 + c.g×255)/65535 — symmetric with
  encode. Premultiplied alpha output matches ONE/1-SRC_ALPHA
  blend. Beaufort stops [0,1,4,7,11,17,22,28,34,41,48,56,64]
  match standard. Discrete ramps return class colors without
  interpolation. rampToLUT maps domain endpoints to first/last
  texels. Round-trip tested within tolerance. Negative values
  handled via normalisation.
- **Pass 320 — route progress reporting: CLEAN.** Progress =
  progressBase + progressSpan×k/maxSteps. Passes tile [0,1]
  contiguously via passIndex/passCount. Monotonic within pass
  (k only increases) and between passes (no gap/overlap).
  Multi-leg: passCount = marks.length × (sensitivity?2:1).
  Reaches 1.0 on final pass. Throttle in worker.ts drops
  intermediate values but lets 1.0 through. Sweep: done/total
  after each solve. Stale progress blocked by msg.id!==p.id
  guard + worker termination on cancel. Backward pass uses
  same arithmetic, occupies second half of bar.
- **Pass 321 — Zustand persist merge: CLEAN.** Partialize
  whitelist: 7 user-config fields. All runtime/sensor state
  excluded. mergePersistedState deep-merges boat, course
  (with startLine), settings — new code fields get defaults.
  Null persisted state defaults to {}. Single-field selectors
  across all 6 consuming files. localStorage storage. Version=1,
  no migrate function (safe discard on bump). Tests cover
  old-schema transitions.
- **Pass 322 — PCHIP interpolation edge cases: CLEAN.**
  Fritsch-Carlson weighted harmonic mean correct at interior
  points. Endpoint three-point formula verified numerically
  against quadratic. Monotonicity limiter: zero at sign changes,
  clamp to 3× adjacent secant. Two-point → linear fallback.
  Single point → all-zero slopes, boundary handlers take over.
  Hermite basis h00/h10/h01/h11 standard. Binary search
  invariant x[lo]≤a<x[hi]. Zero-width intervals → y[lo].
  Flat regions → zero slopes → flat cubic.
- **Pass 323 — haversine geodesy precision: CLEAN.**
  Coincident points → distance 0, bearing 0 (atan2(0,0)).
  Antipodal → π×R_NM via atan2 (avoids asin instability).
  Cardinal bearings tested. destination() wraps lon via
  wrap180, clampUnit protects asin. angdiff returns signed
  shortest arc. wrap180(±180)=180, wrap360(0)=wrap360(360)=0.
  Constants: R_NM=3440.065 (6371/1.852), NM_TO_M=1852.
- **Pass 324 — DDA land detection ray walk: CLEAN.**
  Amanatides-Woo DDA: tdx=1/|dx|, tdy=1/|dy|, Infinity for
  axis-aligned. Slab clip prevents walk outside raster box.
  Cell index via Math.floor. Negative directions: step=-1,
  tmx=(ix-sx)/dx. Scanline rasterizer uses cell-center
  sampling with even-odd rule. Dilation expands 1 cell in 8
  directions. cellIsLand bounds-checks before array access.
  Guard loop with conservative fallthrough (returns true).
  39 tests including 400-random-segment property check.
- **Pass 325 — solar position calculation: CLEAN.** Julian
  date: n=t/86400000+2440587.5-2451545.0. Equation of center
  1.915sin(M)+0.02sin(2M). Declination via obliquity 23.439°.
  Hour angle: GMST+lon-RA with consistent unit conversions.
  Elevation: standard sin(lat)sin(dec)+cos(lat)cos(dec)cos(ha)
  with clampUnit guard. Civil twilight <-6° threshold. Polar
  regions handled naturally. 5-min memoisation bucket ≤0.04°
  error. Test pins Boston midsummer day/night.
- **Pass 326 — DenseField/CubeField trilinear: CLEAN.**
  Bilinear weights w00/w10/w01/w11 = products of (1-f) and f.
  Two time slices blended (1-gt)/gt. Grid index via
  (coord-origin)/step. Boundary: clamp to [0,n-2], frac to
  [0,1]. South-to-north row order with stride [t][y][x].
  Wind stored as u/v components throughout. cube.ts drops NaN
  corners and renormalises weights. DenseField pre-fills gaps
  via fillGaps(). |0 floor trick safe for non-negative clamped
  values. wrap180 on longitude for date-line safety.
- **Pass 327 — isochrone fan heading construction: CLEAN.**
  Adaptive cone ±half degrees (100→180 on stall). Step per
  preset: 5/8/12°. k=0 places direct-to-waypoint heading.
  Four VMG targets injected via fanPushInCone (both tacks
  up/downwind). courseFor = wrap360(twd-twa). Fan buffer 128
  entries, worst case 77. Current not shifted but cone wide
  enough; goalHop solves crab angle via fixed-point iteration.
  Each leg gets own run() with correct origin/goal.
- **Pass 328 — bucket pruning dominance: CLEAN.** Score =
  dir×t + remain/vmax × MS_PER_HOUR (admissible A*). Bucket
  key = ((ix+8000)×16001+(iy+8000))×3+(tack+1) — collision-
  free perfect hash. Bucket size scaled to stepTravelNm/4.
  Label table persists across steps (reset per pass via
  passStamp). Touched array reset each step, only improved
  slots added. Backward pass mirrors forward with reversed
  dir, time, no tack penalties. growLabels rehash preserves
  live entries. Load factor <1/3.
- **Pass 329 — tack/gybe penalty application: CLEAN.**
  manoeuvre() uses (fromTwa>=0)===(toTwa>=0) for side-change.
  Penalty added as seconds→ms to step travel time. tackPen
  vs gybePen selected by manoeuvre() return. TWA=0: newTack=
  parentTack, parentTack!==0 guard prevents false penalty.
  First leg: root tack=0, guard blocks penalty. Cost-to-go
  includes penalty in C.t[c]. Consecutive tacks independent
  per step. Symmetric port↔starboard. Backward pass: useTack
  =false, all tack=0, memoryless. Multi-leg carry-forward of
  prevTack/prevTwa tested end-to-end.
- **Pass 330 — StackedField multi-model resolution: CLEAN.**
  Iterates providers in priority order, takes first non-null
  per parameter. Truthiness checks safe for object types
  (WindSample, WaveState); gust uses !==null for bare number.
  coverage() computes union bbox with clone (no mutation).
  dtMs returns min cadence across providers. NaN→null at
  field level, null falls through stack, all-null→null.
  Tests cover priority, per-parameter fallthrough, out-of-
  coverage null, coverage union.
- **Pass 331 — apparent wind vector math: CLEAN.** Boat-frame
  decomposition: awx=aws×cos(awa), awy=aws×sin(awa), subtract
  BSP from forward component. AWA positive=starboard consistent.
  Zero BSP→TWS=AWS, TWA=AWA. Zero AWS→TWS=BSP, TWA=180.
  estimateCurrent: ground-water vectors, TOWARD convention.
  groundToTrue: flip FROM→TOWARD, subtract current, flip back.
  windToUV/uvToWind: standard meteorological u=-speed×sin(from).
  correctForHeel: divides transverse by cos(heel). Round-trip
  tests confirm invertibility.
- **Pass 332 — format helpers consistency: CLEAN.** 16
  formatters across 7 files audited. UTC/local never confused.
  fmtClock: mm:ss unpadded minutes (race convention). fmtHm:
  three similar local-time formatters (duplication, not bug).
  Midnight → "00:00". Negative durations: Math.abs with sign,
  no "-0" anomalies. Null/NaN/Infinity guarded in all Tile.tsx
  formatters. Precision: speed 1dp, distance 2dp, angles 0dp.
  Units: kn, nm, °, m, BL all correct.
- **Pass 333 — Open-Meteo response parsing: CLEAN.** Field
  names correct including model-suffixed variants via pickSeries.
  Wind direction passed as FROM to uvFromWind. Unit conversion
  factors accurate (km/h, m/s, mph→kn). unitFor reads declared
  unit from response. timeformat=unixtime, ×1000 for ms. Missing
  fields→null via pickSeries, cells initialised NaN. Grid order
  south-to-north, flat index ix=flat%nx, iy=floor(flat/nx).
  Bbox from actual grid. dtMs from first two timestamps.
  alignTimes maps per-location time axis via exact match.
- **Pass 334 — Expedition polar format parsing: CLEAN.**
  Expedition: field[0]=TWS, subsequent pairs (TWA,BSP). Lines
  <3 fields or any NaN skipped. detectDelimiter counts tabs/
  semicolons/commas. CSV: numeric header extraction, orientation
  sniff via maxFinite threshold. cellNum returns NaN for empty
  (avoids Number('')===0). finishTable merges duplicate TWS
  via Map. normaliseRow folds >180°, deduplicates keeping
  faster BSP, clamps negative BSP to 0, sorts by angle.
  Format sniffing uses odd/even magnitude vote with 1.5×
  threshold.
- **Pass 335 — start line geometry: CLEAN.** signedDistanceToLine
  positive on right of P→S (pre-start side). orient factor
  aligns sign convention. timeTo via ray intersection parameter
  ÷ SOG × 3600. lineBias = angdiff(twd, squareWind). favouredEnd:
  positive bias → starboard, 0.25° deadband. LocalFrame:
  equirectangular with cos(lat) scaling. OCS: belowNm<0 AND
  timeToGun>0. Zero-length line → null guard. Parallel heading
  → rayIntersect null, fallback to ends/reach/tacks. 32 tests.
- **Pass 336 — delta-coded binary encoding: CLEAN.** Delta
  per spatial cell across time: residual=q-pred[i], pred[i]=q.
  Decode: q=pred[i]+raw, pred[i]=q (symmetric). MISSING=-32768
  sentinel for NaN, skips predictor update on both sides.
  Values clamped ±16383, max delta ±32766 fits Int16 without
  sentinel collision. Magic big-endian, rest little-endian,
  consistent encode/decode. 2-byte alignment via bodyOffset.
  Byte-plane shuffle with sign extension (<<16>>16). cubeSizeBytes
  matches actual byteLength. Tests cover round-trip, NaN,
  delta across holes, extreme clamp, corrupt rejection.
- **Pass 337 — implicit tacking VMG substitution: CLEAN.**
  deriveTargets: golden-section refinement on PCHIP curve for
  max BSP×cos(TWA). Three regimes in effective(): upwind inside
  no-go uses VMG_up/cos(twaAbs), downwind beyond target
  compares direct vs |downVmg|/cos(180-twaAbs), normal range
  uses polar speed. Both boundaries continuous. c>1e-6 guards.
  effBeat flag marks substituted segments. Same effective()
  used in fan loop, goalHop, speedForHeading. Tack penalties
  fire on desired heading sign, not internal zigzag.
- **Pass 338 — multi-leg route orchestration: CLEAN.** from
  updated to previous mark after each leg. clock updated to
  finishT. prevTack/prevTwa carried via pool entry → next
  leg's initialTack/initialTwa. Isochrones appended per leg.
  elapsedS = (clock-startTime)/1000. Backward sensitivity
  iterates legs in reverse. passCount = marks.length ×
  (sensitivity?2:1). Failed leg returns with leg number.
  Dense field hydrated once covering full horizon. Goal hop
  applies mark rounding penalties. appendLegs pops stale
  arrival row when continuing.
- **Pass 339 — goal hop fixed-point iteration: CLEAN.** Crab
  angle iteration decomposes current into along/cross-track.
  4 iterations (3 updates + 1 eval). Zero current → trivial.
  Current > BSP caught by need>1 guard. Closing speed =
  bsp×cos(phi)+cAlong (forward) or -cAlong (backward).
  Arrival time in ms with penalty. Tack/gybe penalty mirrors
  fan loop. Fires when hours≤dtH. Finish node inserted with
  consistent pool state. startline.ts timeToPointOverGround:
  2-iteration fixed-point, contraction ratio ≈ current/boat
  speed. Tests bisect analytic Zermelo solution.
- **Pass 340 — WebGL state save/restore: CLEAN.** ScalarLayer
  saves/restores: BLEND, BLEND_SRC/DST_RGB, SCISSOR_TEST,
  DEPTH_TEST. ParticleLayer additionally saves/restores:
  VIEWPORT, STENCIL_TEST, COLOR_CLEAR_VALUE. FBO unbound to
  null after every pass. Blend equation never changed (default
  FUNC_ADD). Unsaved state (program, buffer bindings, texture
  units, vertex attrib arrays) is re-set by MapLibre before
  its own draws — follows MapLibre custom layer convention.
- **Pass 341 — route path reconstruction: CLEAN.** Two-pass
  reconstruct: count then fill start-to-finish. Parent=-1
  sentinel terminates. Pool indices monotonic (no cycles).
  Both endpoints included. Timestamps monotonic (dir×addend
  non-negative). VMG beat flag stored/read correctly. Multi-leg:
  appendLegs pops stale arrival when continuing, root uses
  path[1] for outbound conditions. Goal hop: positioned at
  goal, parent=frontier node, land-checked, dist=0 in final
  entry. No-path → failed() with legs:[]. Diagnostics:
  evaluated accumulated across passes, computeMs from timer.
- **Pass 342 — useSensors GPS data flow: CLEAN.** watchPosition
  with enableHighAccuracy:true, maximumAge:1000, timeout:20000.
  clearWatch on unmount. Error → setGpsError(message). SOG from
  platform c.speed × 1.94384 (m/s→kn). COG from platform
  coords.heading (null→NaN, not 0). Accuracy extracted.
  Number.isFinite guards on speed/heading. Geolocation API
  unavailable → error message. setGpsError(null) clears on
  each fix. Tests cover NaN-not-zero, genuine zero, non-finite
  rejection, conversion, cleanup, disabled, no-API.
- **Pass 343 — ping-pong framebuffer swap: CLEAN.** Read
  from particleTexture0 (unit 1), write to particleTexture1
  (FBO), swap via tmp variable. res=ceil(sqrt(count)),
  particleCount=res². RGBA8 with 16-bit R/G+B/A position
  encoding. Random byte init for uniform seeding. No same-
  texture read-write hazard. Screen texture ping-pong also
  correct. Texture units: 0=wind0, 1=particles, 2=ramp,
  3=wind1 — no collisions per draw call. Index shader
  fract(i/res)/floor(i/res)/res maps to unique texel.
- **Pass 344 — venue pack data loading: CLEAN.** Coordinates
  {lat,lon} consistent, MapLibre reorders to [lon,lat].
  Land raster validated: 4 moored instruments read as water,
  3 inland towns as land, waterStart has sea room in all
  directions. Tide station 8418150 cross-validated with
  PORTLAND_DATUM.stationId. Depth grid south-to-north,
  "deepens offshore" test confirms orientation. Cell sizes
  consistent: land 0.001°, depth 1/240°. Cross-asset bbox
  match within half depth cell, water fractions agree ±2%.
  DEPTH_MISSING = weather MISSING = -32768.
- **Pass 345 — Vite config and build pipeline: CLEAN.**
  worker.format:'es' matches type:'module' instantiation.
  base:'./' consistent with manifest start_url/scope and SW
  registration path. Hand-rolled SW with 4-rule strategy.
  es2022 target aligned in vite and tsconfig. sourcemap:true.
  strict:true, jsx:react-jsx, moduleResolution:bundler.
  lib includes DOM+WebWorker. Vitest env:node with per-file
  pragmas. React 19, Zustand 5, Vite 6, TS 5.7 — all
  compatible, no conflicting peer deps.
- **Pass 346 — backward sensitivity pass: CLEAN.**
  Backward pass uses dir:-1, starts at etaMs, iterates legs
  in reverse. Wind sampled at correct departure time. Forward
  recorder keepMax:false (earliest arrival), backward
  keepMax:true (latest departure). buildSensitivity computes
  (T_f − T_b)/60000 — ETA cancels, zero on optimal path.
  Both recorders share identical bbox grid. Tack penalties
  disabled for backward pass (memoryless). goalHop correctly
  reverses base heading and crab-angle for dir:-1.
- **Pass 347 — time step selection heuristic: CLEAN.**
  dtS selection logic in the isochrone kernel verified.
  Step size adapts correctly to leg length and resolution.
  No off-by-one in step count calculation. Time accumulation
  stays monotonic. Final partial step handled correctly.
- **Pass 348 — bathymetry depth query with tide: CLEAN.**
  Bilinear interpolation on depth grid verified. Tide
  correction arithmetic (MSL-to-MLLW datum offset) correct.
  DEPTH_MISSING sentinel propagated without interpolation.
  Grid index clamping at boundaries prevents OOB access.
  Depth sign convention consistent (positive = water depth).
- **Pass 349 — error boundary reset and lazy retry: CLEAN.**
  hasError boolean flag set in getDerivedStateFromError,
  fallback renders correctly. Key-based isolation per tab
  unmounts/remounts boundary on switch. Retry bumps lazyGen
  to defeat React.lazy cached rejection. No infinite loop —
  fallback does not render children. componentDidCatch logs
  screen name + error + stack. Boundaries per-tab, not global.
- **Pass 350 — Zustand selector stability: CLEAN.**
  All useStore calls use single-field selectors returning
  stable references (primitives or same function ref). No
  multi-field destructuring without shallow comparator.
  partialize includes only serializable state. mergePersistedState
  deep-merges nested objects correctly. Every action uses
  single set() call. No subscribe outside React. No async
  actions with stale closures — store uses get() synchronously.
- **Pass 351 — route worker message protocol: CLEAN.**
  Discriminated union on type field, all cases handled.
  Monotonic nextId with identity check drops stale results.
  onerror has worker identity guard against stale crash events.
  Worker try/catch posts errors in-band. Typed arrays not
  transferred (intentional — main thread needs them for
  overlay). cancel() terminates old worker before new request.
  No concurrent messages — always fresh worker per request.
- **Pass 352 — GeoJSON serialization correctness: CLEAN.**
  All coordinates [lon, lat] order, verified across RouteScreen,
  ChartSurface, WeatherScreen, vectorSymbols, gpx. Properties
  all JSON-serializable. LineString guards on empty legs.
  Polygon rings closed. Sensitivity polygons use wrap180.
  isFinite guards on wind arrows and sensitivity values.
- **Pass 353 — map layer add/remove/re-add lifecycle: CLEAN.**
  ParticleLayer and ScalarLayer onRemove deletes all GL
  resources (textures, buffers, FBOs, programs). Tests verify
  alive counts reach 0. Re-add after style change handles
  stale handles (delete no-op per WebGL spec). render() guards
  12+ resources before drawing. GL state save/restore covers
  BLEND, SCISSOR, DEPTH, STENCIL, VIEWPORT. Event listeners
  cleaned up in onRemove. Layer z-order correct with beforeId.
- **Pass 354 — weather model switching races: CLEAN.**
  StackedField priority-resolves per parameter correctly.
  Fetch effect uses cancelled flag — no stale setCube.
  Cache stores promise keyed by model+bbox, identity-checked
  cleanup on failure. Partial failure preserves wind, removes
  marine params, surfaces notes. GPU textures deleted before
  new ones created on model switch. Routing uses monotonic
  ID + generation counter across async boundaries.
- **Pass 355 — PWA service worker caching: CLEAN.**
  Four-rule strategy: weather API network-only, tiles
  network-first, navigation network-first, same-origin
  cache-first (hashed) / stale-while-revalidate (unhashed).
  Default-deny isCacheable allowlist. Install precaches shell,
  skipWaiting. Activate purges old VERSION caches, clients.claim.
  POST filtered. Opaque responses excluded (res.ok && basic).
  Tile cache capped at 1200 entries with trimCache eviction.
- **Pass 356 — departure sweep grid generation: CLEAN.**
  planDepartures inclusive endpoints: floor(span/step)+1.
  Widening formula ceil(span/(cap-1)) correct. Endpoint fixup
  pushes or replaces last point. Edge cases: span=0 → [from],
  reversed → [from], non-finite → [from]. sweepDepartures
  picks best by minimum elapsedS. Per-departure exceptions
  caught. Worker passes startTime correctly via object spread.
- **Pass 357 — GPS sensor data flow: CLEAN.**
  lat/lon mapped to position correctly. maximumAge:1000 prevents
  stale fixes. SOG from coords.speed * 1.94384 (m/s→kt).
  COG from coords.heading. Phone magnetometer intentionally
  not trusted (heading=null). Permission errors set gpsError.
  clearWatch on unmount. fixAge computed with 1 Hz tick, warns
  at 8s stale.
- **Pass 358 — React.lazy and Suspense boundaries: CLEAN.**
  Three lazy calls wrap named exports correctly. All have
  Suspense ancestors with spinner fallbacks. Tab-based
  conditional rendering avoids waterfalls. lazyGen bump
  creates fresh lazy() wrappers defeating cached rejection.
  Stable component refs prevent unnecessary reimporting.
- **Pass 359 — tidal current prediction interpolation: CLEAN.**
  NOAA time parsing uses Date.UTC. Feet→m factor exact.
  Binary search + linear temporal interpolation correct.
  Datum arithmetic: surfaceAboveMsl = waterAboveMllw −
  mslAboveMllw verified with real NOAA figures. Reversing
  stations use binary flood/ebb bearings (no wraparound).
  Router adds current as vectors: vx = bsp*sin + cu. Units
  consistent (knots throughout). Slack water threshold 0.1kt.
- **Pass 360 — format/display helper edge cases: CLEAN.**
  fmtFixed strips negative zero from toFixed. fmtDeg guards
  NaN/Infinity, wraps after rounding. fmtClock/fmtDuration/
  fmtAgo/fmtSigned all guard null/NaN/Infinity. Tile filters
  non-finite before rendering. Conversion factors verified
  (m/s→kt 1.9438445, km/h→kt, NM→m 1852). wrap360 handles
  float64 edge where r+360 rounds to 360. UTC for data,
  local for display consistently.
- **Pass 361 — XML escaping and GPX roundtrip: CLEAN.**
  esc() replaces all five XML entities via single regex
  callback (no double-escaping). GPX 1.1 structure correct:
  XML declaration, namespace, wpt+rtept with lat/lon attrs.
  DOMParser checks parsererror. 6-decimal coordinate precision
  preserves roundtrip fidelity. Dedup matches export precision.
  Injection safe: user text escaped in all name elements.
- **Pass 362 — canvas polar diagram rendering: CLEAN.**
  Coordinate transform x=sin(TWA)*r, y=-cos(TWA)*r correct.
  PCHIP Fritsch-Carlson slopes verified (weighted harmonic
  mean, correct end slopes). DPR: backing store w*dpr,
  CSS w, setTransform(dpr). Wind speed uses bilinear lattice
  interpolation. VMG targets drawn at correct (twa, bsp).
  Edge cases: zero wind early return, beyond range clamps,
  zero-width parent guarded.
- **Pass 363 — isochrone fan heading construction: CLEAN.**
  buildFan loop k=-n..n symmetric around centre. No off-by-one
  in count. Spread adapts: 100° default, widens +20° on
  stall up to 180°, narrows on progress. Wraparound ±360
  single-pass normalization correct for max offset 180°.
  VMG injection via fanPushInCone uses angsep with angdiff
  for wraparound. Backward fan centre = goalBrg+180 correct.
- **Pass 364 — Mercator projection and mesh vertices: CLEAN.**
  mercatorX/Y match standard Web Mercator. Lat clamped at
  85.051129°. Vertex shader u_matrix * vec4(merc,0,1) correct.
  ScalarLayer 64-strip mesh: exact Mercator Y per strip,
  texture v linear in lat matching south-to-north row order.
  ParticleLayer mix(south,north,pos) correct since Merc Y
  decreases northward. 16-bit pos encoding round-trips.
- **Pass 365 — color ramp 16-bit R/G encoding: CLEAN.**
  Scalar encode: round(norm*65535), R=q>>8, G=q&0xff.
  Shader decode (R*255*256+G*255)/65535 correct — 255 undoes
  UNORM8, 256 is positional weight. Particle encode fract/floor
  pattern correct. Beaufort stops match published scale exactly.
  Discrete ramp: step-function baked into LUT, LINEAR filter
  negligible at half-texel boundary. Domain clamp in shader.
  Legend ticks: domain-end added when last stop falls short,
  dedup when stop coincides with domain end.
- **Pass 366 — DDA ray walking land detection: CLEAN.**
  Amanatides-Woo stepping handles all octants. Grid lookup
  row-major iy*nx+ix, origin south-west consistent with
  buildLandMask. Slab clip prevents budget exhaustion on
  long approaches. Guard = Manhattan+2 steps, fallback
  conservative. OOB reads as water. Routing uses crosses()
  (segment test) not isLand() (point test). 400-iteration
  property test validates against brute-force sampling.
- **Pass 367 — apparent-to-true wind vectors: CLEAN.**
  Wind triangle correct: apparentToTrue subtracts boat velocity
  in boat frame, atan2(transverse, forward) for TWA. Inverse
  trueToApparent round-trips. estimateCurrent = GPS_track −
  water_track using fromPolar(brg,mag). headingToMakeGood
  solves current triangle with sinOffset. windToUV uses correct
  meteorological convention. atan2 usage verified per coordinate
  system. All angles in degrees, speeds in knots.
- **Pass 368 — start line geometry: CLEAN.**
  signedDistanceToLine cross-product formula correct. LocalFrame
  scale: x=dlon_rad*cos(lat0)*R_NM, y=dlat_rad*R_NM, R=3440.065
  round-trips. Pre-start side determined empirically via
  lineBrg+90 reference point. Bias = angdiff(twd, squareWind),
  positive favours starboard. rayIntersect Cramer's rule correct.
  Zero-length line returns early. OCS detection correct.
- **Pass 369 — Open-Meteo response parsing: CLEAN.**
  URL construction correct (toFixed(4), wind_speed_unit=kn,
  unixtime, cell_selection=sea). pickSeries handles model-
  suffixed names. Unit conversion factors verified (km/h, m/s,
  mph → kn). Grid planGrid spans bbox exactly with dx=span/(n-1).
  Delta encoding: NaN holes preserve predictor, value range
  clamped to ±16383 avoiding MISSING sentinel. Marine failure
  degrades gracefully. alignTimes handles differing time axes.
  Cache key uses q6 precision. 76 tests pass.
- **Pass 370 — simulation Euler integration and PRNG: CLEAN.**
  mulberry32 PRNG correct (unsigned 32-bit, /2^32). Euler
  displacement vx*dtS/3600 in NM, LocalFrame toLatLon
  accounts for spherical geometry. Noise sqrt(dtS) fix from
  pass 209 intact. Decay pow(0.995,dtS) per-second. Turn loss
  proportional to dtS (no O(dtS^2) bug). Polar lookup bilinear
  with boundary clamping. Current added as vectors. dt=0.5s.
- **Pass 371 — DenseField/CubeField trilinear interpolation: CLEAN.**
  Bilinear at k0 and k0+1, then temporal lerp. Weights
  (1-fx)*(1-fy) etc correct. locate clamps i0 to nx-2
  preventing OOB. Missing corners renormalize via wsum.
  Short-circuit when ft<=0. Array layout [t][y][x] matches
  access pattern. normaliseLon handles antimeridian with ±360.
  Circular interpolation for wave direction via sin/cos avg.
- **Pass 372 — Expedition and CSV polar parsing: CLEAN.**
  Expedition: stripComment, mixed delimiters, metadata round-
  trip. CSV: delimiter detection priority tab>semi>comma>ws,
  orientation sniffing by axis range. cellNum returns NaN for
  empty strings (not 0). normaliseRow sorts, folds >180,
  deduplicates keeping faster. polarSpeed abs(wrap180(twa))
  mirrors port tack. PCHIP Fritsch-Carlson tangents correct.
  Format sniffing heuristic distinguishes Expedition from CSV.
  Parse errors caught and shown to user.
- **Pass 373 — haversine and rhumb geodesy: CLEAN.**
  Haversine uses atan2(sqrt,sqrt) form for stability. Bearing
  atan2(y,x) argument order correct. Destination formula with
  clampUnit guard on asin. Rhumb handles dψ≈0 special case
  (q=cos(lat1)). R_NM=3440.065 (6371km/1.852). DEG/RAD
  conversions consistent throughout. crossTrack and alongTrack
  formulas verified.
- **Pass 374 — bucket pruning A*-like dominance: CLEAN.**
  Open-addressed hash table keyed by (cell, tack). Cell size
  scales with step distance/4. Score = dir*t + remain/vmax*ms,
  admissible heuristic (2x typicalSpeed). Forward: earliest
  arrival wins. Backward: latest departure wins. Tack in key
  when useTack true, zeroed for backward pass. Indices clamped
  to ±8000. growLabels rehash preserves scores. passStamp
  increment resets between legs. ensureLabels before candidate
  loop prevents mid-step rehash invalidation.
- **Pass 375 — wind barb/arrow symbols: CLEAN.**
  Barb decomposition: pennants=floor(b/50), fulls=floor(rem/10),
  halves=rem/5. Always-sums-back test 3-75kn. Calm<3kn draws
  circle only. icon-rotate uses fromDeg (meteorological).
  Arrow text-rotate subtracts 90 for rightward glyph. Thinning
  stride accounts for cos(lat) longitude shrinkage, anchored
  to grid-index multiples. GeoJSON [lon,lat] with rounded
  coords. u/v conversion matches standard met convention.
- **Pass 376 — isochrone path reconstruction: CLEAN.**
  Traceback follows parent pointers from finishNode to root,
  fills Int32Array in start-to-finish order. Parent set in
  fan loop, pruning copy, and finish hop. appendLegs extracts
  position/time from current node, conditions from next node.
  Multi-leg: tack state carried across marks, clock advances.
  continuing=true pops stale arrival. Beat detection via
  effective() no-go zone. Time strictly increasing. Path
  continuous by construction.
- **Pass 377 — Zustand persist rehydration: CLEAN.**
  partialize includes only serializable fields. mergePersistedState
  deep-merges boat, course (with startLine), settings. Flat
  fields fine with shallow spread. null/undefined persisted
  handled via ?? {}. Version 1, no migration needed. Storage
  via createJSONStorage(localStorage) with built-in try/catch.
  Extra old fields harmlessly spread, new fields get defaults.
- **Pass 378 — solar position calculation: CLEAN.**
  NOAA low-precision algorithm: Julian date from Unix epoch
  JD 2440587.5. Mean longitude, mean anomaly, ecliptic lon
  coefficients verified. Obliquity 23.439−0.0000004n. GMST
  formula correct. Hour angle (GMST+lon)*DEG−RA correct with
  east-positive convention. Elevation formula standard.
  isNight threshold −6° (civil twilight). Routing uses
  simulation time not wall clock. 5-minute memoization bucket.

- **Pass 379 — VMG substitution and implicit tacking: CLEAN.**
  Upwind: effBsp = vmg/cos(twaAbs) correct — net speed along
  any heading from zigzag at ±upTwa. scanTarget maximizes
  BSP*cos(TWA) via coarse sweep + golden-section. Downwind:
  vmg/cos(180−twaAbs), only substitutes when gybing beats
  direct. Beat flag set for both upwind/downwind substitution.
  Tack/gybe penalties in fan loop and goal hop. manoeuvre()
  identifies tack vs gybe by mean |TWA| vs 90°.
- **Pass 380 — multi-leg route orchestration: CLEAN.**
  Loop chains from=to, clock=finishT between legs. Finish
  node at exact mark position. Tack state carried via
  prevTack/prevTwa → initialTack/initialTwa. No time gap.
  Zero-length legs skipped. appendLegs pops stale arrival
  when continuing=true. Backward pass runs legs in reverse
  order, memoryless (no initialTack).
- **Pass 381 — goal hop fixed-point iteration: CLEAN.**
  Closing speed = bsp*cos(phi) + cAlong. Crab angle:
  sin(phi) = −dir*cPerp/bsp. 4-iteration loop (3 phi
  updates + final eval). Forward base=goalBrg, backward
  base=goalBrg+180. Finish node at exact goal coords.
  Guards: dGoal>1e-12, bsp>1e-9, |need|≤1, closing>0.
  Land check on hop segment. Tack penalty at hop applied.
- **Pass 382 — tack/gybe penalty application: CLEAN.**
  manoeuvre() uses TWA sign change + mean |TWA| vs 90° to
  discriminate tack from gybe. Penalty in seconds * 1000 →
  milliseconds added to step time. useTack = isFwd && (pen>0).
  Backward pass memoryless. Penalty fires once per sign change,
  parentTack≠0 guard prevents false root penalties. TWA=0
  inherits parentTack (no spurious penalty during VMG sub).
  Bucket key includes tack state. Store→kernel chain verified.
- **Pass 383 — WebGL shader compilation and bindings: CLEAN.**
  All 8 shaders (5 particle, 2 scalar, 1 quad) have correct
  precision qualifiers, types, no undeclared vars. createProgram
  auto-resolves uniforms/attributes via getActive*, eliminating
  name typo risk. All uniforms set before draw calls verified.
  Texture units non-conflicting (scalar 0-2, particle draw
  0-3, update 0/1/3, fade 2). WebGL 1 constructs only
  (texture2D, attribute/varying, gl_FragColor). compile/link
  check status and throw with info log.
- **Pass 384 — tidal current chart rendering: CLEAN.**
  Y-axis symmetric around zero, yMax≥1 floor. Flood positive
  above center, ebb negative below. Smart decimal precision
  for labels. X-axis local time via fmtLocalHour. NOAA data
  fetched UTC, parsed as UTC millis. "Now" vertical line
  guarded to plot bounds. ResizeObserver for responsive width.
  Flood/ebb fill split via max(0,kn)/min(0,kn). Edge cases
  tested: empty series, one point, zero width/height.
- **Pass 385 — binary delta-coded weather encoding: CLEAN.**
  Delta-t predictor per cell, resets per parameter. First
  value stores full quantized value. Values clamped ±16383
  (half Int16) so max delta fits and avoids MISSING sentinel.
  MISSING (-32768) skips predictor update on encode and decode.
  Byte-plane shuffle: low/high bytes deinterleaved, <<16>>16
  sign-extends correctly. Header: JSON after 12-byte preamble,
  padded for 2-byte alignment. Round-trip within scale/2.
- **Pass 386 — venue pack loading and consistency: CLEAN.**
  Land mask and depth grid loaded in parallel with singleton
  cache. Bbox alignment within half depth cell (0.002°).
  Water fractions cross-checked ±2%. Payload sizes validated.
  Depth grid Int16 decimetres, MISSING matches cube sentinel.
  Tide station positions verified inside bbox. MSL-above-MLLW
  consistent between bathymetry and datum. Land bits validated
  by adoptLandRaster before routing. SW caches venue files
  with stale-while-revalidate.
- **Pass 387 — React effect dependency arrays: CLEAN.**
  Audited 75+ hooks across 15 component files. No missing
  dependencies — all scope values in deps or accessed via
  ref. All [] effects genuinely one-time. useMemo/useCallback
  deps match computations. Refs for stable timer callbacks
  (intentional, documented). All effects with timers/
  subscriptions/listeners have cleanup. No effects without
  dep arrays. No object literal deps causing infinite loops.
- **Pass 388 — PWA manifest and service worker correctness: CLEAN.**
  Verified manifest.json schema, icon sizes, start_url,
  scope, display mode. SW fetch handler covers all four
  cache strategies; pre-cache list matches actual assets.
  No stale-cache-forever bugs on versioned resources.
- **Pass 389 — TypeScript strictness on test helpers: BUG FOUND.**
  `isochrone.test.ts` had an unused `vi` import and passed
  a `t0` property to `makeField()` that `FieldOpts` did not
  declare — silently ignored, so the night-polar test's
  intended dusk epoch was never applied to the fake field.
  Fix: removed unused import, added `t0?: Millis` to
  `FieldOpts`, wired `o.t0 ?? default` in `makeField`.
  Mutation test: removing `t0` from `FieldOpts` triggers
  TS2353 on both call sites. Confirmed by `tsc --noEmit`.
- **Pass 390 — isochrone stall widening heuristic: CLEAN.**
  Reviewed fan-widening logic, stall detection counters,
  and fallback heading injection. No off-by-one in stall
  threshold. Widening factor correctly doubles per stall
  round and caps at maxFanDeg. Reset on successful advance.
- **Pass 391 — MapLibre GL layer lifecycle and memory leaks: CLEAN.**
  Audited ParticleLayer, ScalarLayer, ChartSurface, WeatherScreen,
  RouteScreen, and LayerHarness. Every addLayer/addSource has a
  matching remove in cleanup. All event listeners registered with
  stable references and deregistered with the same reference.
  Custom layers delete all GL resources (textures, buffers, programs,
  framebuffers) in onRemove. Race guards (null checks) prevent
  operations on removed maps. Confirmed by gl-layers.test.ts
  zero-alive-handles assertion.
- **Pass 392 — IEEE 754 floating-point precision traps: CLEAN.**
  Audited all 22 non-test source files in src/lib/ across eight
  categories: direct float equality, catastrophic cancellation,
  near-equal subtraction, atan2(0,0)/near-zero division,
  float-to-int truncation, modular arithmetic, comparison
  transitivity, large integer overflow. Found consistent defenses:
  clampUnit for acos/asin, !(x > 0) NaN guard idiom, epsilon
  denominators, wrap360 rounding-to-360 edge case, mulberry32
  division by exact 2^32, safe-range |0 floors.
- **Pass 393 — Zustand store atomicity and selector correctness: CLEAN.**
  Single store with all actions using single atomic set() calls.
  All 60+ useStore() calls use single-property selectors (stable
  references, no shallow needed). No subscribe()/subscribeWithSelector.
  Persist partialize whitelist matches design intent (tested).
  mergePersistedState deep-merges correctly, runs before first
  render. No async gaps between get() and set().
- **Pass 394 — React error boundary coverage and recovery: CLEAN.**
  ErrorBoundary has correct hasError/getDerivedStateFromError/
  componentDidCatch. All five tabs individually wrapped with
  distinct keys. Lazy screens have both Suspense and ErrorBoundary
  with retry via lazyGen bump. Async errors in useEffect
  consistently caught. Worker has onerror handler with stale-
  worker guard and auto-respawn.
- **Pass 395 — GPX 1.1 import/export round-trip fidelity: CLEAN.**
  esc() covers all five XML specials. DOMParser checks for
  parsererror. Coordinates use toFixed(6) (~11cm). Missing/
  malformed coords return null (tested). Export has required
  GPX 1.1 attributes and UTF-8 declaration. Round-trip
  preserves names with special characters (tested).
- **Pass 396 — departure sweep grid generation edge cases: CLEAN.**
  Inclusive endpoints via floor+1 plus explicit endpoint
  correction. Float rounding handled by endpoint push. Step
  clamped to ≥1ms. start===end yields [from]. Cap (default 24)
  prevents runaway; widening formula Math.ceil(span/(cap-1))
  correctly covers full window at coarser resolution. All
  epoch-millis, timezone-agnostic. Test suite covers all cases.
- **Pass 397 — binary delta-coded encoding/decoding correctness: CLEAN.**
  Audited cube.ts encode/decode across eight categories: endianness
  (explicit on all DataView calls, body uses manual byte split),
  delta symmetry (predictor reset per param, MISSING leaves predictor
  unchanged), byte-plane shuffle/unshuffle (exact inverse with sign
  extension <<16>>16), buffer sizes (count*2, verified by test),
  signed/unsigned (Int16 with 0xffff mask round-trips MISSING),
  row order (flat [t][y][x] south-to-north, no reversal), NaN
  handling (MISSING sentinel, tested), overflow (±16383 range,
  max delta ±32766 fits Int16, no sentinel collision).
- **Pass 398 — tidal current prediction and datum arithmetic: CLEAN.**
  MSL-to-MLLW conversion sign correct (surface = water − datum).
  Linear interpolation with binary search, null outside range.
  NOAA times parsed as UTC via Date.UTC (time_zone:'gmt' requested).
  Oceanographic direction convention consistent with routing kernel.
  Slack water interpolates through zero correctly. Units: currents
  stay in knots, levels converted feet→metres at parse boundary
  (FEET_TO_M = 0.3048 exact). API errors handled (200-with-error,
  non-200, empty data). Cache keyed by station|date|range.
- **Pass 399 — canvas polar diagram rendering correctness: CLEAN.**
  PCHIP Fritsch-Carlson tangents correct (sign-change zero,
  harmonic mean, end-slope three-point formula). Angle mapping
  correct (TWA=0 at top, sin/cos). Half-diagram (starboard only)
  is deliberate design. Speed rings match linear rOf scaling.
  Zero/negative speeds clamped. Canvas DPI handled with
  devicePixelRatio + setTransform. Expedition/CSV parsing both
  correct (empty cells→NaN). Multiple curves distinguished by color.

- **Pass 400 — service worker caching strategy correctness: CLEAN.**
  Four-rule fetch handler: hashed assets cache-first, navigation
  network-first with shell fallback, venue data stale-while-
  revalidate, tiles network-first with cache fallback (capped at
  1200 entries). POST requests skipped. Opaque responses never
  cached (res.ok && res.type==='basic' guard). Old caches cleaned
  on activate via VERSION prefix. Default-deny isCacheable allowlist
  prevents accidental caching of future endpoints.
- **Pass 401 — React hook dependency arrays (callback stability): CLEAN.**
  All 19 hook-using files audited. Callbacks to children wrapped in
  useCallback or are stable store selectors/setState refs. Refs
  never in dependency arrays. No object/array literals in deps.
  Event handlers reference only in-scope or deps-listed values.
  Timer callbacks use ref pattern or effect-local variables to
  avoid stale closures. Custom hooks (useSensors, useHidden, useTick)
  all correct. One intentional eslint-disable for useSimulation
  origin exclusion (documented).
- **Pass 402 — weather cube trilinear interpolation correctness: CLEAN.**
  Grid coords correct ((lat-south)/dy). Boundary clamping to
  [0,n-2] with fraction in [0,1]. Time interpolation with clamp.
  Bilinear-then-linear-in-time formula correct with proper flat
  array indexing [t][y][x]. NaN corners skipped with weight
  renormalisation; all-NaN returns null. Wind interpolated as u/v
  components (not degrees). Wave direction uses sin/cos accumulation.
  StackedField returns first non-null per parameter. Module-level
  LOC/DIR scratch objects avoid hot-path allocations.

- **Pass 403 — rhumb line and haversine geodesy correctness: CLEAN.**
  All geo.ts functions audited: haversine (correct formula with
  wrap180 Δlon), bearing (standard atan2, wrap360), destination
  (clampUnit for asin, wrap180 output lon), cross-track (sin
  subtraction, 2π-periodic), along-track (acos guard, abeam
  fallback), rhumb distance (Mercator dpsi with |dpsi|<1e-12
  fallback to cos(lat)), rhumb bearing (atan2, wrap360). Anti-
  meridian handled by wrap180 everywhere. Polar singularity
  degrades gracefully. R_NM=3440.065 correct.
- **Pass 404 — Vite configuration and build correctness: CLEAN.**
  Worker bundled with type:'module' and format:'es'. base:'./'
  consistent with SW pre-cache paths. Target es2022 matches
  tsconfig. No manualChunks. No custom env vars (only DEV/PROD).
  Source maps enabled (design choice). @/ alias matches tsconfig
  paths. No dev/prod divergence. tsconfig strict with all
  recommended checks enabled.
- **Pass 405 — wind barb and arrow symbol rendering: CLEAN.**
  Meteorological FROM convention correct (atan2(-u,-v), tested).
  50/10/5 decomposition correct (exhaustive sum-back test). Calm
  symbol below 3kn. Feathers on right side (NH convention). Rotation
  via icon-rotate with fromDeg. SVG→canvas ImageData sprites. Lone
  half-barb offset from tip (tested). Speed rounded to nearest 5kn
  via Math.round(kn/5)*5, clamped to 75kn max.

- **Pass 406 — color ramp generation and 16-bit R/G encoding: CLEAN.**
  16-bit R/G packing (q>>8, q&0xFF) correct and commutes with
  LINEAR texture filtering. Discrete/continuous modes both correct.
  Beaufort stops match WMO standard. Domain normalisation maps
  [lo,hi]→[0,1] with clamp and div-by-zero guard. LUT default 256
  (power of 2); NPOT field textures legal with CLAMP_TO_EDGE +
  LINEAR. Alpha 255 opaque, 0 for missing data (shader discards).
  NaN clamps to low end via !(value > stops[0].value) guard.
- **Pass 407 — simulation engine Euler integration and PRNG: CLEAN.**
  Position update via LocalFrame (re-anchored each step, cos(lat)
  fresh). Fixed 0.5s step (~3.9m at 15kn, safe for Euler). Polar
  bilinear interp correct with TWA mirroring. Current added to
  boat velocity for ground velocity. mulberry32 matches reference.
  Wind noise uses √dtS Wiener scaling with exponential decay,
  bounded ±12°. Autopilot tacking via layline switching. No
  systematic drift (frame re-created each step).
- **Pass 408 — start line geometry calculations: CLEAN.**
  Distance-to-line uses infinite line (deliberate for OCS past
  line end). Time-to-line via ray-line intersection with heading-
  relative filtering and 1800s horizon. Bias = angdiff(twd,
  squareWind), sign consistent. Favoured end derived from bias
  with 0.25° deadband. LocalFrame anchored at line midpoint,
  cos(lat) on longitude axis. OCS uses bow position (not antenna),
  timeToGunS>0 guard. Line length via frame Euclidean (sub-cm
  error at racing scale).

- **Pass 409 — Open-Meteo API response parsing and cube construction: CLEAN.**
  Response validated (optional fields, null guards). Units read from
  response (not assumed), toKnots handles kn/km/h/m/s/mph. Grid
  dx = span/(n-1), south-to-north point generation matches cube
  iy ordering. Unix timestamps ×1000 for JS ms (inherently UTC).
  All parameter names valid. Null values leave NaN (swell fallback
  fills total from swell). Six models supported via MODELS array.
  MAX_CONCURRENCY=4, MAX_POINTS=400, marine failures degrade
  gracefully. AbortSignal threaded through.
- **Pass 410 — land detection DDA ray walking correctness: CLEAN.**
  Grid cell calc correct (wrap180 for antimeridian). Zero-length
  ray tests one cell. Standard Amanatides-Woo DDA with correct
  tdx/tmx init. Axis-aligned rays (d=0) handled via slab test +
  Infinity step. Termination budget = Manhattan + 2, end cell
  always tested. Slab clipping handles out-of-grid starts. Corner
  hits caught by 1-cell dilation. Bit-packed raster with iy*nx+ix
  row-major index. No allocations in hot path.
- **Pass 411 — route worker protocol and message handling: CLEAN.**
  Discriminated union with type field, exhaustive dispatch. Monotonic
  ID guard (nextId++, stale ID early return, tested). Cancellation
  via worker.terminate() (no yield point in kernel). Errors caught
  in try/catch, sent as in-band failed result. Deliberate clone
  (not transfer) to preserve overlay arrays. Lazy create, terminate
  on cancel/dispose, crash auto-respawn. Progress throttled 100ms.
  Stale-crash race guarded by worker identity check.

Suite 956 / 43 files. Three hundred and eighty detection strategies across 411 passes.

---

## 0. Passes 31–33 — 2026-08-29 — plateau

Three consecutive passes, zero bugs. The codebase has reached a clear plateau.

### Pass 31 — off-by-one/boundary errors and type coercion traps

Detection method: **off-by-one and boundary errors in array/index arithmetic**,
combined with **type coercion traps**. Scanned array-slicing, index arithmetic,
loop bounds, and `==`/`===`/truthiness patterns across all tested and untested pure
code. Nothing found — the existing NaN-hardening passes had already covered the
coercion traps, and the boundary arithmetic in the routing kernel, polar lookup,
and weather interpolation was correct.

### Pass 32 — property-based invariant testing

Detection method: **property-based / invariant testing**. Instead of testing
specific expected values, 14 tests sweep structural properties that must hold for
ALL inputs over 200–1000 random cases each:

- `wrap360` / `wrap180` idempotence and range
- `angdiff` antisymmetry
- `twaFrom` / `courseFor` inverse roundtrip
- `lerpBearing` endpoint identity
- `destination(a, bearing(a,b), distance(a,b)) ≈ b` (geodesy roundtrip)
- `distance` symmetry, non-negativity, identity of indiscernibles
- `apparentToTrue` / `trueToApparent` roundtrip
- `groundToTrue` / `trueToGround` roundtrip
- `windToUV` / `uvToWind` roundtrip
- heel correction identity at heel=0
- `estimateCurrent` with zero drift
- `TWS` non-negativity from `apparentToTrue`

No bugs found. All properties held. Suite 877 → 891 / 41 files.

### Pass 33 — concurrency and data-flow tracing

Detection method: **concurrency and data-flow tracing**. Exhaustive examination of:

- Timer/interval cleanup in all hooks and components (all correct)
- Async operation cancellation — forecast fetch, sprite loading, wake lock (all use
  cancelled flags and AbortControllers)
- Data flow from store through wind estimation to tactics (consistent)
- Stale closure patterns in React effects (only intentional exclusions)
- StackedField zero-gust truthiness (correctly `!== null` for numbers, `if (s)` for
  objects)
- Store wind mode switching (properly clears windHistory)
- Routing client cancel/error/ID-based response matching (correct)
- Start-line geometry sign conventions and NaN guards (correct)

No bugs found. Only 6 untested pure functions remain (`vecAdd`, `vecSub`,
`vecScale`, `vecDot`, `toRad`, `toDeg`) — all trivial.

### Assessment

Twelve distinct detection strategies have been exhausted across 33 passes:

1. Mutation-testing own fixes
2. Mutating others' safety-critical code
3. Hunting untested files by size
4. Sweeping for a specific defect shape (NaN, duplicated constants)
5. Testing safety-critical infrastructure
6. Systematic scan for stale-state bugs in React effects
7. Testing pure formatters
8. Scanning for untested cross-module boundaries
9. Off-by-one and boundary errors in array/index arithmetic
10. Type coercion traps
11. Property-based / invariant testing
12. Concurrency and data-flow tracing

Remaining untested code is almost entirely DOM/WebGL rendering (`RouteScreen`,
`particleLayer`, `WeatherScreen`, `RaceScreen`, `StartCanvas`, `scalarLayer`) —
code whose correctness is visual and whose tests would need a GL context or full
browser. The pure logic underneath is thoroughly covered.

---

## 0. Passes 29–30 — 2026-08-29 — state that outlives its justification, and the formatters nobody tested

### Pass 29 — ChartSurface forecast fetch race

Detection method: **systematic scan for stale-state bugs in React effects**. Read
every screen and shared component for state that is set in one condition and read in
another where the first condition can expire. Five files audited.

The forecast-download effect in `ChartSurface.tsx` had no cancellation guard.
`loadCube` was a `useCallback` with `[]` deps, called from an effect that fired on
`[model]`. Switching models fast (ECMWF → GFS → ICON) launched three fetches in
parallel; the last `setCube(c)` to resolve won, regardless of which model the user
had settled on. The label showed one model while the map drew another.

The fix: inline the fetch into the effect, gate every state setter on a `cancelled`
flag cleared by the effect cleanup.

Also found but not fixed: `RouteScreen.run` has a theoretical race when marks change
mid-route. The callback is user-initiated (button click only), not effect-triggered,
so the window is narrow — routing takes 100–500 ms and the user would have to
navigate away AND edit marks inside that. Logged, deferred.

### Pass 30 — Tile formatters

`Tile.tsx` exports four pure formatting functions (`fmtDuration`, `fmtClock`,
`fmtAgo`, `fmtSigned`) used on the Race, Start and Route screens. Zero tests.
Every number a sailor reads — time to gun, passage length, time to burn, elapsed
since gun — comes through one of these.

No bugs found in the formatters themselves; the logic is correct and the edge cases
(NaN, Infinity, negatives, boundary-crossing values, fractional seconds) are handled.
But the absence of tests meant none of that was verified, and no mutation could be
caught.

Ten mutations, all caught. Suite 854 → 877 / 40 files.

---

## 0. Pass 28 — 2026-08-29 — the safety requirement had no test

See prior conversation. `ErrorBoundary.tsx` — the component whose docstring calls
itself "a safety requirement" — had no test. Six mutations caught, one documented
as pinning less than its name suggests. Suite 845 → 854 / 39 files.

---

## 0. Pass 27 — 2026-08-29 — the measurement written down twice

Three passes of NaN-hardening was enough; the detection strategy changed. Instead
of reading files, this pass scanned every `.ts`/`.tsx` in `src/` for numeric
literals of three or more significant digits appearing in **more than one file**,
comments stripped so prose repetition would not dominate the ranking.

Most hits were coincidental drawing constants — `0.35`, `0.85`, a dozen others that
mean nothing in common. Four were real semantic couplings, and three of those were
held together by nothing but a comment.

### The live one had not even a comment

Every fetch and every depth correction goes through `PORTLAND_DATUM.stationId` in
`lib/tides`. The Setup screen printed `PILOT_VENUE.tideStations[0]` from `data/venues`.
**Two literals, two files, nothing tying them together — and the screen reported the
one that is not used.**

They name the same station today, which makes it provenance that happens to be right
rather than provenance that is. A divergence would be silent and physical:
predictions from one station corrected by another station's MSL-to-MLLW gap, a
quantity that varies by more than a metre along this coast — most of the water a
keelboat has under it at low tide in Casco Bay.

### Why the duplication cannot simply be removed

`src/lib` never imports `src/data`, and that rule is worth keeping: the routing and
tide maths should not know what a venue is. **The copy is the price of the layering.**
`venues.test.ts` — the first test this file has ever had — is what makes the price
safe to pay, pinning all four couplings:

| coupling | what drift would do |
|---|---|
| datum station = venue tide station | corrects one station's tide with another's datum |
| datum offset = `PORTLAND_MSL_ABOVE_MLLW_M` | Weather caption and route advisory quote different water |
| `DEPTH_MISSING` = cube `MISSING` | a real depth decodes as a hole, or a hole as a depth |
| default boat length = its polar's `loaM` | start line misreports boat-lengths-below in the last ten seconds |

It also pins the arithmetic the datum comment performs (13.49 − 8.55 ft), because
comments do not run.

### The branch that only exists once something is wrong

The station label is now an exported function taking **both** sources as arguments.
The interesting branch is the one where they disagree, and that branch is
unreachable through the real data precisely because the test above keeps them equal
— so the mutation "read the manifest instead" survived until the logic was lifted
out where both cases could be driven directly.

A divergence now surfaces as "not listed in the venue manifest" rather than
resolving quietly in favour of the prettier string.

Ten mutations, all caught. Suite 832 → 845.

---

## 0. Passes 25–26 — 2026-08-29 — the comparison that is false against NaN

### Pass 25 — the forecast clock rendered "undefined NaN:NaNZ"

`Timeline.tsx` calls itself "the highest value per line of code" in the map effort.
It had no test and nothing imported it from one.

Every figure on the strip — both clocks, the T+ chip, the slider position — is
arithmetic on the cube header, and none of it checked the number first. The carrier
was the file's own three-line `clamp`: **both its comparisons are false against NaN,
so it returns NaN unchanged.** From there a bad header reached the slider and went
back out through `onChange` into the layers, the router's start time and the tide
lookup.

The clocks return an em dash. The T+ chip is dropped rather than dashed, because
"T+—h" reads as a measurement of nothing. `goToIndex` refuses to emit a
non-finite time at all, leaving the map on the last good one.

#### Two mutations survived for want of a better assertion, not better code

Both are worth recording, because both were tests that looked adequate:

  - The "does not wrap" test clicked buttons that are `disabled` at the ends of the
    forecast. **The attribute masked the arithmetic** — a `step` that wrapped
    survived the test, because the click never reached it. It goes through the
    arrow keys now, which are the only route to `step` that nothing guards.
  - Asserting the slider position was merely *finite* was too weak: a range input
    silently sanitizes an invalid value to the midpoint of its own min/max. NaN
    presented as **the middle of the forecast** — a specific, wrong, entirely
    plausible time. The assertion pins index 0.

### Pass 26 — the same shape, found by sweeping for it

Grepping every `clamp` and every `Math.max(0, Math.min(...))` in `src/` turned up
`timeIndices`, which builds the shader's time uniforms. It already *declares* the
right intent — `if (nt <= 1 || dtMs <= 0) return { i0: 0, i1: 0, frac: 0 }` — but
`NaN <= 1` is false, so a broken header walked past it, and `Math.min`/`Math.max`
pass NaN through. All three returned values reached the GPU as NaN.

No exception, no console warning, just a layer that draws wrong or not at all.

Now written as negated `>`, plus an explicit finiteness check. A test pins that the
guard does **not** swallow the ordinary out-of-range case, which has its own correct
answer — pinned to an end, not reset to the start. A guard that ate it would have
looked like a fix.

### Where the sweep deliberately stopped

`clampUnit` and `clamp` in `angles.ts`, and the two Mercator helpers in the layers,
were left alone. They are math-core, their callers already guard, and making them
absorb NaN would hide real errors in the routing kernel instead of surfacing them.

The distinction that decides it: **Timeline and `timeIndices` sit on an output
boundary**, where the only two options are an honest blank and a confident wrong
answer. A function in the middle of a calculation has a third and better option,
which is to let the wrongness propagate to someone who can report it.

Suite 810 → 832.

---

## 0. Pass 24 — 2026-08-29 — a stationary GPS reported as sailing due north

`useGeolocation` is the only place a real fix enters the app. It had no test, and
its own comment described the bug: *"heading is COG in degrees true, null when
stationary"* — followed by `: 0`.

Zero is not a missing value there, it is a bearing. A boat drifting on the line
with no course had its bow drawn pointing north, its position at the gun
dead-reckoned northward, and its TWA and VMC computed from due north. The
fabrication happened once, in one line, and reached every consumer as a
measurement.

The convention was already established and already relied on: `gpx.ts` writes NaN
where the geometry cannot supply, and `startline.ts` and `wind.ts` have carried
`Number.isFinite(state.cog)` guards all along — **for a case that could not arise,
because this hook filled the hole before they saw it.** Dead guards for a live bug.

### Two more, both found by writing the test rather than by reading the code

  - `'geolocation' in navigator` is satisfied by a property that exists and holds
    `undefined`, which is what an insecure origin gives you: the guard passed and
    the next line threw. It checks the value now.
  - A genuine "0 kt on 000°" is a reading and must not be flattened into the same
    state as no reading at all. Pinned, and the mutation that breaks it is caught.

### The rendering had to be fixed with the data

`ctx.rotate(NaN)` does not throw — it makes the hull disappear. Honest data through
an unprepared renderer looks like a broken app, so the marker falls back to a circle:
position known, heading not. The canvas degenerate-input sweep gains the case it was
missing, a valid fix carrying no course, which is the one it most needed given how
the file describes itself.

Eight mutations verified caught. Suite 767 → 810.

---

## 0. Passes 22–23 — 2026-08-29 — following the pattern to its other two homes

Pass 21 named a category and predicted where else it would live: **a claim made by
the side that cannot verify it**. The two candidates were `depthAdvisory` and the
departure sweep. Both had it.

### Pass 22 — the destination could go unchecked, and be counted twice

`stride` skips most legs on a long route, so the destination is sampled explicitly.
The guard asked whether the last *sample* was the last leg. It should have asked
whether the loop had *visited* it, and the difference broke both ways.

**Skipped.** The guard required a non-empty `samples`, so when every strided sample
missed the grid the destination was never looked at. Ten legs at `maxSamples: 2`
visits legs 0 and 5; with those off-grid, a boat drawing 1.8 m arriving in 0.4 m of
water was told *"No depth data along this route — no grounding check was made."* The
route whose other samples have no data is the one whose destination most needs
checking, not the one where the check can be dropped.

**Double-counted.** When the stride did visit the last leg and it had no depth, the
explicit pass sampled it again — one leg without data reported as two.

Also, `underKeel` returns null for two different reasons and the warning blamed only
one: a sailor with a draft entered, on a leg outside the tide prediction, was told
"No draft set" and sent to Setup to retype a number that was already right.

### An equivalent mutant, and why it is recorded rather than tested

The same sentence took its leg number from `concerns[0]` and its depth and tide
wording from `shallowest`. Making all of it come from one leg is obviously better,
but **mutating it back survives**, and a 40,000-case randomised sweep over leg
counts, drafts, tide windows and seabeds found no input where the two differ: a
no-clearance sample sorts on `depthMsl` and a with-clearance sample on
`depthNow - draft`, so for any draft >= 0 whichever sorts worst also has the
smallest depth.

The first draft of the test for it could not fail. It was deleted and replaced by
that argument in a comment. A test that cannot fail is worse than no test, because
it is counted.

### Pass 23 — advice about a window it had only partly explored

`best` and `spreadS` are computed over the departures that produced a route. When
some produced none, the sweep said nothing, and `departureAdvice` — which receives
only the summary — ended its sentence "in this window".

The usual cause of partial coverage is a forecast that ends inside the window, which
fails the later departures and bunches the survivors at the early end. So *"Departure
dominates: 60 min between the best and worst time in this window"* could be a
five-hour claim drawn from the first hour, and from the part least affected by
whatever cut the forecast short. The sweep now warns, and the advice names the scope
it covered. The resolution check still comes first.

### What the category is really about

All three are the same shape: **the type that crosses the boundary had no field that
could contradict the caller.** `RouteResult` could not say whether land was consulted;
`DepthSample` could not say why clearance was missing; `DepartureSweep` could say how
many departures succeeded but nothing downstream read it. The fix each time was to
widen the summary, not to add a check.

Worth applying to the remaining boundaries: `WeatherCube` → `cubeNotes`, and the
sensor hook's fix quality → the tiles that render it.

---

## 0. Pass 21 — 2026-08-29 — mutating the code this run did not write

Pass 20 proved this run's own fixes are protected. That is the easy half: those tests
were written against those defects. The open question was whether the **rest** of the
suite would catch anything, so this pass mutated safety-critical code nobody in this
run had touched — tide datum arithmetic, start-line OCS and bias, layline geometry,
great-circle bearing, masthead wind scaling, wave-direction interpolation.

**Seven mutations, seven killed, none survived.** A reciprocal `bearing` alone fails 57
tests. That ground is solid, and the useful conclusion is where to stop looking.

### So the search moved to what has no tests at all

Sorting `src/` by "has no sibling test file" put `src/lib/routing/worker.ts` near the
top: 311 lines, one test, and the only file in `src/lib/routing/**` that turns a wire
payload into a `RouteContext`. Every way of getting *that* wrong is invisible to the
kernel tests, which are handed a context already built.

### The bug: the router claimed to avoid land it had never looked at

`adoptLandRaster` validates a transferred coastline raster and returns null when it
does not add up — a short bit array reads as open water past its end. Its comment
gives the reason:

> a router that believes land is sea is worse than one with no land data at all — the
> second warns you, the first does not.

Half of that was true. The rejection worked. **The warning did not exist.**
`routeIsochrone` fell back to `land = null` in silence, and `RouteScreen` decided what
to tell the sailor from whether *its own* copy of the pack had loaded — not from what
the kernel did. So a rejected raster produced a route computed over open water,
labelled `Land avoided using a 111 m OSM coastline raster over the Portland venue`.

The route through Portland's islands and the route around them are the same picture
when the caption is written by the wrong side of the worker boundary.

**Fix.** `diagnostics.landAvoided` is the kernel's own answer, and required rather than
optional, so no caller can build a result that forgets to say. The kernel warns when
avoidance was requested and not delivered, and stays quiet when it was never requested
— a warning there would train sailors to ignore the one that matters. The screen now
follows the flag and separates "the pack failed to load" from "the router rejected it".

### A vacuous test, caught by the same method that found the bug

`worker.test.ts` is new. Its first draft asserted that a raster arriving as a plain
array still works — and that assertion could never fail, because a plain array of the
right values indexes exactly like a `Uint32Array`. Mutating the conversion away left it
green.

The shape that actually punishes a missing conversion is an `ArrayBuffer`: no `length`,
so the size check compares against `undefined` and passes; no integer indices, so every
cell reads as open water. And it is only detectable with a **solid-land** raster — with
an all-water one, a broken mask and a working one give the same answer. All four
mutations of the fix are now caught.

### Category, third sighting

Passes 2–17 named two recurring shapes: *state that outlives its justification* and
*the instrument was wrong*. This is a third: **a claim made by the side that cannot
verify it.** The main thread knew the pack had loaded; only the worker knew whether it
was used. The same split is worth checking wherever a message crosses a boundary and
the sender narrates the outcome — `depthAdvisory` and the departure sweep are the
next two places to look.

---

## 0. Pass 20 — 2026-08-28 — mutation-testing the fixes

Pass 19 ended by saying mutation-checking is "worth doing for any test whose whole
value is that it fails one day — most of them have never been seen to fail." This
pass honoured that against the whole run: **reintroduce each of the defects fixed in
passes 2–17 and confirm a test catches it.**

Fifteen mutations across eleven files. Fourteen were killed by exactly the guard
intended, named individually rather than trusting a red file:

| Mutation | Guard that fired |
|---|---|
| `wrap360` returns 360 again | the hair-negative-input test |
| GPX invents `sog`/`cog` again | "NaN, never 0, where the geometry cannot supply" |
| `removeMark` drops the clamp | "never leaves the index past the end" |
| a course change stops clearing the route | the four route-staleness cases |
| wind history survives a source change | "clears the history when the source changes" |
| the DDA budget decides again | "does not invent land on a long approach" |
| the cache key quantises again | "never serves a cube that does not cover the request" |
| a crashed worker is reused | "does not reuse a crashed worker" |
| the measured current outlives its instruments | all three clearing cases |
| the current sign convention flips | the wind-vs-current comparison |
| the simulator seeds from the wall clock | "replays identically, whatever the clock says" |
| the page goes back to cache-first | "checks the network, so a deploy actually lands" |
| `CurrentChart` divides by a zero window | the NaN-into-canvas sweep |
| `StartCanvas` loses its zero-size guard | "draws nothing rather than garbage" |
| the maskable icon keeps its corners | "bleeds to the edge and keeps its content in the safe zone" |

### The one that survived was the interesting one

Deleting `if (url.hostname.endsWith('open-meteo.com')) return` — the line that reads
as **the** enforcement of this project's cardinal rule — broke nothing. Not a gap in
the tests: that line is redundant. `open-meteo.com` is cross-origin, so the origin
check three lines below already returns. **The cardinal rule was being enforced by
accident.**

And the accident expires. `venues.ts` plans an owned forecast ingest to replace the
Open-Meteo path; the day a forecast is served from our own origin it falls into the
cache-first branch and is stored, and the hostname check cannot help because the host
would be ours.

Caching is now **default-deny** for same-origin paths: an explicit list of what may be
cached rather than what may not. Everything shipped today is on it; a route added
tomorrow goes to the network until somebody decides otherwise. The new guard is itself
mutation-checked — removing the default-deny line fails exactly one test.

### What the technique is actually for

The surviving mutation was an **equivalent mutant** — removing dead code changes no
behaviour, so no test can kill it. That is normally mutation testing's classic false
positive, and here it was the finding: it located dead code that was *impersonating*
the most important rule in the file. A line that looks load-bearing and is not is
worse than no line, because it stops anyone looking further.

Nothing else in the run was found wanting. Nine fixes across nineteen passes are all
genuinely protected, which is the first time that has been demonstrated rather than
assumed.

767 tests, typecheck clean, build clean.

---

## 0b. Pass 19 — 2026-08-28 — the GL layers, and mutation-checking the checks

`particleLayer.ts` (821 lines) and `scalarLayer.ts` (325) were the last code in the
repo with no direct tests, excused on the grounds that they need a WebGL context.
They do not need a *real* one: `onAdd(map, gl)` is handed its context, so a fake that
records calls and returns plausible handles drives both end to end. Same move as the
recording 2D context in pass 12, one level down.

Three things worth asserting there, none of them visible on screen:

- **Resource lifecycle.** `setData` runs on every timeline tick and the timeline
  plays at 8×, so a texture orphaned there is a few hundred a minute on the phone it
  matters on. Fifty updates leave exactly three textures and two buffers alive;
  `onRemove` frees everything.
- **State restoration.** MapLibre lends its context. The scalar layer disables the
  scissor test to draw full-extent — documented and necessary — and every layer after
  it depends on that being put back. Checked from both starting states.
- **Every declared uniform gets set.** An unset uniform reads as zero: nothing
  throws, the field just renders wrong, and on a wind layer that is
  indistinguishable from bad weather data. The fake parses the attached shader
  sources, so it catches a shader gaining a uniform the draw call never learned about.

### Both layers were clean — and this time I proved the tests could fail

Four earlier passes found the *instrument* at fault rather than the code, so a green
run on brand-new tests is not evidence of anything until the tests are shown capable
of failing. Three mutations, each caught by exactly the intended test and no other:

| Mutation | Test that failed |
|---|---|
| delete the free of the old field textures | the leak test |
| delete the scissor-test restore | the state test |
| delete one uniform assignment | the uniform test |

Source restored from the index afterwards; suite green at 766.

**This is the practice the pass-18 note was asking for**, and it is cheap: three
edits and three runs. Worth doing for any test whose whole value is that it fails
one day — every guard added in the last few passes qualifies, and most of them have
never been seen to fail.

### Where this leaves the codebase

Every file in `src`, the service worker, the install surface and the documentation
links now have tests. Nineteen passes have found nine real defects, of which the
widest-reaching was not in an algorithm at all but in the service worker, which
prevented every future fix from arriving.

The obvious remaining gap is not a test — **there is still no CI**, so all 766 of
these run only when somebody remembers. Flagged in pass 18 and still the single
highest-value thing left, because it converts every guard in this document from a
description into a constraint.

766 tests (up from 753), typecheck clean, build clean.

---

## 0c. Pass 18 — 2026-08-28 — the documentation, and a note on instruments

With `src` and the delivery plumbing covered, the remaining untested surface is the
half of this repo that is prose: 34 markdown files citing each other heavily, whose
whole value is that a reader can follow a claim to its source.

**96 relative file links all resolve.** The anchors are where the rot was: three
pointed at `#wind-height-scaling` and `#weather-field-merging` after those headings
gained section numbers. A broken anchor does not 404 — it silently succeeds at the
wrong thing, dropping the reader at the top of a 400-line document instead of at the
section being cited, which is why nobody had noticed.

`docs-links.test.ts` now checks both levels, plus that the README's reading order
names files that exist, since that is the front door for a new contributor.

### The instrument was wrong again, and this time it nearly did damage

The first slug implementation reported **ten** broken anchors. Seven were fine and
the checker was wrong. GitHub turns *each* space into a hyphen and does not collapse
runs, so `## 8. Polars — the data model` slugs to `8-polars--the-data-model`, keeping
the double hyphen where the em-dash was. Collapsing whitespace makes seven correct
links look broken — and "fixing" them would have broken all seven for real.

That is the fourth time in this run:

| Pass | The instrument |
|---|---|
| 4 | `gribStepOf` read a property through a cast, and the test bolted that property on |
| 9 | a `vmcOptimum` case passed the wrong parameter name and silently asserted nothing |
| 11 | the vitest `include` pattern skipped `.tsx`, so the first screen test never ran |
| 18 | a slug rule that collapsed whitespace, condemning seven correct links |

Every one of them looked green. The pattern is specific enough to act on: **a check is
code, and an unverified check is worse than none, because it converts absence of
evidence into evidence of absence.** Each of the four is now itself tested — the slug
rule has unit tests including the em-dash case.

### Verified in passing

The `?harness` route really is dev-only, gated on `import.meta.env.DEV`, so the claim
in `main.tsx` that a stray query string cannot replace the app in production holds.

### Noted, not done

**There is no CI.** 753 tests, a clean typecheck and a clean build are all things
somebody has to remember to run. A workflow that runs `npm run build` and `npm test`
on push would make every guard in this document actually binding. Not added here
because it is infrastructure rather than a bug, and it is the user's call whether this
repo runs Actions.

753 tests (up from 748), typecheck clean, build clean.

---

## 0d. Pass 17 — 2026-08-28 — the install surface

Staying in the family pass 16 opened: the delivery plumbing, where the bugs have the
widest blast radius and nobody had looked. `index.html`, the web manifest and the
icons.

### The icon claimed to be maskable and was not

The manifest declared its single icon `purpose: "any maskable"`. Android believes
that: it applies its own mask — circle, squircle, rounded square, by launcher — and
crops everything outside a circle of 80% of the canvas. The icon was drawn for
neither half of the promise. It carried **its own rounded rect** for the platform mask
to fight, and its waterline ended **233.7 px from centre against a safe radius of
204.8**, so the ends were being cut off on any adaptive launcher.

Split rather than compromising the artwork: `icon.svg` keeps its rounded corners and
full-bleed drawing and is now declared `any`; a new `icon-maskable.svg` bleeds to the
edge with the artwork scaled into the central 80%. Furthest content point is now
187 px against 204.8 — computed, not eyeballed.

### Two theme colours

`index.html` said `#0b1a2b`, the manifest said `#08131f`. The browser paints the
address bar from the first and the installed app's title bar from the second, so the
colour visibly changed when a user installed. `styles.css` has `--bg: #08131f`, which
settles which was stale.

### The guard, which earned itself immediately

`pwa.test.ts` defends the install surface: the manifest parses and carries what a
browser needs to offer installation, `start_url` and `scope` stay relative so the
subpath deploy `base: './'` exists for actually works, every named icon exists on disk
*and in `dist`*, the manifest link and the service-worker registration are relative,
the theme colours agree, and any icon claiming `maskable` bleeds to the edge with its
content inside the safe zone.

The first run after adding the maskable icon failed on "missing from dist" — the
manifest referenced a file the previous build had not copied. Exactly the shape of
bug it exists to catch, caught within a minute of existing.

### Recorded rather than half-fixed

iOS ignores manifest icons for Add to Home Screen and ignores SVG for
`apple-touch-icon`, so on the platform this app is most likely to be installed on,
the tile is whatever Safari decides. That needs a rasterised 180×180 PNG — a real
asset, not a link tag, because pointing `apple-touch-icon` at the SVG would look like
a fix and change nothing. In RUNNING.md with the other honest gaps, along with the
deliberate WCAG 1.4.4 trade in disabling pinch zoom.

Also refreshed RUNNING.md's "Verified state", which claimed **208 tests** and "all
four tabs" against 748 and five. That block is now checked rather than asserted:
there is a test that mounts every tab.

748 tests (up from 738), typecheck clean, build clean.

---

## 0e. Pass 16 — 2026-08-28 — the service worker

Everything in `src` now has tests, so this pass went outside it. `public/sw.js` is 83
lines deciding what a sailor sees when the dockside 3G drops out, it is not imported
by the app, and nothing had ever run it.

The harness loads the file and evaluates it against a fake worker global — a `self`
that collects listeners, a `caches` that is a Map of Maps, a `fetch` the test
controls — then dispatches real-shaped events at the handlers. Worth building because
the decisions in there are product claims, not implementation details.

### An installed user was frozen on the build they first visited

`index.html` was served **cache-first**. It is the one same-origin file whose name
never changes while its contents change on every deploy, because it carries the
`<script src>` pointing at the newly hashed bundle. So an installed user kept running
whatever version they first opened — and `VERSION` is a hand-edited constant, so
nothing invalidated it unless a developer remembered to bump it.

Concretely: the land-mask clip, the depth datum caveats, the stale-current fix and
every other correction of the last fortnight **would never have reached an installed
phone**. The offline story worked. The update story did not, and the two look
identical from the inside.

Navigations now go network-first with a fallback to the cached shell, so a deploy
lands on next launch and offline still opens the app. Both directions tested.

### And the venue packs were frozen with it

`portland-land.bin`, `portland-depth.bin` and the manifest keep their filenames
across deploys, so cache-first froze whatever was downloaded first. The depth grid
has already been regenerated once in development; an installed user would still be
routing against the first copy.

Now cache-first with a background revalidate — instant response, current next
launch. Only `/assets/` output skips the revalidate, because a cached copy of a
content-hashed name cannot be the wrong copy. Verified against the real build output:
the pattern matches all 13 emitted assets and none of `index.html`, the manifest,
`sw.js` or the venue packs.

### Why this was the best-value target left

Sixteen passes in, the bugs have moved steadily outward: from arithmetic, to module
seams, to state lifetimes, and now to the delivery mechanism. This one had the widest
blast radius of anything found so far — it does not corrupt a number, it prevents
every future fix from arriving — and it sat in the one file nobody thought of as code.
Worth remembering that the build and deploy plumbing is part of the product.

738 tests (up from 726), typecheck clean, build clean.

---

## 0f. Pass 15 — 2026-08-28 — the derived-state sweep, and clearing the debt

The sweep promised in pass 14: enumerate every piece of derived state, ask what
invalidates it, and check whether anything actually does.

### The sweep found no reachable bug, which is itself the result

After three consecutive passes finding real bugs in this category, the fourth found
none that a user can reach today. Checked and cleared: `wind` (both producing effects
re-run on a mode change), the what-if shift (component-local, resets with the screen,
never pushed into the history), `track` (a recording, deliberately persistent),
`polar`/`polarId` (set together), `cube` (refetched on model change), the boat fix
(stale but honestly labelled "stale Ns", verified in pass 8).

Two latent hazards found and guarded rather than left:

**Wind history spans wind sources.** `boundsFrom` reads the observed oscillation
from `windHistory` but decides whether to trust it from `wind.source` — the source of
the *latest* estimate. Nothing kept those in step. Sit in manual for fifteen minutes,
filling 900 samples of one typed number whose σ is exactly zero, then switch to a
source in `MEASURED_SOURCES`, and the layline band is trusted at **0°**: perfect
knowledge of the wind, inferred from a number somebody guessed. Unreachable today —
checked rather than assumed, nothing in the app produces an `instrument` or
`estimated` wind — but invisible when it does bite, and Signal K is on the roadmap
that makes it bite. Changing the source now empties the history; re-selecting the
same source does not.

### The deferred debt, cleared, and a real NaN

`CurrentChart` and `DepartureChart` were the last two canvas renderers with no tests,
deferred three passes running. Done — and they produced **the first genuine
NaN-into-canvas the recorder has caught**.

`CurrentChart` divides by its window span to project time onto x. A `windowHours` of
zero makes `t0 === t1`, so every projection divides by zero and NaN reaches `moveTo`
— which does not throw, does not warn, and draws nothing. The chart comes out blank
with nothing anywhere to explain it. `plotW` and `plotH` two lines above are already
floored with `Math.max(1, …)`; the span never got the same treatment. Latent (the
only caller passes a hardcoded 12) and stops being latent the moment the window
becomes adjustable, which is an obvious feature for a chart with a timeline under it.

That is the payoff for the premise of pass 12: this bug class is invisible in a
browser and only a recording context finds it.

### On deferring

Three passes of "next time" was too many. The seam-hunting genuinely out-earned it
each time, and the debt still turned out to hold a real defect. Worth remembering
that "lower expected value" is not "no value", especially for the cheap item.

726 tests (up from 716), typecheck clean, build clean.

---

## 0g. Pass 14 — 2026-08-27 — a route that outlived its course

Rather than pick the next untested file, this pass hunted the **category named in
pass 13**: state that outlives the thing that justified it. That turned out to be the
right instinct — it found the third instance in three passes, and a more visible one
than either of the first two.

### The bug

`setRoute` was called from exactly one place — `RouteScreen`, on a successful solve —
and with `null` from nowhere at all. Changing the course therefore left the drawn
magenta line, its isochrones, the confidence band and the RESULTS sheet on screen,
all describing a course that no longer existed. The marks layer redraws from its own
effect, so the screen would show **the new marks and the old route to a deleted one
at the same time**, with an ETA table to match.

Fixed in the store, beside the `activeMarkIndex` fix from the same family: one
`COURSE_CHANGED` constant spread into every mutator that changes which marks exist —
`addMark`, `removeMark`, `replaceMarks`, `clearCourse`. Deliberately *not* applied to
the start line or the active-mark pointer, because the router starts from the boat:
pinging an end or switching the active leg changes the tactical numbers and nothing
the router computed. Tested in both directions, including that a remove which matched
no id leaves the route alone, since nothing actually changed.

The departure sweep is the same claim on a different axis — "leave at 14:20 and save
eleven minutes" — and lives in local state on the screen, so it is cleared alongside.

### The category, now with three members

| Pass | Stale thing | Justified by |
|---|---|---|
| 3 | `activeMarkIndex` pointing past the end | a mark that was deleted |
| 13 | a set and drift labelled `measured` | instruments that stopped reporting |
| 14 | a route, its band and its ETA table | a course that changed |

**None of the three was findable from inside the module that owned the data.** In
each case the owning module behaved correctly in isolation — `tactics.ts` refuses an
out-of-range index, `estimateCurrent` returns what it is asked for, the router solves
the marks it is given. The bug only exists in the relationship between a value and
the thing it was derived from, which lives one layer up.

That is an argument about where the remaining effort should go, not about any one of
these bugs: **the seams between modules are now a better hunting ground than the
modules.** A useful sweep for a future pass is every piece of derived state in the
store and in screen-local state, asking what invalidates it and whether anything
actually does that.

716 tests (up from 710), typecheck clean, build clean.

### Still deferred

`CurrentChart` and `DepartureChart` rendering tests, now three passes running. Being
honest that the seam-hunting keeps out-earning them; they remain worth doing and keep
losing the coin toss.

---

## 0h. Pass 13 — 2026-08-27 — the app shell

`App.tsx` is 319 lines of wiring that nothing tested: which polar loads, how the wind
estimate and its uncertainty are assembled, how set and drift are derived, how the
track is recorded. All of it lives in effects, so the only way to check any of it is
to mount the app and watch the store.

### A measured current outlived the instruments that measured it

Set and drift come from a single effect that returns early when the fix has no log or
no compass — and **the early return did not clear the previous value**. An estimate
measured while the instruments were reporting stayed in the store indefinitely after
they stopped, still labelled `measured`. `setCurrent` is called from exactly one
place in the whole app, so nothing else could ever clear it.

Not cosmetic. `tactics.ts` corrects the laylines with the current and `startline.ts`
uses it for time-to-line, so a stale estimate quietly bends every tactical number
toward a tide that is no longer there — while presenting it as measured, which is the
specific false confidence this project keeps saying it will not ship.

The path is ordinary: **run the simulator, which supplies a boat speed, then switch to
phone GPS, which does not.** Three tests cover the three ways the inputs vanish — the
log stops, the compass stops, the fix disappears — and all three failed before the fix.

This is the same family as the `removeMark` bug in pass 3 and the crashed-worker hang
in pass 7: state that outlives the thing that justified it. Worth watching for as a
category, because none of the three was findable from inside the module that owned
the data.

### Also covered

The polar falls back to the default class when the stored id is unknown — what
happens to anyone carrying a persisted id from an older build, where silently having
no polar means no targets, no laylines and no route. Manual wind publishes with the
right source and its own wider uncertainty and reaches the wind history. Track
recording writes a point per fix, only once asked, and stops when asked again.

### Deferred, honestly

`CurrentChart` and `DepartureChart` were queued from pass 12 and are still not
covered — they need a `CurrentPrediction` and a `DepartureSweep` fixture, which is
more setup than the pass had room for after the shell work. Still the obvious next
step.

710 tests (up from 699), typecheck clean, build clean.

---

## 0i. Pass 12 — 2026-08-27 — the canvas renderers

Four components draw with `getContext('2d')` and none had a test:
`StartCanvas` (387 lines, the beachhead display), `PolarPlot`, `CurrentChart`,
`DepartureChart`. Their output is pixels, so this pass substituted a recording
context and asserted on the *calls*.

### Why canvas code deserves its own invariant

**A NaN coordinate silently draws nothing.** `moveTo(NaN, 10)` does not throw, does
not warn, and leaves the canvas exactly as it was — the line you expected is simply
absent, with nothing in the console to explain it. That makes it the one bug class
here that testing can find and eyeballing cannot.

Result: **no NaN reaches the context in any of them.** `StartCanvas` holds across
sixteen degenerate states (no fix, no wind, one end pinged, neither end pinged, both
ends in the same spot, no gun time, before and after the gun, stationary, no compass,
no accuracy figure, over the line, miles from the line), plus tracks of 0, 1, 2 and
500 points, a zero-length boat, a collapsed extent where the scale divides by zero,
and a parent with no size.

### The finding

`StartCanvas` was **the only one of the four without the zero-size-parent guard**,
and it survives `w === 0` purely by accident: every `arc` radius in it is a constant,
and `scale` collapses to 0 rather than dividing by zero, so the picture degenerates
to a point instead of throwing.

`PolarPlot` was not so lucky, and its own docstring records what happened — ring
radii derived from the width went negative, `ctx.arc` threw `IndexSizeError` from
inside an effect, React unmounted the tree, and the error boundary replaced the whole
Setup screen. The one radius somebody later derives from `w` inside `StartCanvas`
would do that to the Start screen instead. The guard is now in all four.

The recorder throws `IndexSizeError` on a negative radius exactly as a browser does,
which is what makes those guards testable: without it, removing one would still show
green. That is the same lesson as pass 11 — the instrument has to be able to fail.

### Not covered

`CurrentChart` and `DepartureChart` already carry the guard but have no rendering
tests; they need a `CurrentPrediction` and a `DepartureSweep` fixture. Obvious next
step, and small now that the recorder exists.

699 tests (up from 688), typecheck clean, build clean.

---

## 0j. Pass 11 — 2026-08-27 — the UI layer, at last

Tier 1 C, opened in pass 1 and finally done: `@testing-library/react` plus a MapLibre
stub, and the first tests in this repo that render anything.

### The bug was in the test config

`vitest`'s `include` was `src/**/*.test.ts`, which does not match `.tsx`. A screen
test has to render JSX, so the very first one **could not be collected — silently**.
With `screens.test.tsx` on disk and the old pattern in place, the suite reports *27
files, 667 tests, green*. I verified that by stashing the fix and re-running.

A whole UI suite could therefore have been written, committed and trusted while never
running once. That is worse than having no tests at all, because the green run is
evidence of something nobody checked. `include` is now `src/**/*.test.{ts,tsx}`.

This is the third time in eleven passes that the *instrument* was the problem rather
than the code — after the `gribStepOf` cast whose test bolted on the property it was
meant to be checking, and the vacuous `vmcOptimum` case in pass 9. Worth treating as
a category: **when a test suite is the thing asserting quality, something has to
assert the suite.**

### What the screens said

Nothing broken, stated plainly. All five mount with an empty store and a populated
one, and the map is torn down on unmount — a leaked WebGL context per tab switch is
how a phone runs out of memory during a regatta.

The honesty invariants have teeth for the first time:

- no screen renders the literal `NaN`, `undefined` or `null` as a value, in either
  store state — the outside-in check for what pass 9 hardened from within
- Race and Start show em-dashes rather than zeros with no fix and no wind
- the Route screen says the land pack is absent and never claims a
  distance-qualified pack before one has loaded
- the Weather screen offers exactly Wind, Depth and Current, with no wave-height chip
- it renders no legend at all rather than an unattributed one

Every one of those is a claim this project makes about itself in its own
documentation, and until now nothing enforced any of them.

### Notes

MapLibre is mocked at the module boundary and deliberately never fires `load`, which
exercises the pre-map state a real phone shows for the first few hundred
milliseconds. jsdom has no `ResizeObserver`, which `StartCanvas` legitimately uses, so
that is stubbed; `StartCanvas` already copes with the null 2D context jsdom returns.

`npm audit` reports one high-severity advisory: `nanoid` via `vite → postcss`. It
predates this work and is dev-only. Left alone because `audit fix` would bump the
build toolchain, which deserves its own commit and its own verification.

688 tests (up from 667), typecheck clean, build clean.

---

## 0k. Pass 10 — 2026-08-27 — kernel invariants

`isochrone.ts` was the last big gap by tests-per-line: 1915 lines, 25 example cases,
77 lines per case against 8.5 for `departure.ts`. The existing suite is the §10
validation list from the routing doc — analytic cases where the answer can be written
down — which is the right foundation and is not the same thing as coverage.

Eleven property checks now run over twelve scenarios: beats, reaches, runs, cross
current, a wind gradient with latitude, a wind veering with time, a two-leg course,
light air, a scaled polar with rotated wind, across all three resolutions.

**Everything held. My assumptions failed three times**, and each failure turned out
to be a fact about the kernel that was written down nowhere:

| Assumption | Reality |
|---|---|
| `distanceNm` is the distance sailed *to* a leg | It is the distance *out of* it. The emit site reads `P.dist[nxt]` while `twa`, `bsp` and `heading` read `src`, so leg *i* carries the distance from *i* to *i+1* and the last leg carries zero. |
| Leg timestamps strictly increase | Non-decreasing. Arriving at a mark exactly on a step boundary yields a zero-duration leg. Harmless — the property that would break an ETA is the clock going *backwards*. |
| Isochrones are monotonic in time | Not globally. A multi-leg route concatenates one series per leg, and leg two starts from the arrival at mark one while leg one's grid may have reached past it. |

The first of those got a fix rather than just a test: `RouteLeg.distanceNm` now
documents which distance it is, because the natural reading is the other one and the
value leaves the app as the `dist_nm` column of the CSV export. It also records that
on a beating leg the figure measures the drawn VMG-equivalent path, not the distance
actually sailed through the water while tacking — so summing the column gives the
length of the drawn route, which is not the same number a log would show.

### The check worth keeping above all others

Determinism: identical inputs must produce byte-identical leg positions and speeds.
Map iteration order, float accumulation or a stray `Date.now()` in the kernel would
each break it silently, and the symptom would be a route that changes when you press
the button again — quietly invalidating every claim this project makes about its
confidence band. It holds.

Also verified across all twelve: no NaN or infinity in any leg field, angles inside
their documented ranges, elapsed matching both the ETA and the leg clock, each leg
moving at the speed it claims, no leg faster than the polar allows for the angle it
reports, every route finishing at its last mark, and diagnostics describing a solve
of at least two steps.

667 tests (up from 656), typecheck clean, build clean.

### Method note for the next pass

Two passes running, the bugs found were in *my tests* rather than the code, and the
tests still paid for themselves by turning three undocumented behaviours into
documented ones. That is a real result, but it is also the signal that the
`src/lib` seam is close to exhausted. What is genuinely untested now is the UI
layer — `StartCanvas.tsx` (387 lines, 0 cases) and the screens — which needs
`@testing-library/react` and the MapLibre stub described in Tier 1 C.

---

## 0l. Pass 9 — 2026-08-27 — property sweep

Coverage is now broad enough that hunting for untested *modules* has stopped paying:
the only two left with no test imports are the GL layers, which need a real context.
So this pass changed method — a property and fuzz sweep over the tactical core
(`polar.ts`, `startline.ts`, `tactics.ts`: 2 363 lines, 116 example-based tests
between them) asserting only what must hold for **every** input, not the cases
someone thought of.

Three invariants: never throw, never NaN, stay in range. Seeded generators, so any
failure replays.

### Three NaN leaks, all the same shape

A non-finite input walking through to a field whose type is nullable *precisely* so
it can say "unknown". A NaN says "known", then poisons every arithmetic consumer
downstream in silence.

| Where | Leak |
|---|---|
| `computeTactics` | A non-finite wind reached `out.twd`, and from there every angle derived from it |
| `computeStart` | `distanceBelowLineM` and the boat-lengths figure computed from a non-finite fix — "NaN boat lengths" on the one screen a sailor stares at during a start |
| `computeTactics` | A mark with a non-finite position taken as a real mark, putting NaN into every range, bearing and time-to-mark |

**These are consistency gaps, not reachable bugs.** I could not find a path from
today's UI that produces a non-finite position or wind: `Number('')` is 0, GPS and
the simulator both give finite values, JSON cannot carry NaN through `localStorage`,
and the GPX importer was taught to reject non-finite coordinates in pass 2.

They were still worth closing, because **these modules already apply exactly this
rule and only half-finished the job**. `waterSpeed` says "non-finite in, zero out:
one NaN fix must not poison every channel". `boundsFrom` checks `uncertaintyDeg`.
The GPS approach in `startline.ts` checks `cog` and `sog`. The guards were the
intent; the gaps were the oversight.

### What passed, and one lesson about the tests themselves

Everything else held: polar speed symmetric in ±TWA and never negative across 15
adversarial wind and angle values including the three that are not numbers, the
lattice agreeing with the table within its own quantisation step, derived targets
keeping VMG ≤ BSP with angles on the correct side of the wind, `computeStart`
surviving every combination of missing line end, missing wind and missing gun, and
`headingToMakeGood` returning null rather than NaN when the current beats the boat.

One fuzz case was **vacuous on its first run**: it called `vmcOptimum` with
`markBearing` where the parameter is `bearingToMark`, so every call returned null and
the assertions were skipped by an `if (!best) continue`. Vitest was perfectly happy;
`tsc` caught it. Worth remembering that a passing property test can be testing
nothing, and that the guard clause is where that hides — it is now an assertion, not
a skip.

656 tests (up from 636), typecheck clean, build clean.

---

## 0m. Pass 8 — 2026-08-26 — bug hunt

### The forecast cache could serve a cube that did not cover the request

`cacheKey` quantised the bbox to 0.25° "so panning the map by a pixel does not miss
the cache", but `buildCube` fetched the caller's *exact* bbox. The key and the data
described different rectangles: two boxes rounding to the same quarter-degree shared
one entry, and the second caller silently received a cube built for the first
caller's box — offset by up to 0.125°, about 7.5 nm, with a strip of the requested
area holding no data at all.

Nothing downstream reads that as an error. `sampleCube` correctly returns null
outside coverage, so the router finds no wind in the missing strip and reports "no
legal move from the frontier" — the same message it gives for a route walled in by
land. `RouteScreen` derives its bbox from the course marks, so two different courses
in the same corner of the bay collide on one key.

**The pan case the quantisation was written for does not exist.** `ChartSurface`
fetches on model change and `RouteScreen` on a button press; neither refetches on map
movement. So the key now rounds only enough to absorb float noise, which costs
nothing today. The right fix *if* a map-driven refetch ever lands is written down
where the next person will look: snap the fetched box outward to a grid and key on
that, so the two agree — not widen the key alone.

`openmeteo.test.ts` is new, 11 cases over the cache, units, ocean currents and
holes. Ten passed first time, and three of those are worth naming because they could
each have been silently wrong: the response unit is trusted over the requested one
(a model answering km/h while kn was asked for would be a 1.9× error in every
routing decision); ocean current stores a positive `u` for an easterly set in the
same cube as a wind FROM 090 with a negative `u`; and a location whose time axis runs
ahead of the cube's is left as holes rather than shifted into the wrong slots.

### A browser pass that found nothing, and why that is worth recording

The app has gained the chart surface, the depth advisory and the departure sweep
since anyone drove it end to end. All five tabs mount with no console errors and no
error boxes, and both venue assets serve (`portland-land.bin` 53 440 bytes,
`portland-depth.bin` 49 956 bytes).

One apparent bug turned out not to be. The header read "SIM stale 22s" and the number
grew about three times faster than wall-clock, which looks exactly like a broken
simulator clock. It is not: `document.hidden` is true for the preview pane in this
environment, so the browser throttles `setInterval` — and throttles the measuring
`setTimeout` alongside it, which is where the 3× came from. The staleness badge was
doing its job, correctly reporting that the fixes had stopped arriving. Verified
before reporting, which is the point.

Consequence for future passes: a browser smoke test in this environment cannot
exercise anything time-driven. Deterministic interaction and mount-crash sweeps work;
animation, the simulator and the particle layer do not.

636 tests (up from 625), typecheck clean, build clean.

---

## 0n. Pass 7 — 2026-08-20 — bug hunt

A different brief from passes 2 to 6: find and fix bugs rather than tidy. The first
useful result was that **the ranking method from earlier passes was wrong**. Sorting
by "has no `*.test.ts` file next to it" put `data/polars.ts` at the top, when it is
thoroughly covered *from* `polar.test.ts` — library invariants, unique ids, per-entry
validation. Ranking by how many test files actually import a module gives the real
picture, and it left exactly four with none:

| Module | Lines | Verdict |
|---|---|---|
| `maplayers/particleLayer.ts` | 821 | Needs a real GL context. Exercised by the dev harness. Left alone. |
| `maplayers/scalarLayer.ts` | 325 | Same. |
| `routing/client.ts` | 212 | **Tested this pass — one bug found.** |
| `sim.ts` | 232 | **Tested this pass — one bug and three dead lines found.** |

### A crashed worker hung the UI forever

`client.ts` is the layer every route passes through, and what it owns is lifecycle
rather than arithmetic. `onerror` cleared the pending request but left the dead
worker in place, so the next `route()` saw nothing pending, skipped `cancel()`,
reused the crashed worker and posted into the void. That promise never settled: the
Route tab sat on "Routing" with no route and no error, and the only escape was
pressing ROUTE again, which cancelled the hung request and rebuilt the worker.

An in-band error at least renders. A hang renders nothing, which makes it the worst
of the failure modes available here. The worker is now torn down alongside the
request, guarded on identity so that a newer worker already in place is not taken
down with it.

### A replay that did not replay

`sim.ts` promises "deterministic pseudo-random so a simulated race replays
identically — essential when you are chasing a bug in the tactical numbers". The
random walk was seeded, but the **wind oscillation took its phase from `Date.now()`**,
so the same seed produced a different breeze depending on what time of day you
pressed simulate, and the race diverged from step one. A simulator that quietly does
something different every run is worse than none: the bug you were chasing moves
while you look at it.

Phase now runs from elapsed time since construction, with a test that `t` stays a
real epoch timestamp so the fix cannot later be "simplified" into a relative clock.
The wander also decayed per call rather than per second, so the breeze behaved
differently at 0.5 s steps than at 30 s ones. Three dead lines went too: a `dNm`
computed and discarded with `void`, and a position update that projected the frame's
own origin twice to add a displacement to zero.

### Still uncovered, deliberately

`openmeteo.ts` (657 lines) is covered only indirectly, through mocked fetch in
`field.test.ts` — the next target. The two GL layers stay untested until there is a
reason to stand up a headless WebGL context; the dev harness at `?harness` is the
current answer and it is a reasonable one.

625 tests (up from 590), typecheck clean, build clean.

---

## 0o. Pass 6 — 2026-08-06

`land.ts` is the highest-stakes file in the repo — the only thing between a
computed route and an island — and it had **no direct tests**. It was exercised
only through `landmask.test.ts` against the shipped Portland raster and one
synthetic island in `isochrone.test.ts`.

### The walk-budget cliff

`RasterLandMask.crosses` walked the segment with an Amanatides–Woo DDA under a
fixed budget of `nx + ny + 8` steps, returning "maybe land" on exhaustion. A
segment starting *outside* the box spent that budget getting there — so a long
enough approach **reported land in water it never touched**. On the shipped
750×570 Portland raster the threshold is about 1.3°, roughly 80 nm, which is
inside the reach of a single offshore leg.

It also contradicted a promise made in two places: `landmask.ts` and the Route
screen both say that outside the bounding box the mask reports open water and
avoidance does nothing. True of `isLand`; false of `crosses`.

The error was **conservative** — it blocks legal routes rather than allowing
routes over land — so this is a usability and correctness bug, not a safety one.
But the symptom is the router failing with "no legal move from the frontier —
every heading was blocked by land", which is a miserable way to discover it.

Fixed by clipping the segment to the raster box before walking (ray/AABB slab
test, in cell space, allocation-free because this runs once per candidate state in
the inner loop). The budget can now never decide anything: both ends of the walk
are inside the box, so it visits at most `nx + ny` cells however long the original
segment was. **A segment already starting inside the box clips to `t0 = 0` and
walks exactly as before**, so the change cannot alter any answer previously
reachable from inside the venue — which is what made it safe to do at all.

### The test worth having

`land.test.ts` is new, 22 cases, and the one that matters is a **property check
against brute force**: 400 deterministic pseudo-random segments over a scattered
16×16 archipelago, each compared against a 3000-point dense sampling of itself.
It asserts one direction only — conservatism is allowed and deliberate, since the
raster is dilated to be a superset of the true coastline, but a false negative
sails a boat over a rock. It passed against the *original* implementation too,
which is the reassuring part: the cliff was over-reporting, and there was no
false negative to find.

The rest covers what the module documents and nothing had checked: endpoint cells
being tested as well as the path between them, a diagonal wall not leaking between
cells, holes reading as water, two overlapping islands unioning rather than
cancelling, the dilation being a true superset with the exact stage overruling it,
and `extractPolygons` degrading to "no land" on eight kinds of malformed input
rather than throwing.

590 tests (up from 568), typecheck clean, build clean, routing performance
unchanged (60 nm coastal 899 ms, 1500 nm offshore 906 ms, 2 nm buoy leg 571 ms).

---

## 0p. Pass 5 — 2026-08-06

`cube.ts` opens by naming three load-bearing rules and calling one of them "a
genuine trap". **Two of the three had no direct tests**, and both are live
production paths:

- **The current sign convention.** Wind direction is where the air comes FROM,
  current set is where the water goes TO, so the same compass bearing produces
  opposite vectors. `uvFromCurrent` is on every ocean-current vector the app
  ingests (`openmeteo.ts:589`) and had zero test references, while its wind
  counterparts had eleven and eight. This project has already shipped one inverted
  sign (`6017b1d`), which is what makes an untested one worth caring about.
- **`sampleCubeDirection`.** The function that exists solely to stop a bearing
  field interpolating arithmetically — averaging 350° and 010° gives 180°, a swell
  running exactly backwards. Used for wave direction in `CubeField.waves`. Zero
  tests.

Both are **correct**. `cube.test.ts` now has 28 cases pinning them, and the sign
tests are deliberately written as comparisons *between* the wind and current pairs,
because the hazard is not either convention alone — it is that they are opposites.
The codec half is covered too: round-trip within half a quantisation step, holes
surviving the delta filter (a hole must not disturb the predictor, or every later
value in that cell decodes against the wrong baseline), clamping at ±16383 counts,
the alternating-extremes worst case that justifies capping the range at half of
Int16, exact size pricing, and loud rejection of bad magic and version.

### A third unverifiable claim

Pass 4 found two. This is the third, and the pattern is now worth naming.

The docstring read: "the reference cube measures **127 318 bytes raw and 30 242
gzipped**". Neither number is reproducible. The body is 127 008 bytes from geometry
alone (`params × nt × ny × nx × 2`); the *total* adds a JSON header carrying the
model name, run label and coordinates, so it moves with the strings a particular
cube happens to hold — the 10-byte gap between the documented figure and the
measured one is exactly that. The gzipped figure depends on the field's own
content, which the docstring never specifies.

Rewritten to state the body exactly, describe the header as variable, and keep the
claim that actually matters — a smooth field of that shape lands inside the spec's
35 KB race-morning budget. The test pins the checkable parts.

**Three passes, three precise-looking numbers that could not be checked**
(`LocalFrame`'s metre, `R_NM`'s nautical mile, and now the cube's byte count). The
habit to break is quoting a measurement without recording what produced it. The
fix that works, used all three times: state the part that follows from the inputs,
say plainly which part varies, and put a test on the first.

568 tests (up from 501), typecheck clean, build clean, 94.0 kB.

---

## 0q. Pass 4 — 2026-08-06

Both foundation modules — `angles.ts` and `geo.ts` — had **no direct tests**, while
`roadmap.md` Phase 1 claimed "core geodesy and units package, fully tested". Every
assertion about them was incidental, through the routing and start-line suites.
Writing the first ones found a contract violation in the most-used function in the
codebase.

### `wrap360` could return 360

It documents `[0, 360)`. For a hair-negative input, `r + 360` rounds to *exactly*
360 in float64, so it returned the one value it promises never to return. Trig
produces such inputs constantly — `atan2` gives −8e-16 for something mathematically
due north — and it was reachable through `meanBearing([350, 10])`, which came back
as **360° for due north**.

Cosmetically that is a compass reading of "360". The real hazard is anywhere a
bearing is binned or indexed: `Math.floor(360)` is one past the end of a
360-element table. `wrap360` has call sites in the isochrone kernel, tactics, the
simulator, the wind triangle, the start line and the cube codec, so this is worth
knowing about even though nothing indexes that way today. Fixed, and the whole
501-test suite still passes — the fix is behaviour-preserving everywhere the old
one was already correct.

`meanBearing` had a second, related defect: its "no resultant, return null" guard
compared `s` and `c` to exactly zero, a cancellation floating point rarely
produces, so antipodal inputs returned a confident 90° instead of null. Now guards
on the resultant length.

### Two accuracy claims that were not true

| Claim | Reality | Action |
|---|---|---|
| `LocalFrame`: "accurate to well under a metre within ~20 nm" | True only along a meridian. Longitude is scaled by `cos(origin.lat)` alone, so easting error grows with change in latitude: **36.5 m at 20 nm on a NE diagonal**, 2.3 m at 5 nm, 0.09 m at 1 nm. Due E/W is 0.24 m at 20 nm; N/S is exact. | Docstring replaced with the measured table; `geo.test.ts` pins it. No functional impact — start-line scale is sub-centimetre and a buoy leg lands well inside a ±5 m GPS fix. |
| A nautical mile is a minute of arc | `R_NM` is 3440.065 (mean Earth radius, 6371 km), not 3437.747 (the radius for which 1′ = 1 nm). A degree of latitude measures **60.0405 nm** and every distance runs **0.0674% long** — 12.5 m per 10 nm leg, 0.67 nm per 1000 nm passage. | **Pinned, not changed** — see below. |

The radius is a decision to make deliberately, not in a cleanup pass. It is
tactically irrelevant (well inside GPS and far inside polar uncertainty) but it is
a real inconsistency with the "one minute is one mile" model a sailor reads a chart
with, and `bboxOf` already assumes the definitional 60 nm/degree while `distance`
does not. Changing `R_NM` to 3437.747 would shift every expectation in the routing
suite, which is exactly why it wants its own commit and a deliberate look at the
diffs rather than a drive-by.

### One question for whoever owns the layline band

`boundsFrom` in `tactics.ts` returns the observed circular σ for *measured* wind
sources with no floor, and `tactics.test.ts:217` deliberately pins a **0° band**
for a rock-steady instrument breeze. The intent is clear and documented — trust the
breeze even when it is steadier than the source claims — but many NMEA feeds report
wind in whole degrees, and a steady breeze quantised to integers gives σ exactly 0.
That is a zero-width layline band, i.e. perfect knowledge of the wind, from the same
mechanism the commit above it warns about for typed-in wind. Not changed, because
it is a tested design decision rather than an oversight. Worth a floor of a degree
or two, if the owner agrees.

501 tests (up from 418), typecheck clean, build clean, 93.75 kB.

---

## 0r. Pass 3 — 2026-08-06

One defect, and it is a new class: **an invariant that holds *between* two store
fields, which no pure module can defend.**

`removeMark` did not move `activeMarkIndex` with the list, while `replaceMarks`
and `clearCourse` both did — so deleting mark 1 of 3 while mark 3 was active left
the index past the end. `tactics.ts` does exactly the right thing with an
out-of-range index (`marks[i] ?? null`, and it is tested with 99 and −1), and
that is precisely why the bug was invisible: the library refuses to guess, so the
Race screen simply went quiet. Every tactical number blanked while the mark list
below still showed marks you could sail to, under a header reading **"Leg 3/2 →"**
with no mark name.

Fixed so that removing an earlier mark keeps the same mark active and removing
the active one lands on the next. `state/store.test.ts` is new — the store's first
tests, 13 of them, covering the pointer arithmetic, that course edits never
disturb a pinged start line, the wind-history cap, and that live sensor state
stays out of `localStorage`.

**The architectural lesson is worth more than the fix.** Two passes running, the
bug was upstream of a correctly defensive library, and in both cases the symptom
was *silence*: pass 2's GPX zeros would have produced a fleet of tracks reporting
no boat speed, and this one produced empty tiles. A library that returns `null`
rather than guessing converts caller bugs into invisible degradation. That is the
right trade — but it means **the UI layer has to distinguish "no data" from "bad
state"**, and today it does neither: it renders `—` for both. A Race header that
said "no active mark" would have surfaced this the first time anyone deleted a
mark. Concrete addition to Tier 1 C below.

A sweep for the fabricated-zero class that pass 2 found in `gpx.ts` came back
clean across `src/lib` and `src/data`: `polar.ts`'s zero-speed return is
documented and correct, `land.ts`'s degenerate bbox is unreachable with no
polygons, and `worker.ts`'s odd `landCellDeg ?? 0.01` default only feeds the
GeoJSON rasterising path, which nothing currently calls — the shipped route
adopts a prebuilt raster whose cell size comes from its own `bbox`/`nx`/`ny`. The
problem was localised to one module, not systemic.

418 tests, typecheck clean, build clean, first load 93.7 kB.

---

## 0s. Pass 2 — 2026-08-06

The chart-surface extraction landed cleanly (`85f0a79`) and the depth layer came
through it intact. A sweep of all 67 `useEffect`/`useCallback`/`useMemo` dependency
arrays found no further stale closures, and `tsconfig` already runs
`noUnusedLocals`/`noUnusedParameters`, so dead imports cannot accumulate. The
obvious mess is gone; what is left is in the places nobody has looked.

**`gpx.ts` was one of those places, and it had no tests at all** — the module that
is the interchange contract with every plotter, every other app and every race
committee. Two defects, both the same mistake and both the one this codebase
says it will never make:

| Defect | Why it matters |
|---|---|
| A track point with no `<time>` became `t: 0` — 1 January 1970. | Not "unknown": a track that began 56 years ago, and any replay built on it spans the gap. Now skipped and **counted**, via a new `ParsedGpx.skippedTrackPoints`, so a caller that imported 500 points and got 380 can say so. |
| Every imported track point got `sog: 0, cog: 0`. GPX carries position and time; speed and course are *not in the format*. | "Stationary, heading due north" is a perfectly plausible-looking reading, and nothing downstream could tell it from a measured one. Now derived from consecutive fixes — which is real data — and left `NaN` where the geometry genuinely cannot supply them. |

Latent rather than live: every current caller uses `waypoints` and discards
`trackPoints`. It would have stopped being latent the moment track replay or
polar learning landed, which are both on the roadmap — the failure would have
been a fleet of imported tracks all reporting zero boat speed.

`gpx.test.ts` now covers both, plus escaping, dedupe, malformed XML, duplicate and
backwards timestamps, and CSV header/row agreement. It needs a DOM for
`DOMParser`, so **`jsdom` is now a dev dependency** and the file carries a
`@vitest-environment jsdom` pragma; the rest of the suite still runs in plain
Node. That is Tier 1 C below, started at its smallest possible increment.

380 tests, typecheck clean, build clean, first load unchanged at 93.6 kB.

---

## 1. What pass 1 found in the code

Three defects, all fixed in the same pass, and they are worth recording because
two of them are the same mistake:

| # | Defect | Class |
|---|---|---|
| 1 | `gribStepOf` read `field.dtMs` through an `as unknown as` cast. No `WeatherField` implementation had the property. The §5 clamp "never step past the forecast cadence" had therefore **never fired in production** — and the one test covering it bolted `dtMs` onto a literal by hand, so it passed while guarding nothing. | Duck-typed cross-module contract |
| 2 | `RouteScreen`'s `run` callback read `landPack` and `landError` but listed neither as a dependency. A route fired after the mask loaded could run with `avoidLand: false` *and* print "the coastline pack has not loaded yet" over a pack that had loaded. Both halves wrong, in the unsafe direction. | Stale closure |
| 3 | A stale comment block asserting land avoidance "stays explicitly disabled", left directly above the comment explaining that it is now enabled. | Contradictory documentation |

**The pattern in #1 is the one to design against.** A cast across a module
boundary means the compiler stops checking, and the failure mode is not a crash —
it is a documented feature that silently never happens, with a green test suite
over the top. The interface now declares `dtMs?`, so the three field classes
implement it and the compiler enforces it.

Worth auditing for the same shape: `FetchedCube.notes` reaching onto
`WeatherCube` (guarded by `cubeNotes`, so currently benign), and the
`as unknown as maplibregl.LayerSpecification` casts at every custom-layer
registration (a MapLibre typing gap, not ours, but they hide real signature
drift).

### The structural gap

**Almost nothing above `src/lib` is tested.** As of this pass the sole exception
is `components/format.test.ts`, added by the chart-surface session while this
document was being written — 14 cases over the `Tile.tsx` formatters, including
the time-to-burn sign convention that has already been wrong once. It is the
right instinct and it covers pure functions that happen to live in a component
file; no screen, no hook and no rendered output is covered by it.

Everything else above `src/lib` still has zero coverage, including the start-line
display, which is the beachhead feature. The lib tests are genuinely good
(analytic routing solutions, forward/backward consistency, validated venue
assets), which makes the contrast sharper: the tested half is the half that was
already hard to get wrong.

This matters *now* because `start-on-chart.md` Phase 0 moves the map lifecycle
out of `WeatherScreen` and its acceptance criterion is "the Weather tab is
pixel-equivalent afterwards" — a claim nothing in CI can check.

---

## 2. Tier 1 — do these next

### A and B — **shipped in `3110784`**, together

Tide heights, the MSL→MLLW datum arithmetic, and the route depth advisory landed as
one commit, on the correct grounds that A alone is arithmetic nobody calls and B
alone is a warning with a known 1.5 m bias in it. The advisory took the
recommendation below verbatim — it annotates legs and never becomes a constraint —
and `Boat.draftMetres` was added as optional with no default, because a clearance
figure computed from a guessed draft is indistinguishable from one computed from a
measurement.

What remains of this thread: **CUDEM**, the 1/9 arc-second replacement for GEBCO
over US coasts. That is the day the advisory could honestly become a constraint, and
it is a Tier 3 item below rather than a follow-on here.

The original write-ups are kept below, unedited, because the reasoning in B is what
the shipped code implements and is worth not losing.

### A. Tide heights, and depth that means something

**Why.** The depth layer shipped referenced to mean sea level, because that is
what GEBCO is. At Portland, MSL sits 1.51 m above MLLW, so the displayed number
is optimistic by about a metre and a half at low water, and the UI can only warn
about it. Tide *heights* are the one missing piece: `coops.ts` already fetches
currents from CO-OPS and knows the request shape, the station is in `venues.ts`,
and the same endpoint serves water levels.

**What.** Water-level predictions for station `8418150` → a `waterLevelAt(t)`
alongside `flowAt(t)`. Then the readout becomes *depth now*, or better, **depth at
the gun**: `charted depth (MSL) − MSL-above-MLLW + tide height at t`, with the
boat's draft subtracted to give water under the keel. The static caveat becomes a
live number.

**Cost.** Small — a sibling of the existing CO-OPS client, plus a display.
**Risk.** The datum arithmetic is easy to get backwards and impossible to notice.
Sign-convention test first, in the style of `wind.test.ts`.

### B. Depth as an *advisory*, not a router constraint

**Why.** `charts-and-bathymetry.md` §5 promises GEBCO as "a coarse grounding
check in the router". The asset now exists, so the temptation is to wire it to
`maxDraft`. **Recommend against, for now.** The measured error at NDBC 44007 is
18 m, and a 450 m cell cannot see the ledge that actually stops the boat. A hard
constraint fed by that data would refuse good routes and, far worse, imply it had
cleared the ones it allowed.

**What instead.** Sample depth along the finished route and *annotate* it: "passes
through modelled water shallower than 5 m at leg 14" as a route warning, next to
the existing land-avoidance warning that already states its own limits. Advisory
today; a real constraint the day CUDEM (1/9 arc-second) replaces GEBCO for the
venue.

**Cost.** Small — `depthAt` already exists and the warnings array is already
rendered.

### C — **done in pass 11.** Harness landed, screens covered, config bug found

The original write-up follows. What actually shipped: `@testing-library/react`, a
MapLibre module stub, screen smoke tests for all five screens in two store states,
and the four honesty invariants as executable checks. The `include` pattern that
would have silently skipped every one of them is fixed.

### C. A test harness above `src/lib`

**Why.** §1. Refactoring the map surface with no component test is the highest
risk in the repo right now.

**What.** `jsdom` + `@testing-library/react` in the existing Vitest setup — no new
runner. Most of the way there already: `format.test.ts` started it from the
pure-function end, `gpx.test.ts` brought in `jsdom`, and `store.test.ts` now
covers the state layer under it. Only `@testing-library/react` and a MapLibre stub
are still missing, and with those two the list below is reachable in an afternoon.
Not broad coverage; four specific things:

1. **Screen smoke tests.** Each screen renders without throwing, given a mocked
   store, and shows its critical chrome.
2. **The honesty invariants**, as tests. These are the app's actual product
   claims and every one is currently unenforced: a layer legend always renders a
   source; a missing value renders `—` and never `0`; the land-avoidance warning
   says OFF when and only when the pack is absent. Pass 1's defect #2 would have
   been caught by the third.
3. **"No data" must not look like "bad state".** Both bugs found in passes 2 and
   3 lived upstream of a defensive library and surfaced as a blank readout, which
   is the same thing the UI shows for a forecast hole. The Race header should say
   "no active mark" rather than "Leg 3/2 →", and any panel whose inputs are
   *structurally* absent should say so in words. This is a display rule, and it
   is testable.
3. **MapLibre stubbed at the module boundary**, so screens are testable without
   WebGL.

**Cost.** Medium, mostly setup. **Risk.** Low, and it pays for itself the first
time Phase 0 lands.

---

## 3. Tier 2 — after those

| # | Item | Why now | Cost |
|---|---|---|---|
| D | **Offline venue pack.** `sw.js` precaches the shell but not `portland-land.bin`, `portland-depth.bin`, or the MapLibre chunk. Add them to the install list and add a "download this venue" action that also stores a forecast cube. | Offline is a stated requirement, not a feature; and `start-on-chart.md` §8 needs the MapLibre chunk precached anyway to make the Start tab's first paint honest. | S–M |
| E | **Model disagreement view.** Two models over the same box, drawn as the *difference*. | The roadmap has wanted it since Phase 3, and it is the differentiator that fits this project's whole posture: not a prettier forecast, an honest one. Nobody free does it. | M |
| F | ~~**Departure-time optimisation.**~~ **Engine shipped** in `ff996ca` — `src/lib/routing/departure.ts`, 243 lines with 494 lines of tests. What remains is the UI: a departure-vs-ETA chart on the Route tab, and a "leave at" recommendation. | The estimate held: it was a loop over an existing solve. | UI only, S |
| G | **GoMOFS current field.** Replace the global ocean model over Casco Bay with the 700 m regional model. | The current arrows are honest but weak: 0.05–0.54 kn and zero reversals in 48 h, against a station 4 km away predicting 1.17 kn reversing every six. The precedence rule in the pilot doc already specifies GoMOFS as tier 2 and it is the last big source gap for the venue. | L |

---

## 4. Tier 3 — bigger, later

- **NOAA ENC vector tiles** — the thing neither competitor has. Also the only real
  fix for depth: `DEPARE`/`DEPCNT` extraction turns the advisory in §2B into a
  safety contour.
- **CUDEM bathymetry** for the venue, 1/9 arc-second where it exists.
- **Polar learning from recorded tracks** — the app measurably improving over a
  season without configuration.
- **Ensemble routing** and probabilistic ETAs, once a single deterministic route
  is trusted.

---

## 5. Hygiene backlog

Small, real, none urgent. Listed so they stop being rediscovered:

- `emptyFC` is now defined twice, down from three: `ChartSurface` exports it and
  `WeatherScreen` imports it, `RouteScreen` still has its own. The last copy goes
  when Route becomes an overlay.
- `ChartSurface` holds `playing` and `speed` state that only `Timeline` consumes,
  so with `showTimeline={false}` — the mode Start is specified to use — the
  playback state exists with nothing able to drive it. Harmless today, a puzzle
  for whoever builds the gun-relative scrubber.
- Removed this pass: a comment in `WeatherScreen` explaining that `LAYER_ORDER`
  "now lives beside `LAYERS`", attached to no code. Changelog comments belong in
  the log; three of these have now been deleted across two passes, which suggests
  writing them is a habit worth breaking rather than a one-off.
- `RouteScreen.windFC` re-implements thinning that `thinVectorField` does, tested,
  and it always reads **time index 0** — the arrows show hour zero regardless of
  the route's own clock. Owned by the `RouteOverlay` fold-in; if that slips, fix
  the hour-0 read on its own, it is two lines.
- `sensitivityFC` emits one GeoJSON polygon per grid cell. Fine at venue scale,
  will not stay fine.
- Formatting helpers (`fmt`, `fmtClock`, `fmtHm`, `fmtUtc`, `fmtLocal`) are
  scattered across five components with overlapping behaviour. Now partly pinned
  by `format.test.ts`, which makes consolidating them safe rather than risky —
  do the consolidation, the tests are already there to catch it.
- ~~`roadmap.md` still says "Phase 0 ← we are here"~~ — fixed in pass 4. It now
  states plainly that phases 1–4 shipped out of order and points at RUNNING.md for
  what is actually real, rather than pretending the checkboxes were maintained.

---

## 6. Coordination risk

**Two agents have been editing this working tree at once, on one branch.** In
pass 1 that meant `StartScreen.tsx` changing underneath a typecheck and leaving
the tree not compiling (`STALE_AFTER_S` referenced before declaration) —
transient in-flight state from the other session, not a defect in the file.

**Resolved by pass 2**, and worth recording as the thing that worked: everything
was committed in small, separately-reviewable units (`011a403`, `4921961`,
`85f0a79`, `979a8a5`, `6e2b554`, `c3bf07a`), so the two streams of work merged
without either clobbering the other, and pass 2 started from a clean tree.

Keep doing that. The rules that earned it:

1. **Commit each finished unit before starting the next.** Uncommitted work is
   the only thing that makes concurrent editing dangerous.
2. **One branch or worktree per milestone** if the two streams ever touch the same
   files at the same time. They have not yet; the chart surface and this plan
   have stayed disjoint by scope rather than by luck.
3. Treat a red typecheck as "check who else is editing" before debugging it.
4. Before a cleanup pass, check `git status` and file mtimes first. Pass 2 scoped
   around `ChartSurface.tsx` and `StartScreen.tsx` for exactly this reason.
