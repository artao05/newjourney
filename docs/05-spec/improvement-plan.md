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

## 0. Pass 7 — 2026-08-20 — bug hunt

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

## 0b. Pass 6 — 2026-08-06

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

## 0c. Pass 5 — 2026-08-06

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

## 0d. Pass 4 — 2026-08-06

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

## 0e. Pass 3 — 2026-08-06

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

## 0f. Pass 2 — 2026-08-06

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
