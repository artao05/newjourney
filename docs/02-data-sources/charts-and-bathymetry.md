# Charts, Basemaps, Bathymetry and Coastline

Expedition supports eight chart formats, of which six are commercially licensed. We can
match its *free* coverage almost exactly, and we cannot match its licensed coverage at
all. This document is about being precise on that boundary.

---

## 1. NOAA ENC — official US charts, free

<https://nauticalcharts.noaa.gov/charts/noaa-enc.html>

NOAA ENCs are S-57 vector charts covering all US waters, published free, updated
weekly, and — as US Government works — in the **public domain**. This is the single best
free chart dataset in the world.

> Note: NOAA completed the sunset of traditional paper/raster nautical charts in
> January 2025; ENC is now the primary product line. Verify current RNC availability
> before depending on it.

### Access paths

| Method | Endpoint | Use |
|---|---|---|
| **ENC downloads** (S-57) | <https://charts.noaa.gov/ENCs/ENCs.shtml> — individual cells or regional bundles | Render our own tiles; extract depth areas for routing |
| **ENC Direct to GIS** | <https://encdirect.noaa.gov/> — S-57 as shapefile/geodatabase, weekly | Easiest path to depth contours, depth areas, obstructions |
| **NOAA Chart Display Service** (paper-chart symbology) | Esri REST: `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer`<br>WMS: same path with `/WMSServer`<br>WMTS: `https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/WMTS` | **Zero-effort chart display in the MVP** |
| **ECDIS Display Service** (S-52 symbology) | `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer` (+ `/WMSServer`) | Proper ECDIS look |
| **MBTiles for offline** | <https://distribution.charts.noaa.gov/ncds/index.html> | Pre-built offline tilesets by region |

NOAA's own caveat, verbatim: *"ENC Direct to GIS DOES NOT meet USCG chart carriage
requirements for commercial vessels."* We will carry an equivalent notice.

### Strategy

- **MVP:** consume the WMTS/WMS display service directly. Charts on screen in an
  afternoon.
- **v1:** ingest S-57 ourselves, render vector tiles (MapLibre style, S-52-ish palette,
  day/dusk/night), and pre-package MBTiles/PMTiles regions for offline. Owning the
  render is what lets us do the S-52 display categories, safety-contour colouring, and a
  legible-on-a-phone-in-spray typography pass.
- **Always:** extract `DEPARE` (depth areas), `DEPCNT` (contours), `OBSTRN`, `WRECKS`,
  `UWTROC`, `LNDARE` into a routing-usable geometry layer. This is what powers "avoid
  ENC land and safety depth."

---

## 2. Non-US official charts

Free national ENC availability is uneven. As of writing, worth checking (each has its
own terms — verify before shipping, don't assume):

| Country/region | Source | Notes |
|---|---|---|
| USA | NOAA | Free, public domain ✅ |
| Canada | CHS | Mostly paid |
| UK | UKHO / ADMIRALTY | Paid |
| Australia | AusENC (via AHO) | Paid — Expedition documents its own AusENC integration |
| France | SHOM | Paid, some free viewers |
| Norway, Denmark, Netherlands, NZ | Varies; several have free-to-view or open datasets | Verify individually |
| **Global fallback** | **OpenSeaMap** | See below |

**Honest position for the product:** official-grade charting is US-first. Elsewhere we
give OpenSeaMap seamarks + OSM coastline + GEBCO bathymetry, and we say plainly that it
is not an official chart. Racing sailors mostly need *marks, hazards, depth contours and
the coastline*, not full ECDIS — but that caveat must be visible, not buried.

---

## 3. OpenSeaMap — the global free nautical layer

<https://map.openseamap.org/> · <https://wiki.openstreetmap.org/wiki/Seamarks>

A sub-project of OpenStreetMap holding seamark data — beacons, buoys, lights (with
characteristics and sectors), harbours, marinas, chandleries, ferry routes.

**Licence:** the underlying OSM data is **ODbL 1.0**; the rendered OpenSeaMap tiles are
**CC-BY-SA 2.0**. ODbL is the one to think carefully about — it is share-alike on
*derived databases*. Using OSM data to render a map and display it is fine with
attribution. Building and **distributing** a derived database (e.g. a routing graph baked
from OSM coastline) can trigger share-alike obligations. Practical guidance:
<https://wiki.osmfoundation.org/wiki/Licence/Community_Guidelines>.

**Our stance:** attribute properly, keep any OSM-derived database artefacts openly
licensed, and keep proprietary logic (routing algorithms, polar handling, UI) in code
rather than in derived data. This is the normal and well-trodden pattern.

**Tiles:** use the public `tiles.openseamap.org/seamark/{z}/{x}/{y}.png` overlay for
prototyping, but do **not** hammer a volunteer tile server in production — render our own
from OSM extracts.

---

## 4. Basemap

| Option | Licence | Notes |
|---|---|---|
| **Protomaps** basemap (PMTiles from OSM) | ODbL data, BSD tooling | Single-file tileset, servable from S3/R2 with HTTP range requests, no tile server. **Recommended.** |
| **MapLibre GL JS** | BSD-3 | The renderer. Open fork of Mapbox GL JS pre-licence-change. **Recommended.** |
| OpenMapTiles / Tilemaker | varies | Self-host vector tile generation |
| Commercial (Mapbox, MapTiler) | paid | Faster to start, recurring cost, and a per-request dependency at sea |

**PMTiles + MapLibre is the correct architecture for this app** because it makes offline
a first-class case rather than a bolt-on: a `.pmtiles` file is a single archive that can
be downloaded to the device, stored in OPFS, and read by range requests locally. See
<https://docs.protomaps.com/pmtiles/> and the MapLibre offline PMTiles plugin
(<https://github.com/makinacorpus/maplibre-offline-pmtiles>).

---

## 5. Bathymetry — GEBCO

<https://www.gebco.net/data-products/gridded-bathymetry-data>

GEBCO_2025 is a global 15 arc-second (~450 m at the equator) elevation grid for ocean and
land, available as netCDF, GeoTIFF, or Esri ASCII, globally or by user-defined area, with
an optional under-ice variant. Released annually (2024, 2025, …) under terms that permit
free public use.

**Uses:**
1. Depth shading on the chart where no ENC exists.
2. A **coarse grounding check** in the router — reject any leg crossing a cell shallower
   than the boat's safety depth. Cheap, global, and catches the gross errors.
3. Tidal-current sanity (currents accelerate over shoals and through gaps).

**Do not** present GEBCO as navigational depth. At 450 m resolution with sparse survey
coverage in shallow water, it is a bathymetric model, not a survey. The router uses it as
a *filter*, and the disclaimer says so.

Higher-resolution regional alternatives: NOAA **CUDEM** / continuously updated DEMs for US
coasts (1/9 to 1/3 arc-second), EMODnet Bathymetry for European seas (~115 m).

---

## 6. Coastline and land polygons — the routing obstacle layer

<https://osmdata.openstreetmap.de/data/land-polygons.html>

Daily-generated, geometrically validated land polygons assembled from OSM coastline ways
by `osmcoastline`. Available complete or split into tiles, in WGS84 and Web Mercator, as
shapefiles. Also available: `water-polygons`, `coastlines`, and a `simplified-land-polygons`
set intended for low zoom.

This is our direct equivalent of Expedition's bundled "simple world chart" for land
avoidance — and it is substantially better, since it is derived from live OSM coastline
rather than a coarse static dataset.

**Recommended handling:**

- Build **two** obstacle layers: a simplified one (fast, for the isochrone rejection test
  at ocean scale) and a full-resolution one (for inshore legs and the final route check).
- Index with an R-tree / STRtree; the per-step question is "does segment `p → p'` cross
  land?", which is a segment-vs-polygon intersection query, not a point-in-polygon test.
  Getting this wrong — testing only endpoints — lets routes hop over islands and is the
  most common bug in hobby routers.
- Pre-rasterise a land mask at the routing grid resolution for the grid algorithm.
  A bitmask lookup is ~100× faster than a geometry query and is exactly what a coarse
  pass needs.

**Licence:** ODbL, as OSM. See the note in §3.

---

## 7. Additional useful layers

| Layer | Source | Use |
|---|---|---|
| Marine protected areas / restricted zones | NOAA, Marine Regions (marineregions.org) | Exclusion zones |
| Traffic separation schemes | ENC (`TSSLPT` etc.), OSM | Exclusion / caution zones |
| Magnetic declination | **WMM** (NOAA/NCEI) — model coefficients are public; `geomagJS` and others implement it | Converting °T ↔ °M, which every racer expects |
| Sunrise/sunset/civil twilight | Computed locally (NOAA solar position algorithm) | Day/night polar switching, night mode |
| Racing marks | User-entered / GPX import / club sailing instructions | |

Magnetic variation deserves a callout: Expedition exposes it as a channel and lets the
user work in °M throughout. Race committees set course axes in magnetic. Any app that
only speaks true north will feel wrong to a racer. WMM is a small polynomial evaluation
and runs fine client-side.

---

## 8. Offline strategy

The phone-first premise means offline is a requirement, not a feature.

| Asset | Mechanism | Size (typical racing venue) |
|---|---|---|
| Basemap + seamarks | PMTiles in OPFS | 20–80 MB for a region |
| ENC-derived chart tiles | PMTiles / MBTiles | 10–100 MB |
| Bathymetry | Pre-clipped GEBCO tile | 1–10 MB |
| Land polygons | Simplified GeoJSON/FlatGeobuf for the bbox | < 5 MB |
| Weather | Our compact binary grid, `Int16` u/v | 100–500 KB per model per day |
| Tide harmonics | Constituents for nearby stations | < 1 MB |
| Polars | Text | < 100 KB |

A "download this venue" button producing a ~100 MB bundle covers a full regatta with no
connectivity. That is a feature Expedition genuinely does not have in a portable form —
and it is arguably more useful than anything in its settings pages.
