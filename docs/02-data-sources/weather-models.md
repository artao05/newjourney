# Weather Models and Forecast Data

Everything here is free to access. Licence obligations are summarised in
[licensing-matrix.md](licensing-matrix.md).

---

## 1. Aggregator: Open-Meteo (recommended starting point)

<https://open-meteo.com> · <https://github.com/open-meteo/open-meteo> (AGPL-3.0 server)

Open-Meteo is an open-source weather API that ingests the major national models and
serves them as JSON, with no API key on the free non-commercial tier.

**Endpoints we care about**

| API | Base URL | Gives us |
|---|---|---|
| Forecast | `https://api.open-meteo.com/v1/forecast` | wind at 10 m (speed/direction/gusts), MSLP, temperature, dew point, humidity, cloud, precipitation, CAPE |
| Marine | `https://marine-api.open-meteo.com/v1/marine` | wave height / direction / period (mean, wind, swell, secondary, tertiary), peak period, **ocean current velocity and direction**, SST, sea level height |
| Ensemble | `https://ensemble-api.open-meteo.com/v1/ensemble` | GFS/ICON/ECMWF ensemble members |
| Historical | `https://archive-api.open-meteo.com/v1/archive` | ERA5 reanalysis back to 1940 — useful for polar fitting from old tracks |

**Marine model coverage** (from the Open-Meteo marine docs):

| Model | Region | Resolution | Horizon | Update |
|---|---|---|---|---|
| MeteoFrance MFWAM | Global | 0.08° (~8 km) | 10 d | 12 h |
| ECMWF WAM | Global | 9 km | 15 d | 6 h |
| NCEP GFS Wave 0.25° | Global | 0.25° | 16 d | 6 h |
| NCEP GFS Wave 0.16° | 52.5°N–15°S | 0.16° | 16 d | 6 h |
| DWD EWAM | Europe | 0.05° (~5 km) | 8 d | 12 h |
| ERA5-Ocean | Global | 0.5° | historical | daily |

**Terms.** Free for non-commercial use with attribution (to Open-Meteo and, for
DWD-derived data, to DWD). Commercial use requires a paid key. The server is AGPL-3.0 and
**self-hostable**, which is the important part: if we outgrow the hosted free tier or go
commercial, we can run the same stack ourselves rather than rewriting our data layer.

**Why start here:** it eliminates GRIB decoding, model-run scheduling, storage, and
interpolation from the critical path. A functioning weather-routing prototype is a
weekend, not a month.

**Where it runs out:** point queries, not gridded fields; no control over caching for
offline; non-commercial terms. See the phase-2 plan in [README.md](README.md).

---

## 2. NOAA GFS — the global baseline

The workhorse. Public domain, no key, no terms.

| Property | Value |
|---|---|
| Resolution | 0.25° global (also 0.5°, 1.0°) |
| Cadence | 4 runs/day (00/06/12/18Z) |
| Horizon | 384 h; hourly to 120 h, then 3-hourly |
| Latency | ~3.5–5 h after synoptic hour |
| Format | GRIB2 |

**Access paths**

1. **NOMADS GRIB filter** — subset by parameter, level, and bounding box server-side.
   Base: `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl`
   Docs: <https://nomads.ncep.noaa.gov/info.php?page=gribfilter>
   This is the single most valuable endpoint for us: we ask for `UGRD`/`VGRD` at
   `10_m_above_ground` plus `PRMSL` over a 10° box and get a file measured in kilobytes.
   NOMADS asks users to be gentle — it is a shared public resource with hit-rate limits.

2. **AWS Open Data mirror** — `s3://noaa-gfs-bdp-pds` (no-sign-request), registry entry
   at <https://registry.opendata.aws/noaa-gfs-bdp-pds/>. No rate limits, high
   throughput, but you fetch whole files unless you use `.idx` byte-range tricks (see
   below). Mirrors also exist on Google Cloud and Azure.

3. **Byte-range subsetting via `.idx`** — every GRIB2 file has a companion `.idx` listing
   each message's byte offset. Fetch the `.idx` (a few KB), find the messages you want,
   then issue HTTP `Range` requests for just those bytes. This gives NOMADS-style
   subsetting with S3-style reliability, and it is how the Python `Herbie` library works
   (<https://herbie.readthedocs.io>). **This is the technique to build on.**

**Related NOAA models**

| Model | Resolution | Coverage | Use |
|---|---|---|---|
| **GEFS** | 0.5°, 31 members | Global | Ensemble confidence |
| **GFS-Wave** | 0.25° / 0.16° | Global | Significant height, swell/wind-wave partitions, period, direction |
| **HRRR** | 3 km, hourly | CONUS + Alaska | Sea/lake breeze, thermal gradients — huge for US inshore racing |
| **NBM** | 2.5 km | CONUS, AK, HI, PR | Statistically blended multi-model; the operational US forecast |
| **NAM / NAM nests** | 12 km / 3 km | North America | |
| **RTOFS** | 1/12° global HYCOM | Global ocean | Currents — see [tides-and-currents.md](tides-and-currents.md) |
| **NOAA OFS** (CBOFS, DBOFS, NYOFS, SFBOFS, …) | ~100 m–1 km | US estuaries | Best free inshore current data anywhere |

---

## 3. ECMWF open data — the quality leader

As of the 2025 policy change, **ECMWF's entire real-time catalogue is open under
CC-BY-4.0**, with the free/open tier at 0.25° since March 2024 and 9 km forecasts due to
join the free tier later in 2026 (with ~2 h latency).

| Property | Value |
|---|---|
| Models | IFS (physics) and **AIFS** (ECMWF's ML model) |
| Resolution | 0.25° free tier; 9 km coming |
| Cadence | 00/06/12/18Z |
| Horizon | 240 h (00/12Z), 90 h (06/18Z) |
| Licence | **CC-BY-4.0** — commercial use and redistribution permitted with attribution |
| Access | `ecmwf-opendata` Python client; AWS `s3://ecmwf-forecasts`; <https://data.ecmwf.int/forecasts/> |

Docs: <https://confluence.ecmwf.int/display/DAC/ECMWF+open+data%3A+real-time+forecasts+from+IFS+and+AIFS>
AWS registry: <https://registry.opendata.aws/ecmwf-forecasts/>

**Why it matters:** ECMWF has for years been the model offshore navigators trust most,
and until recently getting it meant paying Saildocs/Squid/Expedition. CC-BY-4.0 means we
can serve it to users, including commercially, with attribution. This is arguably the
single biggest change that makes this project viable now and not five years ago.

**AIFS is worth watching.** ML forecasts run in minutes rather than hours on
supercomputers, which changes the economics of running our own ensemble routing.

---

## 4. DWD ICON — free, high-res, Europe-strong

| Model | Resolution | Coverage | Horizon |
|---|---|---|---|
| ICON global | 13 km (0.125°) | Global | 180 h |
| ICON-EU | 6.5 km | Europe | 120 h |
| ICON-D2 | 2.2 km | Central Europe | 48 h |

Open data server: <https://opendata.dwd.de/weather/nwp/> — plain HTTP directory listing
of GRIB2, no key, updated continuously.
Licence: CC-BY-4.0 with a required DWD attribution notice
(<https://www.dwd.de/EN/service/copyright/copyright_node.html>).

ICON-D2 at 2.2 km is in the same class as Expedition's mid-tier WRF nests, for free.

---

## 5. Other national models worth having

| Model | Provider | Resolution | Notes |
|---|---|---|---|
| **ARPEGE** | Météo-France | 0.1° Europe / 0.25° global | Free open data portal, requires a key |
| **AROME** | Météo-France | 1.3 km France | Excellent for Med/Brittany venues |
| **GDPS / HRDPS** | ECCC (Canada) | 15 km / 2.5 km | Open licence, good for Great Lakes and NE coast |
| **UM / UKV** | UK Met Office | ~10 km / 1.5 km | Some open data via the Met Office DataHub; check terms per product |
| **ACCESS** | BoM (Australia) | 12 km / 1.5 km | Relevant for Sydney–Hobart-class venues |
| **NAVGEM** | US Navy | 0.5° | Available via Saildocs; lower priority |

Expedition's own GRIB server offers GFS 0.11°/0.25°, UM 0.1°, ECMWF 0.2°, ICON 0.1°,
GDPS 0.15°, ARPEGE 0.1–0.25°, NBM 0.09°, and Mercator 1/12°. Note those are *interpolated*
resolutions — Expedition is upsampling native grids for delivery. We should not copy that;
serving 0.11° GFS when the native grid is 0.25° implies a precision the model doesn't have.

---

## 6. Observations (ground truth)

| Source | What | Access |
|---|---|---|
| **NDBC** | Moored buoy + C-MAN wind, waves, pressure, SST | `https://www.ndbc.noaa.gov/data/realtime2/` (plain text), also a THREDDS/ERDDAP service |
| **NWS/METAR** | Airport observations | `https://aviationweather.gov/api/` |
| **NOAA CO-OPS met** | Wind/pressure/temp at tide stations | Same API as tides |
| **Met Office / DWD / MF station data** | Regional | Varies |
| **Windy/PWS networks** | Crowd-sourced | Mostly paid or restricted |

Expedition uses SailFlow (paid) for this. NDBC + METAR covers most US coastal racing for
free, and comparing `TWS predicted` to a nearby buoy is one of the highest-value
teaching displays we can build — it shows a beginner, concretely, how much to trust a
forecast.

**RainViewer** (<https://www.rainviewer.com/api.html>) offers free radar tiles with a
generous non-commercial tier — the direct equivalent of Expedition's Rainviewer
integration. NWS MRMS is the free US-only alternative.

---

## 7. Practical notes on GRIB2 handling

- **Always work in u/v components**, never speed/direction, until the final render.
  Interpolating direction across 0°/360° is a classic and invisible bug.
- **Parameter names we need:** `UGRD`/`VGRD` at 10 m, `GUST`, `PRMSL`, `TMP` at 2 m,
  `DPT`, `RH`, `APCP`, `TCDC`, `CAPE`; waves: `HTSGW`, `SWELL`, `SWDIR`, `SWPER`,
  `WVHGT`, `WVDIR`, `WVPER`, `PERPW`, `DIRPW`; currents: `UOGRD`/`VOGRD`.
- **Decoding in JS:** `grib2-simple` (pure JS, Node, DWD-focused) is the most mature
  small option; a wgrib2-compatible JS reader also exists. For anything serious,
  decode server-side with `eccodes`/`cfgrib`/`xarray` (Python) or `wgrib2`, and serve
  our own compact binary format to the client. **Do not decode GRIB in the browser.**
- **Our wire format to the client** should be a small typed-array blob: header with
  bbox/grid/time axis, then `Int16` u/v scaled by a factor. A 60×60 grid × 40 time steps
  × 2 components ≈ 576 KB raw, ~150 KB gzipped. That is a perfectly reasonable payload
  for a race-day download and is the basis of the offline mode.
- **Cadence-aware caching:** GFS 00Z is complete around 04:00–05:30Z. Cache keyed on
  `(model, run, bbox, params)` with a TTL that expires at the next expected run.

---

## 8. Recommended default stack

| Layer | Choice | Why |
|---|---|---|
| Default global model | **ECMWF IFS 0.25°** | Best skill, CC-BY-4.0 |
| Fallback / cross-check | **GFS 0.25°** | Always available, public domain, 4×/day |
| Ensemble | **GEFS** then ECMWF ENS | Confidence bands |
| Europe inshore | **ICON-D2 / AROME** | 1–2 km |
| US inshore | **HRRR / NBM** | 2.5–3 km |
| Waves | **GFS-Wave** global, **EWAM** Europe | |
| Ocean current | **RTOFS** global, **NOAA OFS** US estuaries | |
| Observations | **NDBC + METAR** | |
| Phase-1 shortcut for all of the above | **Open-Meteo** | Ship something this month |

Offering *two* models and showing where they disagree is more honest — and more
educational — than offering fifteen and letting the user pick one they don't understand.
