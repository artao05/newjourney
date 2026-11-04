# Running the prototype

```bash
npm install
npm run dev
```

Then open the printed URL. On a phone, use `npm run dev -- --host` and browse to
your machine's LAN address — geolocation needs HTTPS or localhost, so for real
GPS on a phone either deploy it or use a tunnel.

```bash
npm test        # unit tests (vitest)
npm run build   # typecheck + production build
npm run preview # serve the production build, with the service worker active
```

## Deploying

Pushes to `main` publish the app to GitHub Pages through
`.github/workflows/deploy.yml`, once the tests have passed. Pages is switched on in the
repository's settings: **Settings → Pages → Source: GitHub Actions**. The site is at
<https://artao05.github.io/newjourney/>. It is served over HTTPS, which is what a phone
needs before it will hand over its GPS, so this is also the easiest way to try it on the
water, for which [PILOT.md](PILOT.md) is the sailor's guide. Every push and pull request
also runs `.github/workflows/ci.yml`: the tests, the routing kernel's time budgets on
their own, then the build and its typecheck.

The site is built from `main` only. On 2026-11-04 it was serving `0aa1ede`, deployed that
day.

---

## Trying it without a boat

Open **Setup → Simulate a boat**. That swaps the GPS feed for a synthetic vessel
that sails the loaded polar properly: it tacks through the no-go zone, loses
speed in turns, accelerates on a time constant, and drifts with a current. Every
downstream calculation is exercised exactly as it would be at sea.

While it runs, the simulator is exposed as `window.__sim`, in a production build too, so
you can steer it from the console:

```js
__sim.setAutopilot({ mode: 'twa', twa: -42 })     // sail port-tack close-hauled
__sim.setAutopilot({ mode: 'heading', heading: 90 })
__sim.setAutopilot({ mode: 'mark', target: { lat: 43.68, lon: -70.20 } })
__sim.setAutopilot({ mode: 'drift' })
__sim.setWind(240, 16)
```

## A 60-second tour

1. **Setup** — pick a class. That loads a polar; the polar diagram below shows
   the curves and the derived VMG target points. Turn on *Simulate a boat*.
2. **Start** — press `5 MIN`, then `PING PIN` and `PING RC` a few seconds apart
   while the simulated boat moves. You now have a line. Watch *time to burn*,
   the burn bar, the favoured end, and distance below the line in boat lengths.
3. **Race** — drag the *what-if* wind shift slider and watch the laylines and
   the beat split move. This is the feature that teaches fastest.
4. **Route** — press `FORECAST` (needs internet; pulls Open-Meteo), drop a
   couple of marks on the Race tab first, then `ROUTE`. You get the optimal
   route, the isochrones, and the shaded band of positions within 10 minutes of
   optimal.

## The map-layer harness

The GPU particle and scalar-field layers can be worked on in isolation, without
a GPS fix or a forecast download:

```
http://localhost:5173/?harness
```

Dev-only — a stray query string in production cannot replace the app.

## What's real and what isn't

Checked against the code on 2026-11-04, at `0aa1ede`.

**Real:** the geodesy, the wind triangle, the polar interpolation and target
derivation, the start-line math including turn and acceleration dynamics, the
layline math including current correction, the isochrone router and its
forward/backward sensitivity pass, the Open-Meteo ingest and the binary cube
format, the GPU particle / scalar map layers, the NOAA CO-OPS tidal current
prediction with its slack times, and tide heights. `waterLevelAt`
(`src/lib/tides/coops.ts`, since `3110784`) reads NOAA's predicted heights for Portland,
station `8418150`, and `src/lib/tides/datum.ts` uses them to correct the depth along a
finished route, in the Route tab's depth advisory. That advisory is the only thing that
uses them. They are fetched, so they need a connection.

**Not real yet:**

- Charts are an OpenStreetMap + OpenSeaMap raster overlay, not rendered NOAA ENC.
- **The Depth layer is a bathymetric model, not a chart, and three separate things
  are wrong with it as a depth source.** It is GEBCO 2020 at 15 arc-seconds
  (~450 m) for the Portland venue only (`public/venue/portland-depth.bin`, 50 kB, read by
  `src/data/bathymetry.ts`). (1) At
  NDBC buoy 44007 it reads 31 m where NOAA publishes 49 m. (2) Depths are below
  *mean sea level*, while charts are below MLLW — at Portland that is 1.51 m of
  water the tide can take away. (3) A 450 m cell cannot hold a ledge, a rock, a
  jetty or a dredged channel, and it calls the island at the venue centre 10 m of
  water. It is there to show you where the bay is shallow. The router never consults it.
  Besides the chart layer, it feeds only the depth advisory on a finished route, which never
  changes the route. GEBCO's own words are in the banner.
- **Land avoidance is ON for the Portland venue, and only there.** It uses a
  111 m land raster built from OSM coastline (`public/venue/portland-land.bin`, 53 kB, or
  4.8 kB at `gzip -9`, read by `src/data/landmask.ts`), validated against coordinates that
  are water by definition — the NOAA
  tide and current stations and both NDBC buoys. Outside that bounding box the
  mask reports open water and avoidance does nothing. It is a *land* check, not a
  depth check: it will happily route you through two feet of water over a mudflat,
  and the Depth layer above is not wired into it.
  The Route tab shows a `land pack` chip when the mask is loaded and a red chip
  when it is not; every route carries a warning stating which applied.
- **The Current view draws on two different sources, and they disagree.** The
  arrows and their speed labels come from Open-Meteo's global ocean model, which
  over Casco Bay ran 0.05–0.54 kn and reversed direction *zero* times in 48
  hours when this was measured on 2026-08-05 — it resolves ocean drift, not tide. The turn
  times come from NOAA CO-OPS harmonic prediction at Portland Harbor Entrance (station
  `CAB1401`), which predicted 1.17 kn that day, reversing about every six hours. The legend
  labels the arrows as an ocean model that does not resolve tidal reversal, and the chart
  states it is one station and not a field. They are not blended, on purpose. What is still
  missing is a tidal current *field* for the whole bay — that needs GoMOFS.
- No on-device harmonic engine. The CO-OPS client fetches NOAA's published predictions, for
  currents and for tide heights, rather than summing constituents, so it needs a connection.
- **Every polar in the class library is generated from published dimensions, not
  measured.** They are labelled that way in `src/data/polars.ts`. Treat target
  speeds as indicative, not as your boat.
- Pinch zoom is disabled (`user-scalable=no`) for an app-like feel. That is a
  deliberate trade against WCAG 1.4.4, and worth revisiting for anyone who needs
  larger text than the layout offers.
- No account, sync, fleet sharing, or Signal K ingest.
- No result from a phone on the water is recorded in this repo.

See [docs/05-spec/roadmap.md](docs/05-spec/roadmap.md) for what comes next, and
[docs/07-map-layers/](docs/07-map-layers/) for the layer engine design.

## Verified state

Measured by hand on 2026-11-04, at `0aa1ede`: **1,053 tests** across 48 files, all passing,
and the routing kernel's time budgets pass on their own. `tsc -b --noEmit` and
`npm run build` are clean, and CI was green at this commit that day. All five tabs
render: `src/screens/screens.test.tsx` mounts each of them, so that claim is checked rather
than asserted.

Two of the tests, in `src/pwa.test.ts`, read `dist/` and are skipped without it. So a fresh
clone reports 1,051 passed and 2 skipped, and so does CI, which runs the tests before the
build.

First load is 100 KB of gzipped JS plus 3 KB of CSS. The map chunk (286 KB of gzipped JS
plus 10 KB of CSS, mostly MapLibre) and the Route and Weather screens (11 KB and 20 KB) load
only when you open a chart tab. The service worker also fetches them in the background after
the first visit, so that they are there offline.

These figures are written by hand, and hand-written figures in this repo have drifted
before: this line said 748 when the suite had 956, and 963 when `main` had 1,048. CI runs
the suite on every push, so its result is the live figure, and this paragraph is only a
snapshot.

**Not for navigation.** Prototype. Advisory only. Nothing here replaces official
charts, official tide tables, or your own judgment.
