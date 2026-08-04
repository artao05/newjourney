# AIS, Fleet Tracking and Position Reporting

Two distinct needs, often confused:

1. **AIS** — collision awareness. Who is around me, and will we hit each other?
2. **Fleet tracking** — race awareness. Where are my competitors, and am I gaining?

Expedition does both. AIS via a hardware receiver (plus `aisstream.io`), fleet tracking
via scheduled position reports (Volvo/Ocean Race format, YB Tracking, Vessel Finder).

---

## 1. AIS sources

| Source | Access | Cost | Notes |
|---|---|---|---|
| **aisstream.io** | WebSocket, JSON, API key | Free tier | Bounding-box subscriptions; the same service Expedition integrates. **Best free option.** |
| **AISHub** | Reciprocal — you must feed data to get data | Free if you contribute | Requires running a receiver |
| **MarineTraffic / VesselFinder / Spire** | REST | Paid | Commercial API pricing is significant |
| **Norwegian Coastal Administration (Kystverket)** | Open AIS feed | Free | Norway only, genuinely open |
| **Danish Maritime Authority** | Open AIS | Free | Denmark/Baltic |
| **Local receiver via Signal K** | NMEA 0183 `!AIVDM` / NMEA 2000 | Hardware cost | The only source that works offshore with no internet |

**Reality check for our target user.** Terrestrial AIS aggregation covers coastal waters
where receivers exist. Satellite AIS is expensive. And a phone-based app has no AIS
receiver. So:

- **Do not position AIS as a safety feature.** Anything that suggests "you can see all
  the traffic" when you cannot is worse than not shipping it.
- Ship AIS as *situational context* in coastal waters with connectivity, clearly labelled
  as internet-sourced and possibly stale.
- Where a Signal K server is connected, use the boat's own receiver — that data is real,
  local and current.

**CPA/TCPA math** (worth implementing regardless of source):

```
relative position  r = p_target − p_own
relative velocity  v = v_target − v_own
TCPA = − (r · v) / |v|²          (seconds; negative ⇒ already past CPA)
CPA  = | r + v · TCPA |
```

Alarm when `CPA < threshold` and `0 < TCPA < horizon`. Expedition has exactly this, with
a pop-up on zone entry.

---

## 2. Fleet / race tracking

| Source | Format | Notes |
|---|---|---|
| **YB Tracking** (<https://yb.tl>) | Per-race JSON/binary feeds | Used by most major offshore races. Expedition has a dedicated importer and can email YB for boat IDs. Terms are per-race; scraping is not appropriate — ask organisers. |
| **Race organiser feeds** | Varies | Ocean Race / Volvo publish structured position reports; Expedition parses `*_FIRST_POSREPORT.txt`-style files with class, day-of-week, positions in degrees and decimal minutes, optional UTC field |
| **RaceQs, Kattack, TracTrac, SAP Sailing Analytics** | APIs vary | Club and event level |
| **Our own** | Our app | See below |

### The obvious opportunity

If the app is a phone app with GPS and connectivity, **it is already a tracker**. A
"share my position with my team / my fleet" toggle gives us:

- Live competitor positions at club level with zero hardware (currently a paid product)
- Post-race debrief tracks for everybody in the fleet
- `Ahead of` computed VMG-wise, exactly as Expedition defines it: *"Distance boat zero is
  ahead of boat n vmg-wise"* — i.e. projected onto the axis toward the next mark, not
  straight-line distance
- The data flywheel for track-derived polars (see [polars.md §2.6](polars.md#26-learn-the-polar-from-the-users-own-tracks--the-endgame))

**Privacy is not optional here.** Position sharing is opt-in, per-session, scoped to a
named group, with a visible indicator while active and an obvious off switch. Location
history is among the most sensitive data a phone holds. Default off, expire by default,
and never share by default with anyone outside a group the user explicitly joined.

### Race-tracking derived numbers (from Expedition)

Worth copying because they are cheap and tactically meaningful:

- `Ahead of` — VMG-wise gain/loss vs. each competitor
- `Boat range/bearing from boat 0`
- Interpolation of scheduled reports to "now" (Expedition explicitly interpolates
  positions from reports to the current time)
- **Reverse-isochrone comparison** — because a reverse isochrone is a line of equal
  remaining time, plotting the fleet against it tells you who is *actually* winning,
  which is often not who is furthest along the rhumb line. This is Expedition's most
  elegant tactical idea and it costs us nothing extra once the router computes the
  backward pass.
- `Shadow` / `Shadow opposite gybe` — bearing of a competitor's wind shadow, and where it
  would be on the other gybe

---

## 3. What we should build, in order

1. **v1** — own-boat tracking + track recording + post-race replay. No dependencies, and
   it feeds polar learning.
2. **v1.x** — opt-in group position sharing ("crew/fleet mode") over WebSocket.
3. **v2** — AIS via aisstream.io in coastal waters, clearly labelled, with CPA/TCPA.
4. **v2** — Signal K ingest, which gives real onboard AIS to anyone with a receiver.
5. **Later** — importers for YB and event feeds, with organiser permission.
