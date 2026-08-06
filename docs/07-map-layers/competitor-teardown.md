# What PredictWind and SeaLegs Actually Do for Charting and Mapping

Research question: *what do these apps use for charting and mapping, so we can build a
fully functional wind/wave/map layer?*

The answer contains a surprise that changes our roadmap, so it goes first.

---

## The headline finding

**Neither PredictWind nor SeaLegs does charting at all.**

PredictWind ships no nautical charts. No ENC, no Navionics, no C-MAP. Their own
integration documentation describes the **DataHub feeding NMEA data over Wi-Fi *to*
Navionics, Aqua Map or OpenCPN** — they explicitly hand charting to somebody else's app
and keep the weather.

SeaLegs is blunter still. Their own material states the app "is for marine weather
forecasting over the open ocean. It is not to be used for navigational purposes."

So when either app shows you a "map", it is a **basemap plus data layers**. The map is a
backdrop for the weather, not a chart you navigate on.

**Why this matters to us.** Two things follow:

1. The thing we were treating as a hard, expensive dependency — real chart data — is a
   feature the two market leaders in this space have *declined to build*. NOAA ENC is
   free. If we render it, we are doing something PredictWind chose not to do, not
   catching up to them.
2. What we actually have to match is not cartography. It is a **data-layer rendering
   engine**: streamlines, barbs, colour fields, time animation, model switching. That is
   a well-understood GPU problem with open prior art, and it is achievable.

The competitive read: *PredictWind wins on models and layer rendering. It concedes
charting. Nobody in the phone-first tier does both.*

---

## PredictWind, in detail

### Data layers offered

Wind · gust · CAPE · wave · currents · rain · cloud · isobars · air temperature ·
sea temperature. (Cloud and isobars have no display options; everything else does.)

### The three render modes — this is the core of the product

| Mode | What it is |
|---|---|
| **Streamlines** | "smooth, flowing lines representing wind direction and intensity" — continuous flow across the map |
| **Feathers** | Conventional wind barbs; feather count encodes speed, stem encodes direction |
| **Directional arrows** | Arrows coloured by speed, arrowhead showing direction |

Offering all three is not indecision — it is the correct answer. Barbs are what a
forecaster reads and what a racing sailor was taught. Streamlines make gradients and
convergence lines obvious at a glance. Arrows are the fastest to read at speed. Different
questions want different marks.

### Resolution and models

- Grid resolutions exposed to the user: **1 km / 8 km** (high-res) through
  **50 km / 100 km** (synoptic).
- Models: **PWG, PWE, ECMWF, GFS, AIFS, UKMO, PW AI, ICON, HRRR, NAM, AROME.**

`PWG` and `PWE` are PredictWind's own proprietary runs — in effect their own WRF-class
nests initialised from GFS and ECMWF respectively. That 1 km tier is the thing you
cannot get free, and it is a real moat: it is compute, not code.

Note `AIFS` and `PW AI` in that list. Both leaders are already shipping ML forecast
models alongside physics ones. ECMWF's AIFS is in the **free CC-BY-4.0 open tier** — so
this specific capability is available to us at zero cost.

### Currents

Three products, which is more nuanced than most apps:

| Product | Role |
|---|---|
| **Mercator** | Global ocean current model |
| **RTOFS** | NOAA's Real-Time Ocean Forecast System |
| **"Tidal and Ocean"** | Coastal — because, in their own words, "the Mercator and RTOFS are Ocean Current Models so will not have data close to shore" |

Resolutions: **100 m / 400 m / 4 km / 50 km**.

This is exactly the precedence problem Expedition solves and that we documented in
[../02-data-sources/tides-and-currents.md §5](../02-data-sources/tides-and-currents.md#5-precedence--copy-expedition-here).
Three independent sources confirming that inshore current needs a separate, finer product
than the global ocean model is a strong signal we got that call right.

Both Mercator (via CMEMS) and RTOFS are **free to us**. The 100 m coastal tier is
proprietary; our free equivalent is NOAA's OFS estuary models plus harmonic constituents.

### Interaction features worth stealing

- **Split-screen comparison** — two models, or two times, side by side. This is the
  honest way to show forecast uncertainty, and it is philosophically the same idea as our
  route sensitivity band.
- **Animation with adjustable playback speed.**
- **Expanded/full-screen inspection mode.**
- **GMDSS overlay** for maritime safety warnings.

---

## SeaLegs, in detail

A different product aimed at a different user — fishing and day-boating rather than
racing.

**Layers:** sea surface temperature, chlorophyll, bathymetry, thermocline, ocean
currents, eddies, thermal fronts. The pitch is reading temperature breaks, colour edges
and depth contours — i.e. finding fish, not sailing fast.

**Models:** marketing says ECMWF, GFS, ICON; the developer docs say "GFS, NAM, HRRR and
other leading weather models." Take the API docs as authoritative.

**The actual product** is not the map. It is an AI verdict — **Go / Caution / Avoid** for
your route and departure time, with hourly detail and a suggested alternative time if
today is marginal — plus an embeddable `SpotCast` widget and a single
`POST /v3/spotcast` API endpoint.

**No tile products, chart data, or map infrastructure are disclosed anywhere in their
public documentation.**

**What is worth learning from them:** the decision-support framing. A beginner does not
want a wind field, they want to know whether to go. Our equivalent of Go/Caution/Avoid
already exists conceptually — it is the route confidence band — and their success
suggests we should surface a plain-language verdict, not only a shaded envelope.

**What is worth avoiding:** an AI verdict with a stated "95% confidence" on a marine
forecast is a precision claim that a forecast cannot support. Our
[product principles](../05-spec/product-spec.md) commit us to the opposite.

---

## Side by side

| | PredictWind | SeaLegs | Expedition | **us, today** | **us, target** |
|---|---|---|---|---|---|
| Nautical charts | ❌ none | ❌ none | ✅ S-57/S-63/C-MAP | OSM + OpenSeaMap raster | **NOAA ENC vector** |
| Basemap | custom | custom | — | OSM raster | custom vector |
| Bathymetry | ❌ | ✅ | ✅ | ✅ GEBCO 15″ venue pack | GEBCO + CUDEM |
| Wind: streamlines | ✅ | — | ❌ | ✅ GPU | ✅ |
| Wind: barbs | ✅ | — | ✅ | ✅ | ✅ |
| Wind: arrows | ✅ | — | ✅ | ✅ | ✅ |
| Wave layer | ✅ | ✅ | ✅ | ❌ **removed on purpose** | P2 |
| Current layer | ✅ 3 products | ✅ | ✅ | ✅ ocean model + speed labels | ✅ |
| Tidal current turn times | ✅ | ❌ | ✅ | ✅ NOAA CO-OPS station | ✅ |
| SST | ✅ | ✅ | ✅ | ❌ (no fetcher) | ✅ |
| Gust as its own layer | ✅ | — | ✅ | ❌ **removed on purpose** | ❌ |
| Pressure as its own layer | ✅ | — | ✅ | ❌ **removed on purpose** | ❌ |
| Time animation | ✅ w/ speed | — | ✅ | ✅ w/ speed | ✅ |
| Model switching | ✅ 11 models | ❌ | ✅ 15+ | ✅ 6 | ✅ 4–6 |
| Split-screen compare | ✅ | ❌ | ❌ | ❌ | P2 |
| Own 1 km model | ✅ PWG/PWE | ❌ | ✅ WRF | ❌ | ❌ (real moat) |
| Free | ❌ | partly | ❌ | ✅ | ✅ |
| Racing tactics | ❌ | ❌ | ✅ | ✅ | ✅ |

The two columns that matter: **we already have the racing tactics neither of them has,
and they have the layer rendering we don't.** The rendering is the smaller gap.

Three rows are deliberate subtractions rather than gaps. A gust is a number you want at a
point, not a full-screen wash of colour; mean sea-level pressure is not something an
inshore racer sails on; and significant wave height across a bay 30 km wide is a
near-uniform smear that told nobody anything, so the Weather screen no longer even
downloads it. Gust and pressure are still fetched and still appear in the tap-to-inspect
readout, gust is still a routing constraint, and the router can still fetch waves and
limit on them (`maxWaveHeightM`) — the chips went, not the plumbing. Matching a
competitor's layer list is not the goal; three layers a sailor uses beats five they
scroll past.

The row that replaced it is bathymetry, which is the one layer on this table neither
competitor treats as tactical and every sailor in a shoal-draft bay reads first. Ours is
a 49 kB GEBCO 2020 venue pack drawn as discrete depth bands, and its limits are measured
rather than assumed: 18 m out against NOAA's published depth at buoy 44007, referenced to
MSL rather than a chart datum, and blind to anything narrower than 450 m. It is a display
layer, deliberately not wired to the router — the same separation as the chart-data caveat
below. Being able to see where the shoals are, with the error stated, beats not knowing;
it does not begin to approach a chart.

One row is a source correction worth recording. The current *field* comes from a global
ocean model, and measured over Casco Bay that model gives 0.05–0.54 kn with **zero
direction reversals in 48 hours** while the NOAA station 4 km away predicts 1.17 kn
reversing every six. So the field and the turn times come from different products, and the
UI says which is which rather than blending them — the precedence rule in
[../02-data-sources/portland-maine-pilot.md](../02-data-sources/portland-maine-pilot.md)
forbids averaging unrelated products, and this is exactly the case it exists for.

---

## What "fully functional" actually requires

Six things, in dependency order:

1. **A GPU data-layer engine** — u/v encoded into a texture, particles advected on the
   GPU, scalar fields drawn as smooth colour ramps. See
   [render-architecture.md](render-architecture.md).
2. **Three render modes for vector fields** — streamlines, barbs, arrows.
3. **Smooth scalar fields** — wave height, SST, rain, pressure. Bilinear-sampled with a
   colour LUT. A blocky field is the visible signature of a naive implementation.
4. **A time axis in the UI** — scrub and animate. Our `WeatherCube` already carries
   `nt` time steps; the Route screen currently draws only index 0, so the data is there
   and unused.
5. **Model and resolution selection**, with the source visible.
6. **A legend and colour scale** on every layer. A colour field without a scale is
   decoration.

### Where we already are

Better placed than the gap table suggests. `src/lib/weather/` already produces a
`WeatherCube` with `Float32Array` u/v components over a regular lat/lon grid with `nt`
time steps — **which is precisely the input a GPU particle layer wants**. The ingest,
the compression and the interpolation are done. What is missing is the renderer.

### The honest chart-data caveat

`RouteScreen.tsx` used to disable land avoidance outright, on the correct grounds that an
OSM raster basemap is not a routing-grade obstacle mask. It now enables it from a
purpose-built 111 m raster (`src/data/landmask.ts`) and reports at runtime whether that
pack actually loaded. Rendering ENC would not by itself have changed anything: **a chart
you can see is not the same as a coastline the router can test against.** Those are two
separate deliverables — vector chart tiles for the eye, and validated geometry for the
router — and they stay separately tracked. The depth layer is the same distinction
applied to soundings: a bathymetry wash for the eye is not a safety contour the router
can test against, and the router does not read it.

---

## Recommended sequence

| # | Work | Why here |
|---|---|---|
| 1 | Time scrubber + animation over the existing cube | Pure UI, zero new data, immediately makes the fetched forecast useful |
| 2 | Barbs + coloured arrows with a legend | Barbs are what racers read; cheap with MapLibre symbol layers |
| 3 | Smooth scalar field layer (wave height, then SST) | Data is already fetched and thrown away |
| 4 | GPU streamline/particle layer | The visual signature of a serious weather app |
| 5 | Model + resolution picker with provenance shown | We have ECMWF/GFS/ICON/AIFS free |
| 6 | Current layer with the 3-tier precedence | Matches PredictWind's structure using free sources |
| 7 | NOAA ENC vector chart tiles | The differentiator neither competitor has |
| 8 | Routing-grade coastline package | Unblocks `HAS_ROUTING_LAND_DATA` |

Items 1–3 are days of work against data we already download. Item 4 is the one with
real technical depth. Item 7 is the one that makes us different rather than equal.

## Sources

- PredictWind app page — <https://www.predictwind.com/apps/predictwind-app>
- PredictWind, *How to use Maps in the PredictWind App* —
  <https://help.predictwind.com/en/articles/9954516-how-to-use-maps-in-the-predictwind-app>
- PredictWind, *FAQ: Current Maps* —
  <https://help.predictwind.com/en/articles/9628351-faq-predictwind-current-maps>
- PredictWind, *DataHub connecting by Wi-Fi to Navionics, Aquamaps or OpenCPN* —
  <https://help.predictwind.com/en/articles/8332728-datahub-connecting-by-wi-fi-to-navionics-aquamaps-or-opencpn-to-receive-nmea-data>
- PredictWind weather routing — <https://www.predictwind.com/features/weather-routing>
- SeaLegs AI app — <https://www.sealegs.ai/app> · FAQ — <https://www.sealegs.ai/faq>
- SeaLegs developer API — <https://developer.sealegs.ai/> · FAQ —
  <https://developer.sealegs.ai/faq/>

*Note on method: `forecast.predictwind.com` is behind a login wall, so the rendering
pipeline was not inspected directly — no account was used. Everything above comes from
public product and help documentation. The render-mode names, model list, resolutions and
current products are quoted from PredictWind's own help pages.*
