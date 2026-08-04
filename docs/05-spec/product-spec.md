# Product Specification

**Status:** draft v0.1 · research phase · nothing built yet

---

## 1. The premise

Sailing's best tactical software costs €1,250, runs only on Windows, needs 16 GB of RAM,
expects a nav station wired to marine instruments, and takes a season to learn. It is
excellent, and it is unavailable to almost every sailor on earth.

Meanwhile the raw ingredients are now free: ECMWF opened its entire real-time catalogue
under CC-BY-4.0, NOAA gives away ENC charts and tide data, GEBCO gives away bathymetry,
OSM gives away the coastline — and every sailor carries a GPS-equipped computer in a
waterproof pouch around their neck.

**The gap is not data and it is not algorithms. It is packaging.**

---

## 2. Who this is for

### Primary: the club and junior racer

A 16-year-old sailing a 420 at a club programme. A college team. A Wednesday-night PHRF
crew. They:

- Own a phone. Own no instruments beyond a compass, maybe.
- Have never seen a polar file and shouldn't have to.
- Lose races at the start and on the first beat, repeatedly, for reasons nobody explains.
- Would never spend €1,250, and shouldn't have to.

**What they need, in order:** a start line that works, laylines they can trust, and an
honest debrief.

### Secondary: the coastal-distance amateur

Newport–Bermuda, Fastnet, Chicago–Mac, Sydney–Hobart amateur divisions, ARC crossings.
They:

- Might have a laptop, might have instruments, might have a satellite phone.
- Need real weather routing, offline capability, and a reason to trust the answer.
- Currently choose between free-and-limited (OpenCPN) and expensive-and-professional.

### Explicit non-goal: the professional navigator

The Volvo/IMOCA/AC navigator will keep Expedition, and should. We are not competing for
that user, and designing for them is exactly how this project would fail — it's how you
end up with 40 routing settings.

---

## 3. Product principles

1. **The first useful answer arrives in under 60 seconds, with zero setup.** No account,
   no polar file, no instrument pairing. Pick your boat class from a list, and go.
2. **Never show a number without being able to explain it.** Long-press any value → what
   it means, what it's computed from, how much to trust it.
3. **Show uncertainty, always.** A route is a band, not a line. Anything else is a lie
   that a beginner cannot detect.
4. **Progressive disclosure, not settings pages.** Three presets where Expedition has
   forty checkboxes. The forty exist, behind an "advanced" drawer, for the people who
   want them.
5. **Offline is the default assumption.** You are on the water. There is no signal.
   Everything critical must already be on the device.
6. **One-handed, wet-handed, in bright sun, while the boat is moving.** That's the design
   constraint on every screen. Large targets, high contrast, no typing.
7. **The app gets better the more you sail.** Track-derived polars, learned acceleration
   tables, personal performance history.
8. **Be honest about what this isn't.** Not ECDIS. Not a substitute for official charts,
   tide tables, or judgment.

---

## 4. Feature scope by tier

### Tier 0 — "Start line" (the beachhead)

Ships first. Complete and useful on its own. Requires: phone GPS only.

- Ping committee boat and pin to set the line
- Distance below/above line (bow-corrected), in boat lengths
- Time to gun, with sync-to-signal
- Time to line (GPS-based)
- **Time to burn**, as a graphic bar
- Line bias: favoured end + advantage in boat lengths
- Simple graphical start display: line, boat, COG, laylines from both ends
- Auto-hide the clutter one minute after the gun
- Track recording

**Why start here:** it's the highest-value thing a phone can do for a junior sailor, it
needs no weather data, no polar, no charts, and no backend, and dedicated hardware
selling for $400–900 does little more.

### Tier 1 — "Race" (tactical)

- Windward/leeward course builder (axis, distances, gate)
- Laylines to marks and gates, with layline bounds under oscillating breeze
- Time and distance to each layline on each tack
- Split of the beat between port and starboard
- **What-if?** wind shift and current — drag a slider, watch the laylines move
- VMG / target boat speed / target TWA against a class polar
- VMC and VMC-optimum heading
- Wind history: TWD trend, oscillation period, shift alarms
- Post-race replay and debrief
- Handicap corrected time (PHRF/ORC/IRC time-on-time and time-on-distance)

### Tier 2 — "Route" (weather routing)

- Chart display (NOAA ENC where available, OpenSeaMap elsewhere) + wind overlay
- Weather from ECMWF/GFS with model selection and disagreement display
- **Isochrone routing** with obstacle avoidance
- **Route confidence band** from the backward pass — the headline feature
- Per-leg results table: time, position, TWD/TWS/TWA, boat speed, recommended sail
- Departure-time optimisation ("leave at 06:00 instead and save 4 hours")
- Tides and currents, with source and resolution shown
- Offline venue packs

### Tier 3 — "Fleet & learn"

- Opt-in position sharing with a crew or fleet
- Competitor tracking, `Ahead of` computed VMG-wise
- Fleet position plotted against the reverse isochrone ("who is actually winning")
- **Polar learning from your own tracks**
- Coach dashboard, multi-boat debrief
- Signal K instrument ingest
- AIS in coastal waters, clearly labelled

---

## 5. What we deliberately will not build

| Not building | Why |
|---|---|
| Proprietary instrument protocols (B&G, Ockam, NKE, …) | Signal K exists. 25 protocols is a career, not a feature. |
| Radar integration | Hardware-bound, and irrelevant to our user |
| S-63 encrypted charts | Structurally incompatible with an open web app |
| Sail-shape / VSPARS analysis | Requires mast cameras |
| America's Cup race management | Wrong user by three orders of magnitude |
| Full ECDIS compliance | Regulatory, expensive, and not what a 420 needs |
| Satellite comms management | Our answer is small payloads, not modem control |
| A settings page with 400 channels | The point of this project is the opposite |

---

## 6. Success criteria

**MVP (Tier 0 + parts of Tier 1) is successful if:**

- A sailor who has never used the app can set a start line and get a useful time-to-burn
  within 2 minutes of opening it, without instructions.
- It works with the phone in a pouch, in the rain, in sunlight, one-handed.
- A junior sailing coach voluntarily tells another coach about it.

**v1 (through Tier 2) is successful if:**

- Someone chooses it over PredictWind for a coastal race and doesn't regret it.
- Routes agree with qtVlm/OpenCPN within a few percent on the same inputs.
- A full regatta weekend works with no connectivity.

**The long-term test:** a sailor who has used it for a season understands *why* they win
and lose races better than they did before. That's the actual product.

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Polar acquisition** — users don't have polars and won't get them | **High** | Class-default polars + parametric generation + track-learned polars. Never block on a polar file. |
| **Safety liability** — someone follows a route onto a rock | **High** | Not-for-navigation notices in-app, hard depth constraints, conservative defaults, confidence bands rather than a single line |
| Phone GPS accuracy at the start line (~3–5 m) | Medium | Honest error display; a 5 m error on a 100 m line is real and must be shown, not hidden. Consider RTK/BLE GPS later. |
| No wind instrument → TWD is a guess | Medium | Estimate from forecast + a sail-by calibration workflow; make manual entry trivial; show the assumption prominently |
| Battery and screen-on time | Medium | Aggressive efficiency, dark mode, low-refresh mode, wake-lock only when needed |
| Data source terms change | Medium | Provider abstraction; never depend on a single source |
| ODbL / ORC licensing | Medium | See [../02-data-sources/licensing-matrix.md](../02-data-sources/licensing-matrix.md) |
| Scope creep toward Expedition parity | **High** | This document. Re-read §5 quarterly. |
| Nobody uses it | High | Ship Tier 0 to one junior programme and watch. Don't build Tier 2 until Tier 0 is loved. |

---

## 8. Open questions

1. **Native app or PWA?** PWA gets us cross-platform, instant updates, and no app store.
   Native gets background GPS, better sensor access, and App Store discovery. Current
   lean: PWA first, wrap with Capacitor when background tracking becomes essential.
2. **How much routing runs on-device vs. server?** On-device is free, private, and works
   offline. Server is faster and can do ensembles. Lean: on-device by default, server as
   an optional accelerator.
3. **Do we need accounts at all in v1?** Probably not until fleet sharing. Local storage
   and an export/import code go a long way.
4. **Which venue and which programme do we pilot with?** This should be decided by
   talking to a specific coach, not by design.
5. **ORC data terms** — needs an actual answer before any bulk polar feature.
