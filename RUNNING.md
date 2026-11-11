# Running the prototype

This copy of the file is on `parity/expedition`, and it covers two builds. `main` is the
phone-first product, and GitHub Pages serves it. `parity/expedition` is this branch, which
aims at Expedition's capabilities and is not deployed. Where they differ, the text says
which is which.

```bash
npm install
npm run dev
```

Then open the printed URL. To try it on a phone, see [On a real phone](#on-a-real-phone):
`npm run dev -- --host` and your machine's LAN address show the layout, but GPS, offline
and stored data need HTTPS or `localhost`.

```bash
npm test        # unit tests (vitest)
npm run build   # typecheck + production build
npm run preview # serve the production build, with the service worker active
```

On this branch only:

```bash
node scripts/parity-score.ts --areas  # the parity score, from the matrix
node bridge/bridge.ts --udp 10110     # the instrument bridge (bridge/README.md)
npm run test:phone                    # the built app at phone sizes, in your Chrome
npm run test:phone:webkit             # the same in Playwright's WebKit, Safari's engine
```

`test:phone:webkit` needs Playwright's WebKit, downloaded once with
`npx playwright-core install webkit` (about 60 MB).

Here `npm run build` also fails if the first download passes its limit
(`scripts/check-budget.ts`).

## Deploying

Pushes to `main` publish the app to GitHub Pages through
`.github/workflows/deploy.yml`, once the tests have passed. Pages is switched on in the
repository's settings: **Settings → Pages → Source: GitHub Actions**. The site is at
<https://artao05.github.io/newjourney/>. It is served over HTTPS, which is what a phone
needs before it will hand over its GPS, so this is also the easiest way to try it on the
water, for which [PILOT.md](PILOT.md) is the sailor's guide. Every push and pull request
also runs `.github/workflows/ci.yml`: the tests, the routing kernel's time budgets on
their own, then the build and its typecheck. This branch's copy then runs `npm run test:phone`
and, in Playwright's WebKit, `npm run test:phone:webkit`.

The site is built from `main` only, and last deployed `ffac1b9` on 2026-11-11. Nothing on
`parity/expedition` reaches it. That branch went to `origin` as a backup, at `fbb40b4` on
2026-11-03 and at `31fe190` on 2026-11-11, so CI ran on both, but it has no pull request and
no deploy.

## On a real phone

A phone hands over its GPS, keeps the app for offline use and protects its stored data only
on an HTTPS address or on `localhost`. A LAN address such as `http://192.168.1.20:5173` is
neither. This branch isn't deployed, so serve its production build and reach it one of the
two ways below. Then run [PILOT.md](PILOT.md) §1 and §2, including the two checks only this
branch has, and write the results into phase 0 of the
[phone plan](docs/05-spec/phone-and-hardware.md).

```bash
npm run build
npm run preview   # http://127.0.0.1:4173, on this machine only
```

**Android, over a USB cable.** Nothing to install on the PC, except the phone maker's USB
driver for some phones.

1. On the phone, turn on Developer options (Settings → About phone, tap Build number seven
   times), then **USB debugging** inside them.
2. Plug it in, open `chrome://inspect/#devices` in Chrome on the PC, and allow the PC when
   the phone asks.
3. Under **Port forwarding**, map port `4173` to `127.0.0.1:4173`, tick **Enable port
   forwarding**, and keep that tab open.
4. In Chrome on the phone, open `http://localhost:4173`. The phone counts it as secure, so
   GPS, offline and stored data all work. **inspect**, under the phone in
   `chrome://inspect`, gives DevTools for the page on the PC.

**iPhone, or any phone without a cable: a tunnel.** Each gives the preview server an HTTPS
address. `vite.config.ts` lets both through (`preview.allowedHosts`), so add any other
tunnel's domain there.

- **Cloudflare quick tunnel,** no account. Install it with
  `winget install --id Cloudflare.cloudflared`, run
  `cloudflared tunnel --url http://127.0.0.1:4173`, and open the `https://….trycloudflare.com`
  address it prints. The address changes on every run, and anyone who has it can open the
  app while the tunnel runs.
- **Tailscale,** a free account, with the PC and the phone both signed in to it. Run
  `tailscale serve 4173` and open `https://<pc name>.<tailnet>.ts.net`. The address stays
  the same, and only your own devices reach it. If HTTPS is off for your tailnet, the first
  run says how to turn it on.

Once the app is on the home screen and has opened once, it runs from its own cache, so the
tunnel can close. A new address is a new site to the phone: a fresh install, without the
old one's tracks or settings.

**Debugging an iPhone.** Safari's Web Inspector needs a Mac. Without one, note what you see
with the phone model and iOS version. inspect.dev sells a Windows tool for it, not tried here.

Neither way has been tried with a real phone yet (2026-11-11). On this machine, the preview
server answered the two tunnels' hostnames and refused others.

---

## Trying it without a boat

Open **Setup → Simulate a boat**. That swaps the GPS feed for a synthetic vessel
that sails the loaded polar properly: it tacks through the no-go zone, loses
speed in turns, accelerates on a time constant, and drifts with a current. Every
downstream calculation is exercised exactly as it would be at sea.

While it runs, the simulator is exposed as `window.__sim`, so you can steer it from the
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

That is the phone layout, on both builds. At 1,024 px and wider this branch shows the same
screens as a nav station: a ribbon across the top, Start, Race or Setup in the panel on the
left, Route, Weather or Strip in the middle, number boxes on the right, and a status bar
along the foot.

## Instruments without a boat (this branch)

Turn off *Simulate a boat*, run these two, then **Setup → Instruments → CONNECT BRIDGE**:

```bash
node bridge/bridge.ts --udp 10110
node bridge/replay.ts bridge/fixtures/casco-bay-synthetic.nmea --to 127.0.0.1:10110 --rate 7 --loop
```

The recording is made up, not taken from a boat. [bridge/README.md](bridge/README.md) has
the rest: TCP, serial, NMEA 2000 gateways, sharing between copies of the app, and watched
folders.

## The map-layer harness

The GPU particle and scalar-field layers can be worked on in isolation, without
a GPS fix or a forecast download:

```
http://localhost:5173/?harness
```

Dev-only — a stray query string in production cannot replace the app.

## What's real and what isn't

Checked against the code on 2026-11-03, at `5bad931` on `main` and `fbb40b4` on
`parity/expedition`. `main` then took three pull requests:
[#3](https://github.com/artao05/newjourney/pull/3) on 2026-11-04, Route's action row and three
small fixes; [#4](https://github.com/artao05/newjourney/pull/4) on 2026-11-09, its docs and
decision records; and [#5](https://github.com/artao05/newjourney/pull/5) on 2026-11-11
(`ffac1b9`), five places where a small phone lost a button or a note. None of it changes what
this section says. This branch then took phone phase 0 (`01bbe6f`, committed 2026-11-05), and
this section was checked against that too.

| | `main` | `parity/expedition` (this branch) |
|---|---|---|
| Served from | GitHub Pages | Nowhere. On `origin` as a backup since 2026-11-03, with no pull request |
| Tabs on a phone | Five: Start, Race, Weather, Route, Setup | Six: those and Strip |
| At 1,024 px and wider | The same tabs | A nav station |
| Palette | Dark only | Opens in a black-on-white day palette, with dusk, night and by the sun |
| Charts | OpenStreetMap + OpenSeaMap raster | The same base map, plus S-57 ENC cells and BSB/KAP raster charts you open |
| Instruments | Phone GPS | Also Signal K, Web Serial and the Node bridge |
| Tide heights | NOAA's published predictions for Portland, fetched | The same, plus a harmonic engine on the device for any NOAA harmonic station |
| Magnetic variation | One Portland value, carried forward by its yearly change | WMM-2025 where the boat, the pointer or the mark is |

**Real on both:** the geodesy, the wind triangle, the polar interpolation and target
derivation, the start-line math including turn and acceleration dynamics, the
layline math including current correction, the isochrone router and its
forward/backward sensitivity pass, the Open-Meteo ingest and the binary cube
format, the GPU particle / scalar map layers, the NOAA CO-OPS tidal current
prediction with its slack times, and tide heights. `waterLevelAt`
(`src/lib/tides/coops.ts`, since `3110784`) reads NOAA's predicted heights for Portland, and
`src/lib/tides/datum.ts` uses them to correct the depth along a finished route. Those
heights are fetched, so they need a connection.

**Real on this branch only.** None of it has been on a boat. Each entry says how far it has
been checked.

- **ENC charts.** Route → ENC opens S-57 cells: `.000` files with their updates, a folder,
  or NOAA's zips. The app decodes them itself in a worker (`src/lib/charts/iso8211.ts`,
  `s57.ts`), keeps the files in IndexedDB, and draws them in a simplified S-52 style
  (`s52.ts`) that is not IHO's presentation library. No cells ship with the app, so you
  bring your own. Checked on one real cell, NOAA's US5PWMDC (Portland Harbor): the records
  read match the cell's own counts, its update applies, and its bounds match NOAA's
  catalogue (`s57.real.test.ts`). It has not been compared with GDAL or with NOAA's own
  rendering. See [ADR-0007](docs/06-decisions/0007-decode-enc-on-device.md).
- **BSB/KAP raster charts.** Route → ENC → `OPEN RASTER`. Checked on one real chart, NOAA's
  14983, a Minnesota lake, from the Internet Archive because NOAA withdrew its raster
  charts: every reference point lands within a pixel, and the drawn tiles are within 2 m of
  the projection (`bsb.real.test.ts`).
- **Routing against the ENC.** With cells open, their land, water under the safety depth
  and dangers go to the router as land, on by default, and a finished route is checked
  against them (`src/lib/charts/encRouting.ts`). This covers only the cells you opened.
- **Instruments.** Setup → Instruments takes Signal K over a WebSocket, a serial port through
  Web Serial where the browser has it (Setup's note says Chrome or Edge on a computer), or the
  bridge. Serial and the bridge feed decoders for NMEA 0183, NMEA 2000 gateway text and AIS.
  Signal K gives the boat's own values only, so no AIS, and it has no sign-in token. All of
  them feed a pipeline for damping, leeway, true wind and set and drift
  (`src/lib/instruments/`). Only one source runs at a time, and any of them turns the phone's
  GPS off. All of this is tested on streams written to the formats, mocked ports and a made-up
  recording. No real instrument, gateway or Signal K server has been connected, and there is
  no recording from a real boat
  ([needs.md §5](docs/08-parity/needs.md#5-data-wed-need-to-get-hold-of)).
- **The bridge.** `bridge/` is a Node program with no dependencies. It listens on UDP, TCP and
  serial ports, relays between copies of the app, and watches folders. It only listens:
  nothing goes to the boat. A phone cannot use it yet, because a connection from another
  machine gets nothing without the key, and the app has no key to give. Tried on 2026-11-03:
  the made-up recording over UDP came out of its WebSocket, and its own tests are in the suite.
- **Tides on the device.** Weather → Tides works out the tide at the nearest NOAA station from
  its harmonic constants (`src/lib/tides/harmonic.ts`). The station list and each station's
  constants are fetched once and then kept, so the first look at a station needs a
  connection. At Portland it stays within 3 mm RMS of NOAA's hourly predictions for 1–7 October
  2026 (`harmonic.real.test.ts`). The Route depth advisory still uses NOAA's published heights,
  and still needs a connection.
- **Tidal streams.** Weather → Tidal streams, and Route → SETTINGS → *Route with NOAA's tidal
  streams* (off by default), use NOAA's harmonic current stations (`src/lib/tides/currents.ts`).
  They apply within a radius of a station. They are not a field, and subordinate stations are
  not read.
- **Magnetic variation.** From our own WMM-2025 (`src/lib/wmm.ts`), which matches NCEI's test
  values (`wmm.test.ts`). It is taken where the boat is, or at the venue centre before a fix,
  at the pointer, and at each mark.
- **GRIB files.** GRIB 1 and 2, opened in Weather or dropped on the chart, decoded in a worker,
  in simple, complex, PNG, JPEG 2000 and CCSDS packing (`src/lib/weather/`). Two whole global
  GFS messages decode as NOAA's wgrib2 does (`grib2.real.test.ts`). These are files you bring,
  kept only until the page reloads. The app does not download GRIB itself.
- **Phone phase 0,** from the [phone and hardware plan](docs/05-spec/phone-and-hardware.md).
  Action rows wrap, Start's ping and timer rows stay put under a readout that scrolls, and on a
  touch screen buttons are at least 34 px. Only Start and what it needs are in the first
  download. The app asks the browser to keep what it stores, and Setup → Stored data shows the
  answer. A running countdown warns when it can't sound, and Start → TIMER has TEST SOUND.
  Checked by unit tests and in emulated phones, not on a real phone.
- **The rest of the parity work,** row by row in
  [parity-matrix.md](docs/08-parity/parity-matrix.md): number boxes on Expedition's channel
  catalogue, a marks library and named routes, race notes, W/L and Olympic course wizards, the
  timer sheet, the polar editor and roles, sail charts, logs with replay and a stripchart,
  alarms, AIS targets with CPA and TCPA, race-tracking files, the boats database and fleet
  routing, ensemble and grid routing, handicap, length units, and channels out over a
  WebSocket. `node scripts/parity-score.ts` gave **36.5 %** on 2026-11-03: 360 of 985
  applicable rows Done, 231 Partial and 394 Missing. This branch is not yet a replacement for
  Expedition.

**Not real yet, on both builds:**

- The base map is an OpenStreetMap + OpenSeaMap raster overlay from their public tile servers,
  with glyphs from `demotiles.maplibre.org`. On `main` that is the only chart: no rendered
  NOAA ENC.
- **The Depth layer is a bathymetric model, not a chart, and three separate things
  are wrong with it as a depth source.** It is GEBCO 2020 at 15 arc-seconds
  (~450 m) for the Portland venue only (`public/venue/portland-depth.bin`, 50 kB, read by
  `src/data/bathymetry.ts`). (1) At
  NDBC buoy 44007 it reads 31 m where NOAA publishes 49 m. (2) Depths are below
  *mean sea level*, while charts are below MLLW — at Portland that is 1.51 m of
  water the tide can take away. (3) A 450 m cell cannot hold a ledge, a rock, a
  jetty or a dredged channel, and it calls the island at the venue centre 10 m of
  water. It is there to show you where the bay is shallow, and it is a display
  layer only: the router never consults it. GEBCO's own words are in the banner.
- **Land avoidance is ON for the Portland venue, and only there.** It uses a
  111 m land raster built from OSM coastline (`public/venue/portland-land.bin`, 4.8 kB
  gzipped, read by `src/data/landmask.ts`), validated against coordinates that are water by
  definition — the NOAA tide and current stations and both NDBC buoys. Outside that bounding
  box the mask reports open water and avoidance does nothing. It is a *land* check, not a
  depth check: it will happily route you through two feet of water over a mudflat,
  and the Depth layer above is not wired into it. On this branch, ENC cells you open add their
  own land and shallow water, inside those cells.
  The Route tab shows a `land pack` chip when the mask is loaded and a red chip
  when it is not, in the status bar on a nav station. Every route carries a warning
  stating which applied.
- **The Current view draws on two different sources, and they disagree.** The
  arrows and their speed labels come from Open-Meteo's global ocean model, which
  over Casco Bay runs 0.05–0.54 kn and reverses direction *zero* times in 48
  hours — it resolves ocean drift, not tide. The turn times come from NOAA CO-OPS
  harmonic prediction at Portland Harbor Entrance (station `CAB1401`), which
  predicts 1.17 kn reversing about every six hours. The legend labels the arrows
  as an ocean model that does not resolve tidal reversal, and the chart states it
  is one station and not a field. They are not blended, on purpose. What is still
  missing is a tidal current *field* for the whole bay — that needs GoMOFS.
- **Every polar in the class library is generated from published dimensions, not
  measured.** They are labelled that way in `src/data/polars.ts`. Treat target
  speeds as indicative, not as your boat. No ORC data is bundled or fetched; Setup reads a
  polar file you already have. On this branch you can also edit one.
- Pinch zoom is disabled (`user-scalable=no`) for an app-like feel. That is a
  deliberate trade against WCAG 1.4.4, and worth revisiting for anyone who needs
  larger text than the layout offers.
- No account and no sync ([ADR-0008](docs/06-decisions/0008-no-accounts.md)). Everything is on
  the device. `main` also has no fleet sharing and no Signal K ingest.
- No result from a phone on the water is recorded in this repo.

**Not real yet, on this branch:**

- **Nothing transmits to instruments.** Worklist M19 is not built, though the owner has decided
  to build it, off by default. *Channels out* (Setup, off by default) sends to a WebSocket you
  name, not to a bus.
- **No backend.** Worklist M20 is not built. So there is no GRIB download from NOMADS or ECMWF,
  no NDBC buoys or METARs on the chart (NOAA's CO-OPS stations do work), and no sharing over the
  internet. Sharing runs through the bridge, on the machine or over linked bridges.
- **Land avoidance outside Portland** waits on an owner answer about downloading OSM's land
  polygons (worklist 20.7).
- **Licensed and hardware rows.** S-63, C-MAP and Navionics charts, radar and the vendor
  protocols are not built, and [needs.md](docs/08-parity/needs.md) says what each would take.
- **Nothing has been compared with Expedition itself** (needs.md D7).
- **It has not been tried on a real phone.** `npm run test:phone` checks the built app in Chrome
  at 360 to 412 px wide, on six tabs and three sheets, and `npm run test:phone:webkit` does the
  same in Playwright's WebKit. Both passed on this Windows machine on 2026-11-11. In CI, on
  GitHub's Linux runner at `31fe190` on 2026-11-11, the Chrome check failed with 204 problems:
  segmented buttons 32 px tall, under its 34 px floor, and at 360 px every screen scrolling 4 px
  sideways. The WebKit check came after that push and has not run in CI. The difference is the
  font. Windows draws the app in Segoe UI, whose taller lines carry the segmented buttons to
  34 px. Forced into Arial, whose lines are nearer Roboto's and San Francisco's, this machine
  shows CI's 204 problems too, so a real phone probably will. Not fixed yet. The check blocks
  the network, so it sees the forecast screens only when run by hand with `LIVE=1`, and it never
  loads a route. It doesn't open the wind sheet or Route's results and departure sheets, where
  `main` fixed lost buttons on 2026-11-11
  ([pull request #5](https://github.com/artao05/newjourney/pull/5)). Nor can it see what only a
  phone shows: iOS Safari, GPS, sound, heat or a wet thumb. Until [PILOT.md](PILOT.md) §2 has
  passed on a real iPhone and Android phone, treat it as unproven.

See [docs/05-spec/roadmap.md](docs/05-spec/roadmap.md) for what comes next on `main`,
[docs/08-parity/worklist.md](docs/08-parity/worklist.md) for this branch, and
[docs/07-map-layers/](docs/07-map-layers/) for the layer engine design.

## Verified state

Measured by hand, `main` on 2026-11-11 and this branch on 2026-11-05:

| | `main` (`ffac1b9`) | `parity/expedition` (`01bbe6f`) |
|---|---|---|
| Tests | 1,072 in 48 files | 1,869 in 151 files |
| `npx tsc -b --noEmit`, `npm run build` | clean | clean |
| CI | green at this commit, 2026-11-11 | red at `31fe190`, this code plus docs, 2026-11-11: tests and build passed, and `test:phone` failed on the runner's font, as above |
| First load, gzipped | 100 KB of JS, 3 KB of CSS | 113 KB of JS, 5 KB of CSS (215 KB of JS before phone phase 0) |
| All a first visit stores for offline, gzipped | 0.49 MB, 17 files | 0.70 MB, 45 files |
| Map chunk, gzipped, mostly MapLibre | 286 KB of JS, 10 KB of CSS | 289 KB of JS, 10 KB of CSS |
| Route and Weather screens, gzipped | 11 KB and 20 KB | 42 KB and 36 KB |

KB here is Vite's figure, 1,000 bytes. This branch's budget check divides by 1,024, so it
prints the same first load as 110.7 KB, against a limit of 115 by its own count.

Every test passes. Two in `src/pwa.test.ts` read `dist/` and are skipped without it, as they
are in CI, where the tests run before the build. So a fresh clone reports 1,070 passed and 2
skipped on `main`, and 1,867 and 2 on this branch. Each tab is mounted by a test in
`src/screens/screens.test.tsx`. On `main`, the map chunk and the two chart screens load only
when you open them. On this branch so do Race, Setup and Strip. A first visit still stores them
all in the background, for offline use. This branch's production build, visited once in a clean
Chrome profile at 390×844, stored every file it lists. With its server stopped it then reloaded
and opened all six tabs (2026-11-05). That is not yet airplane mode on a phone.

These figures are written by hand, and hand-written figures in this repo have drifted
before: this line said 748 when the suite had 956, and 963 when `main` had 1,048. CI runs the
suite on every push, so its result is the live figure, and this paragraph is only a snapshot.

**Not for navigation.** Prototype. Advisory only. Nothing here replaces official
charts, official tide tables, or your own judgment.
