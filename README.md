# newjourney

**An open, phone-first weather routing and tactical navigation app for sailors.**

The goal: replace the €1,250, Windows-only, antenna-dependent, steep-learning-curve
tactical software stack (Expedition and its peers) with something a 16-year-old on a
420 or a first-time offshore navigator on a J/105 can open on a phone and understand
in five minutes — built entirely on public data.

> **Status: working prototype on `main`, with Portland & Casco Bay, Maine, as its pilot venue.**
> A running React PWA with the start-line tools, tactical numbers, an isochrone
> weather router with departure-time optimisation, and GPU wind, depth and current
> layers, alongside the research and specification work it was built from. See
> [RUNNING.md](RUNNING.md) to try it — including a boat simulator so you can use the
> whole app from a desk, with no GPS fix needed.
>
> **This copy is on `parity/expedition`,** a branch that also has ENC and BSB charts,
> Signal K, serial and bridge instruments, a harmonic tide engine and position-aware
> magnetic variation, none of which is on `main` or the deployed site. See
> [Branches](#branches).
>
> [![CI](https://github.com/artao05/newjourney/actions/workflows/ci.yml/badge.svg)](https://github.com/artao05/newjourney/actions/workflows/ci.yml)
> tests, typecheck and build on every push. First-load JS, gzipped, measured 2026-11-03:
> 100 KB on `main`, 215 KB on this branch.
> **Not for navigation** — see the caveats in [RUNNING.md](RUNNING.md#whats-real-and-what-isnt).
> Land avoidance works, but only inside the Portland venue box and only as a
> land check, never a depth check. On this branch, ENC cells you open add their own land,
> shallow water and dangers, inside those cells. The depth layer is a 450 m bathymetric model
> referenced to mean sea level, not a chart and not a routing input — it reads 18 m
> shallow at a NOAA buoy and 1.5 m deep against chart datum, and it says so. The
> bundled polars are generated from published dimensions rather than measured.

## Branches

**`main`** is the phone-first product and the research behind it. GitHub Pages serves it.

**`parity/expedition`**, this branch, aims at Expedition's full capabilities on the owner's
instruction ([docs/08-parity](docs/08-parity/README.md)), which reverses some of the
product spec's non-goals. It was cut from `main` at `5bad931` and was 172 commits ahead on
2026-11-03, when `main` had not moved since. It went to `origin` that day as a backup. It has
no pull request and no deploy, and whether it merges is the owner's call and still
[open](docs/06-decisions/README.md#open-only-the-owner-can-settle-these). Its parity score
that day was 36.5 %, from `node scripts/parity-score.ts`. Its loop last ran on 2026-09-30.

`main` held research and specification only until the prototype was promoted onto
it. The application code arrived from `feature/tide-depth`, which is where the
chart-surface, depth and hardening work was done before it merged in
[pull request #1](https://github.com/artao05/newjourney/pull/1). The Maine pilot work
followed from `mvp/maine-pilot` in
[pull request #2](https://github.com/artao05/newjourney/pull/2).

The older branches were deleted on 2026-09-27, once everything in them had reached
`main`. They were `MVP1` (an earlier snapshot of the prototype),
`feature/departure-window` and `feature/departure-ui`, `UIunderstanding`, and
`feature/tide-depth`. The research from `UIunderstanding`, on how PredictWind and
SeaLegs handle charting, lives on in newer form in
[docs/07-map-layers](docs/07-map-layers/). The git history keeps the rest.

---

## The problem

| | Expedition | What we want |
|---|---|---|
| Price | €1,250 licence + €275 upgrades | Free tier; cheap paid tier |
| Platform | Windows 10/11, 16 GB RAM | Any phone browser (PWA) |
| Data | Paid GRIB subscriptions, satcom, ENC licences | Public/open data only |
| Instruments | NMEA 0183/2000 wired to a PC | Phone GPS first; Signal K optional |
| Learning curve | Weeks. ~600 topics of manual. ~400 data channels. | Minutes |
| Charts | Licensed S-57/S-63/C-MAP | NOAA ENC + OpenSeaMap + GEBCO |

Expedition is not bad software — it is *extraordinary* software, and much of this
repo is an admiring teardown of it. It is simply built for a professional navigator
with a nav station, a budget, and a satellite connection. Most sailors have a phone
and a wet pocket.

## What's here

| Doc | What it covers |
|---|---|
| [docs/00-overview](docs/00-overview/) | Project premise, glossary of sailing/nav terms |
| [hardware and connectivity brief](docs/00-overview/hardware-and-connectivity-brief.md) | Plain-language guide to phones, boat instruments, AIS, displays, Signal K, and Starlink |
| [docs/01-expedition-analysis](docs/01-expedition-analysis/) | Hyper-detailed teardown of Expedition: every feature, every computed channel, and how each is probably calculated |
| [docs/02-data-sources](docs/02-data-sources/) | Every public data source we can legally build on — weather, charts, bathymetry, tides, currents, polars, AIS — with licences and access patterns |
| [docs/03-algorithms](docs/03-algorithms/) | The math: isochrone routing, graph routing, polars/VPP, laylines, start line, current & wave corrections |
| [docs/04-prior-art](docs/04-prior-art/) | Open-source and commercial landscape, with licence compatibility notes |
| [docs/05-spec](docs/05-spec/) | Product spec, technical spec, MVP scope, roadmap |
| [docs/06-decisions](docs/06-decisions/README.md) | Architecture decision records, and the questions still open |
| [docs/07-map-layers](docs/07-map-layers/) | How competitors draw charts and overlays, and our layer engine design |
| [docs/08-parity](docs/08-parity/README.md) | *This branch only.* The Expedition parity effort: the matrix, the worklist, everything we would need, and the reports |
| [docs/09-api](docs/09-api/channels-out.md) | *This branch only.* The channels-out WebSocket schema |
| [docs/SOURCES.md](docs/SOURCES.md) | Master bibliography — every URL cited across the research |
| [RUNNING.md](RUNNING.md) | How to run the prototype, and what in it is real |
| [PILOT.md](PILOT.md) | For sailors trying it on the water: install, the dock check, the two-minute test, and what to send back |
| [bridge/README.md](bridge/README.md) | *This branch only.* The local bridge for instruments on the boat's network |
| [fixtures/real/SOURCES.md](fixtures/real/SOURCES.md) | *This branch only.* The real public files the tests read, with their licences |

## Code layout

On `main`, a row is what comes before "Also", though this branch has extended much of that too.
Rows marked *Branch* are not on `main` at all.

| Path | What |
|---|---|
| `src/lib/angles.ts`, `src/lib/geo.ts` | Angle discipline and spherical geodesy |
| `src/lib/polar.ts`, `src/data/polars.ts` | Polar parsing/interpolation, derived targets, class library |
| `src/data/venues.ts` | Pilot-venue identity, extent, public source IDs, and provenance links |
| `src/data/landmask.ts`, `src/data/bathymetry.ts`, `public/venue/` | The two venue assets: an OSM coastline raster the router tests against, and a GEBCO depth grid the chart draws |
| `src/lib/wind.ts` | Wind triangle, leeway, set & drift, ground-vs-true wind |
| `src/lib/magnetic.ts` | True and magnetic north. Also `src/lib/wmm.ts` and `src/data/wmm2025.ts`: the World Magnetic Model |
| `src/lib/startline.ts` | Bias, distance below line, time to line and time to burn. Also `timer.ts` and `lineAdjust.ts` |
| `src/lib/tactics.ts` | Laylines, VMG/VMC, beat split, time to mark. Also `whatif.ts`, `gates.ts`, `wlcourse.ts`, `legs.ts`, `laylineGeo.ts`, `legsOnChart.ts`, `courseEdit.ts`, `handicap.ts` |
| `src/lib/weather/` | Open-Meteo ingest, binary forecast cube, field providers. Also GRIB 1 and 2 decoders, observations, overlays, ensembles |
| `src/lib/routing/` | Isochrone kernel, land mask, Web Worker, departure sweep, depth advisory. Also the grid solver, ensemble and fleet routing |
| `src/lib/tides/` | NOAA CO-OPS predictions and datum arithmetic. Also the harmonic tide and stream engines, and stations |
| `src/lib/maplayers/`, `src/lib/pwa/` | GPU particle and scalar layers; the service worker's precache list |
| `src/lib/sim.ts` | Synthetic boat, so the app is usable from a desk |
| `src/lib/gpx.ts` | GPX. Also `marksCsv.ts`, `raceNotesFile.ts`, `config.ts`, `latlon.ts`, `zip.ts`, `inflate.ts` |
| `src/lib/charts/` | *Branch.* ISO 8211, S-57 and BSB/KAP readers, S-52-style drawing, the chart library, routing against the ENC |
| `src/lib/instruments/` | *Branch.* Signal K, Web Serial and bridge clients, NMEA 0183 and 2000, Expedition's text protocol, the pipeline, calibration |
| `src/lib/ais/`, `src/lib/fleet.ts`, `src/lib/tracking.ts`, `src/lib/share.ts` | *Branch.* AIS targets, the boats database, race-tracking files, sharing between copies of the app |
| `src/lib/channels/`, `src/lib/logging/`, `src/lib/alarms/`, `src/lib/api/` | *Branch.* The channel catalogue, logs and playback, alarms, channels out |
| `src/lib/` others | *Branch.* `chartView.ts`, `mapExport.ts`, `palette.ts`, `units.ts`, `sailchart.ts`, `shortcuts.ts`, `errorLog.ts` and the rest |
| `src/state/`, `src/hooks/` | The store and sensors. Also the chart, AIS, tracking and weather-file stores, and hooks for instruments, playback, sharing and the wide layout |
| `src/screens/`, `src/components/` | Five screens and the start display. Also a sixth screen, Strip, and the nav-station ribbon, panes and number boxes |
| `src/dev/` | The map-layer harness, dev only |
| `scripts/build-depth-grid.mjs` | Rebuilds the depth asset. Also `parity-score.ts` and `parity-set.ts` |
| `bridge/` | *Branch.* The local Node bridge: UDP, TCP, serial, sharing, watched folders |
| `fixtures/real/` | *Branch.* Public NOAA files the tests read: GFS, an ENC cell, a raster chart, WMM, tide constants |

The Portland pilot’s source inventory, station IDs, current-model precedence, and
venue-pack build order live in [docs/02-data-sources/portland-maine-pilot.md](docs/02-data-sources/portland-maine-pilot.md).

## Reading order

1. [docs/05-spec/product-spec.md](docs/05-spec/product-spec.md) — what we're building and for whom
2. [docs/01-expedition-analysis/feature-inventory.md](docs/01-expedition-analysis/feature-inventory.md) — the benchmark, feature by feature
3. [docs/02-data-sources/README.md](docs/02-data-sources/README.md) — what we're allowed to build on
4. [docs/03-algorithms/routing-isochrone.md](docs/03-algorithms/routing-isochrone.md) — the core algorithm
5. [docs/05-spec/technical-spec.md](docs/05-spec/technical-spec.md) — how it gets built
6. [docs/06-decisions/README.md](docs/06-decisions/README.md) — what has been settled, and what is still open

## Safety notice

Nothing produced in this repo is, or will be, a substitute for official charts,
official tide tables, or prudent seamanship. Expedition itself says the same thing
about its own tide predictions, and it costs €1,250. Treat every number as advisory.

## Licence

Code: [MIT](LICENSE) ([ADR-0005](docs/06-decisions/0005-mit-licence.md)). Documentation: CC BY 4.0.
Third-party data retains its own licence — see
[docs/02-data-sources/licensing-matrix.md](docs/02-data-sources/licensing-matrix.md).
The land mask derives from OpenStreetMap, so `src/data/landmask.ts` and
`public/venue/portland-land.bin` are ODbL 1.0.
