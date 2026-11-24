# NewJourney v2

A new interface for NewJourney: sailing navigation, course calculation and race
coaching, built to be friendlier to people new to the sport and better looking
than the original. It sits on the same tested engine as the main app (`../src/lib`:
polars, weather cubes, the isochrone router, the Signal K client), so it
doesn't fork the hard maths.

Not for navigation.

## Run it

```bash
npm install
npm run dev:v2          # http://localhost:5174
npm run test:v2         # simulator and coach tests
npm run typecheck:v2
npm run build:v2        # dist-v2/
```

### Turn on the AI coach

The coach calls Claude (`claude-opus-5-5`) from the dev or preview server, so
the key never reaches the browser. Create a key at
[console.anthropic.com](https://console.anthropic.com) (Settings → API keys) and put it in
`v2/.env.local`, which git ignores:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The running dev server picks it up without a restart; a key set in the shell's
environment works too and wins over the file. Only `ANTHROPIC_*` names are read from
the file, into the server alone (they have no `VITE_` prefix, so they never reach
the page). The API bills that key's Console account per use; a Claude.ai
subscription doesn't cover it.

Without a key, the app says so and uses its built-in, rule-based coach instead.
That coach works from the same analysis, so everything else still works.

## What's in it

| Top menu | What it does |
| --- | --- |
| **Plan** | Forecast overlay: colour for wind speed (white/green light → yellow/orange → red strong), arrows for direction, a time bar to scrub through the forecast. The overlay is pinned to the map, and a dashed line marks where the forecast ends; pan away from it and a forecast for the new area loads by itself (not during a race, when the map offers a button instead). Demo sea breeze offline, or **Live forecast here** from Open-Meteo. Leg-by-leg course plan (beat/reach/run, which tack first and why, time per leg). **Optimal route** from the isochrone router, accounting for tacking angles and boat speed, in one of three kinds: **Whole course** (from the favoured end of the start line at the gun, around every mark, to the finish, with the time to each mark; before a sequence, the gun is the time bar's time), **From here** (from the boat now around the marks still to go; during a race it recalculates every 2 minutes and at each mark) or **To one mark**. **Your boat sails this route** (on by default): on auto helm the simulated boat sails the yellow line, tacking and gybing where it does and, on the stretches the router drew as a straight zigzag stand-in, tacking in a lane around it; near each mark the usual rounding takes over, and the learner's mistakes are off while it follows. A whole-course route is recalculated for the real gun when a sequence starts. |
| **Course** | Add marks by clicking the map or typing coordinates (`43 35.1 N 70 9.6 W`, or decimal). Drag marks to move them. Start pin and committee boat, course order, finish. **Standard courses**, laid square to the wind in one tap with the beat length you pick: **W2** and **W4** (windward-leeward with an offset mark and a leeward gate, two or four beats, downwind finish), **Triangle** (beat, two reaches, then windward-leeward, upwind finish) and **Trapezoid** (outer loop with a leeward gate, reach to the finish). **Gates**: any course mark can become a gate (two marks, round either), and each gate is **Open** (sail between the marks, then round either) or **Closed** (no sailing between them: round the outside of one). The map draws an open gate green and dashed, a closed one red; the simulated boats sail both correctly, and sailing through a closed gate is logged as a foul. |
| **Race** | Start sequence: 10, 5 or 3 minutes, beeps on the minute and in the last 10 s, sync to the minute. Ping the line ends from the boat. Line length, favoured end and what it's worth. Fleet standings and AIS targets with CPA. |
| **Simulate** | Place the boat anywhere, pick a boat (J/70, dinghy, J/105, 40 ft cruiser-racer), then **Sail the course** or **Race the fleet**. A virtual skipper times the start, sails target angles, tacks on headers and laylines, and rounds the marks. Speeds 1× to 32×. Take the helm yourself (arrow keys, T to tack). |
| **Coach** | Automatic debrief when you finish: where time was lost (each finding shows its stretch of track on the map), tendencies, what went well, drills, clarifying questions whose answers are saved, and a chat. **What the app has learned**: the boat's real share of the polar per wind band, tack loss and recurring issues. The instruments then show learned targets. |

The **Start** picker sits in the top bar too, so a sequence is one tap from any screen.

**Race view.** When a sequence starts (or with the frame button in the top bar, or R),
the panels, tabs, colour key and time bar go away and only the instruments, race data
and start controls stay, in bigger type. At the finish the panels come back on the
coach's debrief. **Show panels** brings them back early. The sliders button on the
instruments chooses which data boxes show and in what order, separately for setting up
and for the race view, with presets (Beginner, Start, Upwind, Everything). The choice
is kept in this browser.

On the map: the boat with its track and a wind tick, laylines to the next mark
(green starboard, red port), the start line with its favoured end, the course,
the fleet with names, and OpenSeaMap seamarks.

While racing, the instruments and race display show boat speed against target,
TWA against target, TWS/TWD, heading, VMG, apparent wind and polar %. Before
the start, they show distance to the line in metres and boat lengths, time to
the line, time to burn and the favoured end. After it: distance and bearing to
the mark, time to layline, VMC and your place. Live coach tips ("Headed 6°:
the other tack is lifted") need no AI.

**Instruments (NMEA 2000).** Pick *NMEA 2000 (Signal K)* in the top bar and
point it at a Signal K server's stream (for example a Raspberry Pi with an
N2K gateway). The own boat then comes from the network and is logged for the
coach exactly like the simulator. *Phone GPS* gives position, COG and SOG only.

**The simulator's mistakes.** With *Learner crew* on (the default), the own
boat starts late, sails about 7° low for part of the first beat, sails on in a
header, overstands the first windward layline, tacks on every wiggle and pinches
on the second beat, sails high downwind, and tacks slowly. The coach's analysis
finds all of these from the instrument log alone. The tests check that, and
check that a clean race finds far less.

## Where things are

```
v2/
  server/coachApi.ts     Vite plugin: /api/coach/{status,debrief,chat} → Claude
  src/engine/            boats, demo forecast, course geometry, leg planner, the simulator (world.ts)
  src/coach/             analysis of the log, learning per boat, debrief rules, browser client
  src/map/               MapLibre view, wind overlay canvas, boat icons
  src/ui/                top bar, instruments, panels, coach
  src/state.ts           store, the sim loop, actions, N2K/GPS feeds
```

## Known gaps

- AIS from a real network isn't wired yet. The fleet is simulated, even with live instruments.
- The learned profile and the data-box choice are kept in this browser only (`localStorage`).
- No land avoidance in the router here yet. The main app has the venue land rasters.
- The route doesn't count the time a tack or gybe costs (the router's tack penalty is 0), so a boat sailing it finishes a few per cent after the route's time and may tack more than is worth it.
- The bundle is large (about 395 KB gzipped, mostly MapLibre). It isn't split yet.
