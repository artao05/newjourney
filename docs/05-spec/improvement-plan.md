# Improvement plan — everything except the chart surface

**Status:** backlog. The review loop that kept this plan ran 411 passes between
2026-08-05 and 2026-08-31 and has stopped. Its pass-by-pass record is in
[review-log.md](review-log.md).
**First written:** 2026-08-05
**Does not own:** the chart-surface milestone. `ChartSurface`, `StartOverlay`, the
Race fold-in and the retirement of `StartCanvas` all belong to
[start-on-chart.md](start-on-chart.md). Phase 0 of that plan has shipped and
Phases 1–6 have not started. Anything it claims is deliberately absent below,
referenced rather than restated.

This is a plan for the *rest* of the app: the data underneath the chart, the
router, and the parts of the codebase that have no safety net.

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
| D | **Offline venue pack.** `sw.js` now caches the venue packs and every built asset, the MapLibre chunk included, the first time each is fetched. It still precaches only the shell at install, so a venue or tab never opened online is missing offline. Add them to the install list, and add a "download this venue" action that also stores a forecast cube. If the pack ever carries basemap tiles, they cannot be prefetched from `tile.openstreetmap.org`, whose usage policy forbids bulk and offline downloading. An owned tile source is the route (see `start-on-chart.md` §8). | Offline is a stated requirement, not a feature; and `start-on-chart.md` §8 needs the MapLibre chunk precached anyway to make the Start tab's first paint honest. | S–M |
| E | **Model disagreement view.** Two models over the same box, drawn as the *difference*. | The roadmap has wanted it since Phase 3, and it is the differentiator that fits this project's whole posture: not a prettier forecast, an honest one. Nobody free does it. | M |
| F | ~~**Departure-time optimisation.**~~ **Shipped.** The engine landed in `ff996ca` (`src/lib/routing/departure.ts`, 243 lines with 494 lines of tests) and the UI in `db99af2`. WHEN on the Route tab runs the sweep, charts departure against ETA and offers ROUTE FROM the best departure. | The estimate held: it was a loop over an existing solve. | Done |
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
- `RouteScreen.windFC` re-implements thinning that `thinVectorField` does, tested.
  Owned by the `RouteOverlay` fold-in. ~~It always reads **time index 0**~~ — the
  fold-in slipped, so the hour-0 read was fixed on its own: the arrows now sample
  through `sampleCube` at the drawn route's departure, or now when there is no
  route, and draw nothing outside the forecast. Tested in `routeGeo.test.ts` and,
  wired through the screen, in `screens.test.tsx`.
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
