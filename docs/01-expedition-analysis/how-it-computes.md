# How Expedition Probably Computes What It Computes

Expedition is closed source. This document reconstructs its internals from three
kinds of evidence:

1. **Explicit statements in the manual** — quoted verbatim, marked ✅ **documented**.
2. **Strong inference** from the names, units, and dependency structure of its ~400
   channels and its settings — marked 🔍 **inferred**.
3. **Standard practice** in the published marine-routing literature, which the manual's
   vocabulary tracks closely — marked 📚 **literature**.

Where the manual gives a formula, we use it. Where it doesn't, we say so.

---

## 1. Coordinate and angle conventions

✅ **documented.** Expedition states its sign conventions outright:

| Quantity | Convention |
|---|---|
| TWA, AWA | Positive on starboard, negative on port |
| Trim (pitch) | Bow-up positive |
| Heel (roll) | Positive to starboard (i.e. positive when sailing on port) |
| Leeway | Signed so clockwise leeway is positive → leeway > 0 on port |

And the fundamental identities:

```
course  = heading + leeway
COG     = heading + leeway + current      (i.e. course + current vector)
leeway  ≈ k · heel / bsp²
```

Two definitions that matter and are widely muddled elsewhere:

- **TWD/TWS** are referenced to *the surface of the water* — they ignore current.
- **GWD/GWS** ("ground wind") are referenced to *the surface of the earth*.

So `Ground wind = True wind + current vector`. Expedition exposes both. (The manual
also notes Deckman uses ground wind as the What-if? input whereas Expedition uses true
wind — a compatibility footnote worth remembering if we ever import Deckman data.)

**Expedition's TWA includes leeway.** Verbatim: "If your instrument system calculates
Twa to the centreline of the boat, then Expedition will add the leeway value (if any) to
that to generate Expedition's Twa." So Expedition's TWA is the angle between the wind
and the boat's *track through the water*, not its centreline. This matters for polar
lookups: a polar keyed on Expedition-TWA is keyed on course, not heading.

---

## 2. Wind height scaling

✅ **documented**, formula given explicitly:

```
TWS_masthead = TWS_10m · (h / 10)^a
```

where `h` is masthead/instrument height in metres and `a` is the **Hellmann exponent**,
"normally in the range 0.11 to 0.14 at sea."

Worked example from the manual: `h = 20 m`, `a = 0.12` → `(20/10)^0.12 = 1.09` → enter
**109 %** in Scale winds.

This is the standard power-law wind profile. It matters more than it looks: designer
polars are usually referenced to 10 m, boat instruments read at masthead height, and a
9 % TWS error moves target boat speed by several tenths of a knot and target TWA by
degrees. Getting this wrong silently poisons every downstream number.

**Implication for us:** we should apply this automatically from a single "mast height"
input in boat setup, and never make the user think about percentages. This is a
one-field replacement for a settings page.

---

## 3. Weather field merging

✅ **documented** (behaviour), 🔍 **inferred** (mechanism):

> "Expedition can seamlessly merge and use multiple Grib files, automatically using the
> best available data in the selected Grib files for its calculations."

And on tides specifically:

> "Tidal stream data is used in preference to grib current data where both are present."

The inferred mechanism is a **priority-resolved field query**. Rather than pre-merging
grids, Expedition almost certainly answers a query of the form
`(lat, lon, t, parameter) → value` by walking loaded datasets in a precedence order and
taking the first that covers the point. Evidence:

- There is "no practical limit to the number of Grib files that can be loaded."
- Files can cover different times *and* different areas.
- Enabling/disabling a file is a checkbox, taking effect immediately — cheap for a
  query-time resolver, expensive for a pre-merge.
- The Newport–Bermuda example describes precedence changing *along a route*: tidal
  streams inshore, GRIB Gulf Stream offshore.

Likely precedence, highest first: user "What-if?"/held values → tidal-stream database →
high-resolution regional model → global model → climatology. Within a tie, finer grid
spacing and more recent analysis time win.

**Our design consequence:** build a `WeatherProvider` interface with exactly this
signature and an ordered stack of sources, rather than a monolithic merged grid. It also
makes the "which model said that?" tooltip trivial, which is a teaching feature
Expedition lacks.

---

## 4. Field interpolation

🔍 **inferred**, 📚 **literature**. The manual never states its interpolation scheme,
but the behaviour constrains it:

- **Space:** bilinear in (lat, lon) on the source grid is near-universal. Wind must be
  interpolated as **u/v components, not speed/direction** — interpolating direction
  across the 0°/360° wrap produces garbage. Every GRIB wind field is natively stored as
  u/v (10u/10v), which is why Squid's download UI requires selecting both.
- **Time:** linear between forecast steps, again on u/v.
- **Currents:** same treatment, u/v.
- **Wave direction/period:** these are *not* safely linearly interpolable across
  crossing swell trains; nearest-neighbour in time is more defensible.

The `Animation interval` default of 60 minutes with GRIB steps of 3 h implies temporal
interpolation is definitely happening — you can step to a time that has no forecast
field.

---

## 5. Polar lookup and target derivation

✅ **documented** for the data model (see
[feature-inventory.md §8](feature-inventory.md#8-polars--the-data-model)),
🔍 **inferred** for the interpolation.

Given a polar as a ragged table `TWS_i → [(TWA_ij, BSP_ij)]`:

**Boat speed lookup `bsp(tws, twa)`** is a 2-D interpolation, but a *ragged* one — rows
have different TWA breakpoints. The standard approach, which fits Expedition's behaviour:

1. Find bracketing TWS rows `i`, `i+1`.
2. Within each row, interpolate BSP at the requested `|TWA|` — 1-D, monotone.
3. Interpolate between the two row results in TWS.

Whether steps use linear or a shape-preserving spline (PCHIP/monotone cubic) is not
stated. Evidence leans toward something smoother than linear: the polar editor draws
smooth curves, and the manual's warning that editing one point can *change which point
is the target* implies targets are found by scanning a densely evaluated curve, not by
comparing table rows.

**Target derivation** ✅ documented: "Exp automatically determines which point is the
target (maximum upwind or downwind vmg)." So:

```
VMG(twa) = bsp(tws, twa) · cos(twa)
target_twa_upwind   = argmax over twa ∈ (0°, ~90°)   of VMG
target_twa_downwind = argmin over twa ∈ (~90°, 180°) of VMG   (most negative)
target_bsp          = bsp(tws, target_twa)
target_vmg          = |VMG(target_twa)|
```

Note the subtlety flagged in the manual: because targets are recomputed from the curve,
a hand-edited point can steal target status from its neighbour. Any polar editor we
build needs to show the derived target live.

**Scalings applied on top**, in an inferred order:

```
bsp_effective = bsp(tws_scaled, twa)
              · polar_pct/100
              · (night ? polar_pct_night/100 : 1)
              · wave_factor(swell, wind_waves, crossed_sea)
              · air_density_factor(p, T, dewpoint)
```

where `tws_scaled` already includes the height scaling, the model bias scaling, and any
decaying user correction.

---

## 6. The isochrone routing algorithm

✅ **documented** at a high level, 📚 **literature** for the mechanism. Expedition's
description — "pushes an isochrone out from the start point," "to an extent… allowed to
sail around corners," "initial search angle… half this value each side of the route,
default 200°" — matches the **Hagiwara-style modified isochrone method** used across
commercial marine routing since ~1989.

Full treatment in [../03-algorithms/routing-isochrone.md](../03-algorithms/routing-isochrone.md).
The reconstruction in brief:

```
S₀ = { start position }
for each time step Δt:
    candidates = ∅
    for each point p in S_{k}:
        for each heading θ in the search fan about the great-circle bearing:
            w   = wind(p, t_k)              # priority-resolved, interpolated
            c   = current(p, t_k)
            v   = polar_speed(w, θ) with all scalings
            p'  = advance(p, θ, v, c, Δt)   # vector sum of boat-through-water + current
            if crosses land / exclusion / violates TWS or wave limits: reject
            cost = t_k + Δt + tack_gybe_penalty(if tack/gybe occurred)
            candidates ∪= { p' with backpointer to p }
    S_{k+1} = prune(candidates)
```

**The whole game is `prune`.** Without it the frontier grows as `fan^k`. The classical
pruning is a **sector/corridor decomposition**: fan out sub-sectors from the origin (or
from the destination bearing), and keep only the single furthest-advanced point in each
sector. Modern variants prune on distance-to-goal or on a lattice bucket.

Evidence Expedition prunes on a **spatially bucketed** criterion rather than pure
distance-along-great-circle:

- "To an extent, the isochronal algorithm is allowed to sail around corners" — a pure
  great-circle-distance pruning cannot round a headland, because backwards-in-distance
  moves get culled.
- Land avoidance and race-note obstacles are explicitly cited as areas where the
  isochronal algorithm is *better* than the grid one.
- "Minimum isochrone resolution… allowing too low a resolution may yield worse results"
  — classic isochrone pathology: too-fine time steps make each step's reachable set
  smaller than the pruning bucket, so distinct branches collapse.

**Auto-resolution** ✅ documented: chosen "based on the grib time steps and grid
resolution and leg length." Inferred rule of thumb: `Δt` is a divisor of the GRIB time
step (so you sample real forecast fields, not just interpolations), bounded below by
the minimum-isochrone-resolution setting and above by needing enough steps to resolve
the leg.

**Tack/gybe penalties** ✅ documented as user-specified seconds, applied when a
transition crosses head-to-wind or dead-downwind. The note that they are "not used for
reverse isochrones" is a strong hint that the reverse pass is a separate, simpler
computation — see §8.

**Implicit tacking** ✅ documented behaviourally: dashed route segments with TWA in
parentheses mean "Exp has tacked or gybed for that part of the optimal route… in other
cases it might mean staying in a lane of stronger wind." This is the standard treatment
of the no-go zone: when the required course is inside the tacking angle, you cannot sail
it directly, so the router substitutes a VMG-equivalent zigzag whose *net* progress along
the desired bearing is `target_vmg`, and reports the negative/parenthesised TWA to signal
"this leg is a beat, not a course."

---

## 7. The grid routing algorithm

🔍 **inferred**, 📚 **literature**. Documented properties:

- "uses an adaptive grid over the route area"
- "originally developed for routing studies where it was important to compare similar
  simulations" → deterministic and reproducible
- "not designed to route around corners. One solution is to use multiple marks"
- only algorithm supporting "optimise along great circle"
- controlled by a *spatial* resolution, not a time step

That is a **time-dependent shortest-path search on a fixed spatial lattice**: nodes are
grid cells, edge cost is the time to sail between adjacent cells given the wind and
current *at the arrival time*, solved with Dijkstra or A*. Because the lattice is fixed,
two runs with different polars or different GRIBs produce directly comparable node sets
— exactly the property you want for A/B studies. Because edges only connect neighbouring
cells in a limited stencil, sharp course reversals around a headland are penalised or
impossible, which explains "not designed to route around corners."

"Adaptive" most likely means the cell size varies with distance from the rhumb/great-circle
corridor, or refines near marks and coastlines.

Note the theoretical wrinkle: with tack/gybe penalties the cost is not memoryless (the
cost of entering a cell depends on the heading you entered it with), so a correct
implementation expands the state space to (cell, tack) or (cell, heading bucket). We
should do the same.

---

## 8. Reverse isochrones and route sensitivity

✅ **documented** definition, 🔍 **inferred** mechanism. The manual:

> "Reverse Isochrones use fancy math to work the optimal route backwards through the GRIB
> fields from finish to start… Reverse isochrones are lines of points equidistant in time
> from the finish."

The honest description of "fancy math": running the forward algorithm on the **time-reversed
problem**. From the finish, at each backward step, ask "from which points could I have
reached here in Δt?" That requires evaluating the polar with the wind *at the earlier
time*, sailing the reciprocal heading. It is not simply the forward algorithm run
backwards, because:

- The wind field is time-varying, so the backward pass must index time correctly.
- Boat speed is not symmetric under reversal — sailing A→B is not the reciprocal of
  B→A in the same wind.
- Tack/gybe penalties are path-history-dependent, which is exactly why the manual says
  they are **not used for reverse isochrones**. Dropping them makes the backward pass
  memoryless and therefore tractable.

**What it gives you:** define `T_f(p)` = earliest arrival time at `p` from the start, and
`T_r(p)` = minimum remaining time from `p` to the finish. Then

```
total(p) = T_f(p) + T_r(p)
loss(p)  = total(p) − total(optimal route)
```

`loss(p)` is the **cost of being at p** — minutes you'd give up by passing through that
point. That scalar field is the sensitivity map. Shading `loss(p) < N minutes` produces
Expedition's "shade time sensitivity" envelope directly. This is a textbook
forward–backward (Bellman) decomposition, and it is genuinely the most valuable idea in
the product.

**Why it matters more for beginners than experts** — the manual's own reading rule:

> "If the forward and reverse isochrones are close together and parallel over a large
> distance along their length, then the optimal route isn't very critical, but if they
> are only close together over a small distance, then the optimal route is much more
> critical."

Translated: the sensitivity field tells you *how much to trust the line on the screen*.
A beginner's failure mode is treating the magenta line as truth. We should ship this as
a plain-language confidence readout ("anywhere in this band costs you under 10 minutes"),
not as a pair of isochrone families the user must learn to interpret.

---

## 9. Wave correction

✅ **documented** structurally, 🔍 **inferred** numerically. What we know:

- Requires **boat length** to be correct in settings.
- Swell source priority: (swell dir/period/height) > (primary wave dir/period + Hs) >
  (mean wave dir/period + Hs).
- User enters *percentages*, described as "the maximum effect at the reference height."
- Wind waves are off by default because "wind wave effects are normally as are in the
  polar."
- Crossed-sea penalty fires on three simultaneous conditions (both heights above a
  minimum, combined height above a threshold, wind-wave/swell angle within a tolerance
  of 90°).

The inferred model is a multiplicative polar penalty:

```
factor = 1 − P_max/100 · f_height(Hs, L) · g_angle(wave_dir − heading) · h_period(T, L, v)
```

- `f_height` scales with `Hs` relative to a reference height, and with `Hs / L` — a 2 m
  sea is nothing to a 60-footer and brutal to a 25-footer. Boat length being *required*
  is the tell.
- `g_angle` peaks head-on and decays to ~0 following. Real added-resistance curves are
  roughly `cos²` in the bow quadrant.
- `h_period` captures encounter frequency: the penalty peaks when the wave encounter
  period is near the boat's pitch natural period, which scales with `√L`. This is why
  period is in the priority list at all.

📚 In ship routing this is the **added resistance in waves** problem (Maruo / Gerritsma–Beukelman
strip theory, or the ISO 15016 / STAwave-2 empirical forms). Expedition almost certainly
uses an empirical fit, not strip theory — the user-tunable "percentage" is the giveaway.

**Our approach:** ship a simple, documented, tunable form rather than pretending to
physics we can't validate, and default it *off* with an explanation, exactly as Expedition
does for wind waves.

---

## 10. Start line math

Fully reconstructed in [../03-algorithms/start-line-math.md](../03-algorithms/start-line-math.md).
Key documented facts:

- `Start time to burn = time_to_line − time_to_gun`
- `Start distance below line` is "the minimum of the bow and GPS position below the line…
  negative if over the line. Essentially the XTE from the line" — i.e. signed
  perpendicular distance to the infinite line through the two ends.
- `Start time to line` = "shortest time to the line at targets (includes tacking or
  gybing and acceleration) based on the start polar, rate of turn and acceleration
  settings."
- Expedition computes *many* candidate approaches — to each end, on each layline, on a
  reach, from GPS COG/SOG, with left or right turns, pinching above targets — and takes
  the **minimum** over the subset the user enabled.
- `Start bias angle`: negative = port end favoured, positive = starboard.
- `Start line square wind` = the TWD that would make the line perfectly square.
- Calibration inputs: rate of turn (°/s as a function of BSP), acceleration (kn/min as a
  function of TWS and TWA), braking (seconds to stop as a function of ROT).
- Bow-to-GPS offset is applied so the *bow* is what crosses the line.

The presence of acceleration and turn dynamics is what separates a real time-to-line from
the naive `distance / SOG` that consumer apps ship. It's also why Expedition insists ROT
and acceleration are "always on, else the time to the line functions can not work."

---

## 11. Laylines

🔍 **inferred** from the channel set, which is unusually explicit.

Basic (no current):

```
layline_bearing_stbd = TWD − target_twa
layline_bearing_port = TWD + target_twa
```

The layline to a mark on starboard tack is the line through the mark at
`TWD − target_twa`; time and distance to it come from intersecting the boat's current
track with that line.

Expedition then layers on:

- **Current-corrected laylines** (`Layline tide … time`, `Tide left/right … time`): the
  layline is computed in the *water* frame, then the required heading is corrected for
  set and drift — so the drawn layline over ground is skewed. It uses the *predicted*
  current at the mark at the estimated time of rounding (`Mark current set/drift` is
  documented as exactly that, based on `Mark polar time`).
- **Rate-of-turn allowance** ✅ documented: "Exp will include the time and distance to
  turn to the opposite tack or gybe when calculating laylines… Time and distance to each
  layline will be to the *start* of the tack or gybe."
- **Layline bounds** (`Lay max/min bearing on port/strb`): the envelope of laylines under
  the observed wind oscillation, using `Twd Period` — Expedition tracks "the period of
  the dominant wind shift" and "the period of the dominant tws cycle," which implies a
  spectral or autocorrelation analysis of the TWD/TWS time series.
- **Gate spot**: the intersection of the laylines to the two gate marks — the point from
  which both gates are equally reachable.
- **`Twd to lay mark`** — "what the wind direction would have to shift to in order to lay
  mark." Elegant inverse framing, and a great teaching number.

---

## 12. VMC optimisation

🔍 **inferred**, straightforward. VMC = velocity made *course*, the component of SOG
towards the current mark.

```
VMC(twa) = bsp(tws, twa) · cos(bearing_to_mark − (TWD − twa))
Vmc_optimum        = max over twa of VMC
Vmc_optimum_heading = the heading achieving it
Vmc_optimum_twa     = the TWA at that heading
```

Expedition exposes `Vmc`, `Vmc%`, `Vmc optimum`, `Vmc optimum heading`,
`Vmc optimum twa`, `Vmc polar`, and `Vmc to mark polar`. The distinction between
`Vmc polar` (VMC at the *current* heading per the polar) and `Vmc` (actual, from SOG) is
the performance-vs-tactics split: one tells you if you're sailing the boat well, the
other tells you if you're pointed the right way.

---

## 13. Current (set and drift)

✅ **documented**: "The calculations of set and drift use the Expedition system damped
values of cog, sog, bsp, hdg and leeway. The ROT limit for current calculations sets an
upper limit at which the current set and drift will be calculated (you don't want to
calculate current during a tack)."

So:

```
water_track_vector  = (heading + leeway, bsp)
ground_track_vector = (COG, SOG)
current_vector      = ground_track_vector − water_track_vector
```

...computed on damped inputs and gated on `|ROT| < limit`. The gating is the practical
insight: during a manoeuvre, BSP and heading are transient and the residual is noise, not
current. Any implementation without that gate produces a current arrow that swings wildly
every tack.

---

## 14. Performance channels

🔍 **inferred**, but the naming makes them nearly self-defining:

```
Polar Bsp      = bsp(tws, twa)                     from the performance polar
Polar Bsp%     = 100 · bsp_actual / Polar Bsp
Target Bsp     = bsp at the target TWA for this TWS
Target Bsp%    = 100 · bsp_actual / Target Bsp
Vmg            = bsp · cos(twa)                    (with leeway included in twa)
Vmg%           = 100 · Vmg / Target Vmg
Delta target bsp = bsp_actual − Target Bsp
Delta target twa = twa_actual − Target Twa
Polar Tws      = the TWS implied by the observed BSP (and optionally heel) via inverse polar lookup
Target Twd     = "Estimated Twd based on course and target twa from the nav polar"
Target Twd Delta = Target Twd − instrument Twd
```

`Polar Tws` (inverting the polar to infer wind speed from boat speed) and `Target Twd`
(inferring what the wind *must* be if you were sailing perfectly) are clever
cross-checks on instrument calibration: if `Target Twd Delta` is persistently non-zero,
either the wind sensor or the polar is wrong.

---

## 15. What we should copy, and what we should not

**Copy the ideas:**

- Priority-resolved multi-source weather query (§3)
- Auto-selected routing resolution from data characteristics (§6)
- Forward + backward passes giving a sensitivity field (§8)
- Height-scaled wind as a single boat-setup field (§2)
- Derived (not stored) polar targets (§5)
- ROT-gated current estimation (§13)
- Day/night polar scaling — a one-line change with real accuracy payoff
- Time-shifting and decaying-correction of the forecast (§4.3 in the inventory)

**Do not copy:**

- Exposing 40 routing settings. Expedition's own docs mark half of them "not normally
  used" or "advanced users only." Ship three presets and an "advanced" drawer.
- Exposing 400 channels. Ship ~20 and let power users add more.
- Requiring a polar file before the app does anything useful. We can ship class-default
  polars and infer a rough one from the user's own tracks.
- Silent precision. Every routing output should carry its sensitivity band.
