# Polars and Boat Performance Data

A weather router without a polar is a chart with a magenta line on it. This is the
hardest *acquisition* problem in the project — not technically, but practically: most
sailors do not have a polar file, do not know what one is, and will abandon an app that
demands one on first launch.

Expedition's position, verbatim: *"Polars may be obtained from many sources - your boat
designer, class [association]…"* — and it ships sample polars for popular classes while
telling users to get accurate ones from the manufacturer, designer, or US Sailing. That
is a reasonable answer for a professional navigator and a fatal answer for a 16-year-old.

**Our design rule: the app must produce a useful route before the user has ever heard the
word "polar."**

---

## 1. What a polar is, precisely

A table of achievable boat speed as a function of true wind speed and true wind angle:

```
TWS \ TWA   40°   52°   60°   75°   90°  110°  120°  135°  150°  165°  180°
   6 kn    3.10  4.35  4.80  5.25  5.40  5.35  5.20  4.70  4.15  3.60  3.35
   8 kn    3.95  5.15  5.55  6.00  6.20  6.25  6.15  5.70  5.15  4.55  4.25
  10 kn    4.60  5.75  6.05  6.40  6.60  6.75  6.75  6.45  5.95  5.35  5.00
  ...
```

Derived, not stored: the **upwind target** (TWA maximising `bsp·cos(twa)`) and the
**downwind target** (TWA minimising it). See
[../03-algorithms/polars-and-vpp.md](../03-algorithms/polars-and-vpp.md).

Expedition's file format (see
[../01-expedition-analysis/feature-inventory.md §8](../01-expedition-analysis/feature-inventory.md#8-polars--the-data-model))
is plain text: first column TWS, then (TWA, BSP) pairs, ragged rows allowed, `!` for
comments. **We should read and write it natively** — it is the de-facto interchange
format, and supporting it is a one-afternoon job that instantly makes us useful to
anyone who already has Expedition or Deckman data.

Other formats to support: qtVlm/`.pol` (TWA columns × TWS rows CSV, tab or `;`
delimited), ORC CSV as exported by jieter's tool, and our own JSON.

---

## 2. Sources, ranked by practicality

### 2.1 ORC certificate VPP data — the best public dataset

ORC (Offshore Racing Congress) issues certificates containing full VPP output: target
speeds at TWS 6/8/10/12/14/16/20 kn and TWA 52/60/75/90/110/120/135/150°, plus beat and
run VMG angles and speeds, for tens of thousands of certified boats.

- <https://jieter.github.io/orc-data/site/> — community tool that surfaces the public
  ORC certificate data as tables, polar plots and CSV.
  Source: <https://github.com/jieter/orc-data>
- ORC's own sailor-services site publishes certificate data per boat.
- <https://www.boatpolars.com/> — aggregated free ORC VPP polar diagrams.

**Coverage:** excellent for keelboats that race under ORC (Europe-heavy, plus US
offshore). Nothing for dinghies, skiffs, most one-designs, or cruisers without
certificates.

**Licence caution — flagged, not resolved.** ORC certificate data is published for
public inspection, and third-party tools redistribute it, but ORC has its own terms of
use. **Before shipping bulk ORC-derived polars we must check ORC's terms and, ideally,
ask.** A safe interim: let users look up and import their own boat's certificate
(a user-initiated fetch of their own data), rather than us redistributing a bulk
database.

### 2.2 Class associations and designers

Many one-design classes publish target/polar data; designers often supply polars with a
new boat. Manual collection, high quality, no automation.

### 2.3 US Sailing / handicap-system VPPs

US Sailing has historically published polars and target boat speeds for common
production boats. IRC does not publish its VPP. ORR (Offshore Racing Rule) certificates
include performance curves.

### 2.4 Community and open datasets

- <https://github.com/dakk/libweatherrouting> ships sample polars (MIT).
- Seapilot, qtVlm, OpenCPN and Expedition all bundle sample polars — usable as
  *references* for typical shapes, not as redistributable content unless their licence
  says so.
- `hrosailing` (<https://github.com/hrosailing/hrosailing>) — Python library for
  processing, fitting and interpolating polar data from real sailing tracks. MIT-ish;
  verify. This is the closest thing to prior art for §4 below.

### 2.5 Parametric / generated polars

For a boat with no data at all, generate a plausible polar from a handful of inputs:
LOA, LWL, displacement, sail area, keel type, and one known target (e.g. "we do about
6.2 kn upwind in 12 kn"). Anchor on:

- Hull speed `≈ 1.34 · √LWL(ft)` kn as an asymptote
- Sail area / displacement ratio setting light-air performance
- Displacement / length ratio setting heavy-air behaviour
- A library of *shape templates* by boat type (dinghy, sportboat, cruiser-racer, heavy
  cruiser, multihull, foiler) normalised to hull speed and scaled to the boat

This is not accurate. It is *plausible*, and it lets someone sail their first routed leg
in 60 seconds. Show the confidence honestly and push them toward §4.

**This is the single most important onboarding decision in the product.**

### 2.6 Learn the polar from the user's own tracks — the endgame

Every phone GPS trip is a stream of `(t, lat, lon, SOG, COG)`. Combine with a wind
forecast/hindcast (ERA5 or the archived forecast for that day and place) and you can
estimate TWA and TWS for every sample, then fit a polar to the cloud.

```
for each GPS sample:
    tws, twd  ←  forecast/hindcast at (lat, lon, t)
    twa       =  wrap(cog − twd)
    bsp       ≈  sog            (approximation: ignores current)
    bin by (tws_bucket, |twa|_bucket)
take a high percentile (85–95th) of bsp in each bin  →  polar point
smooth and enforce monotonicity/convexity
```

Notes that make this actually work:

- Use a **high percentile, not the mean** — polars represent good sailing, not average
  sailing. The mean includes tacks, luffs, drifting, and lunch.
- Filter out manoeuvres (high rate of turn), low-speed drifting, and motoring (steady
  speed at any TWA, straight COG, high speed dead upwind).
- `SOG ≈ BSP` is wrong wherever there is current. Correct with a current model if
  available, or restrict fitting to low-current areas/times.
- Forecast TWD/TWS at 10 m must be height-scaled before use.
- Require a minimum sample count per bin; leave under-sampled bins to the parametric
  prior rather than fitting noise.
- This is a **Bayesian update**: start from the parametric prior (§2.5) and let observed
  data pull it. That degrades gracefully instead of producing a spiky polar from three
  data points.

Expedition has a manual version of this (drag polar points onto a cluster of saved
tests, with a "normalised" option scaling test BSP to the displayed TWS). Automating it
is a genuine leapfrog, and it is the thing that makes a free app *better* than a €1,250
one for a sailor without a certificate.

---

## 3. Extra polar types worth supporting

Expedition supports performance / navigation / start / heel / port / starboard / custom
polars. Our v1 subset:

| Polar | Why |
|---|---|
| **Main (nav)** | Routing + all tactical numbers |
| **Start** | Pre-start acceleration and time-to-line; typically the main polar de-powered downwind |
| **Heel** | Optional; enables target heel, which is the most useful single number for a dinghy sailor |

Plus scaling factors, all of which Expedition has and all of which are one multiply:

- Global polar % (crew ability, boat condition, dirty bottom)
- **Night polar %** — reduced performance between civil dusk and dawn
- Wave correction factor
- Air density factor

Defaulting global polar % to something like 92 % for a novice crew is more honest than
routing them at grand-prix pace, and it's a single slider labelled "how well are you
sailing today?"

---

## 4. Validation

A polar can be silently wrong in ways that produce plausible-looking routes. Sanity
checks to run on import and after fitting:

- Monotone non-decreasing in TWS up to the point of de-powering (a real polar can
  *decrease* at high TWS as the boat becomes overpowered — allow it, but flag it)
- No speed above a hard ceiling (`~1.6 · √LWL` for a displacement hull; much higher for
  planing/foiling — needs boat-type awareness)
- Upwind target TWA plausible: 35–50° for a modern keelboat, 40–55° cruiser, 30–40°
  foiler-adjacent, 45–60° heavy cruiser
- Downwind target TWA plausible: 135–180° displacement, 120–150° planing/asymmetric
- Convexity of the polar curve — pronounced dents usually mean bad data
- Non-zero at TWS = 0 → reject

Show the polar as a plot at import time. Sailors can spot a wrong polar visually in a
second, and cannot spot it in a table.
