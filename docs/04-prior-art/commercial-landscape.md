# Commercial Landscape

Where the money and the users are, and which gap we're aiming at.

> Prices are indicative and change. Only Expedition's (€1,250 / €275 upgrade) has been
> verified against the vendor's own sales page as of this writing; treat the rest as
> approximate and re-check before quoting them anywhere public.

---

## 1. The professional tactical tier — €1,000+, Windows, nav station

| Product | Notes |
|---|---|
| **Expedition** (Tasman Bay Navigation Systems, NZ) | €1,250. The benchmark. See [../01-expedition-analysis/](../01-expedition-analysis/). Windows 10/11, 16 GB RAM. Volvo Ocean Race / America's Cup heritage. |
| **Deckman for Windows** (B&G) | The old guard; still used at the top level. Widely described as extremely powerful with a dated UI. |
| **Adrena** (France) | The main European competitor. Strong in French offshore racing (Figaro, Vendée). Several tiers. |
| **TimeZero Professional** (MaxSea lineage) | More navigation-and-fishing than racing tactics. |
| **B&G H5000 / WTP3 onboard processors** | Not software you buy — hardware you install. Thousands of euros plus instruments. |

**Shared characteristics:** Windows-only; assume a nav station and a dedicated PC; assume
NMEA-connected instruments; assume paid GRIB subscriptions and often satcom; assume a
trained navigator; steep learning curve measured in seasons.

**Who actually buys them:** professional and semi-professional offshore programmes,
grand-prix inshore teams, well-funded club boats with a dedicated navigator.

---

## 2. The prosumer weather tier — $50–500/year, mobile + desktop

| Product | Positioning |
|---|---|
| **PredictWind** | The strongest in this tier for offshore. Proprietary PWG/PWE models, routing from your polar, departure planning, Iridium GO integration, offshore app. Professional tier around US$499/yr; cheaper tiers below. |
| **LuckGrib** | Beautiful, focused GRIB viewer + router. macOS/iOS. One-time or subscription. Excellent model catalogue including RTOFS and CMEMS. |
| **Windy.com / Windy.app** | Best-in-class visualisation, huge free tier, weak on decision support. Windy is "a data tool rather than a decision tool." |
| **Squid (Great Circle)** | GRIB delivery + routing, popular in France; integrates with Expedition. |
| **Saildocs** | Free-ish email GRIB delivery. Ancient, beloved, still the offshore backbone. |
| **Weather4D, Weather Routing Inc, Commanders' Weather** | Routing services and human routers |

**Gap:** all of these are *weather* products. None does buoy racing, start lines, or
laylines.

---

## 3. The cruising navigation tier — $50–200/year, mobile-first

| Product | Positioning |
|---|---|
| **Navionics (Garmin)** | The default chart app. Enormous install base. |
| **Savvy Navvy** | "Google Maps for boats." Tiers roughly £59–£99/yr. Auto-routing, weather, charts. Explicitly cruising-focused. |
| **Aqua Map, Aquamaps, iSailor, TZ iBoat, SEAiq** | Chart plotters for phones/tablets |
| **Wavve Boating** | US-focused, social/cruising |

**Gap:** all cruising. Routing here means "avoid the shallows," not "which side of the
course."

---

## 4. The racing-tools tier — the sparse one

| Product | Positioning |
|---|---|
| **RaceQs** | Free/cheap 3-D race replay from phone GPS. Great debrief, no live tactics. |
| **Sailmon Max / Bravo** | Hardware + app. Live performance, replay, coaching. Hundreds to thousands of euros. |
| **Vakaros Atlas** | Premium racing instrument (~$1,000+) with line/start functions. Hardware-led. |
| **Racegeek D10 / Velocitek ProStart / Prizm** | Dedicated start-line and compass devices, ~$400–900. Solve *one* problem very well. |
| **SailRacer, Sail Racer Pro, Regatta apps** | Mostly event management and tracking |
| **B&G SailSteer / Zeus plotters** | Laylines and start line built into a chartplotter you already paid for |

**This is where the opening is.** Velocitek and Racegeek prove that sailors will pay
hundreds of dollars for a device that *only* does the start line — the same numbers a
phone can compute for free. Vakaros proves there's a premium market. Nobody is serving the
bottom of that market with software.

---

## 5. Market map

```
                   RACING TACTICS
                         ▲
                         │
      Expedition ●       │       ● Vakaros
      Deckman ●          │       ● Racegeek / Velocitek
      Adrena ●           │       ● Sailmon
                         │
                         │   ◆ ← us
                         │
  ───────────────────────┼───────────────────────►
   EXPENSIVE /           │            CHEAP /
   HIGH BARRIER          │            LOW BARRIER
                         │
      PredictWind ●      │       ● Windy (free tier)
      LuckGrib ●         │       ● RaceQs
      Savvy Navvy ●      │       ● Navionics (cheap tier)
                         │
                         ▼
                  CRUISING / WEATHER
```

The lower-right quadrant — cheap *and* racing-focused — is close to empty, and it is
where the largest number of sailors are: junior programmes, high-school and college
teams, club fleets, and the enormous population of people who own a boat and race it
casually.

---

## 6. Who we're for, precisely

| Segment | Size | Current spend | What they need |
|---|---|---|---|
| **Junior / youth sailors** (Opti, 420, Laser, 29er) | Very large | ~€0 | Start line, laylines, "why did I lose that beat?" |
| **High school & college teams** | Large | ~€0, coach-funded | Start line, debrief, coaching tools |
| **Club racers** (PHRF/IRC/ORC weeknights) | Very large | €0–200 | Start line, laylines, simple routing, handicap corrected time |
| **Coastal / distance amateurs** (Newport–Bermuda, Fastnet corinthian, Chicago–Mac) | Medium | €200–1,500 | Real weather routing, offline, confidence bands |
| **Cruisers who race occasionally** | Large | €50–200 | Routing + charts, low friction |
| **Professional navigators** | Tiny | €1,250+ | Not us. They'll keep Expedition, and they should. |

**We are not trying to beat Expedition for its own users.** We're trying to serve the
99 % of sailors for whom Expedition was never an option.

---

## 7. Positioning statement

> **The tactical tools professional navigators use, on the phone in your pocket, for free
> — and it explains itself.**

Three defensible differentiators, in order of strength:

1. **Free and phone-native.** Structurally impossible for the incumbents to match without
   destroying their own pricing.
2. **Teaches, doesn't just tell.** Every number can explain itself; every route shows its
   confidence band. Nobody in this market does this. It's also the honest response to the
   fact that a route is a forecast-derived guess.
3. **Learns your boat.** Polars from your own GPS tracks means a user with no certificate,
   no instruments and no data gets progressively better answers just by sailing.

---

## 8. Business model options (for later)

Not an MVP concern, but worth writing down so the architecture doesn't foreclose them:

| Model | Notes |
|---|---|
| **Free core, paid pro tier** | Higher-res models, ensembles, longer forecasts, fleet sharing, unlimited offline venues |
| **Team / club licence** | Coach dashboards, fleet tracking, multi-boat debrief — this is where schools and clubs have actual budget |
| **Hardware partnership** | A cheap BLE wind/compass puck, or integration with existing ones |
| **Regatta / event tier** | Organiser tools, course publishing, spectator tracking |
| **Donations / grants** | Youth sailing development is a fundable cause |

The architectural implication is small but real: keep account, sync, and entitlement
concerns behind a clean boundary from day one, and keep the routing engine independently
runnable client-side so a free tier never costs us server time.
