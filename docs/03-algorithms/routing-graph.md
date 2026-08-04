# Grid / Graph Routing (the second algorithm)

Expedition ships two routers. The grid one exists because reproducibility matters when
you are comparing simulations rather than sailing a race.

> "The grid algorithm was originally developed for routing studies where it was important
> to compare similar simulations. As such, it is less commonly used… the grid algorithm is
> not designed to route around corners. One solution is to use multiple marks for this."

---

## 1. Formulation

Discretise the route area into a lattice of nodes. An edge `(i → j)` between neighbouring
nodes has a **time-dependent cost**:

```
cost(i → j, t) = geodesic_distance(i, j) / effective_speed(i, j, t)
```

where `effective_speed` comes from the polar at the wind at node `i` at time `t`, plus the
current projected onto the `i→j` bearing. Then solve for the minimum arrival time at the
destination with **Dijkstra** (or A* with an admissible heuristic).

Because edge costs depend on arrival time, this is a **time-dependent shortest path**
(TDSP) problem. Dijkstra remains correct provided the **FIFO / non-overtaking property**
holds: leaving later cannot make you arrive earlier. In sailing this is *not* strictly
guaranteed — a wind that fills in later can genuinely make a later departure faster. In
practice, treating it as FIFO is what everyone does and the error is small; the honest
alternative is a label-*correcting* algorithm (Bellman–Ford style) that allows re-relaxation.

**Why "adaptive grid":** cell size probably varies with distance from the great-circle
corridor or refines near marks and coastlines. A uniform lattice over an ocean is wasteful
in the middle and too coarse at the ends.

---

## 2. State expansion

Same non-holonomic problem as the isochrone router: with tack/gybe penalties, the cost of
leaving node `j` depends on the heading you arrived with. So the state is not the node —
it is `(node, incoming_heading_bucket)` or at minimum `(node, tack)`.

```
State = (cell_index, heading_bucket)
```

With an 8-neighbour stencil, `heading_bucket` has 8 values, so the graph is 8× larger.
With a 16- or 32-neighbour stencil (needed for decent angular resolution — see §3),
correspondingly more.

---

## 3. Stencil and angular resolution

The classic weakness of lattice routing: with a 4- or 8-neighbour stencil you can only
sail on multiples of 90° or 45°. A true bearing of 52° gets approximated by zigzagging
between 45° and 90°, which both lengthens the path (the "digital geometry" error, up to
~8 % for an 8-neighbour grid) and produces nonsense TWAs.

Fixes, in increasing order of quality:

| Approach | Angular resolution | Cost |
|---|---|---|
| 8-neighbour | 45° | Terrible for sailing |
| 16-neighbour (knight moves) | ~26.6° | Better |
| 32-neighbour | ~14° | Acceptable |
| **Any-angle (Theta\*, Field D\*)** | continuous | Best — allows line-of-sight shortcuts between non-adjacent nodes |
| **Visibility graph** on obstacles | continuous | Optimal in a static field, doesn't handle time-varying wind well |

For sailing, **Theta\*-style any-angle search on a lattice** is the right answer if we
build this at all. It removes the stencil artefact while keeping the lattice's
reproducibility.

This is also exactly why Expedition says the grid algorithm "is not designed to route
around corners": a limited stencil plus obstacles produces staircase paths and dead ends
around headlands.

---

## 4. When to prefer grid over isochrone

| Situation | Better algorithm |
|---|---|
| Race day, "what's fastest from here?" | **Isochrone** |
| Light air, strong current, complex coastline | **Isochrone** (Expedition says so explicitly) |
| A/B comparison: two polars, same GRIB | **Grid** — identical node sets make results comparable |
| A/B comparison: two GRIBs, same polar | **Grid** |
| Sensitivity study over many runs | **Grid** |
| "What if we'd started 3 h earlier?" ×20 | **Grid** |
| Constrained-corridor routing (traffic separation, canals) | **Grid** |
| Great-circle-constrained planning | **Grid** (Expedition's "optimise along great circle" is grid-only) |

**Our recommendation: isochrone first, and probably only.** The grid algorithm's value is
in reproducible study workflows, which is a professional-navigator use case, not a
junior-sailor one. Build it in v2 if and when a research or coaching feature needs it.

A cheaper way to get most of the grid algorithm's benefit: make the isochrone router
**deterministic** (fixed seed, fixed bucket grid anchored in absolute coordinates rather
than relative to the start) so that two runs with different inputs are directly
comparable. That gets the A/B property without a second router.

---

## 5. A* heuristic

If we do build it, the admissible heuristic is:

```
h(node) = geodesic_distance(node, goal) / v_max
```

where `v_max` is the boat's maximum speed anywhere in the polar. Admissible (never
overestimates the true remaining time), cheap, and reasonably tight in strong wind. It is
weak in light air, where `v_max` is nowhere near achievable — a better bound uses the
maximum speed achievable in the *actual wind field along the way*, precomputable as a
backward relaxation over a coarse grid. That is exactly the `T_r` field from the isochrone
backward pass, which makes the two algorithms complementary: run a coarse backward
isochrone pass to build a near-perfect heuristic, then A* on the fine lattice.

---

## 6. Relationship to the literature

| Method | Notes |
|---|---|
| Isochrone (Hagiwara 1989 and successors) | Continuous space, discrete time. What Expedition defaults to. |
| Modified / 3-D modified isochrone | Adds speed/engine-power dimension; ship-focused |
| Dijkstra / A* on a lattice | Discrete space, continuous time. Expedition's grid algorithm. |
| Dynamic programming over stages | Equivalent formulation; the forward/backward passes are literally Bellman's principle |
| Genetic / evolutionary algorithms | Used in ship-routing research, especially for multi-objective (time vs. fuel vs. safety). Slower, non-deterministic; not appropriate here. |
| Continuous optimal control / level-set methods | Elegant (the isochrone *is* a level set of the arrival-time function; the exact formulation is a Hamilton–Jacobi–Bellman equation). Heavy machinery, but the right mental model. |

The HJB framing is worth internalising: `T_f(p)` is the viscosity solution of an
anisotropic Eikonal equation whose speed function is the polar. The isochrone method is a
Lagrangian (particle-marching) solver for it; the grid method is an Eulerian
(fixed-lattice) one. Everything else — including Fast Marching with anisotropic speed — is
a variation on which solver you pick.
