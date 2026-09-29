# Everything we would need

Code can close most of the gap to Expedition. This page lists what code alone
cannot provide: decisions, licences, hardware, services and data. Each item names the
[parity matrix](parity-matrix.md) areas it unblocks.

Prices are rough ranges to size the ask. Check them before buying anything. Nothing
here has been bought, signed up for or requested. Every item waits for the owner.

**Row counts** are the number of matrix rows each blocker holds back. They are
recomputed in each [report](reports/).

---

## 1. Decisions only the owner can make

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| D1 | **Accept a small backend.** | Several things cannot work from a browser alone: GRIB downloads from NOAA NOMADS (no CORS), YB Tracking files, Saildocs by web, fleet position sharing, networking between devices, and hosted chart tiles. [technical-spec.md §3](../05-spec/technical-spec.md#3-server-stack) already planned one. | Use one Cloudflare Worker (or similar) plus object storage for a CORS proxy, a scheduled GRIB-to-cube ingest and a WebSocket relay. It costs a few dollars a month at pilot scale. It needs an account in your name. |
| D2 | **Signal K as the instrument path.** | Expedition talks to about 25 vendor protocols directly. A browser can't open serial ports (outside desktop Chromium), UDP or TCP sockets. | Read instruments through a [Signal K](https://signalk.org) server (Apache-2.0), which already speaks NMEA 0183/2000 and most vendor gateways. Add Web Serial for a USB NMEA 0183 adapter on desktop Chromium. Ship newjourney as a Signal K web app too, so the boat's server can serve it over plain HTTP. Otherwise an HTTPS page is blocked from `ws://` on the boat's LAN. |
| D3 | **Transmit to the boat, or read only?** | Expedition writes to instrument buses: NMEA output, autopilot steering, polars and calibrations pushed to B&G/Ockam processors, and numbers sent to deck displays. A bad sentence on a live boat's bus is a safety problem, not a UI bug. | Stay read-only until there is a test boat (see §3). The code can be written and tested against recordings, but transmitting stays behind a setting that is off by default. |
| D4 | **A native helper for what Signal K can't do.** | Radar (multicast Ethernet), Iridium GO! control, watching folders, and the Expedition-style DLL API all need OS access. | Build a small, optional desktop helper (Tauri or Go) only when one of these becomes the next item. Until then those rows are **Bridge**. |
| D5 | **Commercial or not.** | Open-Meteo's hosted API is free only for non-commercial use. RainViewer, aisstream.io and OpenSeaMap tiles have similar limits ([licensing-matrix.md](../02-data-sources/licensing-matrix.md)). | Stay non-commercial for now. If that changes, budget for an Open-Meteo API plan or self-host it (AGPL), and move to self-hosted tiles. |
| D6 | **ORC polar data.** | The polar library is generated, not measured. [licensing-matrix.md](../02-data-sources/licensing-matrix.md) §4 leaves ORC unresolved. | Keep ORC as a user-initiated import until someone asks ORC. |
| D7 | **Access to Expedition itself.** | "1:1" can only be proven side by side: the same GRIB, polar and marks giving the same route, the same start numbers, and files that round-trip. | Get a licence (€1,250 per [sales page](https://www.expeditionmarine.com/sales.html)), or time on a navigator's licensed copy, plus a set of real files it wrote (see §5). |

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
| **A chart-tile pipeline** | NOAA ENC → vector tiles for S-52-style display | Runs on the backend or on a build machine. The data is public domain. |
| **Email sending**, for Saildocs requests | Saildocs is an email-request service | A `mailto:` link works with no server. Direct web delivery needs the proxy. |

## 5. Data we'd need to get hold of

| Data | Source | Status |
|---|---|---|
| World land polygons, tiled | OSM land polygons (ODbL) | Free. Needs a pack build. Today land avoidance only covers the Portland box. |
| NOAA ENC cells | NOAA (public domain) | Free. Needs a parser or tile pipeline. |
| Tide and current harmonic constituents for every station | NOAA CO-OPS API (public domain) | Free. Needed for offline tide prediction (Expedition bundles XTide data). |
| World Magnetic Model coefficients | NOAA NCEI (public domain) | Free. Today variation is one fixed Portland value. |
| **Real Expedition files**: polar `.txt`, marks database export, routes, sail chart, race notes, a day's log, a start-line setup | a navigator with Expedition (D7) | **Needed** to prove the formats round-trip |
| **Recorded instrument streams** (NMEA 0183 and 2000) from a race boat, with wind, speed, heading and heel | a boat, or Signal K sample data | **Needed** as fixtures for calibration, playback and set and drift |
| **Recorded AIS streams** | a receiver, or public sample logs | Needed as fixtures |
| Measured or designer polars for the classes we list | designers, class associations, ORC (D6) | The bundled polars are generated, not measured |

## 6. What a browser cannot do, so the native helper would

| Capability | Expedition feature | Route around it |
|---|---|---|
| UDP/TCP sockets | NMEA over the network, Expedition-to-Expedition sharing, Furuno and Exocet feeds | Signal K for input. Our own relay for app-to-app sharing. |
| UDP multicast | Navico and Koden radar | Native helper only |
| Serial on iOS or Firefox | Any serial instrument | Signal K. Web Serial works only on desktop Chromium. |
| Watching the filesystem | Chart-folder scanning, watched folders for fleet reports | The user picks a file each time. The File System Access API on desktop Chromium. |
| Controlling a device on the LAN | Iridium GO! dial and hang-up | Native helper only |
| DLL or COM APIs | ExpDLL, Deckman bridge | A documented WebSocket/JSON API instead |
| Writing to instrument buses | NMEA/N2K output, autopilot, deck displays | Through Signal K's output plugins, behind D3 |

## 7. People

- **A working navigator who uses Expedition**, to walk the worklist and say which rows
  matter in a race and which are furniture.
- **A boat and a day on the water** for every Hardware row.
- **A legal read** before anything ships under D5, D6 or S-63.
