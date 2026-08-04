# Start Line Mathematics

The most under-served, highest-value feature for our target user. A junior sailor gets
maybe 40 starts a season; each one is decided in the last 30 seconds by numbers a phone
can compute perfectly and a human cannot estimate at all.

Expedition has a complete, sophisticated implementation of this — it is arguably the
strongest part of the product — and every input it needs is available from a phone GPS
plus a wind estimate.

---

## 1. Setup

The line is defined by two points, conventionally:
- **Starboard end / committee boat** — `S`
- **Port end / pin** — `P`

Both are set by "pinging": sail to the mark and record the position. Expedition applies a
**bow-to-GPS offset** so the mark is recorded at the bow, not the antenna — configurable,
because on a 40-footer that's 10+ metres and the line is only 100 m long.

Work in a **local flat projection** centred on the line (see
[navigation-math.md §2](navigation-math.md#2-geodesy)). Great-circle math here is pure
overhead and can cost precision.

```
line_vector    = S − P
line_bearing   = atan2(line_vector.x, line_vector.y)      # P → S
line_length    = |line_vector|
line_normal    = perpendicular to line_vector, pointing up-course
```

---

## 2. Line bias

**Square wind** — the TWD that would make the line perpendicular to the wind:
```
line_square_wind = wrap360(line_bearing − 90°)         # sign depends on end ordering
```
Expedition exposes this directly as `Start line square wind`.

**Bias angle:**
```
bias_angle = angdiff(TWD, line_square_wind)
```
Sign convention from the manual: **negative = port end favoured, positive = starboard end
favoured**. Number boxes show a `P` next to a port-favoured value.

**Bias length** — how much distance the favoured end is worth:
```
bias_length = line_length · sin(|bias_angle|)
```
This is the number that actually matters, because a 5° bias on a 100 m line is 8.7 m —
one boat length — while 5° on a 1 km start line is 87 m, which is the whole race.

Presenting bias as *metres* or *boat lengths* rather than degrees is a small UX decision
with a large effect on whether a 16-year-old can act on it.

---

## 3. Distance to the line

```
distance_below_line = signed perpendicular distance from the boat to the infinite line
                      through P and S, positive on the pre-start side
```

Expedition's definition, verbatim: *"The minimum of the bow and GPS position below the
line. This will be negative if over the line. Essentially the XTE from the line."*

Two refinements that matter:
- Use the **bow**, projected from the GPS along the heading by the bow-to-GPS distance.
  The bow is what triggers OCS.
- `Start stern below line` exists too — for a boat sitting head-to-wind on the line,
  knowing where the stern is matters when you're about to accelerate.

Note the definition uses the **infinite line**, not the segment. That's correct: you can
be over early past the end of the line and it's still over early relative to the extension
in most racing rules contexts, and the number stays continuous.

---

## 4. Time to the line — the hard part

Naïve: `time = distance / SOG`. Wrong in every interesting case, because between here and
the line you will turn, accelerate, and possibly tack.

Expedition computes **many candidate approaches** and takes the minimum over the ones the
user has enabled:

| Approach | What it models |
|---|---|
| Time to port end / starboard end | Reaching to a specific end |
| GPS time to line | Straight-line from current COG/SOG — no polar, no dynamics |
| Reaching time to line | Sail the current heading at start-polar speed until you cross |
| Times on port / on starboard | Sail to a layline, tack, and approach close-hauled — including the tack |
| Pinch times | Sail above (or below) target angles |
| With left turn / with right turn | Which way you turn changes the time |

Each candidate is a small dynamics problem:

```
time_to_line(approach):
    t ← 0 ;  p ← bow_position ;  v ← current_bsp ;  θ ← current_heading

    for each phase in approach:                  # e.g. turn → accelerate → sail → tack → sail
        if phase is a turn of Δθ:
            rot ← rate_of_turn_table(v)          # °/s as a function of boat speed
            t   += |Δθ| / rot
            p   += arc travelled during the turn
            v   ×= turn_speed_loss(Δθ)

        if phase is straight:
            # integrate acceleration toward the target speed for this TWA
            v_target ← start_polar(tws, twa)
            a        ← acceleration_table(tws, twa)      # knots per minute
            integrate p, v forward until the line is crossed

    return t
```

**Three calibration tables** drive this, all documented in Expedition:

| Table | Units | Function of |
|---|---|---|
| Rate of turn | °/s | boat speed |
| Acceleration | kn/min | TWS and TWA |
| Braking | seconds to stop | rate of turn |

Expedition: *"Rate of turn and acceleration are always on, else the time to the line
functions can not work."*

**Our approach:** ship class-default tables (a 420 accelerates very differently from a
J/105 or a 40-foot cruiser-racer), let advanced users tune them, and — best of all —
**learn them from the user's own recorded starts**. Every logged pre-start contains turns
and accelerations; fitting `rot(v)` and `a(tws, twa)` from that data is straightforward and
removes the last reason a sailor would have to calibrate anything by hand.

---

## 5. Time to burn

The single most useful number in the pre-start:

```
time_to_burn = time_to_line − time_to_gun
```

| Value | Meaning | What to do |
|---|---|---|
| > 0 | You'll arrive early | Burn time: luff, reach away, slow down |
| ≈ 0 | Perfect | Hold it |
| < 0 | You'll be late | Bear away, build speed, or you're already losing |

Expedition draws this as a **graphic bar** on the left of the start display, and it's the
right call — a bar you glance at beats a number you read when you're also watching three
boats to leeward.

Variants worth having:
- `Start GPS time to burn` — a no-polar fallback, always available
- `Start strb/port end time to burn, X secs` — time to burn if you tack onto a point X
  seconds from the line on the starboard layline. This is the pro move: it plans the
  final approach, not just the arrival.

---

## 6. The start display

Expedition's chart-less start screen is the model, and it's the screen we should build
first. From the manual:

- Line drawn horizontally, **port end left, starboard end right**
- Current heading as a thin blue line; GPS COG as a solid blue line
- Boat track (helps reposition ends if you sail around them)
- Laylines from each end of the line
- Time to each end, drawn at that end and at the top corner; time-to-burn to the corner
  immediately below
- **Bias line above the start line** indicating the favoured end; bias angle, bias length
  and line square wind at bottom right
- Held wind and current at the bottom
- **Turn circles** — "turns to beat (or run) to the line" as thin black lines
- Time to gun, time to burn, distance below line at top centre
- A **grid and range circles in boat lengths**
- Magnified line view when close to one end
- Most of it disappears **1 minute after the start** to reduce clutter

That last detail is a mark of a product designed by someone who has actually done this. The
display gets out of the way at exactly the moment you need to sail the boat.

**Our version should be simpler still.** A first pass needs: the line, your boat, distance
below line, time to gun, time to burn (as a bar), and which end is favoured (as an arrow
and a boat-length count). Six things. Everything else is progressive disclosure.

---

## 7. Holding wind and current

Pre-start, the wind instrument is noisy — you're turning constantly, the boat is
accelerating and decelerating, and the masthead is swinging. So Expedition lets you
**hold** TWD/TWS and set/drift at a value measured in a clean moment, plus apply extra
damping during the pre-start that reverts at the gun, plus optionally auto-release the
held values at the gun.

For a phone-only app with no wind instrument at all, this becomes even more important: our
wind comes from a forecast or from a manual entry, and the natural workflow is
"sail up the line once, we'll estimate the wind from your COG/SOG on each end, then hold
it." That's a nice, achievable feature that turns a limitation into a workflow.

**Estimating TWD from a line sail-by:** sail the line in both directions at a known boat
speed; the asymmetry in SOG gives you the wind component along the line, and combined with
the head-to-wind heading (which sailors find naturally when luffing) you get a usable TWD
without any instrument.

---

## 8. Gate and course-axis geometry

Expedition's `Create W/L course` takes: distance to windward mark, distance to leeward
mark (negative places it below the line), course axis in °M (with a "use current TWD"
button), leave-marks-to-port flag, gate width, separate finish mark, and whether the
leeward mark sits above the committee boat / mid-line / pin.

The **gate spot** is a genuinely clever derived value: the intersection of the laylines to
the two gate marks — the point from which both gates are equally reachable, and therefore
the decision point on the run.

```
gate_spot = intersect( layline_to_left_gate , layline_to_right_gate )
```

**Gate bias** works like line bias: which gate is favoured given the current wind, with
port/starboard sense taken from the previous mark.

---

## 9. What to build, in order

1. Ping two ends → draw the line → **distance below line**, **time to gun**
2. **Line bias** in boat lengths + favoured-end arrow
3. **Time to line** (GPS-based first — no polar needed)
4. **Time to burn** as a bar
5. Start polar + acceleration → proper time to line
6. Laylines from the ends
7. Turn circles and the full Expedition-style display
8. Learn ROT/acceleration from recorded starts

Steps 1–4 need nothing but a phone GPS and two taps. That is a complete, genuinely useful
product for a junior sailor, and it can ship before the router does.
