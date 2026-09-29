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
- [ ] **5.6 Start display extras:** the top-corner time with its time to burn. *Accept:* canvas tests.
- [x] **5.7a Gun distance and stern below the line** (from 5.7): both start channels, from the bow dead-reckoned to the gun and the stern one hull length back. *Done.*
- [x] **5.7b Speed to the ends, start targets and the simple times** (from 5.7). *Done.*
- [x] **5.7c Speed on each tack** (from 5.7), bearing away when over the line early. *Done.*
- [x] **5.7d The reach channels** (from 5.7): distance, time and speed to the line on the present heading. *Done.*
- [ ] **5.7 The remaining start channels:** time to layline P and S, the pinch times,
      boat to pin, and gun speed as % of target.
      *Accept:* start-math tests.
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
- [ ] **6.10 Output to instruments.** `blocked: D3`.

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
- [ ] **9.7 Wave correction**, with swell priority, coefficients and crossed sea, and
      **air-density correction**. These need swell and wind-sea as separate layers, and
      pressure and temperature, which the field does not carry yet (M10). *Accept:* kernel tests.
- [x] **9.8 Route to and via the pointer.** *Accept:* tests.
- [x] **9.9 Grid algorithm**, with an optional great-circle track. *Accept:* analytic
      tests, and agreement with the isochrone solver on open water.
- [x] **9.9b The grid in the app:** choose it in Route SETTINGS and run it in the worker. *Accept:* a screen test.
- [ ] **9.10 Globally optimal multi-mark routing.** *Accept:* a test where leg-by-leg
      routing loses.
- [ ] **9.11 Ensemble routing.** *Accept:* tests.
- [ ] **9.12 Fleet routing:** every boat with its own polar (after 13.4). *Accept:*
      tests.
- [ ] **9.13 World land avoidance** from a tiled OSM land pack. *Accept:* a route
      outside Portland goes round land.
- [x] **9.14 Asymmetric port and starboard polars**, moved here from 4.5 because it
      needs a second set of target tables in the hot loop. *Accept:* the kernel uses
- [ ] **9.14b A port polar in the app:** import it in Setup, keep it, and pass it through the worker. *Accept:* store and worker tests.
      the right side on each tack, with a test.

## M10 — Weather

- [ ] **10.1 GRIB2 decoder** in a worker, starting with simple and complex packing
      with spatial differencing, which covers GFS. *Accept:* fixture tests on a real
      GFS subset.
- [ ] **10.2 GRIB2 JPEG 2000 and PNG packing**, then **GRIB1**. *Accept:* fixture
      tests.
- [ ] **10.3 Open GRIB files** by picker or drag-drop, several at once, with a
      parameter catalogue. *Accept:* tests and a browser check.
- [ ] **10.4 Merge sources** in production: StackedField, best resolution first, per
      parameter. *Accept:* tests.
- [ ] **10.5 Pick the model for routing.** *Accept:* a test that the request uses the
      chosen model.
- [ ] **10.6 Display parity:** a display mode per parameter, contours with step and a
      bold level, Beaufort and other colour modes, isobars, gust, rain, waves, SST and
      air temperature. *Accept:* tests and a browser check.
- [ ] **10.7 Meteogram** at the boat or any point, and a time step setting. *Accept:*
      tests.
- [ ] **10.8 Observations:** NDBC, METAR and NOS PORTS on the chart, with history.
      *Accept:* parser tests.
- [ ] **10.9 Radar, satellite and weather-chart overlays.** *Accept:* a browser check.
- [ ] **10.10 Ensemble display:** members, and mean ± SD. *Accept:* tests.
- [ ] **10.11 A GRIB request builder:** area on the chart, model, parameters and
      times, with a Saildocs `mailto:` and a size estimate. *Accept:* tests.
- [ ] **10.12 NOMADS and ECMWF open-data download.** `blocked: D1`, which needs the
      proxy.

## M11 — Tides and currents

- [ ] **11.1 Harmonic tide engine** from NOAA constituents. *Accept:* agreement with
      NOAA predictions to within a stated tolerance.
- [ ] **11.2 Tide stations:** nearest-station lookup, an offline constituent pack, the
      tide curve, and tide channels. *Accept:* tests.
- [ ] **11.3 Harmonic tidal currents** and tidal diamonds on the chart. *Accept:*
      tests.
- [ ] **11.4 Tidal streams in routing**, taking precedence over forecast current.
      *Accept:* kernel tests.
- [ ] **11.5 Position-aware magnetic variation** (WMM). *Accept:* tests against NOAA
      calculator values.

## M12 — AIS, boats and race tracking

- [ ] **12.1 AIS decoder:** AIVDM/AIVDO types 1–5, 9, 14, 18, 19, 21, 24 and 27, with
      multipart messages. *Accept:* fixture tests.
- [ ] **12.2 AIS targets:** list, chart symbols, CPA/TCPA, filters, alarms (the CPA alarm from 8.2), and
      SART/MOB/EPIRB alerts. *Accept:* tests.
- [ ] **12.3 aisstream.io source.** It needs a free key (needs §2). *Accept:* a test
      against a recorded stream.
- [ ] **12.4 Boats database:** several boats, each with a polar, colour and size.
      *Accept:* tests.
- [ ] **12.5 Race-tracking import:** native, Basic, Volvo, MaxSea, GPX, YB XML and
      Vessel Finder formats, plus boat-id maps. *Accept:* parser tests.
- [ ] **12.6 Tracking window:** positions interpolated to now, range and bearing,
      Ahead-of, and a leaderboard. *Accept:* tests.
- [ ] **12.7 Wind shadow channels** (from 5.10): Shadow and Shadow opposite gybe, from
      the tracked or AIS boats and the wind. *Accept:* geometry tests.

## M13 — Charts

- [ ] **13.1 ISO 8211 reader.** *Accept:* it parses a NOAA ENC cell fixture.
- [ ] **13.2 S-57 decoder** to features in a worker. *Accept:* feature counts match
      GDAL's on the same cell.
- [ ] **13.3 S-52-style display:** depth areas, contours, soundings, land, lights,
      buoys, beacons and hazards. *Accept:* a browser check against NOAA's own
      rendering.
- [ ] **13.4 Display categories and safety settings:** base, standard and all;
      safety, shallow and deep contours; two-colour shading; night palette; simplified
      or paper symbols. *Accept:* tests.
- [ ] **13.5 Chart installer:** load `.000` files or a folder, a cell catalogue and
      bounds. *Accept:* tests.
- [ ] **13.6 Chart object query.** *Accept:* tests.
- [ ] **13.7 Orientation modes:** north-up, course-up and head-up, with follow-boat.
      *Accept:* a browser check.
- [ ] **13.8 BSB/KAP raster charts.** *Accept:* it decodes a NOAA RNC fixture.
- [ ] **13.9 Georeferenced custom images, and GPS chart offset.** *Accept:* tests.
- [ ] **13.10 Safe route check and safety-depth routing** against ENC. *Accept:*
      kernel tests.

## M14 — Integration and the rest of the shell

- [ ] **14.1 A documented JSON/WebSocket API** for channels out. *Accept:* tests.
- [ ] **14.2 Sharing between devices:** marks, routes and the start line. `blocked:
      D1`.
- [ ] **14.3 Save the display as an image, print, and a night palette** for the whole
      UI. *Accept:* a browser check.
- [ ] **14.4 Self-hosted basemap and glyphs.** `blocked: D1`.
