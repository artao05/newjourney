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
__sim.setAutopilot({ mode: 'mark', target: { lat: 41.52, lon: -71.32 } })
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

## What's real and what isn't

**Real:** the geodesy, the wind triangle, the polar interpolation and target
derivation, the start-line math including turn and acceleration dynamics, the
layline math including current correction, the isochrone router and its
forward/backward sensitivity pass, the Open-Meteo ingest and the binary cube
format.

**Not real yet:** charts are an OpenStreetMap + OpenSeaMap raster overlay rather
than rendered NOAA ENC; land avoidance uses a coarse mask rather than full
coastline geometry; tides and currents are forecast-model only, with no harmonic
station engine; there is no account, sync, fleet sharing, or Signal K ingest.
See [docs/05-spec/roadmap.md](docs/05-spec/roadmap.md).

**Not for navigation.** Prototype. Advisory only.
