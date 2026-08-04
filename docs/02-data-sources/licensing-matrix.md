# Licensing Matrix

**Not legal advice.** This is an engineering summary to make the obligations visible and
to keep incompatible material out of the codebase. Anything marked ⚠️ needs a real
decision (and possibly a lawyer) before it ships.

---

## 1. Data sources

| Source | Licence | Commercial use? | Redistribute? | Attribution required | Notes |
|---|---|---|---|---|---|
| NOAA GFS / GEFS / GFS-Wave / HRRR / NBM / NAM / RTOFS / OFS | US Gov work — public domain | ✅ | ✅ | Courtesy only | Cleanest data on earth, legally |
| NOAA ENC (S-57) | Public domain | ✅ | ✅ | Courtesy | ⚠️ Not USCG chart-carriage compliant; carry NOAA's disclaimer |
| NOAA CO-OPS tides/currents | Public domain | ✅ | ✅ | Courtesy | Rate-limited; send an `application` string |
| ECMWF open data (IFS, AIFS) | **CC-BY-4.0** | ✅ | ✅ | **Required** | Plus ECMWF Terms of Use |
| DWD ICON / EWAM | **CC-BY-4.0** (GeoNutzV) | ✅ | ✅ | **Required**, specific DWD wording | |
| Météo-France ARPEGE / AROME / MFWAM | Etalab / open licence per product | ✅ (verify per product) | ✅ | Required | ⚠️ Verify per dataset |
| ECCC GDPS / HRDPS | Canada Open Government Licence | ✅ | ✅ | Required | |
| UK Met Office UM/UKV | ⚠️ Varies by product | ⚠️ | ⚠️ | | Check DataHub terms before use |
| **Open-Meteo** (hosted API) | Free tier **non-commercial**; commercial needs a paid key | ⚠️ | Data yes, service no | Required (Open-Meteo + DWD) | Server itself is **AGPL-3.0** and self-hostable |
| GEBCO grids | Free public use, effectively public domain | ✅ | ✅ | Required (GEBCO/Seabed 2030 wording) | Not for navigation |
| **OpenStreetMap** (basemap, coastline, land polygons) | **ODbL 1.0** | ✅ | ✅ | **Required** | ⚠️ Share-alike applies to *derived databases* — see §3 |
| **OpenSeaMap** tiles | **CC-BY-SA 2.0** (tiles); ODbL (data) | ✅ | ✅ | **Required** | Don't hammer the volunteer tile server in production |
| CMEMS / Copernicus Marine | Copernicus licence — free incl. commercial | ✅ | ✅ | Required | Registration required |
| RainViewer | Free tier, non-commercial-ish | ⚠️ | ❌ | Required | Check current terms |
| NDBC / METAR / aviationweather.gov | Public domain | ✅ | ✅ | Courtesy | |
| **ORC certificate / VPP data** | ⚠️ **Unresolved** | ⚠️ | ⚠️ | | See §4 — treat as user-initiated import until clarified |
| aisstream.io | Free tier under their ToS | ⚠️ | ❌ | Required | Don't rebroadcast |
| AISHub | Reciprocal contribution required | ⚠️ | ❌ | Required | Must feed to receive |
| YB Tracking / event feeds | Per-event, organiser-controlled | ❌ without permission | ❌ | | Ask organisers; do not scrape |
| WMM (magnetic model) | Public domain (NOAA/NCEI) | ✅ | ✅ | Courtesy | |

## 2. Software we might depend on

| Project | Licence | Compatible with a closed/commercial product? | Notes |
|---|---|---|---|
| **MapLibre GL JS** | BSD-3-Clause | ✅ | The renderer |
| **PMTiles** (`protomaps`) | BSD-3-Clause | ✅ | Single-file tiles |
| **Protomaps basemap tiles** | Data is ODbL (OSM) | ✅ with attribution | |
| **Signal K server / spec** | Apache-2.0 | ✅ | Instrument ingest |
| **libweatherrouting** (dakk) | MIT (verify) | ✅ | Reference implementation, Python |
| **hrosailing** | MIT-ish (verify) | ✅ | Polar fitting from tracks |
| `grib2-simple` | MIT-ish (verify) | ✅ | Node GRIB2 decode |
| **ecCodes** | Apache-2.0 | ✅ | ECMWF's GRIB/BUFR library |
| **wgrib2** | Public-domain-ish NOAA | ✅ | CLI |
| `cfgrib` / `xarray` | Apache-2.0 / BSD | ✅ | Python ingest |
| GDAL / OGR | MIT/X (since 3.x) | ✅ | S-57 reading, reprojection |
| **OpenCPN `weather_routing_pi`** | **GPL-3.0** | ❌ **for linking** | See §5 |
| **OpenCPN** core | GPL-2.0+ | ❌ for linking | |
| **XTide** | **GPL** | ❌ for linking | Reimplement harmonics from public NOAA constituents instead |
| `libtcd` | LGPL | ⚠️ dynamic linking only | Or skip it entirely |
| **qtVlm** | **Closed source** (no longer free software) | ❌ | Study behaviour only, never code |
| `pytides` / `pytmd` | MIT / MIT | ✅ | Harmonic reference implementations |
| Open-Meteo server | **AGPL-3.0** | ⚠️ | Fine to *call* over HTTP; self-hosting and modifying triggers AGPL network-use obligations |

## 3. ODbL, specifically

ODbL's share-alike attaches to **derived databases**, not to everything that touches the
data. In practice, for us:

| Activity | Obligation |
|---|---|
| Rendering OSM tiles and showing them | Attribution only ✅ |
| Producing our own vector tiles from OSM | "Produced Work" — attribution ✅ |
| Building a land-polygon obstacle index and **using it on our server** | No distribution → no share-alike trigger ✅ |
| **Shipping** that derived obstacle index inside an offline bundle to users | Distribution of a derived database → **must be offered under ODbL** ⚠️ |
| Our routing algorithm code | Not a database. Stays under whatever licence we choose ✅ |

**Recommendation:** publish any OSM-derived geographic artefacts (land polygons, coastline
indexes, seamark extracts) under ODbL as a separate, clearly-labelled data package, and
keep application code separate. This is the standard pattern and costs us nothing — we
were going to be open anyway.

Reference: <https://wiki.osmfoundation.org/wiki/Licence/Community_Guidelines>

## 4. ORC polar data — open question ⚠️

ORC certificate data is public in the sense of being published for inspection, and
community tools (`jieter/orc-data`, boatpolars.com) surface it. That is not the same as a
licence to redistribute in bulk inside a commercial product.

**Interim policy:**
- ✅ User enters their sail number / boat name; we fetch **their** certificate on their
  behalf and store it in **their** account.
- ❌ We do not ship a bulk ORC polar database.
- 📮 Ask ORC directly. A free tool that gets more sailors using ORC certificates is
  plausibly something they'd support — worth an email before assuming the worst.

## 5. GPL contamination — the real risk

The most useful prior art (`weather_routing_pi`, OpenCPN, XTide) is GPL. We must be
disciplined:

- **Reading GPL source to learn an algorithm is fine.** Algorithms are not copyrightable;
  expressions of them are.
- **Copying GPL code, or translating it line-by-line, is not fine** unless we go GPL.
- Isochrone routing is *published literature* (Hagiwara 1989 and successors), not
  OpenCPN's invention. Implement from the papers and from
  [../03-algorithms/routing-isochrone.md](../03-algorithms/routing-isochrone.md), which
  is written from public descriptions and Expedition's own documentation.

**Practical rule for contributors:** if you have `weather_routing_pi` open in one window,
do not have our router open in the other. Read it, close it, write a description of what
it does, implement from the description.

## 6. Recommended licence for this project

| Component | Proposed licence | Why |
|---|---|---|
| Application code | **MIT** (or Apache-2.0 if we want the patent grant) | Maximum adoption; permissive |
| Documentation (this repo's `docs/`) | **CC BY 4.0** | |
| OSM-derived data packages | **ODbL** | Required |
| Bundled sample polars | Case by case | Only ship ones we're clearly allowed to |

If the long-term plan involves a paid tier, MIT/Apache on the core and a separate
proprietary hosted service is the standard and workable split. Going GPL would rule out
that path.

## 7. Safety and liability

Every navigation product carries a version of this. Expedition's manual carries it about
its own *tide predictions* — a €1,250 product being explicit that its numbers can kill
you:

> "do not rely on the heights computed by this software for anything that could in any
> way endanger you, your vessel, anyone else or anything else. Always use official tide
> height data and your own good judgment and seamanship when piloting shoal waters."

Ours must be at least as clear, must appear **in the app** and not just in a EULA, and
must be specific rather than blanket:

- Not for navigation; not ECDIS; does not meet chart-carriage requirements
- Chart data may be outdated or incomplete outside US waters
- Depth data is modelled, not surveyed
- Routing output is advisory and assumes a forecast that will be wrong
- The skipper is responsible for the safety of the vessel and crew

The sensitivity/confidence display (see
[../01-expedition-analysis/how-it-computes.md §8](../01-expedition-analysis/how-it-computes.md#8-reverse-isochrones-and-route-sensitivity))
is not just a feature — it is the honest expression of this disclaimer in the UI.
