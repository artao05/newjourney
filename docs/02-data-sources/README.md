# Public Data Sources — Index

Everything Expedition charges for, or requires a subscription for, has a free public
equivalent good enough for an MVP. This section catalogues them.

**Ground rule for this project:** if a data source cannot be used free, without
per-seat licensing, and without redistribution restrictions that block a hosted web
app, it does not go in the MVP. Paid sources are noted for completeness and flagged.

| Need | Our source | Cost | Licence | Detail |
|---|---|---|---|---|
| Global wind forecast | NOAA **GFS** 0.25° | Free | US Gov public domain | [weather-models.md](weather-models.md) |
| Best-quality global | **ECMWF IFS/AIFS** open data 0.25° | Free | CC-BY-4.0 | [weather-models.md](weather-models.md) |
| European high-res | DWD **ICON** / **ICON-EU/D2** | Free | CC-BY-4.0 (DWD) | [weather-models.md](weather-models.md) |
| US high-res | NOAA **HRRR** 3 km, **NBM** 2.5 km | Free | Public domain | [weather-models.md](weather-models.md) |
| Waves | **GFS-Wave**, ECMWF **WAM**, MF **MFWAM**, DWD **EWAM** | Free | mixed, all open | [weather-models.md](weather-models.md) |
| Zero-infrastructure start | **Open-Meteo** aggregator API | Free (non-commercial) | CC-BY-4.0 + attribution | [weather-models.md](weather-models.md) |
| Nautical charts (US) | **NOAA ENC** + Chart Display Service | Free | US Gov public domain | [charts-and-bathymetry.md](charts-and-bathymetry.md) |
| Nautical charts (world) | **OpenSeaMap** seamark layer | Free | ODbL (data) / CC-BY-SA (tiles) | [charts-and-bathymetry.md](charts-and-bathymetry.md) |
| Basemap | **OpenStreetMap** via Protomaps/MapLibre | Free | ODbL | [charts-and-bathymetry.md](charts-and-bathymetry.md) |
| Bathymetry | **GEBCO_2025** 15 arc-sec | Free | Public domain-equivalent | [charts-and-bathymetry.md](charts-and-bathymetry.md) |
| Coastline for routing | **OSM land polygons** (osmdata.openstreetmap.de) | Free | ODbL | [charts-and-bathymetry.md](charts-and-bathymetry.md) |
| Tide heights & currents (US) | **NOAA CO-OPS API** + **XTide** harmonics | Free | Public domain | [tides-and-currents.md](tides-and-currents.md) |
| Ocean currents (global) | **NOAA RTOFS** 1/12° | Free | Public domain | [tides-and-currents.md](tides-and-currents.md) |
| Ocean currents (alt) | **CMEMS** Copernicus Marine | Free w/ registration | Copernicus licence | [tides-and-currents.md](tides-and-currents.md) |
| Polars | **ORC** public certificate VPP data | Free | see notes — check ORC terms | [polars.md](polars.md) |
| Observations | **NDBC** buoys, **NWS/METAR**, ASOS | Free | Public domain | [weather-models.md](weather-models.md) |
| Radar | **RainViewer**, NWS **MRMS** | Free tier | see notes | [weather-models.md](weather-models.md) |
| AIS | **aisstream.io**, **AISHub** (reciprocal) | Free tier | see notes | [ais-and-tracking.md](ais-and-tracking.md) |
| Boat instruments | **Signal K** | Free | Apache-2.0 | [../04-prior-art/open-source-landscape.md](../04-prior-art/open-source-landscape.md) |

Full obligations table: [licensing-matrix.md](licensing-matrix.md).

---

## The two-phase data strategy

**Phase 1 — aggregate, don't ingest.** Use [Open-Meteo](https://open-meteo.com) for
wind, waves, and currents. One HTTP call, JSON out, no GRIB decoding, no storage, no
cron. This gets a working router in days instead of weeks, and Open-Meteo already
carries GFS, ECMWF IFS, ICON, ARPEGE, AROME, GEM, HRRR and the major wave models. Its
non-commercial tier is free and keyless.

**Phase 2 — ingest raw.** Pull GRIB2 directly from NOAA/ECMWF/DWD to our own store when
we need: full 2-D fields (not point queries) for routing, ensembles, custom
parameters, our own caching and offline packaging, or commercial use without a
per-request dependency.

Phase 1 is not a throwaway — it stays as the fallback path and the low-bandwidth path.

**Why this ordering matters:** routing needs *fields*, not points. A point-query API can
serve a route once you have a candidate path, but the isochrone expansion evaluates wind
at thousands of (lat, lon, t) tuples per run. Open-Meteo does support multi-point
queries, but past a few hundred points per route, pulling the GRIB subset once and
interpolating locally is both faster and politer. Plan the interface so the swap is one
class.

---

## What we lose versus Expedition, honestly

| Gap | Impact | Mitigation |
|---|---|---|
| No Tidetech / SHOM high-res tidal atlases | Weaker inshore current in Solent, Brittany, Golfe de Gascogne | NOAA OFS models (US), CMEMS, harmonic constituents; be explicit about resolution in the UI |
| No Expedition WRF nests (1/108° ≈ 1 km) | Weaker sea-breeze and terrain effects at venues | Use ICON-D2 (2.2 km), AROME (1.3 km), HRRR (3 km) where they cover the venue |
| No S-63 encrypted ENC | No official charts outside free national providers | NOAA ENC covers US; OpenSeaMap covers the world at lower assurance. Say so loudly. |
| No commercial ensemble products | Weaker confidence estimates | GEFS (31 members) and ECMWF ENS are both free |
| Non-US chart coverage is patchy | Real limitation outside the US | Several countries publish free ENC (see charts doc); otherwise OpenSeaMap + GEBCO |

None of these block a phone app for a junior sailor at a club, a college team, or a
coastal club racer — which is the target user.
