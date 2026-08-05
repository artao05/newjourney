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

---

## Trying it without a boat

Open **Setup → Simulate a boat**. That swaps the GPS feed for a synthetic vessel
that sails the loaded polar properly: it tacks through the no-go zone, loses
speed in turns, accelerates on a time constant, and drifts with a current. Every
downstream calculation is exercised exactly as it would be at sea.

The simulator is exposed as `window.__sim` in dev, so you can steer it from the
console:

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

**Real:** the geodesy, the wind triangle, the polar interpolation and target
derivation, the start-line math including turn and acceleration dynamics, the
layline math including current correction, the isochrone router and its
forward/backward sensitivity pass, the Open-Meteo ingest and the binary cube
format, the GPU particle / scalar map layers, and the NOAA CO-OPS tidal current
prediction with its slack times.

**Not real yet:**

- Charts are an OpenStreetMap + OpenSeaMap raster overlay, not rendered NOAA ENC.
- **Land avoidance is now ON for the Portland venue, and only there.** It uses a
  111 m land raster built from OSM coastline (`src/data/landmask.ts`, 4.8 kB
  gzipped), validated against coordinates that are water by definition — the NOAA
  tide and current stations and both NDBC buoys. Outside that bounding box the
  mask reports open water and avoidance does nothing. It is a *land* check, not a
  depth check: it will happily route you through two feet of water over a mudflat.
  The Route tab shows a `land pack` chip when the mask is loaded and a red chip
  when it is not; every route carries a warning stating which applied.
- **The Current view draws on two different sources, and they disagree.** The
  arrows and their speed labels come from Open-Meteo's global ocean model, which
  over Casco Bay runs 0.05–0.54 kn and reverses direction *zero* times in 48
  hours — it resolves ocean drift, not tide. The turn times come from NOAA CO-OPS
  harmonic prediction at Portland Harbor Entrance (station `CAB1401`), which
  predicts 1.17 kn reversing about every six hours. The legend labels the arrows
  as an ocean model that does not resolve tidal reversal, and the chart states it
  is one station and not a field. They are not blended, on purpose. What is still
  missing is a tidal current *field* for the whole bay — that needs GoMOFS.
- Tide *heights* are not implemented; only current. No on-device harmonic engine
  yet either — the CO-OPS client fetches published predictions rather than summing
  constituents, so it needs a connection.
- **Every polar in the class library is generated from published dimensions, not
  measured.** They are labelled that way in `src/data/polars.ts`. Treat target
  speeds as indicative, not as your boat.
- No account, sync, fleet sharing, or Signal K ingest.

See [docs/05-spec/roadmap.md](docs/05-spec/roadmap.md) for what comes next, and
[docs/07-map-layers/](docs/07-map-layers/) for the layer engine design.

## Verified state

At the last commit: **208 tests passing**, `tsc --noEmit` clean, `npm run build`
clean, all four tabs rendering. First load is 92 KB gzipped; the map chunk
(~290 KB gzipped, mostly MapLibre) loads only when you open the Route tab.

**Not for navigation.** Prototype. Advisory only. Nothing here replaces official
charts, official tide tables, or your own judgment.
