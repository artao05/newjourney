# Tides and Currents

Current is where races are won and lost inshore, and it is the data layer most consumer
sailing apps get wrong or skip. Expedition treats it as a first-class routing input with
explicit precedence over GRIB currents. We should too.

---

## 1. NOAA CO-OPS — US tides and currents, free, no key

**Data API:** `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
**Metadata API:** `https://api.tidesandcurrents.noaa.gov/mdapi/prod/`
Docs: <https://api.tidesandcurrents.noaa.gov/api/prod/>

| Parameter | Notes |
|---|---|
| `station` | 7-char water-level station ID (e.g. `9414290`) or a currents station ID (e.g. `cb1401`) |
| `product` | `predictions`, `water_level`, `high_low`, `hourly_height`, `currents`, `currents_predictions`, `ofs_water_level`, plus met products (`wind`, `air_pressure`, `water_temperature`, …) |
| `datum` | MLLW, MHHW, MHW, MLW, MTL, MSL, NAVD, STND, IGLD, LWD — required for water level |
| `time_zone` | `gmt`, `lst`, `lst_ldt` |
| `format` | `json`, `xml`, `csv` |
| `interval` | `h`, `hilo`, `6` (minutes), `MAX_SLACK` for currents |
| `application` | Identify ourselves in their logs — good citizenship, and they ask for it |

**Limits:** the API throttles under load and recommends sleeps between successive calls.
Range limits by interval: 1-minute → 4 days, 6-minute → 1 month, hourly → 1 year, daily
means → 10 years.

**Coverage:** ~3,000 water-level stations and a large tidal-current station network across
US waters, including harmonic constituents exposed through the metadata API.

**Implication:** because constituents are published, we can compute predictions
**offline on-device**, not just fetch them. That is the difference between "tide works
when you have signal" and "tide works."

---

## 2. XTide and harmonic prediction — offline tides

<https://flaterco.com/xtide/>

XTide is the long-standing open tide-prediction program; its harmonic data file
(`harmonics-dwf-*.tcd`) carries constituents for thousands of US and some international
stations, mostly sourced from NOAA. Expedition bundles a copy — its manual: *"XTide is a
nice repository of tides and currents for the USA. These are mostly sourced from NOAA
and are relatively up to date."*

**The math is simple and worth implementing directly:**

```
h(t) = H₀ + Σᵢ  fᵢ · Aᵢ · cos( ωᵢ·t + (V₀+u)ᵢ − κᵢ )
```

where for each constituent *i*: `Aᵢ` is amplitude and `κᵢ` phase lag (both per-station,
from the constituent table), `ωᵢ` is the constituent's known angular speed, and `fᵢ` /
`(V₀+u)ᵢ` are the node factor and equilibrium argument (functions of astronomical
longitudes for the year — the fiddly part). NOAA's operational predictions use 37
constituents.

Tidal **currents** use the same formulation with amplitude in knots and separate
flood/ebb directions (or a rotary-current formulation of u/v constituents).

References: <https://tidesandcurrents.noaa.gov/about_harmonic_constituents>;
Python `pytides`/`pytmd`; XTide's own `libtcd` for the file format (LGPL — check before
linking).

**Licence care:** XTide itself is GPL; `libtcd` is LGPL; the *harmonic data* is largely
NOAA public-domain but the packaged TCD files carry their own notices. Cleanest path: pull
constituents from the **NOAA metadata API** ourselves and implement the summation in our
own code. No licence entanglement, same numbers.

---

## 3. NOAA Operational Forecast Systems (OFS) — the best free inshore currents

Model nowcast/forecast systems for US estuaries and coastal regions, at resolutions from
~100 m to ~1 km, run 4×/day with ~48 h forecasts:

CBOFS (Chesapeake), DBOFS (Delaware), TBOFS (Tampa), NYOFS/NYHOPS (NY/NJ), SFBOFS (San
Francisco), NGOFS (N. Gulf), LOOFS/LMHOFS etc. (Great Lakes), plus STOFS (surge and
tide, global/coastal).

Access: NOMADS (`https://nomads.ncep.noaa.gov/`), NCEI archive, and CO-OPS
`ofs_water_level`. Output is netCDF on unstructured (FVCOM) or curvilinear (ROMS) grids —
harder to consume than GRIB, but this is the free data that makes San Francisco,
Chesapeake and Long Island Sound racing tractable.

Expedition's own honesty on model currents is worth repeating in our UI:

> "The tidal currents from model predictions… are just that - models. They may not show
> features in complicated situations… For example, the San Francisco model doesn't show
> the tide changing first inshore along the city front. This is because the effect is
> mostly smaller than the resolution of the model."

---

## 4. Global ocean currents

| Source | Resolution | Access | Licence |
|---|---|---|---|
| **NOAA Global RTOFS** (1/12° HYCOM) | 1/12°, 8-day forecast, daily | NOMADS GRIB2; AWS `s3://noaa-nws-rtofs-pds`; registry: <https://registry.opendata.aws/noaa-rtofs/> | Public domain |
| **CMEMS / Copernicus Marine** GLOBAL_ANALYSISFORECAST_PHY_001_024 | 1/12°, 10-day | `copernicusmarine` Python toolbox; netCDF; free but **registration required** | Copernicus licence — free, incl. commercial, with attribution |
| **Mercator Ocean** | 1/12° | Underlies CMEMS; Expedition sells it via its GRIB server | |
| **OSCAR** | 1/3°, 5-day mean | NASA/PODAAC | Public domain |
| **HYCOM** | 1/12° | <https://www.hycom.org/> | Free |

**Practical stack:** RTOFS as the default (public domain, GRIB2, no registration), CMEMS
as the quality alternative where we can accept registration, NOAA OFS wherever it covers
the venue, and harmonic constituents inshore where OFS doesn't reach.

---

## 5. Precedence — copy Expedition here

Expedition resolves current sources by priority, not by merging:

> "Tidal stream data is used in preference to grib current data where both are present.
> So for example in a Newport to Bermuda race, Expedition will use tidal stream
> predictions to start with then start using your grib data containing Gulf Stream
> information when you get away from land."

Our recommended precedence, highest first:

1. User-held / "What-if?" current (manual override)
2. Live measured set & drift (if instruments are connected) — near-field only, decaying
   with time and distance
3. High-resolution regional model (NOAA OFS)
4. Harmonic tidal-current station prediction, spatially blended
5. Global ocean model (RTOFS / CMEMS)
6. Nothing — and say "no current data here" rather than silently using zero

That last point matters. Silently substituting zero current is *worse* than saying
nothing, because it produces a confidently wrong route.

---

## 6. Feature parity notes vs. Expedition

| Expedition feature | Our equivalent |
|---|---|
| XTide TCD bundled | NOAA constituents fetched + our own harmonic engine, cached offline |
| SHOM 2-D tidal current atlases (France) | **No free equivalent.** CMEMS + harmonics; degraded inshore in Brittany/Normandy |
| Winning Tides (Solent, licensed) | No free equivalent; UKHO tidal diamonds data is paid |
| Tidetech (paid) | CMEMS / RTOFS |
| Tidal diamonds | Chart-derived; ENC has `TS_PRH`/`TS_PNH` tidal stream objects where surveyed |
| "Scale currents %" | Same idea, trivially |
| "Tidal stream offset" (time shift, resets on restart) | Copy it, including the reset-on-restart behaviour — that design choice forces it to be a conscious decision each time |
| Track currents (current inferred from own track history) | Copy — needs only GPS + speed through water |

---

## 7. Implementation sketch

```
interface CurrentProvider {
  // Returns current at a point/time, plus its provenance, or null if unknown.
  get(lat, lon, t): { u: number, v: number, source: string, resolutionKm: number } | null
}
```

A `StackedCurrentProvider` walks providers in precedence order and returns the first
non-null answer *with the source attached*. Attaching provenance is what makes the
"where did this come from?" tooltip possible, and it costs nothing.

For routing, hydrate this into a gridded cache over the route bounding box before the
optimisation starts — per-point provider dispatch inside the inner loop of an isochrone
expansion will dominate runtime otherwise.
