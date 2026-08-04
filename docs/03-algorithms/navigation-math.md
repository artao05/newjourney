# Core Navigation Math

Reference sheet for the geodesy, wind triangle, current, and layline calculations. All
of it is standard; collecting it here means we implement each thing once, correctly.

---

## 1. Conventions

| Quantity | Convention |
|---|---|
| Bearings | 0–360°, clockwise from north |
| TWA / AWA | **Signed**: positive = starboard tack, negative = port |
| Heel | Positive to starboard (positive while sailing on port) |
| Pitch | Bow-up positive |
| Leeway | Positive clockwise → positive on port |
| Latitude | +N |
| Longitude | +E |
| Speed | knots internally |
| Distance | nautical miles internally |
| Time | UTC internally, always |

Store everything in one internal unit system and convert only at the display layer.
Expedition stores time internally in UTC and displays local by preference; do the same.

Angle helpers used constantly:

```
wrap360(a)  = ((a % 360) + 360) % 360
wrap180(a)  = wrap360(a + 180) − 180          # → (−180, 180]
angdiff(a,b)= wrap180(a − b)                  # smallest signed difference
```

`angdiff` should be the *only* way angles are ever subtracted in the codebase. Nearly every
compass bug is a subtraction that forgot the wrap.

---

## 2. Geodesy

Use the **sphere** (R = 3440.065 nm = 6371.0088 km) for tactical distances, and WGS-84
ellipsoid (Vincenty or Karney) only where sub-metre accuracy matters. At buoy-racing
scale the difference is centimetres; at transocean scale it's a few miles, which matters
for ETA but not for tactics.

**Great-circle distance (haversine):**
```
Δφ = φ₂ − φ₁ ;  Δλ = λ₂ − λ₁
a  = sin²(Δφ/2) + cos φ₁ · cos φ₂ · sin²(Δλ/2)
d  = 2R · atan2(√a, √(1−a))
```

**Initial bearing:**
```
θ = atan2( sin Δλ · cos φ₂ ,  cos φ₁ · sin φ₂ − sin φ₁ · cos φ₂ · cos Δλ )
```
Note this changes along a great circle — recompute it every step in the router.

**Destination given start, bearing, distance** (δ = d/R):
```
φ₂ = asin( sin φ₁ · cos δ + cos φ₁ · sin δ · cos θ )
λ₂ = λ₁ + atan2( sin θ · sin δ · cos φ₁ ,  cos δ − sin φ₁ · sin φ₂ )
```

**Rhumb line** (constant bearing) — what a helmsman actually steers between marks:
```
Δψ = ln( tan(π/4 + φ₂/2) / tan(π/4 + φ₁/2) )       # stretched latitude difference
q  = |Δψ| > 1e−12 ? Δφ/Δψ : cos φ₁
d  = R · √(Δφ² + q²·Δλ²)
θ  = atan2(Δλ, Δψ)
```

**Cross-track error** from the great circle through `A→B`, at point `P`:
```
δ₁₃ = distance(A,P)/R ;  θ₁₃ = bearing(A,P) ;  θ₁₂ = bearing(A,B)
XTE = asin( sin δ₁₃ · sin(θ₁₃ − θ₁₂) ) · R
```
Sign convention: positive = right of track.

**Along-track distance:**
```
ATD = acos( cos δ₁₃ / cos(XTE/R) ) · R
```

At short range (< ~20 nm), a **local flat-earth projection** is far faster and accurate
enough for the start line and buoy racing:
```
x = (λ − λ₀) · cos φ₀ · R      # east, nm
y = (φ − φ₀) · R               # north, nm
```
Use this for everything on the start screen. Great-circle math on a 100 m start line is
wasted cycles and invites precision problems.

---

## 3. The wind triangle

Given apparent wind (AWA, AWS), boat speed through water (BSP), heading, and leeway.

**Apparent → true** (in the boat's frame, then rotated to earth):
```
# Cartesian, x = forward along course, y = starboard
awx = AWS · cos(AWA)
awy = AWS · sin(AWA)
twx = awx − BSP                # remove the boat's own motion through the water
twy = awy
TWS = √(twx² + twy²)
TWA = atan2(twy, twx)          # signed, same convention as AWA
TWD = wrap360(course + TWA)    where course = heading + leeway
```

**True → apparent** (needed for `Next mark Awa/Aws`, and to predict what you'll feel on
the next leg):
```
twx = TWS · cos(TWA) ;  twy = TWS · sin(TWA)
awx = twx + BSP ;       awy = twy
AWS = √(awx² + awy²) ;  AWA = atan2(awy, awx)
```

**Heel correction.** A masthead unit tilted by heel angle φ under-reads the vertical
component and mis-reads the angle. First-order correction on the measured values:
```
awy_corrected = awy / cos(φ)          # transverse component is compressed by heel
```
followed by recomputing AWS/AWA. (Nexus FDX and some other systems do this internally —
Expedition warns not to double-apply. Ours must be a single explicit toggle.)

**Masthead motion.** In a seaway the masthead swings, adding a spurious velocity of
`ω × r` (pitch/roll rate × mast height). Expedition corrects AWA/AWS for this when pitch
and roll rates are available. P2 for us — it needs a real IMU at the masthead, not a phone
in a pocket.

**Upwash / mast interference.** Real instrument systems carry a TWA/TWS correction matrix
because the sail's circulation bends the flow at the masthead. This is why calibration
tables exist. We can't replicate it without per-boat calibration, and we shouldn't pretend
to.

---

## 4. Ground wind vs. true wind

```
true wind   : relative to the water surface     (TWD / TWS)
ground wind : relative to the earth             (GWD / GWS)

ground_wind_vector = true_wind_vector + current_vector
```

**Which one goes in the polar?** True wind. The boat sails in the water and feels the wind
relative to the water. **Which one does a GRIB contain?** Ground wind — it's an
atmospheric model over a fixed earth. So in a 3 kn current the wind you'll actually
experience is not the wind in the GRIB, and the router must convert:

```
TW = GW_from_grib − current
```

This is a real, commonly-skipped correction. In a 3-knot Gulf Stream against 15 knots of
breeze, the difference between ground and true wind is ~20 % of wind speed — enough to
change target angles and route choice. Expedition exposes both GWD/GWS and TWD/TWS as
separate channels precisely because the distinction is operational, not academic.

---

## 5. Set and drift

```
water_track = vector(course, BSP)          course = heading + leeway
ground_track = vector(COG, SOG)
current     = ground_track − water_track
set   = direction of current  (the direction it flows TOWARD)
drift = magnitude, knots
```

**Gate on rate of turn.** Expedition: *"The ROT limit for current calculations sets an
upper limit at which the current set and drift will be calculated (you don't want to
calculate current during a tack)."* During a manoeuvre, heading and BSP are transient and
out of phase, and the residual is instrument lag, not water movement. Without this gate
the current arrow swings 180° every tack and users lose trust in the feature permanently.

Also damp the inputs before differencing — the difference of two noisy vectors is noisier
than either.

---

## 6. Laylines

Without current, for a mark `M` and boat at `P`:

```
layline_bearing_stbd = wrap360(TWD − target_twa)     # the course you'd sail on starboard
layline_bearing_port = wrap360(TWD + target_twa)
```

The starboard layline is the ray from `M` back along `layline_bearing_stbd + 180°`.
Distance and time to it come from intersecting the boat's current track with that ray:

```
# in the local flat projection
solve  P + t·û_course  =  M + s·û_layline     for t ≥ 0
distance_to_layline = t
time_to_layline     = t / current_speed_along_course
```

**With current**, the layline is defined in the *water* frame but drawn over ground. The
course to steer to make good the layline bearing:

```
# Required: make good ground track = layline_bearing
# Solve the vector triangle for the heading through water:
sin(heading_offset) = (drift / BSP) · sin(set − layline_bearing)
heading_to_steer    = layline_bearing − heading_offset
```
(If `|drift · sin(...)| > BSP`, the current is too strong to make that track at all — an
important, real case in tidal gates, and it must be surfaced rather than producing NaN.)

Use the **predicted current at the mark at the estimated rounding time**, not the current
current — Expedition's `Mark current set/drift` is defined exactly that way, based on
`Mark polar time`.

**Rate-of-turn allowance.** Expedition includes the time and distance to complete the tack
or gybe, and reports times to *the start of the manoeuvre*. Without this, the layline is
optimistic by roughly half a boat-length-per-degree-of-turn, and you tack late every time.

**Layline bounds.** The wind oscillates. Track `TWD` over a window, take a percentile
band (or ± one standard deviation), and draw the layline envelope. Expedition goes further
and estimates `Twd Period` — "the period of the dominant wind shift" — which implies
autocorrelation or spectral analysis of the TWD series. Even a simple ±1σ band is a huge
practical improvement over a single hard line, because it visually discourages the
classic beginner error of tacking on the layline in oscillating breeze.

**`Twd to lay mark`** — invert the relation: what would TWD have to become for the current
course to lay the mark?
```
twd_to_lay = bearing_to_mark + target_twa      (on the current tack)
```
A wonderfully teachable number: "you need a 12° left shift to lay it."

---

## 7. Time and distance to a mark

Three different answers, all worth showing:

```
Mark GPS time   = range / VMC_actual                       # from COG/SOG, no polar
Mark polar time = range / VMC_polar(twd, tws, bearing)     # if you sail perfectly, this heading
Mark time       = full polar solve including tacks         # if the mark is inside the no-go zone
```

The third needs the beat-time calculation: for a mark at bearing `β` with the wind at
`TWD`, if `|angdiff(β, TWD)| < target_twa_up`, you cannot lay it. The total beat time is

```
d_along = range · cos(angdiff(β, TWD))
time    = d_along / target_vmg_up  +  n_tacks · tack_penalty
```

and the split between tacks (`Next mark time on port` / `on starboard`) is a simple
triangle solve:

```
# Sailing legs on port and starboard whose vector sum equals the rhumb to the mark
solve  a·û_port + b·û_stbd = M − P     for a, b ≥ 0
```

That split is one of the most useful numbers in the app: it tells you immediately whether
you're on the long tack or the short one, which is the fundamental first-beat decision.

---

## 8. Magnetic variation

Racers work in magnetic. Course axes are set in magnetic. Every compass on the boat is
magnetic.

```
bearing_magnetic = wrap360(bearing_true − variation_east)
```

Use the **World Magnetic Model** (WMM, NOAA/NCEI) — a spherical-harmonic model updated
every 5 years, public domain, and a small enough computation to run client-side. Cache
per position; variation changes slowly enough that recomputing per fix is wasteful.

**Make °T vs °M a single global display toggle**, and default it to magnetic. Expedition
lets you set the W/L course axis "in degrees magnetic" for exactly this reason.

---

## 9. Solar position (for day/night)

Needed for the night-polar factor and for automatic night display mode. Use the standard
NOAA solar position algorithm:

- Compute solar declination and equation of time from the Julian date
- Hour angle for a given solar elevation → sunrise/sunset (elevation −0.833°) and
  **civil twilight** (−6°)

Expedition switches the night polar between civil dusk and civil dawn, and can trigger the
night palette at dusk. Match that definition exactly so the numbers agree.

---

## 10. Numerical care

- Never subtract bearings without `angdiff`.
- Never interpolate directions — interpolate u/v.
- Never average angles arithmetically — use `atan2(mean(sin), mean(cos))`.
- Watch `acos` domain errors from floating point: clamp arguments to [−1, 1].
- Longitude wrap at ±180° breaks naive bounding boxes; normalise or use a wrap-aware
  bbox type. This bites in the Pacific and nowhere else, which is why it always ships.
- Prefer `atan2` over `atan` everywhere; it handles quadrants and zero denominators.
- At the poles, bearing is undefined. Not our problem, but don't crash.
