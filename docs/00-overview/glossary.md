# Glossary

Sailing, navigation and forecasting terms used throughout this repo. Written for the
engineer who has never raced, and the sailor who has never written code.

---

## Wind

| Term | Meaning |
|---|---|
| **AWA / AWS** | Apparent wind angle / speed — what the masthead instrument measures: the vector sum of true wind and the boat's own motion. Signed: + on starboard, − on port. |
| **TWA / TWS** | True wind angle / speed — wind relative to *the water*. What the polar is indexed on. In Expedition's convention, TWA **includes leeway** (measured from the boat's track through the water, not its centreline). |
| **TWD** | True wind direction, °T. The direction the wind is coming *from*. |
| **GWD / GWS** | Ground wind — wind relative to *the earth*. `Ground wind = True wind + current`. GRIB files contain ground wind. |
| **Gust** | Short-duration peak wind. Models forecast it separately (`GUST`). |
| **Shift** | A change in wind direction. A **lift** brings you closer to your mark, a **header** pushes you away. |
| **Oscillating vs. persistent** | Oscillating breeze swings back and forth (tack on the headers); persistent shift moves one way (get to the shifted side early). Completely different tactics. |
| **Veer / back** | Veer = wind direction rotating clockwise; back = anticlockwise. |
| **Hellmann exponent** | The `a` in `TWS(h) = TWS(10m)·(h/10)^a`, the wind-shear power law. ~0.11–0.14 at sea. |

## Boat performance

| Term | Meaning |
|---|---|
| **BSP** | Boat speed through the water (paddlewheel/sonic log), as opposed to SOG. |
| **SOG / COG** | Speed / course over ground, from GPS. `COG = heading + leeway + current`. |
| **Heading** | Where the bow points (compass). |
| **Course** | `heading + leeway` — the boat's actual track through the water. |
| **Leeway** | Sideways slip. `leeway ≈ k·heel/bsp²`. Signed positive clockwise, so positive on port tack. |
| **Polar / polar diagram** | Table or curve of achievable boat speed vs. TWS and TWA. The single most important input to routing. |
| **VPP** | Velocity Prediction Program — physics software that computes a polar from a hull/rig model. ORC certificates contain VPP output. |
| **Target boat speed / target TWA** | The TWA maximising VMG at a given TWS, and the speed there. Derived from the polar, not stored. |
| **VMG** | Velocity Made Good — speed component *directly upwind or downwind*: `bsp·cos(twa)`. Tells you if you're sailing the boat well. |
| **VMC** | Velocity Made *Course* — speed component *toward the mark*. Tells you if you're pointed the right way. Different from VMG whenever the mark isn't dead up- or downwind. |
| **Heel** | Sideways tilt. Positive to starboard (so positive when sailing on port). |
| **Trim (pitch)** | Fore-aft tilt. Bow-up positive. |
| **De-powering** | Reducing sail force in strong wind. A real polar can *decrease* with increasing TWS once the boat is overpowered. |

## Racing

| Term | Meaning |
|---|---|
| **Beat / windward leg** | Sailing toward a mark upwind, which requires tacking. |
| **Run / downwind leg** | Sailing toward a mark downwind. Fast boats gybe downwind rather than sailing dead square. |
| **Tack (noun)** | Which side the wind is on. Port tack = wind from the left. Starboard tack has right of way. |
| **Tack (verb) / gybe** | Turning the bow (tack) or stern (gybe) through the wind. Each costs distance and time. |
| **No-go zone** | The ~80–100° sector centred on the wind you cannot sail into. Its half-width is the upwind target TWA. |
| **Layline** | The line from a mark along which you can just fetch it on one tack without further tacking. Overstanding (sailing past it) is the most common tactical error in the sport. |
| **Layline bounds** | The envelope of laylines given the wind's oscillation — a band, not a line. |
| **W/L course** | Windward-leeward: start, up to a windward mark, back down to a leeward mark or gate, repeat. |
| **Gate** | A pair of leeward marks; you choose which to round. The **gate spot** is where the laylines to both marks intersect — the decision point. |
| **Line bias** | How far the start line is from perpendicular to the wind. The favoured (upwind) end gives a free head start. |
| **Time to burn** | `time_to_line − time_to_gun`. Positive means you'll be early and must waste time. The most useful number in the pre-start. |
| **OCS** | On Course Side — over the line at the gun. Penalty or restart. |
| **Ping** | Recording a mark's position by sailing to it and pressing a button. |
| **Handicap (PHRF / IRC / ORC / ORR)** | Systems letting different boats race together. **TCF** (time correction factor) converts elapsed to corrected time. |
| **Corrected time** | Elapsed time adjusted by handicap — what determines the result. |

## Navigation

| Term | Meaning |
|---|---|
| **Great circle** | Shortest path on a sphere. Bearing changes along it. |
| **Rhumb line** | Constant-bearing path. Longer than the great circle, easier to steer. |
| **XTE** | Cross-track error — perpendicular distance from the intended track. |
| **Set and drift** | Current direction (toward which it flows) and speed. |
| **Variation / declination** | Angle between true and magnetic north. Racers work in magnetic. Modelled by the **WMM**. |
| **Deviation** | Compass error from the boat's own magnetism. Not modellable; measured. |
| **Fetch** | (a) Distance of open water over which wind builds waves. (b) To *fetch* a mark: to reach it without tacking. |
| **DR** | Dead reckoning — position estimated from course and speed. |

## Charts and hydrography

| Term | Meaning |
|---|---|
| **ENC** | Electronic Navigational Chart — official vector chart data. |
| **S-57 / S-52 / S-63** | IHO standards: S-57 = ENC data format; S-52 = display/symbology rules; S-63 = encryption for licensed distribution. **S-101** is S-57's successor. |
| **RNC / BSB** | Raster nautical chart — a scanned/geo-referenced paper chart. |
| **ECDIS** | The regulated shipboard chart system. Type-approved, expensive, and not what we're building. |
| **Chart datum** | The vertical reference for depths — usually **MLLW** (US) or **LAT**. Tide height is added to charted depth. |
| **Safety depth / safety contour** | User-set shallow-water thresholds that drive chart colouring and route checks. |
| **Bathymetry** | Seafloor depth data. **GEBCO** is the free global grid (~450 m). |
| **Tidal diamond** | A charted point with tabulated tidal stream data by hour relative to high water. |
| **Harmonic constituents** | The ~37 sinusoids (M2, S2, N2, K1, O1, …) whose sum predicts tide. Per-station amplitude and phase. |

## Weather data

| Term | Meaning |
|---|---|
| **GRIB / GRIB2** | WMO binary format for gridded forecast data. What every model ships. |
| **NWP** | Numerical Weather Prediction — the models themselves. |
| **GFS / ECMWF IFS / ICON / ARPEGE / UM / GDPS** | Global models from NOAA, ECMWF, DWD, Météo-France, UK Met Office, ECCC. |
| **HRRR / AROME / ICON-D2 / UKV / WRF** | High-resolution regional models (1–3 km). |
| **NBM** | National Blend of Models — NOAA's statistically blended operational forecast. |
| **Ensemble (GEFS, ENS)** | Many perturbed runs of the same model. The spread is your uncertainty estimate. |
| **Analysis time / run** | When the model was initialised (00/06/12/18Z). |
| **Hs (significant wave height)** | Mean height of the highest third of waves. Individual waves can be ~1.8× larger. |
| **Swell vs. wind waves** | Swell = waves from distant weather (long period). Wind waves = generated locally. A **crossed sea** is two trains at a large angle. |
| **RTOFS / HYCOM / CMEMS / Mercator** | Global ocean current models. |
| **OFS** | NOAA's Operational Forecast Systems for US estuaries — the best free inshore current data. |

## Routing

| Term | Meaning |
|---|---|
| **Weather routing** | Computing the fastest path given a forecast and a polar. |
| **Isochrone** | A curve of points reachable in the same elapsed time from the start. The routing algorithm marches these outward. |
| **Reverse isochrone** | A curve of points with the same *remaining* time to the finish. Two boats on the same one will finish together. |
| **Route sensitivity** | How much time you lose by not being exactly on the optimal route. Forward + backward passes give this as a scalar field. |
| **Implicit tacking** | When the router substitutes a VMG-equivalent speed for a course inside the no-go zone, rather than modelling each tack. Expedition marks these segments with dashed lines and parenthesised TWAs. |
| **Tack/gybe penalty** | Seconds added per manoeuvre. Makes the routing problem non-memoryless. |
| **TDSP** | Time-dependent shortest path — the formal name for the routing problem. |
| **HJB / Eikonal** | The PDE formulation: arrival time as the solution of an anisotropic Eikonal equation. Isochrones are its level sets. |

## Data and platform

| Term | Meaning |
|---|---|
| **Signal K** | Open marine data standard (JSON/WebSocket) + server that multiplexes NMEA 0183/2000. Apache-2.0. |
| **NMEA 0183 / 2000** | The serial and CAN-bus standards for marine instruments. |
| **AIS** | Automatic Identification System — vessel position broadcasts. **CPA/TCPA** = closest point of approach and time to it. |
| **PMTiles** | Single-file tile archive read over HTTP range requests. No tile server; trivially offline. |
| **PWA** | Progressive Web App — installable, offline-capable web app. |
| **OPFS** | Origin Private File System — browser storage with near-native performance for large binary files. |
| **ODbL** | Open Database License — OSM's licence. Share-alike on *derived databases*. |
