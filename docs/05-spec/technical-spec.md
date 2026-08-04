# Technical Specification

**Status:** draft v0.1 · proposals, not decisions. Ratified choices become ADRs in
[../06-decisions/](../06-decisions/).

---

## 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENT  —  PWA (installable, offline-first)                     │
│                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │ UI         │  │ Map          │  │ Web Workers            │    │
│  │ React/     │  │ MapLibre GL  │  │  • routing kernel      │    │
│  │ Svelte     │  │ + PMTiles    │  │  • tactical numbers    │    │
│  │            │  │ + overlays   │  │  • polar/tide engines  │    │
│  └────────────┘  └──────────────┘  └────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Local store: IndexedDB (state) + OPFS (tiles, grids)     │    │
│  └──────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Sensors: Geolocation · DeviceOrientation · Wake Lock      │    │
│  │ Optional: Signal K over WebSocket (local network)         │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTPS / WebSocket
┌───────────────────────────────┴──────────────────────────────────┐
│  SERVER  —  stateless API + scheduled ingest                     │
│                                                                  │
│  /weather/grid   compact binary wind/current/wave cubes           │
│  /tides          harmonic constituents + predictions              │
│  /charts         PMTiles / tile proxy                             │
│  /polars         class defaults, ORC lookup (user-initiated)      │
│  /route          optional server-side routing (big problems)      │
│  /fleet          WebSocket position sharing (opt-in)              │
│                                                                  │
│  Ingest workers: GFS · ECMWF · ICON · HRRR · RTOFS · CO-OPS       │
│  Object store: raw GRIB → processed cubes → CDN                   │
└──────────────────────────────────────────────────────────────────┘
```

**Design rule:** every Tier 0 and Tier 1 feature must work with the server switched off.
The server exists to deliver *data*, never to compute *answers* the client needs live.

---

## 2. Client stack

| Concern | Choice | Rationale |
|---|---|---|
| Framework | **React + TypeScript** (or Svelte) | Team familiarity dominates here. TypeScript is non-negotiable — this is a math-heavy codebase where unit confusion is the main bug class. |
| Map | **MapLibre GL JS** | BSD-3, GPU vector rendering, works on mid-range phones, rotation/pitch built in |
| Tiles | **PMTiles** | Single-file archives, HTTP range reads, trivially offline-able, no tile server |
| State | Zustand or Redux Toolkit | Small, testable |
| Persistence | **IndexedDB** (structured) + **OPFS** (binary blobs) | OPFS gives near-native performance for large tile/grid files |
| Offline shell | **Service worker** (Workbox) | App shell, fonts, sprites |
| Compute | **Web Workers**; **WASM (Rust)** if profiling demands | Never block the main thread during a routing run |
| Charts/plots | Custom canvas or uPlot | Polar diagrams and strip charts are canvas work, not SVG |
| Testing | Vitest + Playwright | |

### Units discipline

Every physical quantity carries its unit in the type system:

```ts
type Knots = number & { readonly __unit: 'kn' }
type Degrees = number & { readonly __unit: 'deg' }
type NauticalMiles = number & { readonly __unit: 'nm' }
type Radians = number & { readonly __unit: 'rad' }
```

Branded types cost nothing at runtime and eliminate the single most likely source of
silently wrong navigation output. Internal representation: knots, nautical miles,
degrees-true, UTC. Convert only at the display boundary.

### Sensors

| Sensor | API | Notes |
|---|---|---|
| Position | `navigator.geolocation.watchPosition` with `enableHighAccuracy` | Gives lat/lon/accuracy/speed/heading. Speed and heading are GPS-derived (COG/SOG), not through-water. |
| Heading | `DeviceOrientationEvent` (`webkitCompassHeading` on iOS) | Magnetometer; needs permission on iOS; unreliable near metal and while heeled. Prefer COG above ~1 kn. |
| Heel/pitch | `DeviceOrientationEvent` beta/gamma | Only meaningful if the phone is mounted, which it usually isn't |
| Screen | **Wake Lock API** | Essential — a screen that sleeps during a start sequence is a dead product |
| Instruments | Signal K WebSocket on the local network | Optional, transforms accuracy when present |

**Reality check on phone heading:** a phone in a pocket or a hand gives useless heading.
Above ~1 knot, COG from GPS is far better. Below that (drifting, head-to-wind in the
pre-start) neither works well. Design around it: don't put heading-dependent numbers in
the critical path, and prefer COG-derived values with an honest quality indicator.

---

## 3. Server stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | **Python** for ingest, **TypeScript/Node** or **Go** for the API | Python owns the GRIB/netCDF ecosystem (`cfgrib`, `xarray`, `eccodes`); the API is thin |
| API | FastAPI or Fastify | |
| Scheduler | Cron / Cloud Scheduler / GitHub Actions initially | Model runs are 4×/day; this is not hard |
| Object store | S3-compatible (R2 is attractive — no egress fees) | Egress is the dominant cost driver for tile and grid serving |
| CDN | Cloudflare | |
| Database | Postgres + PostGIS (only when accounts/fleet arrive) | Not needed for MVP |
| Realtime | WebSocket (fleet sharing) | |

**MVP can be almost serverless.** Tier 0 needs no server at all. Tier 2 needs a weather
cube endpoint, which is a scheduled job writing static files to object storage plus a CDN.
That is a very cheap architecture — likely single-digit dollars per month until there are
real users.

---

## 4. The weather pipeline

```
NOMADS / AWS / ECMWF / DWD
        │  (byte-range subset via .idx, or GRIB filter)
        ▼
   raw GRIB2 (transient)
        │  cfgrib / eccodes → xarray
        ▼
   normalise: u/v components, common vertical level, UTC time axis
        │
        ▼
   regrid + tile into fixed spatial "cubes"
        │
        ▼
   encode: Int16 scaled, per-cube header, gzip/brotli
        │
        ▼
   object storage → CDN → client → OPFS
```

### Wire format

```
Header (JSON or fixed binary):
  { model, run (ISO), bbox: [w,s,e,n], nx, ny, dx, dy,
    t0 (ISO), dt_seconds, nt,
    params: ["u10","v10","gust","prmsl","hs","wdir","wper","uo","vo"],
    scale: { u10: 0.01, ... }, missing: -32768 }

Body: Int16Array, C-order [param][time][y][x]
```

Sizing for a typical coastal race area (5° × 5° at 0.25° = 21 × 21, 48 hourly steps,
u/v + gust):

```
21 × 21 × 48 × 3 × 2 bytes ≈ 127 KB raw → ~35 KB compressed
```

An ocean-crossing box at 0.5° with 10 days of 3-hourly data is still only a few hundred
kilobytes. **This is the number that makes offline routing feasible on a phone.**

Cache key: `(model, run, bbox_quantised, params, resolution)`. TTL expires at the next
expected run.

### Provider abstraction

```ts
interface WeatherField {
  // Returns null where no data covers (p, t) — never silently zero.
  wind(lat: number, lon: number, t: Date): { u: Knots; v: Knots; source: string } | null
  gust(lat, lon, t): Knots | null
  current(lat, lon, t): { u: Knots; v: Knots; source: string } | null
  waves(lat, lon, t): WaveState | null
  coverage(): { bbox: BBox; t0: Date; t1: Date }
}

class StackedField implements WeatherField {
  // Walks providers in precedence order, returns the first hit with provenance.
  constructor(private providers: WeatherField[]) {}
}
```

This mirrors Expedition's merge behaviour (see
[../01-expedition-analysis/how-it-computes.md §3](../01-expedition-analysis/how-it-computes.md#3-weather-field-merging))
and makes "which model produced this number?" a free feature rather than an
afterthought.

**Returning `null` rather than zero is a deliberate safety decision.** A route computed
through a region of "no current data" silently treated as "no current" is exactly the
failure mode that puts a boat somewhere it didn't plan to be.

---

## 5. The routing kernel

Lives in a Web Worker. Pure function of its inputs — no I/O, no clock, no globals — so it
is trivially testable and can be moved to the server or to WASM unchanged.

```ts
interface RouteRequest {
  start: LatLon
  startTime: Date
  marks: Mark[]                  // ordered; each with optional rounding side
  polar: PolarTable
  field: WeatherField            // pre-hydrated dense grid
  obstacles: ObstacleIndex       // land mask + exclusion polygons
  constraints: {
    maxTws?: Knots; minTws?: Knots; maxGust?: Knots
    maxWaveHeight?: Metres; safetyDepth?: Metres
    tackPenalty?: Seconds; gybePenalty?: Seconds
    motorBelow?: Knots
  }
  scalings: {
    polarPct: number; polarPctNight: number
    windScale: number; windRotate: Degrees; windTimeShift: Seconds
    currentScale: number
    waveCorrection: boolean; airDensity: boolean
  }
  resolution: 'fast' | 'balanced' | 'best'
  computeSensitivity: boolean
}

interface RouteResult {
  legs: RouteLeg[]               // per-step: time, position, twd, tws, twa, bsp, sail, current, isBeating
  eta: Date
  isochrones: Isochrone[]
  reverseIsochrones?: Isochrone[]
  sensitivity?: ScalarField      // minutes lost per point — the confidence band
  diagnostics: {
    nodesExplored: number; timeStepSeconds: number
    dataGaps: TimeRange[]        // where the forecast ran out
    warnings: string[]
  }
}
```

Algorithm: [../03-algorithms/routing-isochrone.md](../03-algorithms/routing-isochrone.md).

Performance targets on a mid-range phone (single worker):

| Case | Target |
|---|---|
| Buoy race (2 nm legs) | < 100 ms |
| Coastal (60 nm) | < 1 s |
| Overnight (300 nm) | < 3 s |
| Offshore (1500 nm) | < 10 s |
| Transocean, 'best' | server-side, or accept ~30 s |

Reaching these requires the optimisations in
[routing-isochrone.md §9](../03-algorithms/routing-isochrone.md#9-complexity-and-performance):
typed arrays, pre-hydrated fields, a precomputed polar lattice, and a rasterised land mask.

---

## 6. The tactical engine

Runs continuously (1 Hz) against the current fix. Also a pure function:

```ts
function computeTactics(state: BoatState, context: RaceContext): TacticalNumbers
```

where `BoatState` is position/COG/SOG/heading/(optional BSP, AWA, AWS, heel) and
`RaceContext` holds the course, marks, line, wind estimate, current estimate, and polar.

Output is the ~35-channel core set from
[../01-expedition-analysis/channels-reference.md](../01-expedition-analysis/channels-reference.md#what-we-should-actually-ship).

**Wind estimation without an instrument** — the hard problem, in precedence order:

1. Signal K instrument wind, if connected
2. Held / manually entered wind (a two-tap dial)
3. Forecast wind at the current position and time, height-scaled
4. Estimated from sailing behaviour: head-to-wind heading during a luff, or the tack angle
   bisector across a recorded tack

Whichever is in use must be **visible on screen at all times**, with its source. Every
downstream number inherits its uncertainty, and pretending otherwise is how a beginner
learns to trust a wrong layline.

**Damping.** Raw GPS COG at low speed is noise. Use an adaptive filter — heavier damping
at low speed, lighter when accelerating — and expose a "responsive / smooth" toggle,
which is what every marine instrument system ends up with.

---

## 7. Data model (core entities)

```ts
Boat        { id, name, class, loa, lwl, beam, mastHeight, bowToGps,
              polars: { nav, start?, heel? }, polarPct, polarPctNight,
              rotTable?, accelTable?, handicap? }

Course      { id, name, marks: Mark[], type: 'wl'|'triangle'|'distance'|'custom',
              axis?, startLine?, finishLine? }

Mark        { id, name, position, roundTo: 'port'|'stbd'|'either',
              isGate?, gatePair?, alwaysDraw? }

StartLine   { committeeBoat: LatLon, pin: LatLon, gunTime?: Date }

PolarTable  { tws: number[], rows: { twa: number[], bsp: number[] }[],
              reference: '10m'|'masthead', source, generatedFrom? }

Track       { id, boatId, points: TrackPoint[], startTime, endTime, raceId? }
TrackPoint  { t, lat, lon, sog, cog, hdg?, bsp?, twa?, tws? }

Venue       { id, name, bbox, packs: { charts, bathy, land, tides } }
```

Serialisation: JSON for everything except tracks and weather cubes, which are binary.
Import/export: GPX (routes, marks, tracks), Expedition `.txt` polars, CSV.

---

## 8. Offline strategy

| Asset | Storage | Refresh |
|---|---|---|
| App shell | Service worker cache | On deploy |
| Basemap + seamarks (venue) | OPFS, PMTiles | On demand, user-initiated |
| Chart tiles (venue) | OPFS, PMTiles | On demand |
| Bathymetry (venue) | OPFS, clipped raster | On demand |
| Land polygons (venue) | IndexedDB, FlatGeobuf/GeoJSON | On demand |
| Weather cubes | OPFS, binary | Auto on connectivity; explicit "download forecast" button |
| Tide constituents | IndexedDB | On venue download |
| Polars, boats, courses | IndexedDB | Always local |
| Tracks | IndexedDB, sync when online | |

**"Download this venue"** is a single button producing a bundle of roughly 50–150 MB that
makes the entire app work with the radio off. This is a first-class feature, not a
fallback — and it's something Expedition genuinely cannot do in a pocket.

---

## 9. Security and privacy

- **Position data is the most sensitive thing here.** Local by default. Sharing is opt-in,
  per-session, scoped to a named group, with a persistent on-screen indicator and an
  obvious kill switch.
- No third-party analytics SDKs in the tracking path.
- Tracks belong to the user: full export, full delete, and a default retention that
  expires rather than accumulates.
- No account required for Tier 0/1.
- API keys (aisstream, Météo-France, etc.) stay server-side, always.
- HTTPS everywhere; strict CSP; no eval.

---

## 10. Testing

| Layer | Approach |
|---|---|
| Navigation math | Property tests (round-trip bearing/distance, `angdiff` identities) + known-value tests against published examples |
| Polar engine | Golden-file tests on real polars; target derivation checked against hand computation |
| Router | The analytic cases in [routing-isochrone.md §10](../03-algorithms/routing-isochrone.md#10-validation) — constant wind, dead upwind, pure drift — plus forward/backward consistency |
| Weather decode | Fixture GRIBs, compare against `wgrib2` output |
| Tides | Compare our harmonic engine against NOAA published predictions for a set of stations |
| Integration | Replay recorded tracks, assert tactical numbers are sane throughout |
| E2E | Playwright with a mocked geolocation feed replaying a real race |

**The forward/backward consistency check deserves emphasis:** `T_f(finish)` must equal
`T_r(start)`. It exercises the polar, the field interpolation, the obstacle tests, and
both search passes in a single assertion, and it is nearly free once sensitivity is
implemented.

---

## 11. Repository layout (proposed)

```
newjourney/
├── docs/                      ← research + specs (this)
├── packages/
│   ├── core/                  ← pure TS: geodesy, wind triangle, polars, tactics
│   ├── routing/               ← the isochrone kernel (worker-ready, WASM-swappable)
│   ├── weather/               ← field providers, cube decode, interpolation
│   ├── charts/                ← tile config, S-52 style, offline pack manager
│   └── ui/                    ← shared components
├── apps/
│   ├── web/                   ← the PWA
│   └── ingest/                ← Python: GRIB → cubes
├── data/                      ← class polars, venue definitions, station metadata
└── tools/                     ← polar converters, validation scripts, benchmarks
```

`packages/core` and `packages/routing` must have **zero browser dependencies** so they run
in Node for testing and on the server for heavy routing.

---

## 12. Build order

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 | `core` geodesy + units + tests | — |
| 1 | **Tier 0 start-line app**, GPS only, no map | 0 |
| 2 | Polar engine + class polar library | 0 |
| 3 | Tier 1 tactical numbers + laylines + what-if | 0, 2 |
| 4 | Map + charts + offline packs | — |
| 5 | Weather ingest + cube format + client decode | — |
| 6 | **Routing kernel** + sensitivity | 0, 2, 5 |
| 7 | Tides/currents | 5 |
| 8 | Track recording, replay, debrief | 1 |
| 9 | Polar learning from tracks | 2, 8 |
| 10 | Fleet sharing, Signal K, AIS | 3 |

Phases 1 and 2 are independently shippable. Phase 6 is the headline. Phase 9 is the moat.
