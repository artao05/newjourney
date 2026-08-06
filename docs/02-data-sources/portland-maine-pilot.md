# Portland, Maine / Casco Bay Pilot Data Manifest

This is the first venue pack for Newjourney: a race-first pilot spanning Portland
Harbor and Casco Bay. It defines the data sources that must be available before the
venue is presented as a supported race location.

This document names the data sources and their operational roles. It does not make
the app an aid to navigation: show source, model run, valid time, and freshness next
to every operational layer.

## Venue extent

| Setting | Value |
|---|---|
| Venue ID | `portland-maine` |
| Full pilot bbox (west, south, east, north) | `[-70.34, 43.53, -69.98, 43.79]` |
| Default map centre | `43.655, -70.205` |
| Default map zoom | `11.5` |
| Race-area bbox | `[-70.27, 43.60, -70.12, 43.72]` |
| Time zone | `America/New_York` |
| Tidal datum for displayed heights | `MLLW` |

The full bbox covers Portland Harbor, the inner and outer Casco Bay islands, and the
approaches near Cape Elizabeth. The smaller race-area bbox is the initial map framing
for club racing; routes may expand to the full pilot extent.

## Source manifest

### Charts, shoreline, and safety context

| Source | Identifier / endpoint | Role | Notes |
|---|---|---|---|
| NOAA ENC presentation | <https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService> | Primary on-map nautical-chart layer | Use the live NOAA presentation service for chart display. Do not treat retired paper-chart imagery as current chart data. |
| NOAA ENC downloads | <https://charts.noaa.gov/ENCs/ENCs.shtml> | Offline vector-chart ingest | Discover current cells from the NOAA ENC Product Catalog rather than hard-coding legacy cell names. |
| NOAA ENC status | <https://encdirect.noaa.gov/arcgis/rest/services/MarineChart_Services/Status_New_NOAA_ENCs/MapServer> | Availability/status check | Use during venue-pack building to identify current ENC coverage. |

The legacy references are chart **13292 / US5ME10M** (Portland Harbor) and **13290 /
US5ME13M** (Casco Bay). They remain useful search terms and historical references,
but the corresponding NOAA paper/raster charts were cancelled in 2023. NOAA ENC is
the primary product; see the [NOAA charts overview](https://marinenavigation.noaa.gov/charts.html).

### Bathymetry: the shipped depth layer

| Item | Value |
|---|---|
| Source | GEBCO 2020 Grid, 15 arc-second global bathymetry |
| Access used | NOAA CoastWatch ERDDAP griddap, dataset `GEBCO_2020`, CSV subset |
| Request | `https://coastwatch.pfeg.noaa.gov/erddap/griddap/GEBCO_2020.csv?elevation[(43.38):(43.95)][(-70.55):(-69.8)]` |
| Asset | `public/venue/portland-depth.bin` — 181 x 138 Int16 decimetres, 49 956 bytes |
| Builder | `scripts/build-depth-grid.mjs` |
| Consumer | `src/data/bathymetry.ts`, Weather-screen `Depth` layer |
| Datum | Mean sea level, **not** the MLLW datum used for displayed heights |
| Role | Display only. Not a routing input, not a safety contour. |

Three limits are measured rather than assumed, and all three are stated in the UI:

- **Accuracy.** At NDBC `44007` (43.525, -70.140) GEBCO reads 31 m against NOAA's
  published 49 m water depth for the same mooring — 18 m, at a position known to a metre.
- **Datum.** Station `8418150` datums for the 1983-2001 epoch put MSL at 13.49 ft and
  MLLW at 8.55 ft, so GEBCO depths are **1.51 m optimistic** against a chart. The venue's
  displayed-height datum stays MLLW; this layer is the one place MSL appears, and it is
  labelled.
- **Resolution.** A 450 m cell holds no ledge, rock, jetty or dredged channel, and GEBCO
  calls the island at the venue centre 10 m of water — land the 111 m coastline mask
  resolves correctly. Where the two assets disagree, the coastline mask is the one the
  router trusts.

Cross-check worth keeping: GEBCO puts 44.7% of the shared venue box below sea level and
the independently derived OSM coastline mask puts 44.1% of it in water. Two unrelated
derivations landing within a point of each other is the best validation either asset has.

Higher-resolution replacements, in preference order, are NOAA CUDEM (1/9 arc-second for
US coasts) then ENC `DEPARE`/`DEPCNT` extraction — see
[charts-and-bathymetry.md](charts-and-bathymetry.md) §1 and §5.

### Tide, water level, and local meteorology

Use the [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/datagetter)
with a descriptive `application=newjourney` parameter. Preserve the returned datum,
time zone, station ID, and observation/prediction distinction in stored data.

| Station | ID | Position | Use |
|---|---:|---:|---|
| Portland, ME | `8418150` | 43.6583, -70.2433 | Primary tide/water-level reference and in-harbor meteorological observation: wind, air temperature, water temperature, and pressure. [Station page](https://tidesandcurrents.noaa.gov/stationhome.html?id=8418150). |
| Cow Island, Casco Bay | `8418009` | n/a | Local subordinate tide prediction. |
| Cushing Island, Casco Bay | `8417997` | 43.6450, -70.1983 | Local subordinate tide prediction. |
| Portland Head Light | `8418031` | n/a | Local subordinate tide prediction. |
| Long Island, Casco Bay | `8417941` | n/a | Local subordinate tide prediction. |
| Falmouth Foreside | `8418015` | n/a | Local subordinate tide prediction. |
| Fore River, Portland | `8418268` | n/a | Local subordinate tide prediction. |

Example prediction request (date values are examples):

```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=newjourney&begin_date=20260804&end_date=20260805&datum=MLLW&station=8418150&time_zone=lst_ldt&units=metric&interval=h&format=json
```

The official [station selector](https://tidesandcurrents.noaa.gov/stations.html?type=Datums)
is the source of truth for additions and changes to the subordinate-station list.

### Tidal-current predictions and survey context

| Station | ID | Position | Role |
|---|---:|---:|---|
| Portland Harbor Entrance | `CAB1401` | 43.6280, -70.2095 | Reference tidal-current prediction point. |
| Spring Point, northeast of | `CAB1402` | 43.6537, -70.2227 | In-harbor / entrance harmonic current point. |
| Portland Breakwater Light, 0.3 nmi east | `CAB1403` | 43.6553, -70.2278 | Breakwater current point. |
| Diamond Island Roads | `CAB1404` | 43.6625, -70.2157 | Inner-bay current point. |
| State Pier, Portland Harbor | `CAB1406` | 43.6547, -70.2450 | Harbor current point. |
| Fore River, Portland River Bridge | `CAB1407` | 43.6458, -70.2573 | River current point. |

Request `product=currents_predictions` from the same CO-OPS Data API, for example
with `station=CAB1401`. These are harmonic predictions built from the 2014 Casco Bay
current survey; they are **not** live current sensors. The authoritative survey station
list is the [CO-OPS current data inventory](https://tidesandcurrents.noaa.gov/cdata/StationList?filter=historic&pid=3&type=Current+Data),
and the [Casco Bay technical report](https://tidesandcurrents.noaa.gov/publications/Tech_Rpt_84_CAB_Tech_Report_Final.pdf)
documents the reference station and the survey.

**Implemented** in `src/lib/tides/coops.ts`, feeding the Current view's tidal chart.
Notes from doing it:

- Use **`units=english`** for currents. The response then declares `"feet, knots"`,
  which is what a sailor reads. `units=metric` returns cm/s.
- The endpoint sends permissive CORS headers, so this runs from the browser with no
  key and no proxy.
- Two requests: the plain product for the 6-minute curve, and `interval=MAX_SLACK`
  for the turns. The event rows carry `Type` of `slack`, `flood` or `ebb`, plus
  `meanFloodDir` and `meanEbbDir` on every row. Taking the turns from NOAA rather
  than re-deriving zero crossings keeps our times matching the printed tables —
  measured agreement is within **1 minute** across 8 slacks.
- `Velocity_Major` is **signed along the flood/ebb axis**, so direction at a
  reversing station is binary: the flood bearing or the ebb bearing, never a
  continuously rotating vector.
- Timestamps come back as `'YYYY-MM-DD HH:mm'` with the zone set by `time_zone` and
  **no offset in the string**. We request `gmt` and parse as UTC explicitly;
  `new Date(str)` would read it as local and shift every slack time silently.
- A bad station or range returns **HTTP 200 with an `error` object**, so that has to
  be checked before looking for data — otherwise a nonexistent station reads as calm
  water.

### Operational ocean currents

| Source | Endpoint | Coverage and role |
|---|---|---|
| Gulf of Maine Operational Forecast System (GoMOFS) | <https://opendap.co-ops.nos.noaa.gov/thredds/catalog/NOAA/GOMOFS/MODELS/catalog.html> | Primary gridded current, water-level, water-temperature, and salinity nowcast/forecast for the venue. Discover dated NetCDF files dynamically from the THREDDS catalog. |

GoMOFS runs four times daily (00/06/12/18 UTC), with a six-hour nowcast and a
72-hour forecast. Its approximately 700 m grid is the operational current overlay;
surface the run time and valid time because it is model guidance, not an observation.
NOAA documents the model, resolution, files, and run cadence on the
[GoMOFS information page](https://tidesandcurrents.noaa.gov/ofs/gomofs/gomofs_info.html).

### Wind and waves: observed

| Station | Endpoint | Position | Role |
|---|---|---:|---|
| NDBC Portland / East Hue and Cry Rock | [`44007` station page](https://www.ndbc.noaa.gov/station_page.php?station=44007) and `https://www.ndbc.noaa.gov/data/realtime2/44007.txt` | 43.525, -70.140 | Primary live offshore comparison point: wind, pressure, sea-surface temperature, and directional wave observations. |
| NERACOOS Casco Bay | [`44031` station page](https://www.ndbc.noaa.gov/station_page.php?station=44031) | 43.570, -70.060 | Inner-bay observation where reporting; use only when fresh. |
| NDBC Gulf of Maine | [`44005` station page](https://www.ndbc.noaa.gov/station_page.php?station=44005) | 43.201, -69.127 | Offshore/climatological fallback, not a near-venue substitute. |

NDBC realtime reports are subject to gross-error checking, not final quality control.
Each observation card must show its timestamp and a missing-data state. `44031` and
`44005` can have long availability gaps, so `44007` and CO-OPS `8418150` are the
default observation pair.

### Marine forecast, alerts, and weather fields

| Source | Endpoint / ID | Role |
|---|---|---|
| NWS coastal marine forecast | [`ANZ153` Casco Bay](https://forecast.weather.gov/MapClick.php?TextType=2&zoneid=ANZ153) | Plain-language marine forecast and hazards for the core pilot. |
| NWS forecast-zone API | `https://api.weather.gov/zones/forecast/ANZ153/forecast` | Programmatic Casco Bay forecast. |
| NWS alerts API | `https://api.weather.gov/alerts/active?zone=ANZ153` | Active marine/weather alerts for the core pilot. |
| NWS point discovery | `https://api.weather.gov/points/43.655,-70.205` | Discover current `forecastHourly` and `forecastGridData` endpoints rather than persisting a grid ID. |
| NOAA HRRR | <https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/hrrr.php> | Primary short-range atmospheric model: 3 km, updated hourly over CONUS. |
| NOAA GFS 0.25 degree | <https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl> | Medium-range global fallback and model-comparison field. |

`ANZ153` is the core zone. Include adjacent `ANZ152` (Port Clyde to Cape Elizabeth)
and `ANZ154` (Cape Elizabeth to Merrimack River) once routing crosses the core area.
The [NWS Gray/Portland marine-zone page](https://www.weather.gov/marine/gyxmz) is the
authoritative zone listing. NWS documents its API and its point-to-grid discovery flow
at <https://www.weather.gov/documentation/services-web-API>; it requires an identifying
`User-Agent` and should be cached. Coastal marine grid detail is exposed through
`forecastGridData`.

## Phased ingest order

1. **Venue shell and safety context.** Add the extent, default view, NOAA ENC display,
   and station metadata. Build a visible "data age / source" treatment before adding
   routing inputs.
2. **Race-day observed conditions.** Poll and cache CO-OPS `8418150` and NDBC `44007`.
   Add NWS `ANZ153` forecast and alerts. Treat missing buoy reports as missing, not
   zero wind or wave.
3. **Tide and harmonic current.** *`CAB1401` current predictions are done* — the
   Current view charts the curve with NOAA's slack and peak times and marks the
   station on the map. Still to do: tide *heights* for `8418150` and the subordinate
   stations, and the in-harbor current points (`CAB1402` through `CAB1407`) with
   distinct predicted-current provenance.
4. **Operational current grid.** Ingest and subset GoMOFS by venue bbox and time window.
   Feed its surface current vectors to routing only after recording the model run,
   valid time, grid resolution, and interpolation result.
5. **Atmospheric field and disagreement.** Use HRRR for short-range wind and GFS for
   longer-range/comparison. Compare forecast wind with `8418150` and `44007`; show
   disagreement instead of silently selecting a model.
6. **Offline venue pack.** Persist selected ENC/vector safety data, station metadata,
   latest tide/current predictions, model subsets, and a provenance manifest in local
   storage. Make stale fields visibly stale and expire them rather than presenting
   yesterday's conditions as current.

## Routing precedence for this venue

At a point where multiple current sources overlap, choose one source and preserve its
provenance instead of averaging unrelated products:

1. User/instrument measured set and drift (near-field, time-limited)
2. GoMOFS regional model field
3. CO-OPS harmonic tidal-current prediction
4. Global current model only outside regional coverage
5. No current data - report the absence explicitly

This ordering distinguishes live observations, regional model guidance, and harmonic
predictions. It prevents the app from implying precision it does not have in Portland
Harbor's channels and constricted island passages.
