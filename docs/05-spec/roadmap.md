# Roadmap

Phases, not dates. Each phase ends with something a sailor can use.

---

## Phase 0 — Research and specification ← **we are here**

**Goal:** know what we're building and what we're allowed to build on, before writing app
code.

- [x] Reverse-engineer the Expedition feature set from the official manual
- [x] Catalogue its ~400 computed channels and infer the math behind them
- [x] Survey public data sources with licences and access patterns
- [x] Document the routing algorithms in implementable detail
- [x] Survey open-source and commercial prior art
- [x] Draft product and technical specs
- [ ] Resolve the ORC polar licensing question
- [ ] Pick a pilot venue and a pilot programme (a real coach, a real fleet)
- [ ] Prototype the isochrone router as a throwaway script against a real GRIB, to
      validate the performance assumptions before committing to the architecture

**Exit criterion:** we can explain, to a sailor, exactly what the app will do at each
tier — and to an engineer, exactly how the router works.

---

## Phase 1 — Start line MVP

See [mvp-scope.md](mvp-scope.md).

- Core geodesy and units package, fully tested
- Start-line math: bias, distance, time to line, time to burn
- Chartless start display
- PWA shell, offline, wake lock, track recording
- Ship to one junior programme and watch people use it

**Exit criterion:** sailors use it unprompted at a regatta, and tell someone else.

---

## Phase 2 — Tactical

- Polar engine: interpolation, derived targets, scalings
- Class-default polar library + parametric generation from boat dimensions
- Laylines with bounds, current correction, and rate-of-turn allowance
- **What-if?** wind and current sliders
- Target boat speed, target TWA, VMG, VMC and VMC-optimum
- Windward/leeward course builder, gates, gate spot
- Wind history and oscillation tracking
- Track replay and post-race debrief

**Exit criterion:** a club racer uses it for the whole race, not just the start.

---

## Phase 3 — Charts and weather

- MapLibre + PMTiles basemap, offline packs
- NOAA ENC display (service first, our own tiles later); OpenSeaMap elsewhere
- Weather ingest pipeline: GFS + ECMWF → compact cubes → CDN
- Client-side field decode and interpolation
- Wind, gust, pressure, wave overlays with time animation
- Model comparison view — show where two models disagree
- GEBCO bathymetry + OSM land polygons as data layers
- Venue download bundles

**Exit criterion:** the app is a credible free alternative to a paid weather app, offline.

---

## Phase 4 — Routing

- Isochrone kernel in a worker
- Obstacle avoidance (land raster + vector, exclusion zones, safety depth)
- Constraints: max TWS, gust, wave height, tack/gybe penalties
- Backward pass → **route confidence band** (the headline feature)
- Results table with per-leg wind, angle, speed, sail
- Departure-time optimisation
- Tides and currents in routing, with source precedence
- GPX/CSV export

**Exit criterion:** routes match qtVlm/OpenCPN within a few percent, and the confidence
band makes a beginner *less* likely to blindly follow a line.

---

## Phase 5 — Fleet, learning and instruments

- Opt-in position sharing with a crew or fleet
- Competitor tracking; `Ahead of` VMG-wise; fleet plotted against reverse isochrones
- **Polar learning from recorded tracks** (parametric prior + Bayesian update)
- Learned acceleration and rate-of-turn tables from recorded starts
- Coach dashboard and multi-boat debrief
- Signal K ingest
- AIS in coastal waters, clearly labelled, with CPA/TCPA
- Handicap corrected time

**Exit criterion:** the app is measurably better for a user after a season than it was on
day one, without them configuring anything.

---

## Phase 6 — Depth

Things worth doing once the foundation is real:

- Ensemble routing and probabilistic ETAs
- Multi-leg globally-optimal routing (carrying state sets through marks, not single
  arrivals)
- Sail-crossover charts driven by routing output
- Wave-corrected polars with a validated model
- Regional high-resolution model integration (HRRR, ICON-D2, AROME) by venue
- Race-organiser tools: publish courses, sailing instructions import, spectator tracking
- Native wrapper for background tracking

---

## Non-goals, restated

Proprietary instrument protocols · radar · encrypted charts · sail-shape analysis ·
ECDIS compliance · satcom management · America's Cup race management · settings parity
with Expedition.

---

## Guiding sequence

> **Start line → tactics → charts → weather → routing → learning.**

Every phase ships something usable. Every phase's users fund (in attention, feedback and
credibility) the next one. The interesting engineering comes *fourth*, on purpose.
