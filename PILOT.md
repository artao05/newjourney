# Pilot guide: newjourney on the water in Maine

This is a start-line tool for your phone. It shows which end of the line is favoured,
how far you are below the line, and whether you are early or late. It is a prototype
and **not for navigation**: nothing in it replaces your charts, the tide tables or your
own judgment. What we want from a pilot is to know whether it helps on a real start
line, and where it gets in the way.

This guide is for the site below, which is built from `main`. The `parity/expedition`
branch is not deployed, so nothing it adds is on the site. The last section lists what
differs if you run that branch yourself.

## 1. Install, at home on Wi-Fi (5 minutes)

1. Open **<https://artao05.github.io/newjourney/>** on your phone.
2. Add it to the home screen:
   - **iPhone (Safari):** tap Share, then **Add to Home Screen**.
   - **Android (Chrome):** open the ⋮ menu, then **Install app** or **Add to Home
     screen**.
3. Open it from the home-screen icon, the boat and sail. Accept the not-for-navigation
   notice, and allow location when asked.
4. In **Setup**:
   - Pick your class. This sets the boat length and the polar.
   - Check **bow to GPS**: the distance from your bow to where the phone will ride,
     for example about 3 m on a J/70.
5. Also in Setup, under **Wind**, choose **Magnetic north** if you will read the wind
   off a compass, and the app converts it for you. It uses one figure wherever you are:
   Portland's variation, 14.5° W (NOAA, September 2026), carried forward by its yearly
   change.

That first online visit stores everything the app needs to open without signal.

## 2. Dock check, before you leave (10 minutes)

- [ ] **Offline:** turn on airplane mode, close the app fully, and reopen it from the
      home screen. The Start tab should come up. Then turn airplane mode off.
- [ ] **Location:** the chip at the top left shows `GPS ±N m`, not "no fix" or
      "waiting". If location was refused on an iPhone, go to Settings → Privacy &
      Security → Location Services and allow it While Using.
- [ ] **Screen:** leave the app open and untouched for two minutes. If the Start tab
      says *"The screen may sleep"*, set auto-lock to Never for racing. On an iPhone
      that is Settings → Display & Brightness → Auto-Lock; on Android, Settings →
      Display → Screen timeout.
- [ ] **Sunlight:** read the Start tab at arm's length in direct sun, with brightness
      up.
- [ ] **Battery:** start at 100% and note the percentage at the end of the day.
- [ ] **Recording:** tap `rec` at the top right so it reads **REC**. It keeps recording
      if the app reloads.

These two are only on `parity/expedition`, not on the site above:

- [ ] **Sound:** on the Start tab tap **TIMER**, then **TEST SOUND**, and listen for the beep.
      Silent mode or low volume can mute it, and the app can't tell, so try it with the
      phone set the way you will race. If a countdown shows *"The countdown is silent"*, tap
      **TURN SOUND ON**.
- [ ] **Stored data:** in Setup → **Stored data**, note whether it says *Kept*. If it says
      anything else, export your track after each race.

## 3. On the water: the two-minute test

The app has done its job if a sailor who has never seen it can, **within two minutes
and without instructions**:

1. open the app,
2. pick their class,
3. ping both ends of the line,
4. understand which end is favoured and whether they are early.

Tips worth passing on:

- **Set the wind first.** Tap the wind chip at the top. To read it, luff head to wind
  and read your heading off the compass. While the chip says *set wind* in amber,
  there is no wind, so the favoured end shows a dash.
- **Ping with way on.** The app can only place the bow when it knows which way you are
  pointing, which on a phone needs about a knot. Slower than that, it records the
  phone's position and says so.
- **Ping each end.** Press **PING RC** at the committee boat and **PING PIN** at the
  pin. Start the timer with 5, 4, 3 or 1 **MIN**, and press **SYNC** on the signal to
  round it to the minute.
- **Mis-pinged an end?** Drag it on the start diagram rather than sailing back to
  ping it again.
- **Trust the number as far as the app says.** When the GPS fix is looser than half
  a boat length, the **BELOW LINE** tile turns amber and shows how many boat lengths
  it is good to.

## 4. What to send back

After racing, go to **Setup → EXPORT TRACK (GPX)**. Send that file, by email or
AirDrop, along with short answers to these:

- Did the favoured-end call match what you saw on the line?
- Did time-to-burn feel right: early when you were early, and late when you were late?
- How did you get the wind, and how long did it take?
- How did the phone hold up for battery, heat, sun and a wet pocket or pouch?
- Would you tell another sailor about it? What confused you?

Please include the date, where you sailed, your boat class, where the phone rode, and
the phone model.

## Limits to know

- **Not for navigation.** Every number is advisory.
- **Offline:** the app itself works offline after the first visit, but the chart
  tiles and the forecast need signal.
- **GPS:** a phone's fix is good to about 3–5 m. On a small boat that is most of a
  boat length, and the app shows it.
- **Portland's data:** the variation, the land mask and the depth layer are Portland's.
  The Start tab works anywhere, but the variation changes along the coast, from about
  14.2° W at Kittery to 15.6° W at Eastport (World Magnetic Model, November 2026), so check
  your chart.

## If you run `parity/expedition` instead

This branch is not on the site above. [RUNNING.md](RUNNING.md) says how to run it and what
in it is real. A sailor would notice these differences (checked 2026-11-05, and the layout check
again on 2026-11-11):

- **Variation** comes from the World Magnetic Model where the boat is, not from one Portland
  figure, so the coast check above does not apply. The land mask and the depth layer are
  still Portland's.
- **It looks different.** It opens in a black-on-white day palette (☀ in the top bar, ☾ for
  night), and there is a sixth tab, Strip.
- **It is heavier.** The Start tab needs about 113 KB of JS gzipped, against 100 KB on the
  site. All that the first visit stores comes to about 0.7 MB, against 0.5 MB, so that visit on
  Wi-Fi matters more.
- **It has two more dock checks,** Sound and Stored data, in section 2.
- **It has never been on a real phone.** Its layout check failed with a font like a phone's:
  some buttons came out smaller than it allows, and at 360 px the screen scrolled sideways a
  little. That was fixed on 2026-11-11, and the check now passes in that font on Windows, but
  not yet in CI. The check never loads a route, and section 2 has not been run on it.
- **It can read instruments** in Setup → Instruments. None of that has been tried on a boat.
