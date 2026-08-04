# The Isochrone Routing Algorithm

The core algorithm. This document is written to be implementable from scratch, without
reading any GPL source.

**Provenance:** the method is published literature — the isochrone method dates to the
1950s, with the modern recursive/pruned formulation usually credited to Hagiwara (1989),
and a large subsequent literature on "modified isochrone" and "3-D modified isochrone"
variants. Expedition describes its own implementation in enough detail
([../01-expedition-analysis/how-it-computes.md §6](../01-expedition-analysis/how-it-computes.md#6-the-isochrone-routing-algorithm))
to confirm the shape.

---

## 1. The problem

Given:
- a start position `P₀` and start time `t₀`
- a destination `P_end` (or an ordered list of marks)
- a **polar** `bsp(tws, twa)` giving achievable boat speed
- time-varying fields `wind(p, t)` and `current(p, t)`
- obstacles: land, shallows, exclusion zones
- constraints: max TWS, max wave height, tack/gybe penalties

find the path minimising arrival time.

This is a **continuous-space, time-dependent, non-holonomic shortest-path problem**. It
is not Dijkstra on a road network:

- The "edge cost" depends on *when* you traverse it (the wind changes).
- The reachable set from a point is direction-dependent and asymmetric (you can't sail
  upwind).
- Optimal substructure holds in time (the fastest way to a point at a given time doesn't
  depend on how you got there) — **except** once you add tack/gybe penalties, which make
  cost depend on your arrival heading.

---

## 2. The basic loop

```
S₀ ← { Node(position: P₀, time: t₀, parent: null, tack: none) }
k  ← 0

while destination not reached and k < max_steps:
    Δt         ← choose_time_step(k)
    candidates ← []

    for node in S_k:                                # frontier
        for heading θ in fan(node):
            w  ← wind(node.p, node.t)               # priority-resolved, u/v interpolated
            c  ← current(node.p, node.t)
            twa ← angle_between(θ, w.direction)

            if |twa| < no_go_angle(w.speed):  continue    # can't sail there
            if w.speed > max_tws or w.speed < min_tws: continue
            if wave_height(node.p, node.t) > max_wave: continue

            v_boat  ← polar_speed(w.speed, twa) · all_scalings
            v_total ← vector_add(polar(θ, v_boat), current_vector(c))
            p'      ← advance_great_circle(node.p, v_total, Δt)

            if crosses_land(node.p, p') or crosses_exclusion(node.p, p'): continue

            penalty ← tack_gybe_penalty if manoeuvred(node.tack, sign(twa)) else 0
            candidates.push(Node(p', node.t + Δt + penalty, parent: node, tack: sign(twa)))

    S_{k+1} ← prune(candidates)
    if any node in S_{k+1} can reach destination directly this step:
        record a finish candidate
    k ← k + 1

return best finish candidate, walking parents back to the start
```

Everything interesting is in `fan`, `prune`, and `choose_time_step`.

---

## 3. The heading fan

For each frontier node we try a set of headings. Expedition's setting:

> "Initial scan angle — Initial search angle for isochronal route optimisation. Expedition
> will initially search half this value each side of the route… Default is 200°. Larger
> values may be necessary at times, but will take longer to run."

So the fan is a **cone of ±100° about the bearing to the destination**, sampled at some
angular step. The word "initial" implies the cone adapts as the search proceeds — likely
narrowing once the frontier is established, or widening when the frontier stops
progressing (which is what happens when land or a wind hole forces a large detour).

Practical choices:

| Parameter | Suggested | Note |
|---|---|---|
| Cone half-width | 100° initially | Wider (up to 180°) when blocked |
| Angular step | 5–10° | Finer near the no-go boundary |
| **Snap to VMG angles** | Always include `TWD ± target_twa_up` and `TWD ± target_twa_dn` | Cheap, and it stops the discretisation from missing the optimum by a degree |

That last row matters more than the step size. The optimum upwind heading is almost
always exactly the target TWA; if your fan lands on 44° and 49° but the target is 46.5°,
every upwind leg is systematically slow.

### Handling the no-go zone (implicit tacking)

When the bearing you want is inside the tacking angle, you cannot sail it. Two valid
treatments:

1. **Explicit** — only generate headings outside the no-go zone and let the search
   discover the zigzag. Correct, expensive, and produces routes littered with tacks.
2. **Implicit / VMG substitution** — allow a "virtual" heading straight up the desired
   bearing at the *VMG-equivalent* speed:
   `v_effective = target_vmg_upwind` when `|twa_wanted| < target_twa_up`.

Expedition clearly does (2), because of the documented behaviour: dashed segments with
TWA reported in parentheses, e.g. `(-12)`, meaning "we tacked through here." Its manual
notes this can also mean the router chose to stay "in a lane of stronger wind" — so the
substitution is not purely mechanical.

**Recommendation:** implement (2) as the default and (1) as an "explicit tacks" option
for short courses where each tack matters. Report the substituted segments distinctly, as
Expedition does — hiding them is dishonest, because the drawn line is not a course to
steer.

---

## 4. Pruning — the heart of it

Without pruning the frontier grows as `|fan|^k`. Pruning is what turns an exponential
search into a linear one, and its design determines the algorithm's failure modes.

### 4.1 Classical sector pruning (Hagiwara)

Divide the space around the origin into angular sectors relative to the great-circle
bearing. In each sector, keep only the node that has advanced furthest toward the
destination.

```
for node in candidates:
    s ← sector_index(bearing(P₀ → node.p))
    if node.progress > best[s].progress: best[s] ← node
S_{k+1} ← values(best)
```

Simple, fast, and **cannot round a headland** — a node that must temporarily move *away*
from the destination is always dominated by one that didn't.

### 4.2 Spatial-bucket pruning (recommended)

Bucket candidates on a spatial grid (or a geohash / H3 cell) and keep the earliest-arriving
node per bucket:

```
for node in candidates:
    b ← bucket(node.p, resolution)
    if node.time < best[b].time: best[b] ← node
```

This is closer to a Dijkstra label-setting relaxation and it *can* round corners, because
"progress toward destination" never enters the criterion. It matches Expedition's claim
that the isochronal algorithm is better "around obstructions such as land or race notes"
and is "to an extent… allowed to sail around corners."

**Bucket resolution is the critical tuning knob.** Too coarse and you merge genuinely
different tactical options (the left and right side of a course collapse into one). Too
fine and the frontier explodes. A reasonable heuristic: bucket size ≈ the distance the
boat travels in one time step, divided by 3–5.

This also explains Expedition's warning about *too fine* a time step:

> "Minimum isochrone resolution — Limits the minimum automatically determined isochrone
> time steps… as allowing too low a resolution may yield worse results."

With a small `Δt` and a fixed bucket size, every branch lands in the same bucket, distinct
options get merged, and the search degenerates.

### 4.3 With tack/gybe penalties: expand the state

Penalties break memorylessness. Fix by keying buckets on `(cell, tack)` rather than
`cell`:

```
b ← (bucket(node.p), node.tack)
```

This doubles the frontier and is worth it. Without it, a node that arrived on port tack
can be pruned by one that arrived on starboard a few seconds earlier, and the penalty is
silently lost.

For finer fidelity, key on `(cell, heading_bucket)` — this is the standard "non-holonomic
state expansion" used in hybrid-A* vehicle planning. It costs a factor equal to the number
of heading buckets, so use it only for short, tack-sensitive courses.

---

## 5. Time step selection

Expedition auto-selects "based on the grib time steps and grid resolution and leg length."
A defensible rule:

```
Δt_candidate = min(
    grib_time_step,                  # don't step past forecast data
    leg_distance / typical_speed / target_step_count,
    max_step
)
Δt = clamp(Δt_candidate, min_isochrone_resolution, max_step)
```

with `target_step_count` around 40–120 depending on the resolution preset. Rules of thumb
consistent with Expedition's guidance ("for a 2000 mile race every 12 or 24 hours… for a
100 mile race, you might want them drawn every 2 hours"):

| Leg | Suggested Δt |
|---|---|
| < 20 nm (buoy racing / harbour) | 1–5 min |
| 20–100 nm (coastal) | 10–30 min |
| 100–500 nm (overnight) | 1 h |
| 500–3000 nm (offshore) | 3 h |
| Transocean | 3–6 h |

**Adaptive refinement** is worth doing: run coarse, then re-run at fine resolution in a
corridor around the coarse answer. This is how you get high-quality answers in phone-scale
compute, and it maps naturally onto the Fast / Balanced / Best presets.

---

## 6. Obstacles

The single most common bug in hobby routers: testing only whether the *endpoint* is on
land. Boats then hop over islands.

**Test the segment, not the point.**

```
crosses_land(p, p'):
    for each land polygon in rtree.query(bbox(p, p')):
        if segment_intersects_polygon(p, p', polygon): return true
    return false
```

Layered approach for speed:

1. **Raster mask first.** Pre-rasterise land at the routing resolution into a bitmask.
   Walk the segment with a Bresenham-style trace; if no cell is land, accept immediately.
   This resolves the vast majority of segments in nanoseconds.
2. **Vector test second.** Only if the mask says "maybe" (any traversed cell is land or
   coastal), run the exact polygon intersection.
3. **Shallow water** — same trace against a bathymetry raster, comparing to
   `safety_depth`. Optionally account for tide height at the crossing time, which is a
   nice touch inshore.

Exclusion zones (race notes) go in the same pipeline. Speed-reduction zones are not
obstacles — they multiply `v_boat` inside the polygon.

---

## 7. Multi-leg routes

For a course with marks `M₁…M_n`, the naive approach optimises each leg independently
from the previous leg's arrival time. That's what Expedition's "optimise first leg only"
implies about the default.

Subtlety worth knowing: leg-by-leg optimisation is **not globally optimal**, because
arriving at a mark slightly later can put you into a better wind field for the next leg.
Truly optimal multi-leg routing means carrying a *set* of (position, time) states through
each mark rather than a single best arrival. Expedition doesn't appear to do this, and it
is a legitimate future differentiator — but it is a v2+ problem.

Rounding rules (leave to port/starboard) are a constraint on the approach geometry.
Expedition notes: "Leaving marks to port or starboard is not currently enabled for
isochronal routing." We can do better cheaply by requiring the final approach segment to
pass on the correct side.

---

## 8. The backward pass and sensitivity

Run the same machinery from the finish, backwards in time, to get `T_r(p)` = minimum
remaining time from `p`. Then:

```
loss(p) = (T_f(p) + T_r(p)) − T_optimal
```

is the cost in minutes of routing through `p`. Contour it and you have Expedition's
sensitivity shading; take slices at fixed time and you have its reverse isochrones.

Implementation notes:
- Drop tack/gybe penalties on the backward pass (Expedition does — it is the documented
  behaviour, and it restores memorylessness).
- The backward pass evaluates the polar for the *reciprocal* heading with the wind at the
  *earlier* time. Getting the time indexing right is the whole trick.
- The two passes are independent → run them in parallel (two workers).

**Why this is a headline feature and not an advanced one.** The forward pass produces a
line. The backward pass produces an *uncertainty band*. Showing a beginner "anywhere in
this shaded area costs you under 10 minutes — sail your own race inside it" is
dramatically more useful, and more honest, than a single magenta line they'll follow off a
sandbar. Expedition buries this behind two checkboxes and a paragraph about interpreting
isochrone parallelism. We should make it the default view.

---

## 9. Complexity and performance

Per step: `|frontier| × |fan|` polar evaluations and obstacle tests.

| Scenario | Frontier | Fan | Steps | Evaluations |
|---|---|---|---|---|
| Buoy race, 2 nm legs | ~200 | 30 | 40 | 240 k |
| Coastal, 60 nm | ~800 | 36 | 60 | 1.7 M |
| Offshore, 600 nm | ~2 000 | 36 | 100 | 7.2 M |
| Transatlantic | ~5 000 | 36 | 200 | 36 M |

Each evaluation is a handful of interpolations plus a polar lookup — tens of nanoseconds
in optimised code. **Even the transatlantic case is a few seconds of single-threaded work
if the inner loop is tight.** That is entirely feasible in a Web Worker with WASM, or in
plain JS with typed arrays.

Optimisations that matter, in order:

1. **Typed arrays and flat structs everywhere.** No object allocation in the inner loop.
   This is worth an order of magnitude on its own.
2. **Pre-hydrate the wind/current fields** into a dense local grid over the route bbox
   before starting. Never call a provider inside the loop.
3. **Precompute the polar** onto a regular `(tws, twa)` lattice at startup and do a
   bilinear lookup, rather than interpolating the ragged table every time.
4. **Land as a bitmask**, per §6.
5. **Parallelism.** Expedition's own docs say more cores help most for routing. Split the
   fan across workers, or run forward and backward passes concurrently. `SharedArrayBuffer`
   makes this clean where cross-origin isolation is available.
6. **WASM (Rust)** for the kernel if JS isn't enough — but measure first, because a tight
   typed-array JS loop is often within 2× of WASM.

---

## 10. Validation

How we know it's right:

1. **Zero wind variation, no current, symmetric polar** → the answer must be the great
   circle when the destination is reachable directly, or a symmetric two-tack beat when
   dead upwind. Analytically checkable.
2. **Constant wind, dead upwind** → total time must equal `distance / target_vmg_upwind`
   plus tack penalties. Exact.
3. **Constant current, no wind variation** → compare against the analytic drift solution.
4. **Refinement convergence** → halving `Δt` and the angular step should change the arrival
   time by a decreasing amount. If it doesn't, pruning is broken.
5. **Forward/backward consistency** → `T_f(finish)` must equal `T_r(start)` to within the
   discretisation error. **This is the strongest single test of the whole pipeline** and
   it comes free once the backward pass exists.
6. **Cross-check** against qtVlm / OpenCPN weather routing output on the same GRIB, polar,
   and course. Comparing *outputs* is fine; copying their code is not.
