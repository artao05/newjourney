# Open-Source Prior Art

What already exists, what we can learn from, what we can use, and what we must keep at
arm's length for licence reasons.

**Read [../02-data-sources/licensing-matrix.md §5](../02-data-sources/licensing-matrix.md#5-gpl-contamination--the-real-risk)
before opening any GPL source.**

---

## 1. Routing engines

### OpenCPN `weather_routing_pi` — GPL-3.0

<https://github.com/seandepagnier/weather_routing_pi> ·
manual: <https://opencpn-manuals.github.io/main/weather_routing/index.html>

The most complete free weather router in existence. Isochrone-based, works from GRIB or
averaged climatology, supports constraints (max wind, max swell, day/night cycles,
avoiding land), multiple boats, and route comparison. Its manual describes the isochrone
concept well and is a legitimate, licence-safe thing to read.

- **Use as:** conceptual reference and output cross-check.
- **Do not:** read the source while writing ours, or port it. GPL-3.0.
- **Notable:** it has a "cycles" concept for day/night and configurable "efficiency"
  factors — the same ideas as Expedition's polar % and night polar %.

### `libweatherrouting` (dakk) — MIT (verify)

<https://github.com/dakk/libweatherrouting>

A Python sailing weather-routing library with isochrone routing, polar handling, and
sample polars. Permissively licensed, so we *can* read it, port ideas from it, and even
vendor parts.

- **Use as:** the safe reference implementation. Read this instead of `weather_routing_pi`.
- Also useful for building a **test oracle**: run the same polar + GRIB + course through
  both and compare arrival times.

### qtVlm — closed source

Excellent router, very popular, and **no longer free software** — source is not available.
Study its UI and behaviour, never its internals. It is also a useful benchmark: if our
routes differ materially from qtVlm's on the same inputs, one of us is wrong.

### `sailnavsim` / `sailnavsim-core` — check licence

Sailing simulation with real weather; useful as a *validation harness* — simulate sailing
our computed route through the real forecast and confirm the ETA matches.

---

## 2. Chart plotters and navigation

### OpenCPN — GPL-2.0+

<https://opencpn.org>

The reference open-source chart plotter. S-57 rendering, ENC support, tides/currents,
AIS, dashboard, and a huge plugin ecosystem. Twenty years of accumulated knowledge about
what marine navigation software must do.

- **Use as:** feature checklist and behavioural reference.
- **Do not:** link or port. GPL.
- **Specifically worth studying (from the outside):** its S-52 rendering choices, its
  handling of chart quilting, and its tide/current station UI.

### Signal K — Apache-2.0 ⭐

<https://signalk.org> · <https://github.com/SignalK/signalk-server>

The single most important open-source project for us. A modern marine data standard
(JSON over HTTP/WebSocket) plus a Node.js server that multiplexes NMEA 0183, NMEA 2000,
and other protocols onto it.

**Why it matters:** Expedition supports 25+ proprietary instrument protocols. We support
*one* — Signal K — and let Signal K's ecosystem handle the rest. A user with a Raspberry
Pi, an OpenPlotter install, a Victron Cerbo, or a Yacht Devices gateway already has this.

- **Licence:** Apache-2.0. Fully compatible with anything.
- **Integration:** connect to `ws://signalk-server/signalk/v1/stream`, subscribe to
  `navigation.*`, `environment.wind.*`, `environment.depth.*`.
- **Bonus:** we could ship as a Signal K *plugin/webapp*, giving us instant distribution
  to the existing onboard-computer community.

### OpenSeaMap tooling

<https://github.com/OpenSeaMap>

Renderers and tools for the seamark layer. Useful for building our own seamark tiles.

---

## 3. Weather data tooling

| Project | Licence | Use |
|---|---|---|
| **ecCodes** (ECMWF) | Apache-2.0 | The definitive GRIB/BUFR library. Server-side decode. |
| **wgrib2** (NOAA) | Public-domain-ish | CLI subsetting, inventory, format conversion |
| **cfgrib / xarray** | Apache-2.0 / BSD | Python GRIB → labelled arrays. The pleasant path. |
| **Herbie** | MIT | Discovers and downloads NWP from cloud archives (GFS, HRRR, RAP, NBM, …) with `.idx` byte-range subsetting. **Read this for the download strategy.** |
| **Open-Meteo server** | AGPL-3.0 | Self-hostable aggregator. Calling the hosted API is fine; forking triggers AGPL. |
| `grib2-simple` | permissive (verify) | Pure-JS GRIB2 decode in Node |
| **zarr / kerchunk** | permissive | Cloud-optimised array access — a strong option for serving our own weather cubes |

---

## 4. Mapping and offline

| Project | Licence | Use |
|---|---|---|
| **MapLibre GL JS** | BSD-3 | The renderer. Vector tiles, GPU, mobile-capable. |
| **PMTiles / Protomaps** | BSD-3 | Single-file tile archives, HTTP range reads, no tile server. **Core to our offline story.** |
| `maplibre-offline-pmtiles` | see repo | OPFS-backed offline PMTiles for MapLibre |
| **Tilemaker / Planetiler** | permissive | Build vector tiles from OSM extracts |
| **GDAL/OGR** | MIT/X | S-57 reading (it has a dedicated S-57 driver), reprojection, raster handling |
| **Turf.js** | MIT | Geospatial predicates in JS — intersection, buffering, point-in-polygon |
| **Flatbush / RBush** | ISC/MIT | Fast spatial indexes for the land-obstacle test |

---

## 5. Polars and performance

| Project | Licence | Use |
|---|---|---|
| **`jieter/orc-data`** | see repo | ORC certificate VPP data → tables, polar plots, CSV |
| **`hrosailing`** | permissive (verify) | Python: process, fit and interpolate polar data from real sailing tracks. Directly relevant to [../02-data-sources/polars.md §2.6](../02-data-sources/polars.md#26-learn-the-polar-from-the-users-own-tracks--the-endgame) |
| **`pytides` / `pyTMD`** | MIT | Harmonic tide prediction reference implementations |
| **XTide** | GPL | Reference only — reimplement from NOAA constituents |

---

## 6. What nobody has built

The gap this project exists to fill:

| Capability | OpenCPN + WR | qtVlm | PredictWind | Savvy Navvy | Windy | **Us** |
|---|---|---|---|---|---|---|
| Runs on a phone browser, no install | ❌ | ❌ | app | app | app | ✅ |
| Free | ✅ | partly | ❌ | ❌ | partly | ✅ |
| Open source | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Weather routing | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Buoy racing / start line** | ❌ | partial | ❌ | ❌ | ❌ | ✅ |
| **Laylines** | ❌ | partial | ❌ | ❌ | ❌ | ✅ |
| **Route confidence / sensitivity** | ❌ | ❌ | partial | ❌ | ❌ | ✅ |
| **Teaches you why** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Polar learned from your own tracks | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Offline-first | ✅ | ✅ | partial | ✅ | partial | ✅ |

The uncontested space is **racing tactics on a phone, for free, with an explanation**.
Cruising navigation is crowded (Navionics, Aqua Map, Savvy Navvy, Aquamaps, TZ iBoat).
Weather display is crowded (Windy, PredictWind, LuckGrib). *Racing* tactics on a phone is
essentially empty below the €1,000 price point — and that is where every junior programme,
college team, and club fleet in the world lives.

---

## 7. Standards worth conforming to

| Standard | Why |
|---|---|
| **GPX 1.1** | Universal route/track/waypoint exchange. Non-negotiable. |
| **Signal K** | Instrument data |
| **NMEA 0183 sentences** | Even without hardware, understanding `RMC`, `GGA`, `MWV`, `VHW`, `HDG`, `DPT` is required to talk to anything |
| **S-57 / S-52** | Chart data and its symbology |
| **S-100 / S-101** | The successor to S-57. Worth tracking; ENC production is migrating. |
| **GRIB2 (WMO FM 92)** | Weather |
| **Expedition `.txt` polar format** | De-facto polar interchange |
| **iCalendar / GPX for race courses** | Sailing instructions import is an unsolved, valuable problem |
