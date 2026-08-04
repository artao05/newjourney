# MVP Scope

The purpose of this document is to say **no** to things.

---

## The MVP in one sentence

> A web page a junior sailor opens on their phone at the start of a race that tells them
> which end of the line is favoured, how far below the line they are, and whether they're
> early or late.

That's it. No charts, no weather, no routing, no account.

---

## Why start there and not with routing

Routing is the interesting engineering problem and the wrong first product:

| | Start line | Routing |
|---|---|---|
| Data dependencies | None (phone GPS) | Weather ingest, charts, land polygons, polars |
| Backend required | None | Yes |
| Time to first useful output | ~2 taps | Setup, download, configure |
| Users who need it every single race | ~All racers | Distance racers only |
| Existing free alternatives | Essentially none | OpenCPN, qtVlm, Windy |
| Provable in one afternoon on the water | Yes | No |
| Can be wrong in a way that endangers someone | No | **Yes** |

That last row matters most. Shipping the start line first means our first users are
testing something that cannot hurt them while we build the thing that can.

---

## In scope for MVP

### Must have

- [ ] Set start line by pinging two ends (GPS, with bow offset)
- [ ] Manual line entry / adjustment by dragging on a simple plan view
- [ ] **Distance below line** in metres and boat lengths, bow-corrected, signed
- [ ] **Time to gun** — start a countdown, sync to a signal, 5/4/1/go presets
- [ ] **Time to line** from GPS COG/SOG
- [ ] **Time to burn** — number plus a graphic bar
- [ ] **Line bias** — favoured end, bias angle, advantage in boat lengths
- [ ] Wind input: manual dial, or auto from a forecast lookup if online
- [ ] Simple chartless start display: line, boat, COG vector, heading, distance grid in
      boat lengths
- [ ] Auto-declutter one minute after the gun
- [ ] Track recording during the session
- [ ] Works fully offline after first load (PWA + service worker)
- [ ] Wake lock so the screen stays on
- [ ] Boat setup: name, class, length, bow-to-GPS
- [ ] Not-for-navigation notice

### Should have

- [ ] Post-start replay of the last 5 minutes ("where was I at the gun?")
- [ ] GPS accuracy indicator with an honest warning when accuracy > half a boat length
- [ ] Ping-a-mark and store marks
- [ ] Laylines from the line ends (needs a polar or a class default tacking angle)
- [ ] Dark / high-contrast sunlight mode
- [ ] Metric/imperial, °T/°M toggles

### Explicitly out of MVP

Charts. Weather overlay. Routing. Isochrones. Tides. Currents. AIS. Fleet tracking.
Accounts. Cloud sync. Handicap calculation. Sail charts. Polar editing. Instrument
connectivity. Course builder. Anything with a settings page.

---

## MVP screens

There are three.

**1. Setup** — boat name, class (dropdown), length, bow-to-GPS. One screen, four fields,
sensible defaults, skippable.

**2. Start** — the main event.

```
┌───────────────────────────────┐
│  4:32          ⬤ GPS 3m       │   ← time to gun, GPS quality
│                               │
│      BURN  +18s               │   ← time to burn, large
│  ▓▓▓▓▓▓▓▓▓░░░░░░░             │   ← burn bar
│                               │
│  ─────────────────────────    │   ← the line
│           ▲                   │   ← your boat, with COG vector
│                               │
│  PIN ◀ 1.2 BL favoured        │   ← bias, in boat lengths
│  Below line: 3.4 BL           │
│                               │
│  [ PING PIN ]  [ PING BOAT ]  │
└───────────────────────────────┘
```

Everything above is derivable from a phone GPS and a wind direction. Nothing else on
screen.

**3. After** — track replay, where you crossed, how early/late you actually were.

---

## Definition of done

The MVP is done when a sailor who has never seen it can, in under two minutes and with no
instructions:

1. Open the link
2. Pick their class
3. Ping both ends of the line
4. Understand which end is favoured and whether they're early

...and when it survives a full day of racing on a phone in a pouch without crashing,
draining the battery, or needing a signal.

---

## What we learn from the MVP

Deliberately chosen questions the MVP answers cheaply, before we invest in Tier 2:

1. **Is phone GPS accurate enough at the start?** 3–5 m on a 100 m line is 3–5 % — probably
   fine. In practice, does it feel right to sailors? This is unknowable from a desk.
2. **Do sailors trust a number they can't verify?** If they don't trust time-to-burn, they
   won't trust a route either, and the whole project needs rethinking.
3. **Can we get wind direction without an instrument?** The workflows in
   [../03-algorithms/start-line-math.md §7](../03-algorithms/start-line-math.md#7-holding-wind-and-current)
   need testing on the water.
4. **Does the phone survive?** Battery, heat, sun readability, wet fingers, pouch.
5. **Does anyone tell anyone else about it?** The only distribution signal that matters.

---

## After the MVP

Ordered by value-per-effort, not by how interesting the engineering is:

1. **Laylines + what-if wind shift.** Highest tactical value per line of code. Needs only
   a polar and the wind we already have.
2. **Track replay and debrief.** Turns the app into a coaching tool and starts the polar
   data flywheel.
3. **Course builder + marks.** Makes it useful for the whole race, not just the start.
4. **Charts + weather overlay.** The first real infrastructure investment.
5. **Routing.** The headline feature — built last, on foundations that already have users.

Resist the temptation to invert this list. The routing engine is the fun part and the
part with the least evidence behind it.
