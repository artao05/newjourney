# Polars, Targets and VPP

Everything the router and the tactical numbers depend on flows from one function:

```
bsp = f(tws, twa)
```

---

## 1. Interpolating a ragged polar table

Polar files are ragged — each TWS row can have its own TWA breakpoints. Lookup:

```
polar_speed(tws, twa):
    a ← |twa| clamped to [0, 180]
    (i, j, α) ← bracket rows by tws        # α = fractional position between row i and j
    v_i ← interp_row(row[i], a)
    v_j ← interp_row(row[j], a)
    return (1−α)·v_i + α·v_j
```

with `interp_row` a 1-D interpolation over that row's `(twa, bsp)` pairs.

**Choice of interpolant.** Linear is safe and slightly pessimistic near the peaks.
Monotone cubic (PCHIP / Fritsch–Carlson) is smoother and does not overshoot — important,
because a plain cubic spline through polar points will invent boat speed that doesn't
exist, and the router will happily route to exploit it. **Use PCHIP, never a natural
cubic spline.**

Below the lowest TWS row: scale toward zero (`v ∝ tws` is a reasonable, conservative
approximation in very light air — real boats do worse). Above the highest: hold the top
row, or extrapolate downward if the polar shows de-powering. Never extrapolate upward.

**Performance.** Precompute onto a regular lattice at load time — say TWS 0–50 kn in
0.5 kn steps × TWA 0–180° in 1° steps = 100 × 181 floats = 72 KB. Then every lookup in the
router's inner loop is one bilinear interpolation on a flat `Float32Array`. This is worth
a large constant factor and is the single easiest routing optimisation.

---

## 2. Deriving targets

Targets are **not stored** — Expedition derives them, and so should we:

```
VMG(twa) = polar_speed(tws, twa) · cos(twa)

target_twa_up = argmax   over twa ∈ (0°, 90°]  of VMG(twa)
target_twa_dn = argmin   over twa ∈ [90°, 180°] of VMG(twa)      # most negative
target_bsp_up = polar_speed(tws, target_twa_up)
target_vmg_up = VMG(target_twa_up)
```

Search on the *interpolated curve* (0.5° steps, then a golden-section or parabolic refine),
not on the table points. Expedition's warning about targets jumping between adjacent table
points when you edit one is a direct consequence of doing it the other way.

Precompute a target table over TWS at load. Every layline, every no-go angle, and every
implicit-tacking substitution reads from it.

The upwind target TWA is the **no-go angle** — the boundary of the sector the boat cannot
sail. It's TWS-dependent: typically wider (higher) in very light and very heavy air,
narrowest in the boat's sweet spot.

---

## 3. Scalings, in order

```
tws_used = tws_10m
         · height_factor              # (h/10)^a,  a ≈ 0.11–0.14   — see §4
         · model_scale                # user correction for a biased model
         · decaying_correction(t)     # blends a "right now" correction back to forecast

bsp = polar_speed(tws_used, twa)
    · polar_pct / 100                 # crew/boat condition
    · (is_night(t, lat, lon) ? night_pct/100 : 1)
    · wave_factor(...)                # §5
    · air_density_factor(...)         # §6
    · zone_factor(p)                  # race-note speed-reduction polygons
```

The order matters: wind scalings apply to the *input* of the polar; performance scalings
apply to its *output*. Conflating them produces subtly wrong target angles, because
scaling TWS moves you to a different polar curve while scaling BSP doesn't.

---

## 4. Wind height scaling

Given by Expedition explicitly:

```
TWS(h) = TWS(10 m) · (h / 10)^a          a ∈ [0.11, 0.14] at sea
```

Designer polars are usually referenced to 10 m; instruments read at masthead height. A
20 m rig with `a = 0.12` gives a 9 % increase.

**UI implication:** ask for mast height once, in boat setup, and derive the factor. Never
show the user a percentage. Expedition makes the sailor do this arithmetic; that's a page
of manual we can replace with one number.

Refinement (v2): the exponent depends on atmospheric stability — larger over cold water
under warm air (stable, more shear), smaller in unstable conditions. If we have SST and
air temperature we can pick `a` per condition instead of using a constant. Marginal gain,
but free once we have both fields.

---

## 5. Wave correction

Reconstructed model (see
[../01-expedition-analysis/how-it-computes.md §9](../01-expedition-analysis/how-it-computes.md#9-wave-correction)):

```
wave_factor = 1 − (P_max/100) · f_height(Hs, L) · g_angle(Δθ) · h_period(T, L, v)
```

| Term | Suggested form | Rationale |
|---|---|---|
| `f_height` | `min(1, (Hs / Hs_ref)) `, with `Hs_ref` scaled by `√L` | Added resistance grows with wave height; a given sea is far worse for a short boat |
| `g_angle` | `cos²(Δθ)` for `|Δθ| < 90°`, ~0.1–0.2 astern | Head seas dominate; following seas can even help |
| `h_period` | Peak near encounter period ≈ boat pitch period, `T_pitch ∝ √L` | Resonant pitching is where the speed actually goes |

Sources, in priority order (Expedition's own list):
1. Swell direction + period + height
2. Primary wave direction + period + significant height
3. Mean wave direction + period + significant height

**Crossed-sea penalty** (mainly multihulls) fires when all three hold:
1. Both swell and wind-wave heights exceed a minimum,
2. Combined height exceeds a threshold,
3. The angle between wind waves and swell is within a tolerance of 90°.

Wind waves are excluded by default because they're already baked into a polar measured in
real conditions. Say this in the UI — it's the kind of thing that looks like a missing
feature and is actually correctness.

**Ship this off by default with an explanation.** An untuned wave model is worse than no
wave model, because it moves the route with unearned confidence.

---

## 6. Air density

```
ρ = p_dry/(R_d·T) + p_vapour/(R_v·T)
factor = (ρ / ρ_ref)^β
```
with `ρ_ref` at Expedition's stated reference — 1013.25 hPa, 15 °C, 80 % RH — and `β`
somewhere around 0.3–0.5 (aerodynamic force scales linearly with ρ, boat speed sublinearly
with force). Effect is small (a few tenths of a percent in normal conditions, more in hot
thin air), so this is a P2 refinement, not an MVP feature.

Note the counter-intuitive physics worth putting in a tooltip: **humid air is less dense
than dry air** at the same temperature and pressure, because water vapour (18 g/mol) is
lighter than dry air (~29 g/mol). Hot, humid, low-pressure days are slow days.

---

## 7. Heel, leeway and target heel

If a heel polar exists:

```
target_heel = heel_polar(tws, target_twa)
polar_heel  = heel_polar(tws, twa)
```

`Target heel` is arguably the most actionable single number for a dinghy or sportboat
crew — it's a direct, immediate instruction ("flatten the boat"), unlike target speed
which is a lagging indicator.

Leeway, from Expedition's own stated relation:

```
leeway ≈ k · heel / bsp²
course = heading + leeway
```

`k` is boat-specific (fin keel ~ 8–12 in the usual units; a centreboard dinghy differs).
This matters for laylines: a boat making 4° of leeway that ignores it will consistently
overstand or fail to lay the mark, and never understand why.

---

## 8. Inverse lookups

Two useful inversions Expedition exposes:

**`Polar Tws`** — infer wind speed from observed boat speed (and optionally heel):

```
polar_tws(bsp_observed, twa) = the tws such that polar_speed(tws, twa) = bsp_observed
```

Monotone in TWS below de-powering, so bisection works. Diagnostic: if `Polar Tws` and the
measured TWS disagree persistently, one of the two is wrong.

**`Target Twd`** — infer what the wind direction *must* be, assuming you're sailing at
target TWA:

```
target_twd = course + target_twa · sign(current tack)
target_twd_delta = target_twd − twd_measured
```

A persistent non-zero delta means either the masthead unit is misaligned or the polar's
target angle is wrong for this boat. This is instrument calibration for free, and it's the
kind of thing a coach would love and a beginner would never think to check.

---

## 9. VMC

Velocity made *course* — the component of speed toward the mark:

```
VMC(twa) = polar_speed(tws, twa) · cos( bearing_to_mark − heading(twa) )
```

`Vmc optimum` maximises this over TWA, giving `Vmc optimum heading` and
`Vmc optimum twa`. This answers the everyday tactical question "should I foot off or
point up to get to that mark?" — which is different from the VMG question ("am I sailing
the boat well?").

Sail *VMG* when the mark is dead upwind or dead downwind. Sail *VMC* when it isn't. The
crossover is one of the genuinely non-obvious skills in racing, and a good app can teach it
by simply showing both and highlighting which one currently applies.
