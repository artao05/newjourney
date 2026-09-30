# Parity worklist

The build order for [Expedition parity](README.md). Items are worked top to bottom, one
per commit. Each commit carries the tick and updates the [matrix](parity-matrix.md)
rows it closes. An item that needs something from [needs.md](needs.md) is marked
`blocked:` with the need's number, and work moves on.

**Order.** First the test gate, because nothing else can be verified without it. Then
the cheap wins: engine features that already exist but have no UI. Then the channel
system and nav-station layout that every later display hangs off. Then navigation
data, polars, race tools, instruments, logging and alarms. The large engines come
last: routing depth, GRIB, tides, AIS and fleet, ENC charts, and integration.

Several engines (ENC, GRIB2) span many commits. They are split so that every commit
leaves something tested and working.

---

## M0 — A gate that can be trusted

- [x] **0.1 `npm test` passes on this machine.** It currently exits 1: one test fails
      under load, and vitest's worker RPC times out (`onTaskUpdate`) while long
      synchronous routing tests hold the worker. *Accept:* three consecutive full runs
      exit 0, with no test weakened. Slow tests are split or moved to the `PERF` run.
      *Done:* vitest never yields between tests, so a file of synchronous solves is
      one block and the RPC reply can't land. `src/test-setup.ts` yields a macrotask
      after each test. Three full runs then exited 0 (1,064 tests each).

## M1 — Wire up what already exists

- [x] **1.1 Routing settings.** The kernel supports resolution presets, wind
      scale/rotate/time shift, current scale, max TWS/gust/waves and tack/gybe
      penalties, but Route hard-codes all of them. *Accept:* a settings sheet
      reaches every option, the values persist, and a test shows each one reaching the
      `RouteRequest`.
- [x] **1.2 Mast height really scales the wind.** Setup says it does, and nothing
      calls `heightScaleFactor`. *Accept:* routing and polar lookups apply the height
      correction when the polar is 10 m-referenced, and a test pins the factor.
      *Done, corrected:* the forecast is itself 10 m wind, so a 10 m polar needs no
      correction. The lift applies to a **masthead** polar. Setup now says which
      case the loaded polar is.
- [x] **1.3 Draw reverse isochrones.** They are computed and never drawn. *Accept:* a
      toggle draws them beside the forward isochrones, and a screen test finds the
      layer.
- [x] **1.4 An imported polar survives reload.** *Accept:* the table persists, and a
      store test covers the reload.
- [x] **1.5 Show the computed-but-hidden numbers:** XTE, distance to finish, polar BSP,
      VMG %, VMC, layline bearings and next-mark bearing/range. *Accept:* each is
      reachable on screen, and a test finds it.
- [x] **1.6 Route from anywhere.** Planning from a mark or a tapped point, not only the
      live fix. *Accept:* a start picker, with a test that the request's start is the
      picked point.
- [x] **1.7 Units that do something.** `settings.units` is persisted and read by
      nothing. *Accept:* speed, distance and depth units apply across screens, and a
      format test covers each.

## M2 — Channels and the nav-station layout

- [x] **2.1 The channel catalogue.** Every channel in Expedition's appendix (361 per
      boat), with id, label, unit, group and source (computed, sensor, licence). Each
      is marked computed or not yet. *Accept:* a test checks the catalogue against
      the appendix list, with no duplicates and a valid unit on every entry.
- [x] **2.2 A live channel snapshot.** One per boat, built at 1 Hz from boat state,
      wind, tactics and start numbers. *Accept:* unit tests for each group, and every
      "computed" catalogue entry produces a value under the simulator.
- [x] **2.3 Number boxes.** A configurable grid of any channels, with sizes,
      alternating channels, and a layout that persists. *Accept:* screen tests for
      pick, alternate and persist.
- [x] **2.4 Nav-station layout at ≥1024 px.** The chart in the middle, the tabs as
      side panes, and a number-box column. The phone layout is unchanged. *Accept:*
      screen tests at both widths, plus a browser check.
- [x] **2.5 Keyboard shortcuts and full-screen chart.** *Accept:* a keymap test, plus
      a browser check.
- [x] **2.6 User configuration export and import.** Boats, polars, marks, settings and
      layouts in one JSON file. *Accept:* a round-trip test.

## M3 — Marks, routes and race notes

- [x] **3.1 Edit and place marks.** Enter lat/lon as DD, DMM or DMS, and edit the
      name, rounding side and order. Place marks by tapping the chart. *Accept:*
      store, parser and screen tests. *Split:* the marks library and dragging went
      to 3.1b, so each commit stays one thing.
- [x] **3.1b Drag marks on the chart.** *Accept:* a screen test, and a browser check
      of a pointer drag.
- [x] **3.1c A marks library.** A library of named marks, in folders and separate
      from the course, which routes are built from. GPX import goes to it.
      *Accept:* store and screen tests.
- [x] **3.2 Marks import and export:** GPX and Expedition-style CSV. *Accept:*
      round-trip tests.
- [x] **3.3 Named routes.** Build from marks or by tapping the chart; insert,
      reorder, reverse and activate; next mark; a legs table with bearing, distance,
      TWA and time. *Accept:* store and screen tests.
- [x] **3.4 Range and bearing tools.** Measure between points, EBL/VRM from the boat,
      and a cursor readout with polar time to the cursor. *Accept:* geometry tests
      and a browser check.
- [x] **3.5 Race notes.** Points, lines and polygons with text, drawn on the chart.
      *Accept:* store and screen tests.
- [x] **3.6 Race notes steer the router.** Exclusion zones, and polygons that slow the
      boat by a percentage. *Accept:* analytic kernel tests for both.

## M4 — Polars and sails

- [x] **4.1 Polar roles:** performance, navigation, start and heel, each chosen
      separately. *Accept:* store tests, and each consumer reads its own role.
      *Done for performance and start.* The heel polar waits for heel data (6.6),
      because there is nothing to compare it against until then.
- [x] **4.2 Polar editor.** Table and drag editing, derived targets, save as
      Expedition text. *Accept:* editor and serialiser tests. *Done as a table
      editor.* Dragging points on the plot waits for a canvas hit-testing layer.
- [x] **4.3 Targets table, and logged points drawn on the polar.** *Accept:* tests.
      *Done: the targets table, and wind-speed sets for the plot.* Logged points need
      logged BSP and TWS, so they move to 7.1b.
- [x] **4.4 Sails and the sail chart.** A sail list, a TWA × TWS chart with
      tab-separated import/export, the live point, sail channels and a sail per
      route leg. *Accept:* parser, lookup and screen tests.
- *4.5 Asymmetric port and starboard polars moved to 9.14.*

## M5 — Race tools

- [x] **5.1 Full W/L course builder:** axis in °M, gates with width, a separate
      finish, leeward alignment to boat, mid-line or pin, and the leave-to-port flag
      honoured. *Accept:* geometry tests. *Done, with laps; a separate finish mark
      is not built yet (P2-244).* The leeward sign now follows Expedition: positive
      means above the line.
- [x] **5.2 Gates:** bearing, range, lay distances and times, gate spot, bias and
      square wind. *Accept:* tactics tests.
- [x] **5.3 Laylines on the chart**, with min/max bounds from wind oscillation, and
      tide-affected laylines. *Accept:* tests and a browser check. *Done without
      the tide:* tide-affected laylines need a current field, which comes with 11.4.
- [x] **5.4 What-if for current**, and what-if applied to Start and Route as well.
      *Accept:* tests.
- [x] **5.5 Hold wind and hold current** before the start, released at the gun.
      *Accept:* store tests.
- [x] **5.6a Start line adjustments** (from 5.6): an end set by range and bearing, nudge up the wind, swap ends, and approach options. *Done.*
- [x] **5.6b Start canvas extras** (from 5.6): heading apart from COG, the time to each end, boat-length rings, and a magnified end. *Done.*
- [x] **5.6c Turn circles** (from 5.6): either side of the bow, radius from the rate-of-turn model. *Done.*
- [x] **5.6 Start display extras:** the top-corner time with its time to burn. *Accept:* canvas tests. *Done as a best reading; to check against Expedition when D7 allows.*
- [x] **5.7a Gun distance and stern below the line** (from 5.7): both start channels, from the bow dead-reckoned to the gun and the stern one hull length back. *Done.*
- [x] **5.7b Speed to the ends, start targets and the simple times** (from 5.7). *Done.*
- [x] **5.7c Speed on each tack** (from 5.7), bearing away when over the line early. *Done.*
- [x] **5.7d The reach channels** (from 5.7): distance, time and speed to the line on the present heading. *Done.*
- [x] **5.7 The remaining start channels:** time to layline P and S, the pinch times,
      boat to pin, and gun speed as % of target. *Accept:* start-math tests. *Done as best
      readings of the manual; to check against Expedition when D7 allows.*
- [x] **5.8 Handicap calculator:** TCF time-on-time and time-on-distance, with
      elapsed, corrected and owed times. *Accept:* tests against hand-worked
      examples.
- [x] **5.9 Race timer:** multiple class starts, custom sequences, and sounds.
      *Accept:* timer tests.
- *5.10 Wind shadow channels moved to 12.7: they need other boats' positions, from AIS or race tracking.*

## M6 — Instruments

- [x] **6.1 NMEA 0183 parser.** Checksum, plus RMC, GGA, GLL, VTG, HDG/HDM/HDT, MWV,
      MWD, VHW, VLW, DPT/DBT, MTW, MDA, XDR, RSA, ROT, ZDA, RMB, APB and XTE.
      *Accept:* fixture tests.
- [x] **6.2 Signal K client.** WebSocket delta stream into boat state and channels,
      with a connection UI and a mixed-content warning. *Accept:* tests against a
      recorded delta stream. Live use is `Hardware`.
- [x] **6.3 Web Serial source** for NMEA 0183 on desktop Chromium. *Accept:* a test
      with a mocked port. Live use is `Hardware`.
- [x] **6.4 The instrument pipeline:** per-channel damping, true wind from apparent
      (heel and upwash corrected), the leeway coefficient, and set and drift gated on
      rate of turn. *Accept:* fixture tests.
- [x] **6.5 Calibration tables:** BSP, AWA, AWS, TWA and TWS correction tables, compass
      deviation and offsets. *Accept:* tests.
- [x] **6.5b Mast angle** (from 6.5): read a mast-rotation sensor (XDR or Signal K) and
      correct it with an offset. *Accept:* tests.
- [x] **6.6 Phone heading and heel** from DeviceOrientation, with an honest quality
      flag. *Accept:* hook tests.
- [x] **6.7 GPS window:** fix, HDOP and satellites when NMEA provides them. *Accept:*
      tests.
- [x] **6.8 Expedition's simple text protocol**, parsed and emitted. *Accept:* tests,
      including the checksum.
- [x] **6.9 NMEA 2000 PGN decoding** from Actisense or YD raw formats. *Accept:*
      fixture tests. Live use is `Hardware`.
- [ ] **6.10 Output to instruments.** Unblocked 2026-09-30 (D3: build it, off by default); worked as M19.

## M7 — Logging, playback and stripchart

- [x] **7.1 Channel logger:** 1 Hz to IndexedDB, one log per day, a size cap, and CSV
      export. *Accept:* tests.
- [x] **7.1b Logged points on the polar**, coloured by tack and hollow when below the
      polar's VMG, as Expedition draws them. *Accept:* tests.
- [x] **7.2 Log import:** CSV logs, NMEA recordings and GPX. *Accept:* fixture tests.
- [x] **7.3 LogPlayer:** replay into the live snapshot with play, pause, speed and
      seek. Every screen works during playback. *Accept:* tests and a browser check.
- [x] **7.4 Stripchart:** any channels against time, with zoom, pan and wands showing
      deltas and means. *Accept:* tests and a browser check.
- [x] **7.5 Events and sail tests:** sail changes and notes (automatic at ping and
      gun), and tests saved from wanded spans. *Accept:* tests.

## M8 — Alarms

- [x] **8.1 Alarm engine:** channel thresholds with hysteresis, sound and screen
      alerts, acknowledgement and persistence. *Accept:* tests.
- [x] **8.2 The standard alarms:** anchor drag, depth, arrival, off-course, layline,
      GPS lost and wind shift. *Accept:* tests. *AIS CPA moved to 12.2, with the targets.*

## M9 — Routing to Expedition's depth

- [x] **9.1 Upwind and downwind TWS limits, and motoring** below a minimum sailing
      speed. *Accept:* kernel tests.
- [x] **9.2 Keep and compare routes:** several optimised routes, highlighting the
      previous one. *Accept:* store and screen tests.
- [x] **9.3 Results parity:** current and sail columns, a meteogram along the route,
      barbs at each leg's own time, and export to the marks database. *Accept:*
      tests.
- [x] **9.4 Adjustable sensitivity band and isochrone drawing interval.** *Accept:*
      tests.
- [x] **9.5 Draw every explored path.** *Accept:* tests.
- [x] **9.6 Decaying wind correction:** a now-correction blended back to the forecast
      over N minutes. *Accept:* field tests.
- [x] **9.7a Wave speed table** (from 9.7): % of polar by wave height and angle to the boat, per heading. *Done.*
- [x] **9.7 Wave correction**, with swell priority, coefficients and crossed sea, and
      **air-density correction**. These need swell and wind-sea as separate layers, and
      pressure and temperature, which the field does not carry yet (M10). *Accept:* kernel tests.
- [x] **9.8 Route to and via the pointer.** *Accept:* tests.
- [x] **9.9 Grid algorithm**, with an optional great-circle track. *Accept:* analytic
      tests, and agreement with the isochrone solver on open water.
- [x] **9.9b The grid in the app:** choose it in Route SETTINGS and run it in the worker. *Accept:* a screen test.
- [x] **9.10 Globally optimal multi-mark routing.** *Accept:* a test where leg-by-leg
      routing loses.
- [x] **9.11 Ensemble routing.** *Accept:* tests.
- [x] **9.12 Fleet routing:** every boat with its own polar (after 13.4). *Accept:*
      tests.
- [ ] **9.13 World land avoidance** from a tiled OSM land pack. *Accept:* a route
      outside Portland goes round land. D1 is decided (a local backend), which
      answers "where". Worked as 20.7, which still asks one thing: may I download OSM's
      simplified land polygons (about 25 MB, ODbL, with credit)?
- [x] **9.14 Asymmetric port and starboard polars**, moved here from 4.5 because it
      needs a second set of target tables in the hot loop. *Accept:* the kernel uses
      the right side on each tack, with a test.
- [x] **9.14b A port polar in the app:** import it in Setup, keep it, and pass it through the worker. *Accept:* store and worker tests.

## M10 — Weather

- [x] **10.1 GRIB2 decoder** in a worker, starting with simple and complex packing
      with spatial differencing, which covers GFS. *Accept:* fixture tests on a real
      GFS subset.
- [x] **10.1b Check the GRIB2 decoder on a real GFS file.** 10.1 is tested on messages
      built byte by byte to the WMO layout, because there is no GRIB file here. Unblocked 2026-09-30
      (D8: download them); worked in M16.
      *Whole global GFS messages in NCEP's complex packing with second-order spatial differencing
      decode exactly as NOAA's wgrib2 does at every shared point (grib2.real.test.ts).*
- [x] **10.2 GRIB2 PNG packing**, then **GRIB1**. *Accept:* fixture tests. *PNG with a
      small inflate of our own (src/lib/inflate.ts); GRIB1 with NCEP and ECMWF tables.*
- [x] **10.3 Open GRIB files** by picker or drag-drop, several at once, with a
      parameter catalogue. *Accept:* tests and a browser check.
- [x] **10.4 Merge sources** in production: StackedField, best resolution first, per
      parameter. *Accept:* tests.
- [x] **10.2b GRIB2 CCSDS packing** (5.42, used by ECMWF open data and DWD). *Accept:*
      fixture tests. *A CCSDS 121.0-B decoder of our own (src/lib/weather/aec.ts), with a
      test encoder, round trips over every option and flag, and one stream built by hand.*
- [x] **10.5 Pick the model for routing.** *Accept:* a test that the request uses the
      chosen model.
- [x] **10.6a Display parity, the parameters:** gust, pressure, waves, SST, air temperature
      and rain as layers, offered behind More only when the forecast has them. *Accept:*
      tests and a browser check.
- [x] **10.6b Contours** with a step and a bold level: isobars, isotachs, rain. *Accept:*
      tests and a browser check.
- [x] **10.6c A display mode per parameter:** Beaufort, spectrum, greyscale and single-colour
      modes, and a line width. *Accept:* tests and a browser check.
- [x] **10.7 Meteogram** at the boat or any point, and a time step setting. *Accept:*
      tests.
- [x] **10.8a Observation parsers:** NDBC realtime2 text, raw METARs and NOS CO-OPS wind and
      pressure JSON, in knots, hPa and °C, null for anything not reported. *Accept:* parser
      tests. *(src/lib/weather/observations.ts)*
- [x] **10.8b Observations on the chart, with history:** the stations near the venue drawn
      with their latest wind, and a station's recent reports against the forecast there.
      *Accept:* tests and a browser check.
- [ ] **10.8c Buoys and METARs on the chart.** Parsed already; a browser can't fetch them
      (NDBC and aviationweather.gov send no CORS headers). Unblocked 2026-09-30 (D1: build the
      backend locally); worked as 20.3.
- [x] **10.9 Radar and satellite overlays:** RainViewer's latest frame and GOES-East GeoColor from
      NASA GIBS. *Accept:* a browser check.
- [x] **10.9b Weather-chart overlays:** OPC surface analyses and other fax charts, placed by their
      corners on the chart, as Expedition's image manager does. *Accept:* a browser check. *A picked image placed by its four edges; fetching OPC's own charts needs the proxy (D1), and
      reference-point georeferencing is 13.9.*
- [x] **10.10 Ensemble display:** members, and mean ± SD. *Accept:* tests.
- [x] **10.11 A GRIB request builder:** area on the chart, model, parameters and
      times, with a Saildocs `mailto:` and a size estimate. *Accept:* tests.
- [ ] **10.12 NOMADS and ECMWF open-data download.** Unblocked 2026-09-30 (D1); worked
      as 20.2.
- [x] **10.2c GRIB2 JPEG 2000 packing** (5.40, used by NAM and Canada's GEM). A decoder
      of its own: codestream, tier-2 packets, the MQ coder and EBCOT, and the 5/3 and 9/7
      wavelets. Last in M10 because GFS, HRRR and ECMWF don't need it. *Accept:* fixture tests.

## M11 — Tides and currents

- [x] **11.1 Harmonic tide engine** from NOAA constituents. *Accept:* agreement with
      NOAA predictions to within a stated tolerance. *2–4 mm RMS, under 7 mm worst, against NOAA's
      hourly predictions for Portland over weeks in 2026 and 2027 (checked live); the committed
      regression is a week of NOAA's numbers, 2.0 mm RMS and 4.0 mm at worst (harmonic.real.test.ts).*
- [x] **11.2 Tide stations:** nearest-station lookup, an offline constituent pack, the
      tide curve, and tide channels. *Accept:* tests. *Constants are kept on the device once
      fetched rather than shipped as a pack; the channels are 11.2b.*
- [ ] **11.2b Tide channels** (Tide left/right, port/stbd time; Tide station). `blocked: D7`: the
      manual names them but doesn't say what they measure; what does Expedition show there?
- [x] **11.3 Harmonic tidal currents** and tidal diamonds on the chart. *Accept:*
      tests.
- [x] **11.4 Tidal streams in routing**, taking precedence over forecast current.
      *Accept:* kernel tests.
- [x] **11.5 Position-aware magnetic variation** (WMM). *Accept:* tests against NOAA
      calculator values.
      Unblocked 2026-09-30 (D8); worked in M16.
      *Done as 16.3.*

## M12 — AIS, boats and race tracking

- [x] **12.1 AIS decoder:** AIVDM/AIVDO types 1–5, 9, 14, 18, 19, 21, 24 and 27, with
      multipart messages. *Accept:* fixture tests.
- [x] **12.2 AIS targets:** list, chart symbols, CPA/TCPA, filters, alarms (the CPA alarm from 8.2), and
      SART/MOB/EPIRB alerts. *Accept:* tests.
- [ ] **12.3 aisstream.io source.** It needs a free key (needs §2). *Accept:* a test
      against a recorded stream.
      `blocked: needs §2`: aisstream.io's free key is issued to a person; will you create one
      (github sign-in at aisstream.io) and say where the app should keep it?
- [x] **12.4 Boats database:** several boats, each with a polar, colour and size.
      *Accept:* tests.
- [x] **12.5 Race-tracking import:** GPX (a track a boat), Expedition's own lines, Basic, Volvo and
      MaxSea reports as the manual lays them out, and a plain CSV; each matched to the boats
      database by tracker id, sail number or name. *Accept:* parser tests.
- [ ] **12.5b YB XML and Vessel Finder JSON.** `blocked: D7`: the manual gives neither schema;
      a file of each from a past race is what the parsers need to be written against.
- [x] **12.6 Tracking window:** positions interpolated to now, range and bearing,
      Ahead-of, and a leaderboard. *Accept:* tests.
- [ ] **12.7 Wind shadow channels** (from 5.10): Shadow and Shadow opposite gybe, from
      the tracked or AIS boats and the wind. *Accept:* geometry tests.
      `blocked: D7`: the catalogue has Shadow and Shadow opposite gybe in degrees, but not what
      they measure (a direction our dirty air goes, or where another boat's lies?).

## M13 — Charts

- [x] **13.1 ISO 8211 reader.** *Accept:* it parses a NOAA ENC cell fixture. *Tested on records built to
      the ISO 8211 layout with S-57-shaped fields; a real cell is 13.1b.*
- [x] **13.1b Check the reader on a real NOAA ENC cell.** Unblocked 2026-09-30 (D8); worked
      in M16.
      *US5PWMDC with update 1: the records read equal the cell's own DSSI counts (1,568 features
      and 3,945 vectors, then 1,570), and it drew in the app. It showed that most object classes and
      attributes had no names; the whole S-57 catalogue is in now. A cell whose counts disagree
      with its DSSI now says so.*
- [x] **13.2 S-57 decoder** to features in a worker. *Accept:* feature counts match
      GDAL's on the same cell.
      *On a cell built to the layout; feature counts against a real cell wait on 13.1b (D8).*
- [x] **13.3 S-52-style display:** depth areas, contours, soundings, land, lights,
      buoys, beacons and hazards. *Accept:* a browser check against NOAA's own
      rendering.
      *A simplified rendition on the dark chart, drawn from cells opened under Route → ENC; the full
      PresLib symbol set and light sectors are not drawn. Checked in the browser on a built cell only:
      the comparison with NOAA's own rendering needs a real cell (13.1b, D8).*
- [x] **13.4 Display categories and safety settings:** base, standard and all;
      safety, shallow and deep contours; two-colour shading; night palette. *Accept:* tests.
- [x] **13.4b Simplified or paper symbols** for buoys, beacons and lights: a symbol set to draw
      them with (the dots stand in until then). *Accept:* a browser check.
      *The simplified set, drawn in plain TypeScript and registered on demand (lib/charts/symbols.ts);
      checked in the browser on a built cell. The paper-chart set and light sectors are still to do.*
- [x] **13.5 Chart installer:** load `.000` files or a folder, a cell catalogue and
      bounds. *Accept:* tests.
      *Base cells, updates (applied in sequence), folders and NOAA zips; kept in IndexedDB and
      drawn again on start. Per-cell show/hide is still to do.*
- [x] **13.6 Chart object query.** *Accept:* tests.
- [x] **13.7 Orientation modes:** north-up, course-up and head-up, with follow-boat.
      *Accept:* a browser check.
      *North, course and head up; free, follow, look ahead, and boat + mark (lib/chartView.ts).
      Checked in the browser with the simulator: bearing, framing and a reload.*
- [x] **13.8 BSB/KAP raster charts.** *Accept:* it decodes a NOAA RNC fixture.
      *Decoder, georeferencing and display on the Route chart, on charts built to the layout
      (lib/charts/fixtures/bsb.ts); the real-chart check is 13.8b.*
- [x] **13.8b Check the raster reader on a real BSB/KAP chart.** Unblocked 2026-09-30 (D8); worked
      in M16.
      *NOAA's 14983 found two bugs: wrapped header lines were joined without their comma, so the
      polynomials read as nothing, and pixel-to-world and world-to-pixel were swapped. Its reference
      points now land within a pixel. It also showed that one four-corner warp is 23 m out across a
      Lambert chart, so charts now draw in tiles, each within 2 m.*
- [x] **13.9 Georeferenced custom images, and GPS chart offset.** *Accept:* tests.
      *Images placed by two or more control points (Mercator or lat/lon); a chart offset in metres
      moves the ENC and raster charts (lib/charts/georef.ts). The base map cannot be moved.*
- [x] **13.10 Safe route check and safety-depth routing** against ENC. *Accept:*
      kernel tests.
      *ENC land, water under the safety depth and dangers go to the router as land; routes are
      checked against the cells (lib/charts/encRouting.ts, worker.test.ts).*

## M14 — Integration and the rest of the shell

- [x] **14.1 A documented JSON/WebSocket API** for channels out. *Accept:* tests.
      *Setup → Channels out: newjourney JSON (hello, channels, subscribe, ping) or Signal K deltas
      to a WebSocket the user names, reconnecting with back-off (docs/09-api/channels-out.md).
      Checked live against a local WebSocket server.*
- [ ] **14.2 Sharing between devices:** marks, routes and the start line. Unblocked
      2026-09-30 (D1); worked as 20.4.
- [x] **14.3 Save the display as an image, print, and a night palette** for the whole
      UI. *Accept:* a browser check.
      *Route → image or print: the chart captured at its next frame, captioned with the base map's
      credit (lib/mapExport.ts); the moon in the top bar turns the whole app red on black.*
- [ ] **14.4 Self-hosted basemap and glyphs.** Unblocked 2026-09-30 (D1); worked as 20.6.

## M15 — The matrix, row by row (added in tick 6)

M0–M14 ran out with parity at 24 %: the list never held every Build row of the
matrix, and "perfect" is every row Done or Blocked (README). These milestones take
the Build rows still Missing, cheapest and most used first. Each item names its rows.

- [x] **15.0 Reconcile the matrix with the code.** Rows marked Missing or Partial that
      earlier ticks closed (GRIB opening and drop, JPEG 2000 GRIB, ENC exchange sets and
      folders, heading-up, fleet on the chart, AIS targets, and others) get Done with
      the file and test that show it. *Accept:* each changed row names its evidence.
      *Four passes (ticks 6 and 7): every Missing and Partial Build row audited against the code;
      33 rows to Done, 48 to Partial and 35 Partial notes corrected, each with its evidence.*
- [x] **15.1 Marks by hand:** undo and redo, lock and unlock, a mark at range and
      bearing from the boat or a mark, insert into the nearest leg, add as a gate, go
      to the pointer, a mark from a chart object (P1-121, P1-123, P2-105, P1-128,
      P1-263, P1-261, P1-258, P1-259, P1-255). *Accept:* tests.
      *Go here inserts the mark as the active one rather than replacing the course; a gate is
      left and right looking upwind, as the W/L wizard makes them.*
- [x] **15.2 Legs on the chart:** leg labels, the current-leg line, mark range
      circles, mark and route colours, auto mark advance (P4-138, P4-139, P4-141,
      P4-131, P4-175). *Accept:* tests and a browser check.
      *Labels, the current leg, range circles and auto advance (lib/legsOnChart.ts,
      hooks/useAutoAdvance.ts); route and mark colours in Route → SETTINGS → Display.*
- [x] **15.3 AIS on the chart:** labels, predictor lines and trails, the CPA marker,
      a colour scheme, own-ship MMSI, an allow-list, the raw message log, a warning on
      entering an avoid area (P4-159, P4-160, P4-161, P3-106, P3-103, P3-104, P3-101,
      P3-102). *Accept:* tests.
      *Labels are names only, the MOB PGN is transmitting (D3), and the raw log is kept in memory
      with an export rather than written to storage.*
- [x] **15.4 ENC lights and text:** light descriptions, sectors (full-length and
      small), text groups, large text, anti-clutter (P1-094, P1-095, P2-006, P2-007,
      P2-008, P2-010, P2-009, P1-309). *Accept:* tests and a browser check.
      *All but the important-text group (clearances, not drawn yet). Checked in the browser on a
      built cell with a two-sector light.*
- [x] **15.5 Number boxes:** damped or raw values, per-channel precision, time to a race
      note, alternating numbers by situation, the reaching band (P1-079, P4-182, P4-183,
      P1-159, P4-172, P4-174). *Accept:* tests.
      *Situation boxes cover upwind, reaching, downwind and prestart; MOB, timer and tack are
      still to do in P4-172.*
- [x] **15.6 Log analysis:** tack and gybe analysis, the performance report, the best
      24-hour run, a track point to the stripchart (P1-153, P1-152, P1-239, P1-272).
      *Accept:* tests against a logged session.
      *Analysis, the summary and the best 24 hours are in (Stripchart → Analysis). Still to do: the
      live Tack/gybe loss channels, and a track point to the stripchart (P1-272), which waits on our
      own track being drawn on the chart.*
- [x] **15.7 Stripchart:** sample rate, axis behaviour, a second trace per pane,
      configuration files (P4-206, P4-208, P4-215, P4-209). *Accept:* tests.
      *A boat per pane, and a recent-files list and drop for layouts, are still to do.*
- [x] **15.8 Routing views:** several optimum routes on screen, stepping through the
      routing times, the routing tooltip with DNM %, first leg only, draw paths, routes
      kept (P1-012, P1-217, P1-221, P2-193, P2-215, P2-187). *Accept:* tests.
      *Checked on a live route (55 isochrones). The tap readout gives the isochrone and DNM % but
      not yet the speed and weather there.*
- [x] **15.9 Course wizards and start extras:** Olympic triangle and trapezoid wizards,
      start line ends from marks, a separate finish mark, start time ratios (P1-165,
      P1-166, P2-107, P2-244, P1-180). *Accept:* tests.
- [x] **15.10 Weather presets and info:** display presets 1–9, hide all weather,
      forecast coverage outlines, GRIB file and run-time info (P1-185, P2-119, P1-188,
      P4-168, P2-173, P2-170). *Accept:* tests.
      *The GRIB file info before download and the model run time stay partial: the first cannot be
      known before a Saildocs reply, the second needs the NOMADS listings (D1).*
- [x] **15.11 Files:** race-note files and areas from text, tracking to text,
      BoatId.csv and scheds CSV, an XTide reader (P1-161, P1-162, P2-282, P2-286,
      P2-287, P4-202). *Accept:* tests.
      *All but the XTide reader (P4-202), which is a port of libtcd; NOAA harmonics already feed
      the tide engine.*
- [x] **15.12 Shell:** an error log, hover tooltips, chart text size, layout presets and
      locked panes, Fahrenheit, user-channel names (P1-042, P4-163, P4-133, P1-065,
      P1-063, P4-111, P4-184). *Accept:* tests and a browser check.
      *Hover tooltips (P4-163) and user-channel names (P4-184) are still to do, and °F reaches the
      channels but not yet the Weather probe and meteogram.*
- [x] **15.13 Sails:** the sail inventory editor, the sail chart and its cell editing,
      wind weight (P1-140, P1-073, P3-011, P1-283, P3-073). *Accept:* tests.

## M16 onward: working functionality first (the owner's decisions, 2026-09-30)

The owner asked for the same capabilities with as much of them working as possible. The
look may follow Expedition's if it stays simple and minimalist. D8, D4, D3 and D1 were
answered yes (see [needs.md](needs.md)). So the order is: real files, to prove the
decoders on real data; then the plain nav-station look; then the bridge, transmit
and the backend, which unlock the Bridge rows; then every Build row still missing;
then the Partial rows; then the Hardware rows, tested against recordings.

## M16 — Real files (D8)

- [x] **16.1 Download the public test files** and commit them with a `SOURCES.md` that gives
      each file's URL, date and licence: a small GFS subset from the NOMADS filter, NOAA's
      WMM-2025 `WMM.COF`, one NOAA ENC cell for Portland, one archived NOAA KAP, and a week
      of NOAA tide predictions for Portland (8418150). *Accept:* the files, their sources,
      and a test that each one opens.
      *In `fixtures/real/` (890 KB): GFS subsets plus two whole global messages in NCEP's own
      complex packing, WMM2025 with NCEI's test values, ENC US5PWMDC with its update, RNC 14983
      (the Internet Archive's copy of NOAA's file, since NOAA withdrew RNCs), and CO-OPS
      constants, datums and a week of predictions. Checked in src/realFiles.test.ts.*
- [x] **16.2 Real-file checks:** 10.1b (GFS through the GRIB2 decoder, values against the
      NOMADS listing), 13.1b (the ENC cell's feature counts), 13.8b (the KAP's size, palette
      and corners), and the 11.1 regression fixture. Fix whatever the real files show.
      *Accept:* tests on the real files.
      *All four, with the fixes each found (10.1b, 13.1b, 13.8b above). Checked in the app: the
      Portland cell with Spring Point Ledge Light's sectors, and chart 14983 drawn in 30 tiles.*
- [x] **16.3 Position-aware magnetic variation (11.5)** from WMM-2025: variation at the boat,
      the pointer and each mark, with a date. *Accept:* agreement with NOAA's published
      test values.
      *A WMM of our own (lib/wmm.ts) with NOAA's coefficients embedded and checked against the
      file. It matches all of NCEI's WMM2025 test values (the field to 0.01 nT, the angles to their
      rounding, and each one's annual change) and NOAA's calculator at Portland. The fixed venue
      value is gone: variation is taken at the boat's fix for the channels, the wind and line
      sheets, the W/L axis and the phone compass; at the pointer in the Route readout, which also
      gives °M in magnetic mode; and at each mark in its sheet.*

## M17 — A plain nav-station look

Expedition's look, kept simple: a light day theme, a row of text tabs with the commands
for each one, a status bar, a right-click menu, and panes that dock. Not its name,
logo, icon artwork or manual text.

- [x] **17.1 A light day theme** as the desktop default, with black numerals, one accent
      colour and flat panels; dusk and night stay, and switch by time of day if asked
      (P1-066, P1-067, P2-003, P4-114). *Accept:* tests and a browser check.
      *Day is the default everywhere (an old 'normal' save becomes day). The map overlays and the
      four canvases, drawn for the dark chart, are toned for day by one rule: lightness turned
      over, hue kept (lib/palette.ts). The ENC draws in S-52's day colours; the base map is the
      plain chart. By the sun follows civil twilight at the boat. Checked in the app on the real
      Portland cell in day and dusk. P2-003 (S-52's own dusk table at night) is still to do.*
- [x] **17.2 A command ribbon** at desktop widths: text tabs across the top, each with its
      commands in labelled groups, so nothing hides behind a chip (P1-035, P1-059, P1-062).
      *Accept:* tests and a browser check.
      *The six screens as text tabs, and the chart screen's commands in captioned groups under
      them, put there by the screen itself through a portal, so on the phone the same commands
      stay over the chart. Route: Chart and Routing; Weather: Layer and Display. The panel screens
      (Start, Race, Setup) keep their controls in the pane. The status chips (forecast, rhumb
      distance, land pack) go to the status bar in 17.3.*
- [x] **17.3 A status bar:** pointer position, variation, range and bearing from the boat,
      chart scale, and safety warnings, with the fields chosen in Setup (P1-275, P1-276,
      P1-278, P4-170). *Accept:* tests and a browser check.
      *Along the foot of the nav station. The Route chips that were status, not commands, went
      there from the ribbon, through a portal of their own. It leads with NO POSITION FIX and
      not logging, and names the ENC datum. Checked in the app with a pointer set.*
- [x] **17.4 A right-click menu on the chart:** mark here, go here, range and bearing, zoom
      and centre, chart details, image at pointer, route from here (P1-251, P1-113, P2-018,
      P1-252, P2-100). *Accept:* tests.
      *Checked in the app: the menu opens at the pointer and stays while the chart follows the
      boat, which at first it did not (any move closed it; now only a move by hand). Image at
      pointer covers raster charts only so far.*
- [x] **17.5 Panes:** show, hide, auto-hide and drag to rearrange; hover tooltips on the
      chart, marks, AIS, the track and the weather (P1-062, P1-064, P1-083, P4-163, P4-140,
      P4-164, P4-165). *Accept:* tests and a browser check.
      *Panel and Boxes switches and Auto-hide in the ribbon's tab row; number boxes dragged into
      place; tooltips for marks (with a new comment field), AIS, fleet boats, ENC objects and the
      route. Checked in the app with auto-hide on. Still to do: tooltips on our own track and a
      hover readout on the Weather chart.*

## M18 — The local bridge (D4)

A small Node helper, `bridge/`, with no dependencies. It runs on the nav station, and the
app talks to it over a WebSocket on `127.0.0.1`.

- [x] **18.1 Network instruments:** NMEA 0183 and AIS over UDP (listen, broadcast, subnet)
      and TCP (client and server), several at once, forwarded to the app as a Bridge
      source, with reconnect (P4-033, P3-091, P3-093, P3-094, P1-051, P1-049, P3-119,
      P3-153). *Accept:* tests with a UDP and a TCP sender, and a recording replayed over
      UDP into the running app.
      *bridge/: a WebSocket server of our own (loopback only, local origins only), UDP (broadcast and
      multicast), TCP client with back-off, TCP server, batching, and bridge/replay.ts. The app's
      BridgeClient feeds the serial path's decoders. A synthetic Casco Bay recording, marked as
      such, replayed live into the app: position, speed, apparent wind, depth and a ferry on AIS.*
- [x] **18.2 NMEA 2000 through the bridge:** Actisense and Yacht Devices raw over TCP, UDP
      or a serial port, into the PGN decoder (P4-053, P4-055, P4-057, P4-058, P4-059,
      P4-060). *Accept:* tests with recordings.
      *Any bridge input marked --n2k goes to the NMEA 2000 decoder, which now also reads Actisense
      N2K ASCII (W2K-1) and iKonvert !PDGY, both whole messages that skip fast-packet joining. Tested
      through the bridge over TCP; the NGT-1's binary serial form waits on 18.5, and throttling
      (P4-060) is the gateway's, since the bridge only listens.*
- [x] **18.3 App to app:** instruments, marks, routes and the start line shared between
      copies of the app through the bridge, with channel filters, a repeater mode, and
      reconnect (P3-095, P1-029, P4-116, P1-050, P1-236). *Accept:* tests and two copies
      of the app in the browser.
      *The bridge relays share messages to every other copy and, with --peer and --key, to linked
      bridges; a message is passed on once, even round a circle of links. Setup → Sharing chooses
      topics both ways and the channels sent; instruments taken in make this copy a repeater.
      Checked with two tabs: a mark added in one appeared in the other. Still to do: telling the
      others to reconnect (P1-050) and the user flag (P1-236).*
- [x] **18.4 Watched folders:** position reports, raster charts and GRIB folders, picked up
      as files land (P1-056, P2-277, P1-146, P2-028, P2-141). *Accept:* tests.
      *bridge/watch.ts: fs.watch, sent once a file has stopped changing and only if it changes;
      --scan sends a folder's newest 20 to each app that connects. The app opens each by kind
      through the existing importers (GRIB, raster, ENC, tracking). P1-146 (fetching reports from
      FTP or HTTPS) goes with the backend, M20.*
- [ ] **18.5 Serial through the bridge:** NMEA 0183 serial ports on any browser, a laser
      rangefinder, and serial event buttons, tested on recordings (P1-026, P3-174, P1-171,
      P1-129, P3-152, P3-090). *Accept:* tests; the device check stays Hardware.

## M19 — Transmit, off by default (D3)

Nothing is sent until a master switch is turned on, and each output has its own switch
too. Every sentence sent is logged. Tests prove that nothing goes out while a switch is off.

- [ ] **19.1 The transmit switch,** per-output switches, a rate limit and the send log.
      *Accept:* tests.
- [ ] **19.2 NMEA 0183 out:** sentence selection, echo, wind from the active source, XDR
      type G, and the active route as RTE/WPL with APB/RMB/BWC for a pilot (P3-110, P4-049,
      P4-050, P4-051, P4-052, P4-034, P1-134, P4-042). *Accept:* tests against recordings.
- [ ] **19.3 The Expedition protocol out** with channel filters, and rebroadcast over UDP
      on its own port (P3-142, P3-081, P3-092, P3-151). *Accept:* tests.
- [ ] **19.4 NMEA 2000 out:** navigation, wind, heading, speed and environment PGNs, with
      per-PGN selection (P4-073, P4-074, P4-075, P4-076, P4-077, P4-061). *Accept:* tests
      that decode what was encoded.

## M20 — The backend, run locally (D1)

A Node server, `server/`, that the owner can deploy later. Until then it runs on this
machine, and the app is pointed at it in Setup.

- [ ] **20.1 The proxy:** an allow-list of hosts (NOMADS, ECMWF open data, NDBC,
      aviationweather.gov, CO-OPS, OPC), a cache, and a Setup field for the server.
      *Accept:* tests, and a browser check through the local server.
- [ ] **20.2 NOMADS and ECMWF open-data GRIB download (10.12),** with model run times and
      the previous run (P2-170, P2-167, P1-196). *Accept:* tests and a live download.
- [ ] **20.3 Buoys and METARs on the chart (10.8c)** through the proxy. *Accept:* a browser
      check.
- [ ] **20.4 Sharing between devices (14.2)** through a relay on the server: marks, routes,
      the start line and fleet positions. *Accept:* tests and two browsers.
- [ ] **20.5 Downloads:** OPC fax charts fetched, a download manager that resumes, and
      time-outs (P1-202, P1-061, P2-171, P4-100, P4-096, P2-166). *Accept:* tests.
- [ ] **20.6 Self-hosted glyphs (14.4),** so the chart stops calling `demotiles.maplibre.org`.
      *Accept:* a browser check with that host blocked.
- [ ] **20.7 World land avoidance (9.13)** from OSM's simplified land polygons, tiled by the
      server. `blocked: download`: may I download them (about 25 MB, ODbL, credit shown)?

## M21 — The Build rows still missing

Taken area by area, most used first. Each item names its rows.

- [ ] **21.1 Start and race:** laylines from the boat and from instrument performance, the
      opposite-tack predictor, rate of turn in laylines, the first mark from the starboard
      end, gybe approaches, time-to-burn labels, the countdown past laylines, turns over
      180°, display switches at the gun, the advantage line (P4-144, P1-154, P4-146,
      P2-242, P3-043, P1-168, P1-179, P3-039, P3-044, P3-049, P3-051, P3-053, P4-152).
- [ ] **21.2 Chart display:** lat/lon grid, depth contour labels, nature of seabed, over-zoom
      hatching, a boat range circle, the boat's name, a compass rose, auto-pan (P2-052,
      P2-066, P2-055, P2-041, P4-134, P4-157, P4-154, P4-115).
- [ ] **21.3 Chart library:** ENCs or RNCs only, a name filter, a chart that stays up,
      quilting, the image index, image valid times, information and quality objects, the
      datum warning (P1-303, P2-015, P2-019, P1-307, P2-012, P2-032, P1-253, P1-096,
      P2-004, P2-075).
- [ ] **21.4 Chart presentation:** S-52 or greyscale palettes, simplified boundaries,
      international or US, Easy View, enhanced anti-clutter, coastal land colours, land
      declutter, label language (P1-304, P2-079, P1-312, P2-051, P2-050, P2-089, P2-090,
      P2-091, P2-043, P2-069).
- [ ] **21.5 Marks and routes:** a running fix from bearing lines, reverse divider bearings,
      the Cowes Week SMS course, route folders, looping routes, always draw or don't draw
      (P1-132, P1-133, P1-139, P2-096, P2-097, P2-106).
- [ ] **21.6 Routing options:** tack and gybe preference, grid resolution, the route colour,
      shading by weather, turns only at routing steps, sail polars in routing, routes
      reloaded at start, routing on a weather boat's data (P1-225, P2-186, P2-188, P2-189,
      P2-195, P2-198, P2-205, P2-209).
- [ ] **21.7 Polars and sail tests:** heel polar, custom polars, sail tests overlaid,
      normalised and coloured, the sail polar overlay, per-sail analysis, a polar and sail
      chart built from it, the polar range circle (P2-258, P2-259, P2-260, P2-272, P2-273,
      P2-274, P3-016, P3-022, P3-023, P4-148, P1-243, P1-241).
- [ ] **21.8 Weather:** NetCDF, a GRIB from observed winds or from logs, wind scaling per
      model, Skew-T, Saildocs check, clearing old GRIBs, a colour per model, radar
      settings, fading, currents and SST always on, observation colours, AIS met winds
      (P1-010, P2-181, P1-057, P1-242, P2-136, P2-144, P1-270, P2-146, P2-148, P1-187,
      P1-204, P2-030, P2-122, P2-131, P4-132, P4-162, P2-173).
- [ ] **21.9 Tides:** tide-model laylines, secondary stations, a stream time shift, the tide
      source, the XTide reader (P4-145, P4-194, P4-197, P4-198, P4-202, P1-210, P4-200).
- [ ] **21.10 Fleet:** several boats' data, the latest report, a report time picker, manual
      positions, a tracking database per race, Blue Water Tracks (P1-082, P1-149, P2-280,
      P2-281, P2-283, P4-125, P1-147).
- [ ] **21.11 Logs and instruments:** the logged channel list, track colour and width, COG and
      SOG between wands, a track point to the stripchart, trip reset, the braking table, the
      raw data monitor, the clock from GPS, user-channel names (P4-178, P4-185, P4-188,
      P4-216, P1-272, P1-235, P3-065, P3-080, P1-234, P4-184, P4-221, P3-180).
- [ ] **21.12 Files and the shell:** the data folder, a backup at start, converters, the
      database editor, the scheduler, port mode, the sail graphic, MyImage and MyGrib files
      (P1-040, P1-041, P1-053, P1-157, P4-126, P4-127, P4-123, P4-108, P1-055, P1-249,
      P1-074, P3-017).
- [ ] **21.13 Downloads and satcom:** connection type, plain HTTP on satellite, a host
      allow-list, bzip2, halved resolution, Saildocs by web through the server (P4-094,
      P4-098, P4-107, P2-169, P2-168, P2-147).
- [ ] **21.14 The rest:** the AIS pane's columns, marine-mammal reports and overlay, the
      Hong Kong and New Zealand tide data (P3-098, P1-155, P1-156, P4-169).

## M22 — Partial rows finished

The 214 Partial Build rows, area by area after M21: each item closes the gap its row
names. The tick that reaches M22 writes its items from the matrix, as tick 6 wrote M15.

## M23 — Hardware rows, against recordings

- [ ] **23.0 Reconcile the Hardware rows** with the decoders that exist (NMEA 0183 sentences,
      NMEA 2000 PGNs, the Expedition protocol). A row decoded and fixture-tested becomes
      Partial, with the device check named. *Accept:* each changed row names its evidence.
- [ ] **23.1 onward:** the vendor links (B&G, Ockam, NKE, Garmin/Nexus FDX, Bravo, Cosworth,
      KVH), each tested against the protocol as documented. Radar comes last: it needs a
      radar and an unlock key to be worth anything.
