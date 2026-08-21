# newjourney

**An open, phone-first weather routing and tactical navigation app for sailors.**

The goal: replace the €1,250, Windows-only, antenna-dependent, steep-learning-curve
tactical software stack (Expedition and its peers) with something a 16-year-old on a
420 or a first-time offshore navigator on a J/105 can open on a phone and understand
in five minutes — built entirely on public data.

> **Status: working prototype on `main`, piloting Portland & Casco Bay, Maine.**
> A running React PWA with the start-line tools, tactical numbers, an isochrone
> weather router with departure-time optimisation, and GPU wind, depth and current
> layers, alongside the research and specification work it was built from. See
> [RUNNING.md](RUNNING.md) to try it — including a boat simulator so you can use the
> whole app from a desk, with no GPS fix needed.
>
> 590 tests passing · typecheck clean · build clean · 94 KB gzipped first load.
> **Not for navigation** — see the caveats in [RUNNING.md](RUNNING.md#whats-real-and-what-isnt).
> Land avoidance now works, but only inside the Portland venue box and only as a
> land check, never a depth check. The depth layer is a 450 m bathymetric model
> referenced to mean sea level, not a chart and not a routing input — it reads 18 m
> shallow at a NOAA buoy and 1.5 m deep against chart datum, and it says so. The
> bundled polars are generated from published dimensions rather than measured.

## Branches

| Branch | Contents |
|---|---|
| **`main`** | The prototype and the research behind it. Start here. |
| `MVP1` | An earlier snapshot of the prototype, now strictly behind `main`. Kept for history. |
| `UIunderstanding` | Research into how PredictWind and SeaLegs handle charting and map layers, and the resulting render architecture |

`main` held research and specification only until the prototype was promoted onto
it; the application code arrived from `feature/tide-depth`, which is where the
chart-surface and depth work was done.

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
| [docs/06-decisions](docs/06-decisions/) | Architecture decision records |
| [docs/SOURCES.md](docs/SOURCES.md) | Master bibliography — every URL cited across the research |
| [RUNNING.md](RUNNING.md) | How to run the prototype |

## Code layout

| Path | What |
|---|---|
| `src/lib/angles.ts`, `src/lib/geo.ts` | Angle discipline and spherical geodesy |
| `src/lib/polar.ts`, `src/data/polars.ts` | Polar parsing/interpolation, derived targets, class library |
| `src/data/venues.ts` | Pilot-venue identity, extent, public source IDs, and provenance links |
| `src/data/landmask.ts`, `src/data/bathymetry.ts` | The two venue assets: an OSM coastline raster the router tests against, and a GEBCO depth grid the chart draws |
| `src/lib/wind.ts` | Wind triangle, leeway, set & drift, ground-vs-true wind |
| `src/lib/startline.ts` | Bias, distance below line, time to line and time to burn |
| `src/lib/tactics.ts` | Laylines, VMG/VMC, beat split, time to mark |
| `src/lib/weather/` | Open-Meteo ingest, binary forecast cube, field providers |
| `src/lib/routing/` | Isochrone kernel, land mask, Web Worker |
| `src/lib/sim.ts` | Synthetic boat, so the app is usable from a desk |
| `src/screens/`, `src/components/` | The four screens and the start display |

The Portland pilot’s source inventory, station IDs, current-model precedence, and
venue-pack build order live in [docs/02-data-sources/portland-maine-pilot.md](docs/02-data-sources/portland-maine-pilot.md).

## Reading order

1. [docs/05-spec/product-spec.md](docs/05-spec/product-spec.md) — what we're building and for whom
2. [docs/01-expedition-analysis/feature-inventory.md](docs/01-expedition-analysis/feature-inventory.md) — the benchmark, feature by feature
3. [docs/02-data-sources/README.md](docs/02-data-sources/README.md) — what we're allowed to build on
4. [docs/03-algorithms/routing-isochrone.md](docs/03-algorithms/routing-isochrone.md) — the core algorithm
5. [docs/05-spec/technical-spec.md](docs/05-spec/technical-spec.md) — how it gets built

## Safety notice

Nothing produced in this repo is, or will be, a substitute for official charts,
official tide tables, or prudent seamanship. Expedition itself says the same thing
about its own tide predictions, and it costs €1,250. Treat every number as advisory.

## Licence

Code: [MIT](LICENSE). Documentation: CC BY 4.0.
Third-party data retains its own licence — see
[docs/02-data-sources/licensing-matrix.md](docs/02-data-sources/licensing-matrix.md).
