# Expedition Channel Catalogue

Expedition's "Appendix A: Channels" defines roughly 400 named values, **per boat**
("Expedition has channels for each boat"). Any of them can be placed in a number box,
logged, plotted, alarmed on, or sent to an instrument display.

This is the most precise available statement of *what Expedition actually computes*. It
is therefore the best possible checklist for scoping our own computed-value layer.

Below: every channel from the manual, grouped by function, with our implementation tier.
Definitions in quotes are verbatim from the manual.

**Tiers:** P0 = MVP · P1 = v1.x · P2 = later · P3 = out of scope (needs hardware we
don't target).

---

## A. Position, time, and GPS quality — P0 (core), P3 (DOP/diagnostics)

| Channel | Definition | Tier |
|---|---|---|
| `Latitude`, `Longitude` | | P0 |
| `Time` | "The current date & time and is stored internally in UTC." | P0 |
| `GPS time` | | P0 |
| `Sog` | Speed over ground | P0 |
| `Cog` | "Course over the ground. Heading + leeway + current." | P0 |
| `Log Bsp`, `Log Sog` | Cumulative distance by each source | P1 |
| `Instrument trip log` | | P2 |
| `Magnetic variation` | "The variation between true north and magnetic north at boat n's current position." | P0 (from WMM) |
| `GPS mode`, `GPS position fix`, `GPS number`, `GPS age`, `GPS altitude`, `GPS geoidal separation`, `GPS PDOP/HDOP/VDOP`, `GPS estimated position error`, `Diff station` | NMEA GPS quality fields | P2 (phone gives accuracy only) |
| `System - GPS time delta` | Clock skew between PC and GPS | P3 |

## B. Wind — P0

| Channel | Definition | Tier |
|---|---|---|
| `Awa`, `Aws` | Apparent wind angle/speed | P1 (needs a sensor) |
| `Mwa`, `Mws` | "Measured apparent wind angle and speed" (raw, pre-calibration) | P2 |
| `Twa` | "True wind angle **includes leeway**." | P0 |
| `Tws`, `Twd` | True wind speed/direction — relative to the **water** | P0 |
| `Gwd`, `Gws` | Ground wind — relative to the **earth**. `GW = TW + current` | P1 |
| `Twd -90`, `Twd +90` | TWD ± 90° | P1 |
| `Twd from targets` | TWD implied by sailing at target TWA | P2 |
| `Twd Period` | "Period of the dominant wind shift" | P2 |
| `Tws Period` | "Period of the dominant tws cycle" | P2 |
| `Twd twist` | Wind shear/twist with height | P3 |
| `TWG`, `TWDG` | Gust speed and direction | P1 |
| `TWD predicted`, `TWS predicted` | "TWD and TWS predicted by loaded grib data" | **P0** — this is the forecast-vs-actual comparison, hugely valuable and free for us |
| `MSLP predicted` | Ditto for pressure | P1 |
| `Wind weight` | "In the Ockam sense - as a fraction" | P3 |

## C. Boat motion and attitude — P1/P3

| Channel | Definition | Tier |
|---|---|---|
| `Bsp` | Boat speed through water | P1 |
| `Bsp transverse`, `Bsp - SoG`, `Course - COG` | Derived comparisons | P2 |
| `Course` | "Heading + leeway" | P1 |
| `Heading` | Compass heading | P1 (phone compass, poor) |
| `Heel (roll)`, `Heel (roll) rate` | Positive to starboard | P1 (phone IMU!) |
| `Trim (pitch)`, `Trim (pitch) rate` | Bow-up positive | P2 |
| `Rate of turn` | | P1 (phone gyro) |
| `Leeway` | Signed, positive clockwise → positive on port | P1 |
| `Motion`, `Slam`, `Wave max/sig height/period` | Volvo wave sensor | P3 |

## D. Depth, temperature, atmosphere — P1

`Depth`, `Sea temperature`, `Air temperature`, `Barometer`, `Dew Point`,
`Relative humidity`, `Air density` ("Requires pressure, temperature and preferably dew
point or relative humidity. Will be dry air density if… not available").

Phone can supply barometer on many devices. Depth and SST need a sensor → P2.
`Air density` matters only for the air-density polar correction → P2.

## E. Current — P1

| Channel | Definition | Tier |
|---|---|---|
| `Current set`, `Current drift` | Measured (COG/SOG vs. water track) | P1 |
| `Current set predicted`, `Current drift predicted` | "as predicted by diamonds, NOAA tides, Grib data, Winning tides etc." | **P0** |
| `Mark current set`, `Mark current drift` | "Predicted current at mark at estimated time of rounding, based on Mark polar time." | P1 |
| `Tide station` | Nearest tide station | P1 |
| `Tide left/right (port/stbd) time` | Tide-affected laylines | P2 |

## F. Marks, routes, and cross-track — P0

| Channel | Definition | Tier |
|---|---|---|
| `Mark bearing`, `Mark range` | To the active mark | P0 |
| `Mark latitude`, `Mark longitude` | | P0 |
| `Mark twa` | "True wind angle if heading directly to the current mark" | P0 |
| `Mark time` | Time to mark "based on the current polars" | P0 |
| `Mark polar time` | Time to mark "based on the current wind direction and speed as well as the polar" | P0 |
| `Mark GPS time` | Time to mark from COG/SOG | P0 |
| `Cross track error` | XTE | P0 |
| `Distance to finish` | "Distance to current mark **and on to** last mark in the active route" | P0 |
| `Next mark bearing/range/twa` | For the next leg | P1 |
| `Next mark Awa`, `Next mark Aws` | "Expected apparent wind… on the next leg" | P1 |
| `Next mark polar time` | Expected next-leg duration | P1 |
| `Next mark time on port` / `on starboard` | Split of the next leg by tack | P1 |
| `Heading to steer`, `Heading to steer polar` | "Heading to steer to the mark, allowing for current. At Bsp or polar bsp." | **P0** — this is the single most useful number for a novice |
| `Turn to mark` | | P1 |
| `Finish` | | P1 |

## G. Laylines — P0 core, P2 exotica

Base set (P0):
`Layline bearing`, `Layline distance`, `Layline time`, `Layline time GPS`,
`Layline distance on port` / `on starboard`, `Layline time on port` / `on starboard`,
`Layline port bearing`, `Layline starboard bearing`.

> Watch the naming trap, straight from the manual: **`Layline distance on port` is
> defined as "Distance to the starboard layline."** The channel is named for the tack
> you are *on*, not the layline you're measuring to. We will not repeat this.

Extended (P1/P2):
`Lay max/min bearing on port/strb` (oscillation bounds), `Layline bearing on port/strb`,
`Layline up/dn bearing on port/strb` (upwind vs. downwind), `Layline time on port/strb ratio`,
`Twd to lay mark`, `Twd to lay mark opposite tack` ("what the wind direction would have to
shift to in order to lay mark"), `Layline tide …` (6 tide-corrected variants),
`Opposite track` ("what the Cog would be on the opposite tack or gybe"),
`Opposite track cog` ("Cog ± 2 × TargTwa. No current effects included"),
`Tacking angle`, `Tacking angle polar`, `Tack/gybe loss metres`, `Tack/gybe loss time`.

## H. Gates — P1

`Gate bearing`, `Gate range`, `Gate time`, `Gate lay dist/time on port/starb`,
`Gate spot time on port/starb` ("the gate spot - the intersection of the laylines to the
two gate marks"), `Gate square wind`, `Gate bias length`,
`Port gate lay dst/tm on pt/strb`.

## I. Start line — P0 (this is the junior-sailor killer app)

| Channel | Definition | Tier |
|---|---|---|
| `Start time to gun` | Countdown | P0 |
| `Start time to line` | "Shortest time to the line at targets (includes tacking or gybing and acceleration) based on the start polar, rate of turn and acceleration settings. Negative if over the line." | P0 |
| `Start time to burn` | "Difference between time-to-line and time-to-start." | P0 |
| `Start distance below line` | "The minimum of the bow and GPS position below the line… Essentially the XTE from the line." | P0 |
| `Start distance to line` | Min over enabled approach options, including turns | P0 |
| `Start bias angle` | "Negative means the port end is favoured, positive means the starboard end is favoured." | P0 |
| `Start bias length` | Distance advantage at the favoured end | P0 |
| `Start line square wind` | "Wind direction at 90° to the start line." | P0 |
| `Start port/stbd latitude/longitude` | Line end positions | P0 |
| `Start time to port` / `to starboard` | Time to each end via the start polar | P0 |
| `Start time to port/starboard simple` | "without current, turning, acceleration or braking effects" | P1 |
| `Start time to port/starboard pinch`, `Start pinch time to port/starboard` | Sailing above (or below) targets | P1 |
| `Start speed to port` / `to starboard` | "Speed required to reach an end of the line at the gun" | P1 |
| `Start speed on port` / `on starboard` | Speed required to reach the line on each tack | P1 |
| `Start reach dist/speed/time to line`, `Start distance to line reach` | Reaching approach | P1 |
| `Start GPS time to line`, `Start GPS time to burn` | COG/SOG only | P0 (fallback with no polar) |
| `Start layline on port` / `on starboard` | | P0 |
| `Start time to layline P` / `S` | "after turning and sailing parallel to the line" | P1 |
| `Start port/strb with left/right turn` | Times after a turn each way | P2 |
| `Start strb/port end time to burn, X secs` | "Time to burn after tacking onto a point X seconds from the line on the starboard layline" | P2 |
| `Start boat to pin time` | Time to run the line | P1 |
| `Start gun dist below line` | Predicted position at the gun | P0 |
| `Start gun bsp target %` / `polar %` | Speed at the gun as % of target | P1 |
| `Start target bsp`, `Start target twa` | From the start polar | P0 |
| `Start stern below line` | | P2 |

## J. Polar and target performance — P0/P1

| Channel | Definition | Tier |
|---|---|---|
| `Polar bsp` | "The polar boat speed at the current wind speed and angle." | P0 |
| `Polar bsp%` | Actual / polar, as % | P0 |
| `Target bsp`, `Target bsp nav` | Target speed upwind or downwind | P0 |
| `Target bsp %` | | P0 |
| `Target twa`, `Target twa nav`, `Target twa without leeway` | | P0 |
| `Target vmg` | | P0 |
| `Target awa` | | P1 |
| `Vmg` | "the component of bsp and leeway upwind or downwind" | P0 |
| `Vmg%` | | P0 |
| `Delta target bsp`, `Delta target twa`, `Delta polar bsp` | Signed errors from target | P0 |
| `Vmc` | "the component of sog towards the current mark" | P0 |
| `Vmc%`, `Vmc optimum`, `Vmc optimum heading`, `Vmc optimum twa`, `Vmc polar`, `Vmc to mark polar` | VMC optimisation family | P1 |
| `Polar heel`, `Target heel`, `Delta target heel (roll)` | From the heel polar | P2 |
| `Polar leeway`, `Target leeway` | From the leeway polar | P2 |
| `Polar Tws`, `Polar Tws delta`, `Polar Tws %` | "Uses the bsp nav polar and/or heel/roll and the heel polar to **estimate tws**" — inverse polar lookup | P2 (great calibration tool) |
| `Target Twd`, `Target Twd Delta` | "Estimated Twd based on course and target twa from the nav polar" | P2 |
| `Polar 5,6,7,8` and `%` variants | Custom polars (e.g. keel angle) | P3 |

## K. Fleet, competitors, tracking — P2

`Boat bearing from boat 0`, `Boat range from boat 0`,
`Ahead of` ("Distance boat zero is ahead of boat n **vmg-wise**"),
`Shadow` ("bearing of the centre of boat n's wind shadow"),
`Shadow opposite gybe`, `Radar bearing`, `Radar range`,
`Race note GPS reach distance to` / `time to`.

`Ahead of` being VMG-wise rather than straight-line is the correct racing definition and
worth copying exactly.

## L. Sails and sail shape — P2/P3

`Sail`, `Sail mark`, `Sail next mark` (from the sail chart) — **P1**, these tell you what
to hoist for the current and next leg.

`Sail AI` stripe geometry — Lower/Mid/Upper Stripe × Camber / Draft / Twist / Entry /
Exit (15 channels, from VSPARS-class optical sail-shape systems, measured at 25 %, 50 %
and 75 % of P) — **P3**, requires mast-mounted cameras.

## M. Rig, hydraulics, loads, engine, electrics — P3

Load and geometry: `Backstay`, `Boom`, `Board` / `Board port` / `Board starboard`,
`Deflector`, `Downhaul load` (×2), `Forestay load`, `Forestay inner load`,
`Forestay length`, `Forestay plus tack load`, `Keel Angle`, `Keel Height`, `Lead port`,
`Lead starboard`, `Load cell port/starboard`, `MainSheet`, `Mast angle`, `Mast butt`,
`Mast rake`, `Rake`, `Rudder` (+ forward/port/starboard/toe), `Runner port/starboard`,
`Tab`, `Traveller`, `Vang`.

Engine/electrical: `RPM1`, `RPM2`, `Engine temperature`, `Engine oil temperature/pressure`,
`Transmission oil temperature/pressure`, `Fuel level` (×2), `Water level` (×2), `Voltage`,
`Battery current`, `Charge state`.

All P3. All require NMEA 2000 hardware.

## N. System, diagnostics, and user-defined — P2/P3

`CAN Load`, `CAN fast packet errors`, `Error code`, `Test time`, `Alternating 0–9`,
`User 0–31` ("Channels for custom use").

---

## What we should actually ship

Cutting the ~400 down to a **v1 core of about 35**, chosen so that every one is
computable from a phone GPS + a public forecast + a polar:

**Navigation (8)** — Latitude, Longitude, SOG, COG, Heading to steer, Mark bearing,
Mark range, XTE

**Wind (6)** — TWD, TWS, TWA, TWD predicted, TWS predicted, Gust

**Performance (7)** — Polar BSP, Polar BSP %, Target BSP, Target TWA, VMG, VMG %, VMC

**Tactics (8)** — Layline time/distance on each tack (4), Time to mark (polar), Time to
mark (GPS), Distance to finish, TWD to lay mark

**Start (6)** — Time to gun, Time to line, Time to burn, Distance below line, Line bias
angle, Favoured end

Everything else is an "add a number" menu, not a default.

The lesson from Expedition's channel list is not "build 400 channels." It is that a
small number of *derived* quantities — time to burn, VMC optimum, TWD to lay mark, ahead-of
VMG-wise — carry almost all of the tactical insight, and none of them require a single
piece of marine hardware.
