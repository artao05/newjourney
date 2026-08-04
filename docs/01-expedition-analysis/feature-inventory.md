# Expedition: Complete Feature Inventory

**Source of truth:** the official Expedition help manual, `Expedition.pdf`
(Tasman Bay Navigation Systems Ltd, licence text last updated June 2026),
downloaded from <https://www.expeditionmarine.com/downloads/documents/Expedition.pdf>.
That document is ~600 help topics / ~450,000 characters. Everything in this file is
derived from it plus the product pages at <https://www.expeditionmarine.com/>.

**Vendor:** Tasman Bay Navigation Systems Limited (New Zealand). Author: Nick White,
Volvo Ocean Race navigator and Whitbread winner. In development since the mid-1990s.

**Price:** €1,250 new licence; €275 upgrade for licences bought before 1 Jan 2024
(<https://www.expeditionmarine.com/sales.html>).

**Stated system requirements (verbatim from the manual):** "Windows 11 or 10 with at
least 16GB memory. Windows 11 with minimum 16GB memory and Intel graphics is
recommended. Expedition is a highly multi-threaded application. CPUs with more cores
will increase performance, especially for optimal routing."

That last sentence is the single most important line in the manual for us. Expedition's
routing is CPU-bound and parallel. Ours will run in a browser on a phone, or on a small
server. That constraint drives most of our architecture decisions.

---

## How to read the "Replicate?" column

| Tier | Meaning |
|---|---|
| **P0** | Must exist in the MVP. Without it, the app is not a routing app. |
| **P1** | Strongly wanted, v1.x. Real competitive value, tractable. |
| **P2** | Later. Valuable but expensive or niche. |
| **P3** | Deliberately out of scope. Requires hardware, licences, or a professional user we're not targeting. |

---

## 1. Charting

Expedition is a full chart-plotter that "seamlessly selects, mosaics and rotates charts."

| Feature | Detail from manual | Replicate? | Our approach |
|---|---|---|---|
| S-57 ENC | Official IHO vector charts. WGS-84 datum. | **P0** | NOAA ENC (free, US). Render to vector/raster tiles ourselves, or use NOAA's Chart Display Service. |
| S-63 ENC | Encrypted ENC. Requires User Permit + PERMIT.TXT from a distributor; per-cell licences. | **P3** | Encrypted commercial charts require an OEM licence and a hardware-bound user permit. Not compatible with an open web app. |
| BSB RNC | Raster nautical charts, near-global coverage. | **P2** | NOAA RNCs still exist for some regions; low priority since ENC coverage is better. |
| C-MAP X / 4D / MAX, Navionics | Commercial cartography, incl. SonarChart, multimedia, web store integration. | **P3** | Licensed. Out of scope. |
| Chart mosaicking + auto-select ("Open Best chart") | Picks the best-scale chart to show boat + active mark, auto-pans. | **P1** | A tiled web map does this natively. Free win. |
| Chart rotation (north-up / course-up / head-up / Mercator) | Multiple orientation modes. | **P1** | MapLibre supports bearing/pitch. Cheap. |
| ENC display modes | "Display base" / "Standard display" / "All" — the S-52 ECDIS display categories. Light sectors, safety depth/contour colouring, land features, night palette (dusk-triggered). | **P1** | Implement the three S-52 categories and a night palette. Genuinely useful and genuinely differentiating vs. hobby apps. |
| GPS chart offset | Per-chart manual offset to correct datum/survey error. | **P2** | Niche but trivial. |
| Safe route check | Checks a route against chart hazards. | **P1** | Sample bathymetry + ENC depth areas along the route. High safety value. |
| Custom raster images | Georeferenced user images overlaid on the chart. | **P2** | Useful for sailing instructions / course diagrams. |
| Radar overlay (Koden, Navico/Halo, BR24) | Full radar control: gain, sea clutter, STC/FTC, antenna height, target trails. | **P3** | Requires proprietary radar hardware + protocols. |

**Verdict:** charting is the *easiest* thing to match at MVP level and the *hardest*
to match at ECDIS level. We target "better than a hobby app, honest about not being
ECDIS."

---

## 2. Weather data acquisition

Expedition is, functionally, a GRIB client with an unusually good merge engine.

| Feature | Detail from manual | Replicate? | Our approach |
|---|---|---|---|
| GRIB 1 and GRIB 2 | Reads most common types. No practical limit on files loaded at once. | **P0** | We decode server-side; the phone never sees a GRIB. |
| NetCDF | Some datasets supported, expandable on request. | **P2** | Only if we ingest CMEMS ocean data directly. |
| **Intelligent multi-file merge** | "Expedition can seamlessly merge and use multiple Grib files, automatically using the best available data in the selected Grib files for its calculations." | **P0** | This is a core, under-appreciated feature. See [how-it-computes.md](how-it-computes.md#weather-field-merging). |
| Model catalogue via Expedition's own GRIB server | GFS 0.11°/0.25°, UM 0.1°, ECMWF 0.2°, ICON 0.1°, GDPS 0.15°, Arpège 0.1–0.25°, NBM 0.09°, Mercator 1/12°, plus regional ACCESS, AROME, HARMONIE, HRRR, RAP, ICON-EU/DE, UM-UKV, WRF, OFS, Copernicus. | **P0/P1** | We can get GFS, ECMWF, ICON, GDPS, Arpège, HRRR, NBM, and RTOFS free and legally. See [data-sources](../02-data-sources/weather-models.md). |
| Expedition WRF server | In-house WRF runs at 1/12°, 1/36°, 1/108°; 3–6 hourly. | **P3** initially | Running our own WRF/ICON-D2-class nest is a real cost. Revisit if venue-scale forecasting becomes the differentiator. |
| Saildocs | Email or direct-web GRIB delivery. Models: GFS, ECMWF, ICON, NAVGEM, HRRR, NAM, NDFD, RTOFS. Subscriptions by days. | **P2** | Matters only for satcom users. A "low-bandwidth mode" is the analogous feature for us. |
| Squid (Great Circle) | Commercial GRIB service, JPEG-compressed GRIB. | **P3** | Commercial. |
| MyGrib | Curated list of third-party GRIB/NetCDF on the internet. | **P1** | Cheap to replicate as a "custom source" registry. |
| SailFlow observations | Live station observations; requires paid membership. | **P1** | NDBC buoys + NWS/METAR + Météo-France etc. are free equivalents. |
| Rainviewer radar | Weather radar tiles. | **P1** | RainViewer has a free public tile API; also NWS MRMS. |
| Satellite images, weather (fax) charts | Raster overlays. | **P2** | GOES/Himawari/Meteosat imagery is free via NOAA/EUMETSAT. |
| Tidetech | Commercial high-res tidal/ocean current + SST. | **P3** | Paid. Our free substitutes: NOAA OFS models, CMEMS, RTOFS. |
| SHOM tidal current models | 9 named 2-D tidal current atlases for the French coast, bundled. | **P2** | SHOM data is not open. Substitute: CMEMS + NOAA OFS + harmonic-constituent models. |
| XTide (tcd) | Bundled harmonic tide/current database for the USA, sourced from NOAA. | **P0** | XTide's harmonics data and algorithm are open. This is a direct, free path to offline tide prediction. |
| Iridium GO! integration | Manages a satphone data connection, disconnects after download, handles broken/resumable downloads. | **P3** | Our answer is aggressive payload minimisation, not satcom management. |
| Download resume | Only for Expedition's own GRIB server. | **P1** | HTTP range requests; trivial for us. |

---

## 3. Weather display

| Feature | Detail | Replicate? |
|---|---|---|
| Per-parameter display config (wind, MSLP, current, rain, …) | Each GRIB parameter independently set to contour / shade / barbs / arrows. | **P0** (simplified) |
| Contours with configurable step and highlighted level | e.g. isobars every 2 or 4 mb, one level in bold. | **P1** |
| Shading between shade-min and shade-max | Transparent fills. | **P0** |
| Colour modes | Single colour, red→blue spectrum, greyscale, **Beaufort scale**. | **P1** |
| "Fade colours" | Brighter at larger values, between contour min/max. | **P2** |
| Barbs vs. arrows, line width | | **P0** (barbs), **P1** (arrows) |
| Time animation | Default 60-min step, user-configurable; ↑/↓ keys step time; time shown top-left in UTC or local. | **P0** |
| "Always show currents and SST" | Ocean/SST fields are often historic analyses; this forces them to display alongside forecasts. Manual calls it "especially useful for races such as the Bermuda and Sydney to Hobart where currents are very important." | **P1** |
| Ensemble display modes | Standard / Ensemble (all members) / Ensemble statistics (mean + standard deviation). | **P2** |
| Scale currents % | Multiply GRIB currents by a user factor. Applies to routing only, not instrument-derived current. | **P1** |
| Rotate 10 m wind ±° | Correct a systematic directional bias in a model. | **P1** |
| Scale 10 m wind % | **Height correction.** See the formula in [how-it-computes.md](how-it-computes.md#wind-height-scaling). | **P0** |
| Per-model, per-windspeed user scaling | Stored in `WxModels.xml`. | **P2** |
| SkewT diagram | Optional; noted as slowing route optimisation. | **P3** |

---

## 4. Weather routing ("Optimal routing") — the crown jewel

This is why people buy Expedition. Two algorithms, and a very deep settings surface.

### 4.1 The two algorithms

Verbatim from the manual:

> "Expedition has two route optimisation algorithms that were designed for different
> purposes. They should yield similar results… The isochronal algorithm pushes an
> isochrone out from the start point, whereas the grid based algorithm uses an adaptive
> grid over the route area. The isochronal algorithm is generally the default choice.
> The grid algorithm is useful for routing studies and as a comparison."

**Isochronal** — "generally a slightly superior methodology, especially in areas of
light wind, where the current has a significant effect or around obstructions such as
land or race notes. To an extent, the isochronal algorithm is allowed to sail around
corners."

**Grid** — "originally developed for routing studies where it was important to compare
similar simulations… the grid algorithm is not designed to route around corners. One
solution is to use multiple marks for this." Only the grid algorithm supports
"optimise along great circle."

**Our read:** the isochrone algorithm is the P0 target. The grid algorithm is a
time-dependent shortest path on a fixed lattice — deterministic and reproducible, which
is exactly why it's preferred for A/B studies. Both are documented in
[../03-algorithms/routing-isochrone.md](../03-algorithms/routing-isochrone.md) and
[../03-algorithms/routing-graph.md](../03-algorithms/routing-graph.md).

### 4.2 Resolution controls

| Setting | Detail | Replicate? |
|---|---|---|
| High / Medium / Custom | Medium is default. "It is normal to select Medium or High resolution, which direct Expedition to automatically choose the routing resolution based on the grib time steps and grid resolution and leg length." | **P0** — auto-resolution from (GRIB Δt, GRIB Δx, leg length) is the key usability insight. We should expose *only* Fast/Balanced/Best. |
| Custom isochrone resolution | Isochrone time step. "Not generally recommended." | **P2** |
| Custom grid resolution | Spatial step for grid algorithm. | **P2** |
| Initial scan angle | "Initial search angle for isochronal route optimisation. Expedition will initially search half this value each side of the route… Default is 200°." | **P0** — a ±100° search cone about the great-circle bearing. |
| Minimum isochrone resolution | Floor on the auto-chosen time step; "allowing too low a resolution may yield worse results. Also helps performance." | **P1** |
| Optimised routes to keep | Ring buffer of past optimisations. | **P1** |

### 4.3 Physics and constraint options

| Setting | Detail | Replicate? |
|---|---|---|
| Avoid land (coarse world chart) | Uses the simple bundled world chart — "an approximation of the real coastline." Slows optimisation. | **P0** |
| Avoid ENC land + safety depth | Fine-scale; "probably only useful for very fine scale routing… will slow the route optimisation, especially for the grid algorithm." | **P1** |
| Race notes as exclusion zones | User polygons for shipping channels, **ice exclusion zones**. Can *also* apply a boat-speed reduction (manual's example: Sargasso weed). | **P0** for exclusion, **P1** for speed-reduction polygons |
| Use tidal streams | Tidal database overrides GRIB currents where present. "Tidal stream data is used in preference to grib current data where both are present." Newport–Bermuda example: tidal streams inshore, then GRIB Gulf Stream offshore. | **P1** |
| Extend wind forecast in time | Freezes the last wind field forever so a long route can complete. Manual is honest: "the resultant Optimum route… will converge back to the great circle route from the moment the GRIB ends." | **P0** — plus a clear UI warning. |
| Extend current forecast in time | Same for currents; "even more useful as ocean current GRIB files are often only valid for a single time step." | **P1** |
| Adjust polar for air density | Requires pressure, temperature, and preferably dew point or RH. Reference: standard atmosphere 1013.25 hPa, 15 °C, 80 % RH. | **P2** |
| Correct polar for waves | Uses wave GRIB + user coefficients. Requires correct boat length. | **P1** |
| Tack/gybe penalties (seconds) | User-defined. **"Not used for reverse isochrones."** | **P0** |
| Wind time shift (minutes) | Shift the forecast in time if the weather is running early/late. +60 → use the 17z field at 18z. | **P1** — this is a *brilliant* feature almost no consumer app has. |
| Scale/rotate wind, decaying over N minutes | Blend a current-conditions correction linearly back to the raw forecast over a chosen horizon. | **P1** — likewise excellent, and the honest way to nudge a model. |
| Avoid: max gust; max/min upwind TWS; max/min downwind TWS | Hard constraints that make cells impassable. | **P0** (safety) |
| Avoid significant waves over X | Hard wave-height constraint. | **P1** |
| Motor if speed below minimum sailing speed | Cruiser feature. | **P1** |
| Asymmetric port/starboard polars | "The most likely use of this is if a foil is damaged on one side of a foiling boat." | **P3** |
| Polar % and **polar % night** | Global scaling; separate scaling between civil dusk and dawn. "Useful for route optimisation if the performance is expected to be slower at night." | **P1** — a killer realism feature for shorthanded crews, and cheap. |
| Prefer tacks/gybes at routing steps | Discouraged; can make the finish unreachable. | **P3** |
| Sail polars | "Advanced users only." Per-sail polars → routing also tells you which sail. | **P2** |

### 4.4 Analysis outputs

| Output | Detail | Replicate? |
|---|---|---|
| Optimal route | The answer. Dashed segments = the router is tacking/gybing through that stretch; TWA shown in parentheses e.g. `(-12)`. | **P0** |
| Isochrones | "Curves that indicate where a boat could sail to in a certain amount of time." Drawing interval user-set: 12–24 h for a 2000-mile race, ~2 h for a 100-mile race. | **P0** |
| **Reverse isochrones** | "Lines of points equidistant in time from the finish." Computed by running the optimisation backwards through the GRIB fields from finish to start. "If another boat is on the same reverse isochrone [as you], they should finish at the same time — thus reverse isochrones can be used as a way of seeing who is ahead." | **P1** — the single best analysis idea in the product. |
| **Route sensitivity / criticality** | "To get an idea of how critical the optimal route is, look at how parallel the forward and reverse isochrones are. If [they] are close together and parallel over a large distance along their length, then the optimal route isn't very critical, but if they are only close together over a small distance, then the optimal route is much more critical." | **P1** — this is the antidote to false precision, and belongs in a *beginner* app more than a pro one. |
| Sensitivity shading | Shades the envelope of routes within N minutes of optimal. | **P1** |
| Paths | Draws every successful path explored, not just the best. | **P2** |
| Winds / currents on route; winds everywhere | Barbs along the route or over the whole explored area. | **P1** |
| Results table / meteogram | Per-step table: time, position, TWD, TWS, TWA, BSP, sail, current… Exportable to GPX/CSV/mark DB. | **P0** |
| Multiple optimum routes; highlight previous | Compare runs. | **P1** |
| Fleet routing | Route every boat in the boat DB with its own polar. | **P2** |
| Ensemble routing | Route across all ensemble members. | **P2** — but see note below; this is how you get honest confidence. |

**Manual's own disclaimer, worth quoting in our UI nearly verbatim:**

> "Garbage in = garbage out! Obviously the final results are only as good as the polars
> and weather forecast. Even with the best polars and weather forecast, the prudent
> navigator will study the solution carefully and make decisions based upon practical
> experience or intuition."

And on over-fitting:

> "The router will reward a half degree right shift with an optimal route that goes all
> the way to the right hand side… when in fact it doesn't really matter where you go
> (and a prudent tactician might be more inclined to play the shifts going up the middle
> of the route)."

### 4.5 Wave correction detail

For swell, Expedition uses, **in priority order**:

1. Swell direction, period and height
2. Primary wave direction and period, with significant wave height
3. Mean wave direction and period, with significant wave height

Wind waves: "Not normally selected as wind wave effects are normally included in your
polar." (Because designer polars are usually fitted to real sailing in a matched sea
state.)

**Crossed sea** (mostly multihulls): applies a polar percentage penalty when *all* of:
1. Both swell and wind-wave height exceed a minimum,
2. Combined height exceeds a threshold,
3. The angle between wind waves and swell is within a defined tolerance of 90°.

"If primary waves are used for swell, then the secondary waves will be used instead of
wind waves."

---

## 5. Racing tools

| Feature | Detail | Replicate? |
|---|---|---|
| Create W/L course | Builds a windward-leeward course around an existing line/committee boat from: distance to windward mark, distance to leeward mark (negative = below the line), course axis in °M (with a "use current TWD" button), leave-marks-to-port flag, gate on/off + width, separate finish mark, leeward mark aligned to boat / mid-line / pin. | **P0** for junior/club racing |
| Start line setup | Ping the committee boat and pin (at the bow, using a configured bow-to-GPS distance — or at the GPS). Set an end by range & bearing. Drag marks on the chart. | **P0** |
| Line bias | `Start bias angle` (negative = port end favoured, positive = starboard) and `Start bias length` (metres of advantage). Same concepts exist for gates. | **P0** |
| Time to line / ends / burn | See [start-line-math.md](../03-algorithms/start-line-math.md). Configurable which approaches count: line ends, GPS-based, reaching, port-layline, starboard-layline. Expedition takes the **minimum** of the selected options. | **P0** |
| Time to burn | `time_to_gun − time_to_line`. Positive = you're early and must waste time. Shown as a graphic bar. | **P0** |
| Rate of turn, acceleration, braking calibration | ROT in °/s as a function of boat speed. Acceleration in kn/min as a function of TWS and TWA. Braking in seconds-to-stop as a function of ROT. "Rate of turn and acceleration are always on, else the time to the line functions can not work." | **P1** — approximate with class defaults; sailors won't calibrate. |
| Start display (chart-less) | Scaled to the line. Port end left, starboard end right. Draws heading line, COG line, track, laylines from both ends, times at each end, bias line above the line, turn circles, boat-length grid and range circles, magnified line when close to an end. Most of it disappears 1 minute after the gun. | **P0** — this is the highest-value screen for a young sailor and it does not need a chart at all. |
| Hold wind / hold current | Freeze TWD/TWS and set/drift during the pre-start (they get noisy). Extra damping for TWA/TWS and set/drift pre-start, reverting at the gun. Optionally auto-release at the gun. | **P1** |
| Laylines to marks, gates, and gate "spot" | Layline bearings, distances, times on each tack, plus the *gate spot* — the intersection of the laylines to the two gate marks. Optional tide-affected laylines. Optional rate-of-turn allowance. Optional negative countdown past the layline. | **P0** for laylines, **P1** for gate spot / tidal laylines |
| Layline bounds (min/max bearings) | Envelope from wind oscillation, so you don't overstand on a shift. | **P1** |
| What-if? | User-set TWD/TWS and set/drift, feeding laylines and times. "A navigator might be expecting a 10° wind shift to the left (from 270 instead of 280) and want to see where the laylines would be." If what-if TWS is 0, instrument TWS is used. | **P0** — the cheapest, most educational feature in the whole product. |
| Handicap calculator | TCF-based. Elapsed / corrected / delta / owed times from each boat's gun time. Set events by clicking a boat name at roundings. | **P1** — PHRF/ORC/IRC time-on-time is trivial math and hugely wanted at club level. |
| Race tracking | Import scheduled position reports (Volvo/Ocean Race format, YB Tracking, Vessel Finder); interpolate boats to now; compute range/bearing/`Ahead of` (VMG-wise gain/loss). | **P2** |
| Sail chart | TWA/TWS map of which sail to carry, with crossovers; current point drawn as a circle; per-sail attributes (type, colour, on-board flag). | **P1** — pairs beautifully with routing output. |
| Sail tests / test analysis | Save time-slices as tests, compare sails, export. | **P2** |
| Race notes | Chart annotations that double as routing exclusion / speed-penalty zones. | **P1** |
| America's Cup race management | Boundary/penalty management for AC-style match racing. | **P3** |
| Wind shadow (`Shadow`, `Shadow opposite gybe`) | Bearing of the centre of another boat's wind shadow, and what it would be on the other gybe. | **P2** — lovely tactical feature. |

---

## 6. Instruments, calibration and connectivity

This is roughly a third of the manual and essentially all of it is **P3** for us.

Supported: A+T, B&G (Hercules, Hydra, H2000/H3000/H5000, WTP, HLink, Websocket,
GoFree), Bravo, Cosworth, Digital Yacht, DMK, Furuno NAVnet, Garmin (USB, NMEA 2000,
NX2, GND10), Koden radar, KVH Quadro, laser rangefinders, Navico radar (BR24/Halo),
Nexus NX2 FDX, NKE, NMEA 0183, NMEA 2000 (Actisense NGT-1/NGX-1/W2K-1), Ockam,
Optimizer, Sailmon, Pixel sur Mer Exocet, Tacktick, Ventus, Vesper AIS, VSPARS, Yacht
Devices, plus AIS/DSC/AIS-SART receivers and assorted compasses and MOB sensors.

| Feature | Replicate? | Note |
|---|---|---|
| Direct vendor protocol support | **P3** | Dozens of proprietary protocols. Not our fight. |
| NMEA 0183 / 2000 ingest | **P2** | Via **Signal K** only — one Apache-2.0 open standard instead of 25 protocols. See [../04-prior-art/open-source-landscape.md](../04-prior-art/open-source-landscape.md). |
| Phone GPS as the only sensor | **P0** | This is our starting assumption and our biggest simplification. |
| Wind triangle calculation (TWA/TWS/TWD from AWA/AWS/BSP/HDG) | **P1** | Needed if Signal K feeds us apparent wind. Math in [../03-algorithms/navigation-math.md](../03-algorithms/navigation-math.md). |
| Heel correction of AWA/AWS; masthead motion correction via pitch/roll rates | **P2** | |
| Set & drift calculation | **P1** | From damped COG/SOG/BSP/HDG/leeway, gated by a rate-of-turn limit "(you don't want to calculate current during a tack)." |
| Leeway model | **P1** | Manual gives it outright: `leeway ≈ k · heel / bsp²`, and `course = heading + leeway`. |
| Calibration tables (ROT, acceleration, braking, mast angle, TWA/TWS correction matrices) | **P2** | |
| Networking (broadcast/receive between PCs, slave mode) | **P3** | Web app is inherently multi-device. |
| AIS display, CPA/TCPA alarms, target list, aisstream.io | **P2** | aisstream.io gives a free WebSocket AIS feed — see [../02-data-sources/ais-and-tracking.md](../02-data-sources/ais-and-tracking.md). |
| Iridium GO! / satcom management | **P3** | |

---

## 7. Analysis, logging and data plumbing

| Feature | Detail | Replicate? |
|---|---|---|
| Logging | All channels logged, one file per day. | **P1** |
| LogPlayer / playback | Replay a race at speed, with pause. Used for calibration and debrief. | **P1** — debrief is where juniors actually learn. |
| Stripchart | Time-series plots of any channels, with "wands" to bracket a section and compute deltas; save selections as tests. | **P2** |
| Polar editor | Graphical drag-to-edit polar points, overlaid with logged test data. Views: polar radial / upwind targets / downwind targets. Test points coloured by sail or by tack, hollow if below the polar VMG, with a "normalised" option scaling test BSP to the displayed TWS. | **P1** — "learn your boat from your own tracks" is a *fantastic* free-tier hook. |
| GPX import/export | | **P0** |
| CSV export of routes | | **P0** |
| Number boxes / alternating channels | Any channel in a configurable box; up to 10 alternating channels flashing between values. | **P0** (simplified) |
| Alarms | | **P1** |
| Exp DLL / Dfw2Exp / simple serial protocol | Third-party integration surface. | **P2** — our equivalent is a documented JSON/WebSocket API. |
| ~400 named channels | Full catalogue in [channels-reference.md](channels-reference.md). | see that file |

---

## 8. Polars — the data model

Expedition supports **six** polar roles plus custom ones:

| Polar | Used for |
|---|---|
| **Performance** | Performance numbers: `Polar Bsp`, `Polar Bsp%`, targets. The stable day-to-day reference. |
| **Navigation** | "The main polar used by Expedition. The Nav polar is used in optimal routing and all navigation calculations." Tuned to today's conditions. |
| **Start** | Drives the start-line program (time to burn etc.). Can be de-powered downwind if you do downwind starts. |
| **Heel** | Enables `Target heel`. |
| **Port / Starboard** | Asymmetric polars for damaged-foil cases. |
| **Custom 5–8** | Arbitrary, e.g. keel angle → `polar keel`, `polar keel angle %`. |

**File format** (plain text, editable in Notepad or Excel):

- First column is always TWS.
- Remaining columns are pairs of (TWA, BSP) — or (TWA, heel), etc.
- TWA increases across a row; TWS increases down the file.
- Rows may have different numbers of points.
- Convention: one point just above the upwind target angle, last point at TWA 180.
- `!` starts a comment line (not preserved on save).
- Targets are **derived, not stored**: "Exp automatically determines which point is the
  target (maximum upwind or downwind VMG)."

The manual's warning about target derivation is a real implementation trap:

> "Editing a target point can cause it to have a lower VMG value than an adjacent point,
> which would then become the new target… For this reason, not having polar points too
> close to the targets can make editing a lot easier. For example, if the target angle is
> 46, consider using TWA values of 0, 46, 60 … instead of 0, 46, 50, 60 …"

Also: designer polars are typically referenced to **10 m** wind, while sailors want
masthead-referenced numbers. Expedition solves this with the wind scaling formula in
[how-it-computes.md](how-it-computes.md#wind-height-scaling).

---

## 9. What Expedition deliberately does *not* do

Useful negative space for positioning:

- No mobile client of any kind.
- No cloud sync, no account, no sharing a route with a teammate by link.
- No collaborative or spectator mode.
- No onboarding path — the product assumes you already know what a layline is.
- No automatic polar acquisition; you must source a polar file yourself.
- No built-in explanation of *why* a route was chosen (the reverse-isochrone tooling is
  the closest thing, and it requires interpretation skill).

Every one of those is an opening.

---

## 10. Feature-count reality check

Rough magnitude, from the manual's own structure:

- ~600 help topics
- ~400 named data channels
- 25+ instrument-vendor integrations
- 8 chart formats
- 15+ weather models across 5 delivery services
- 2 routing algorithms with ~40 settings between them

An MVP replicating **P0 only** is roughly 5 % of the surface area — and probably 80 % of
the value for our target user. That ratio is the entire thesis of this project.
