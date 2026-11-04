# Everything we would need

Code can close most of the gap to Expedition. This page lists what code alone
cannot provide: decisions, licences, hardware, services and data. Each item names the
[parity matrix](parity-matrix.md) areas it unblocks.

Prices are rough ranges to size the ask. Check them before buying anything. Nothing
here has been bought, signed up for or requested. Every item waits for the owner, except D2,
which the owner's layout choice of 2026-09-28 settled, and the four decisions the owner made
on 2026-09-30 (D1, D3, D4, D8). As of 2026-11-03, D2, D4 and D8 are built, and D1 and D3 are
not. D5, D6, D7 and D9 are open. [docs/06-decisions](../06-decisions/README.md#open-only-the-owner-can-settle-these)
lists D5, D6 and D9 beside the decision records.

**Row counts** are the number of matrix rows each blocker holds back. They are
recomputed in each [report](reports/).

---

## 1. Decisions only the owner can make

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| D1 | **Accept a small backend.** *Decided 2026-09-30: build it and run it locally. Deploying it needs the owner's account and stays with the owner. Not built yet: worklist M20.* | Several things cannot work from a browser alone: GRIB downloads from NOAA NOMADS (no CORS), YB Tracking files, Saildocs by web, fleet position sharing, networking between devices, and hosted chart tiles. [technical-spec.md §3](../05-spec/technical-spec.md#3-server-stack) already planned one. | Use one Cloudflare Worker (or similar) plus object storage for a CORS proxy, a scheduled GRIB-to-cube ingest and a WebSocket relay. It costs a few dollars a month at pilot scale. It needs an account in your name. |
| D2 | **Signal K as the instrument path.** *Settled 2026-09-28, when the owner chose instruments over Signal K or Web Serial with a bridge for the rest ([README](README.md)). Built: the Signal K client (6.2), Web Serial (6.3) and the bridge (M18). Not built: newjourney as a Signal K web app, so an HTTPS page can still be blocked from `ws://` on a boat's network, and Setup warns. Not checked against a live server or a real device.* | Expedition talks to about 25 vendor protocols directly. A browser can't open serial ports (outside Chromium), UDP or TCP sockets. | Read instruments through a [Signal K](https://signalk.org) server (Apache-2.0), which already speaks NMEA 0183/2000 and most vendor gateways. Add Web Serial for a USB NMEA 0183 adapter on desktop Chromium. Ship newjourney as a Signal K web app too, so the boat's server can serve it over plain HTTP. Otherwise an HTTPS page is blocked from `ws://` on the boat's LAN. |
| D3 | **Transmit to the boat, or read only?** *Decided 2026-09-30: build the outputs, test them against recordings, and keep them behind a switch that is off until a test boat turns it on. Not built yet: worklist M19, so the app reads only.* | Expedition writes to instrument buses: NMEA output, autopilot steering, polars and calibrations pushed to B&G/Ockam processors, and numbers sent to deck displays. A bad sentence on a live boat's bus is a safety problem, not a UI bug. | Stay read-only until there is a test boat (see §3). The code can be written and tested against recordings, but transmitting stays behind a setting that is off by default. |
| D4 | **A native helper for what Signal K can't do.** *Decided 2026-09-30: build a local Node helper for NMEA and AIS over UDP and TCP, app-to-app sharing and watched folders. Built: `bridge/` (M18).* | Radar (multicast Ethernet), Iridium GO! control, watching folders, and the Expedition-style DLL API all need OS access. | Build a small, optional desktop helper (Tauri or Go) only when one of these becomes the next item. Until then those rows are **Bridge**. |
| D5 | **Commercial or not.** *Open.* | Open-Meteo's hosted API is free only for non-commercial use. RainViewer, aisstream.io and OpenSeaMap tiles have similar limits ([licensing-matrix.md](../02-data-sources/licensing-matrix.md)). | Stay non-commercial for now. If that changes, budget for an Open-Meteo API plan or self-host it (AGPL), and move to self-hosted tiles. |
| D6 | **ORC polar data.** *Open.* | The polar library is generated, not measured. [licensing-matrix.md](../02-data-sources/licensing-matrix.md) §4 leaves ORC unresolved. | Keep ORC as a user-initiated import until someone asks ORC. |
| D7 | **Access to Expedition itself.** *Open.* | "1:1" can only be proven side by side: the same GRIB, polar and marks giving the same route, the same start numbers, and files that round-trip. | Get a licence (€1,250 per [sales page](https://www.expeditionmarine.com/sales.html)), or time on a navigator's licensed copy, plus a set of real files it wrote (see §5). |
| D8 | **Downloading public data files: real GRIB fixtures and the WMM coefficients.** *Decided 2026-09-30: yes, download them. Done: `fixtures/real/` (M16).* | The GRIB decoder is tested on messages built to the WMO layout, which proves it reads the layout as I understand it, not as NCEP's encoder writes it. | Let the loop download one small GFS subset from the NOMADS filter (10 m wind and MSLP, a 5° box, about 20 KB, public domain) and commit it, or drop any real `.grb2` into `src/lib/weather/fixtures/`. The same goes for NOAA's WMM-2025 coefficient file (`WMM.COF`, public domain, ~15 KB) for position-aware variation (11.5), one small NOAA ENC cell for the venue (13.1b), one real BSB/KAP raster chart (13.8b), and a week of NOAA tide predictions for a regression test (11.1). |
| D9 | **Does this branch merge into `main`?** *Open.* | `main` is what GitHub Pages serves, so a merge puts this work in front of pilot sailors. It would also reverse the product spec's non-goals on `main`. First-load JS is 215 KB gzipped here against 100 KB on `main` (measured 2026-11-03). On a phone, Route's `SETTINGS` can't be reached and Start's timer row overflows (measured 2026-11-04). | None settled. The phone and hardware plan (`docs/05-spec/phone-and-hardware.md`) recommends this branch once its phase 0 fixes are in. Until the owner says otherwise the two stay apart, and the docs say where they differ. |

## 2. Licences, subscriptions and agreements

These are the **Licence** rows. Without them the feature can't be built legitimately,
however good the code.

| Need | Unlocks | From | Feasible in a PWA? |
|---|---|---|---|
| **IHO S-63 manufacturer registration**, then cell permits from a distributor | Encrypted official ENCs worldwide (UKHO AVCS, Primar, ChartWorld, AusENC) | IHO data-protection scheme; distributors per region | **Not client-side.** The manufacturer key must stay secret, and a web app can't hide it. It would need server-side decryption or the native helper, plus scheme approval. Free NOAA S-57 ENCs cover US waters without any of this. |
| **C-MAP OEM agreement** (X, 4D, MAX/NT) | C-MAP cartography, 4D relief and satellite, C-MAP tides | C-MAP (Navico group) | Unlikely. The SDKs are Windows/OpenGL, and no web SDK is known. |
| **Navionics web API key** | Navionics charts, SonarChart, Community Edits | Garmin/Navionics developer programme | **Possible.** A keyed JavaScript web API exists. Terms and cost unknown. |
| **SailFlow membership plus API access** | SailFlow live observations | WeatherFlow | Possible with an agreement. Free substitutes (NDBC buoys, NOS PORTS, METAR) are Build rows. |
| **Squid** subscription | Squid GRIB models | Great Circle | Proprietary format and service. Skip. Open models cover the need. |
| **Tidetech** subscription | High-resolution tidal and ocean currents, SST | Tidetech | Possible with an API agreement. |
| **SHOM** licence | Nine French tidal-current atlases | SHOM | Possible with a licence. The free substitute is Copernicus Marine plus harmonic tides. |
| **Winning Tides** licence | European tide datasets | Vendor | Possible with a licence. |
| **Navico radar unlock key**, one per radar | Navico/HALO radar overlay | Navico dealer, per radar Lock ID | Needs the native helper (D4) *and* the key. |
| **YB Tracking permission**, per event | One-click YB fleet download | Race organisers / YB | The file formats are Build. Fetching them needs permission and the proxy (D1). |
| **Vessel Finder API key** | Vessel Finder fleet import | Vessel Finder (paid) | Possible. |
| **aisstream.io API key** (free) | Internet AIS when there is no receiver | aisstream.io | Yes. It is a free key under their terms, and it must not be rebroadcast. |
| **Sailing Performance Crossover Chart** format | Importing their sail charts | Sailing Performance | Only with the format from them. Our own sail chart is Build. |
| **Expedition's own GRIB server and WRF runs** | Their in-house models | Tasman Bay Navigation Systems | Not available to us. Replace with NOMADS, ECMWF open data and Open-Meteo. Running our own WRF is a compute cost, not a licence. |

## 3. Hardware: to build against, and to verify

These are the **Hardware** rows. The parser or driver can be written and tested
against recordings, but it is not "Done" until it has worked on the real device.

| Need | Rough cost | Unlocks |
|---|---|---|
| **USB–NMEA 0183 adapter** (RS-422) | under $100 | Web Serial ingest, and testing NMEA output safely off-boat |
| **NMEA 2000 gateway** (Actisense NGX-1, Yacht Devices YDWG-02 or iKonvert) | $150–400 | N2K PGN decoding, verified through Signal K |
| **Signal K server** (Raspberry Pi with OpenPlotter, or a Victron Cerbo GX) | $100–250 | The whole instrument path (D2) |
| **AIS receiver** (e.g. dAISy USB, or a Vesper/Digital Yacht unit) | $70–400 | Live AIS, CPA/TCPA alarms, SART handling |
| **An instrumented boat**, or its logs: masthead wind, paddlewheel, compass, depth, ideally heel | access, not purchase | Wind-triangle calibration, set and drift, leeway, true-wind corrections, polar-from-logs, LogPlayer fixtures |
| **Vendor processors** (B&G H5000, Ockam, NKE, Cosworth) | $1k+ each, or time on a boat that has one | The vendor-protocol rows. Low priority, since Signal K covers most of it. |
| **Radar** (Navico HALO or BR24, or Koden) plus unlock key | $1k+ | Radar overlay (D4) |
| **Laser rangefinder** with serial or Bluetooth output | $200–600 | Pinging the line from a distance |
| **Iridium GO!** plus airtime | $700+ and a plan | Satcom download management |
| **One iPhone and one Android phone, and a Windows laptop** | already owned? | Every visible change on both phone platforms; running Expedition side by side (D7) |

## 4. Services and infrastructure

| Need | Why | Notes |
|---|---|---|
| **A backend account** (D1) | CORS proxy, GRIB ingest, fleet and device relay | Cloudflare Workers + R2, or similar |
| **Self-hosted basemap tiles** (Protomaps PMTiles) | The app currently loads raster tiles from `tile.openstreetmap.org`, whose usage policy forbids heavy use | Needed before any real user base |
| **Self-hosted map glyphs** | They are loaded from `demotiles.maplibre.org` | Small job. Build row. |
| **A chart-tile pipeline** | NOAA ENC → vector tiles for S-52-style display | Not needed for display any more: cells are decoded on the device ([ADR-0007](../06-decisions/0007-decode-enc-on-device.md)). It would only matter for pre-built offline packs. |
| **Email sending**, for Saildocs requests | Saildocs is an email-request service | A `mailto:` link works with no server. Direct web delivery needs the proxy. |

## 5. Data we'd need to get hold of

| Data | Source | Status |
|---|---|---|
| World land polygons, tiled | OSM land polygons (ODbL) | Free. Needs a pack build. Today land avoidance only covers the Portland box. |
| NOAA ENC cells | NOAA (public domain) | Free. The reader is built (`src/lib/charts/`). None ship with the app, so a sailor opens their own. One cell is in `fixtures/real/` for tests. |
| Tide and current harmonic constituents for every station | NOAA CO-OPS API (public domain) | Free. Fetched per station and kept on the device, for offline tide prediction. No pack is bundled (Expedition bundles XTide data). |
| World Magnetic Model coefficients | NOAA NCEI (public domain) | Done on this branch: `src/data/wmm2025.ts`. `main` still has one fixed Portland value. |
| **Real Expedition files**: polar `.txt`, marks database export, routes, sail chart, race notes, a day's log, a start-line setup | a navigator with Expedition (D7) | **Needed** to prove the formats round-trip |
| **Recorded instrument streams** (NMEA 0183 and 2000) from a race boat, with wind, speed, heading and heel | a boat, or Signal K sample data | **Needed** as fixtures for calibration, playback and set and drift |
| **Recorded AIS streams** | a receiver, or public sample logs | Needed as fixtures |
| Measured or designer polars for the classes we list | designers, class associations, ORC (D6) | The bundled polars are generated, not measured |

## 6. What a browser cannot do, so the native helper would

| Capability | Expedition feature | Route around it |
|---|---|---|
| UDP/TCP sockets | NMEA over the network, Expedition-to-Expedition sharing, Furuno and Exocet feeds | Built: the bridge (`bridge/`, M18) takes UDP and TCP and relays between copies of the app. Signal K also works for input. |
| UDP multicast | Navico and Koden radar | Native helper only. The bridge hears multicast NMEA, but radar is not built. |
| Serial on iOS or Firefox | Any serial instrument | Built: the bridge's `--serial`, on a computer. Otherwise Signal K. Web Serial needs a Chromium browser, and has only been written for a computer. |
| Watching the filesystem | Chart-folder scanning, watched folders for fleet reports | Built: the bridge's `--watch`. Without it, the user picks a file each time. |
| Controlling a device on the LAN | Iridium GO! dial and hang-up | Native helper only |
| DLL or COM APIs | ExpDLL, Deckman bridge | Built: a documented WebSocket/JSON API instead ([channels-out.md](../09-api/channels-out.md)) |
| Writing to instrument buses | NMEA/N2K output, autopilot, deck displays | Through Signal K's output plugins, behind D3. Not built: worklist M19. |

## 7. People

- **A working navigator who uses Expedition**, to walk the worklist and say which rows
  matter in a race and which are furniture.
- **A boat and a day on the water** for every Hardware row.
- **A legal read** before anything ships under D5, D6 or S-63.
