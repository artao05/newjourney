# Hardware and Connectivity: A Plain-English Brief

## The short version

Newjourney is designed to be useful with **only a phone**. That is the starting
point, not a cut-down demo. A phone knows where it is, how fast it is moving, and
which way it is travelling. That is enough for the start-line display, basic
laylines, manual wind, track recording, and downloaded weather.

Extra boat hardware does not make the app a different product. It makes the same
answers more accurate and adds answers a phone cannot honestly create by itself:
actual wind at the masthead, heading at low speed, speed through the water, depth,
and nearby AIS targets.

The intended architecture is deliberately simple:

```text
boat sensors and AIS
        │
        │  NMEA 2000 / NMEA 0183 (the boat's internal data wiring)
        ▼
Signal K gateway or onboard computer
        │
        │  boat Wi-Fi
        ▼
phone, tablet, or browser display running Newjourney

cellular / Starlink ──► weather, updates, optional sharing
```

The internet connection and the boat-instrument connection are separate jobs. A
Starlink terminal gives the boat internet; it does **not** read wind, GPS, depth,
or AIS by itself. Signal K reads the onboard data; it does **not** create an
internet connection.

## What works at each hardware level

| What the sailor has | What Newjourney can do well | What it cannot know reliably |
|---|---|---|
| **Phone only** | Position, course and speed over ground, start-line timing, manual wind, basic tactics, recorded track, downloaded forecast | True heading while nearly stopped, masthead wind, speed through water, depth, full AIS picture |
| **Phone + external GPS/GNSS receiver** | Better and usually faster position updates; a more dependable start-line position | Wind, depth, and boat-speed performance data |
| **Existing instrumented boat + Signal K bridge** | Uses the boat's GPS, compass, wind, depth, speed-through-water, and AIS data on the phone/tablet | Nothing magically appears: the boat must actually have those sensors and the bridge must be configured |
| **Instrumented boat + onboard display** | A shared, live tactical view on several phones/tablets; possible browser view on supported displays | A guarantee that every proprietary chartplotter can run a web app or accept custom overlays |
| **Above + cellular/Starlink** | Fresh weather, model updates, off-boat sync, fleet sharing, support and software updates | Better sensor accuracy or a replacement for local boat Wi-Fi |

## What the individual pieces mean

### Phone or tablet

This is the screen and the minimum viable sensor package. It has a GPS receiver,
a data connection when ashore, and its own battery. A modern phone is enough for a
dinghy or club racer. A larger, waterproof tablet is the more readable choice on a
keelboat.

The important limitation is heading. A phone compass is easily disturbed by metal,
speakers, a pocket, and the motion of a boat. When moving, the app should use the
GPS direction of travel instead. When almost stationary—as often happens before a
start—neither is ideal. The product must show that uncertainty rather than inventing
precision.

### GPS and the word “antenna”

Every GPS receiver has an antenna. With a phone-only setup it is the small antenna
inside the phone, so there is nothing to install. It is often good enough for club
racing, but its position can wander by several metres and it may update slowly.

An external **GNSS/GPS receiver** is a separate waterproof unit with a clearer view
of the sky. It can send location data by Bluetooth, Wi-Fi, NMEA 0183, or NMEA 2000.
It is the first optional upgrade for crews who care deeply about the start line. It
should be mounted where it can see the sky and its offset from the bow must be known.

Do not confuse the GPS antenna with a VHF/AIS antenna or a Starlink antenna. They
serve different radio systems.

### Wind, compass, speed, and depth instruments

These are usually already present on a larger racing or cruising boat:

- A **wind sensor** is normally at the masthead. It measures the wind the boat feels.
- A **compass/heading sensor** usually lives inside the boat and knows which way the
  hull points even at low speed.
- A **speed/depth transducer** is mounted through the hull. It reports speed through
  the water and water depth.
- The **GPS** reports speed and direction over the ground.

Comparing water speed and GPS speed lets the app estimate current. Combining wind,
boat speed, and heading makes polar and target-speed feedback much more meaningful.
These are valuable improvements, but they are not prerequisites for the first
Newjourney experience.

### NMEA: the boat's data wiring

NMEA 2000 is the common modern network inside a boat. Think of it as a shared data
cable: instruments and displays plug into one backbone. NMEA 0183 is the older,
usually point-to-point version. Both can carry position, wind, depth, heading, and
AIS messages.

Newjourney should **not** try to speak to every vendor's instruments separately.
Instead it should use Signal K, an open translator and data hub. Signal K can read
NMEA 2000 and NMEA 0183, then make selected values available over the boat's local
Wi-Fi to a phone or tablet. It can run on a small onboard computer such as a
Raspberry Pi, or on some existing marine/energy gateway hardware. Signal K describes
itself as a hub that gathers onboard data and publishes it over normal network
connections. [Signal K overview](https://demo.signalk.org/documentation/index.html)

For Newjourney, the safe first integration is **read-only**: read the boat's data,
but do not control an autopilot, engine, or radio. That keeps the app focused on
advice and avoids turning a phone tactical tool into a control system.

### AIS

AIS lets vessels broadcast identity, position, course, and speed. On board, it is
normally supplied by an AIS receiver or transponder connected to the VHF antenna
system and to NMEA 2000/0183. The Signal K gateway can then provide those targets to
the app on local Wi-Fi.

There are also internet AIS feeds. They are useful as coastal context, but they may
be delayed, incomplete, or absent offshore. Newjourney must never present an
internet-only feed as collision avoidance. The correct priority is:

1. Local boat AIS receiver via Signal K
2. Internet AIS as clearly labelled, possibly stale context
3. No AIS shown when neither source is available

An AIS transponder is a radio installation, not just an app accessory. It needs an
appropriate VHF antenna arrangement, power, and correct installation. The app should
consume its data, not ask a newcomer to improvise the radio side.

### Displays

There are three practical display options:

| Display choice | Best for | Trade-off |
|---|---|---|
| **Phone** | Dinghy, crew-held start tool | Small, can overheat, difficult in spray/sun |
| **Waterproof tablet** | Cockpit tactical display and coach boat | Good screen and flexible; needs a mount, power, and waterproofing |
| **Existing chartplotter/MFD** | A permanently installed helm display | Vendor browsers and custom-app support vary widely; treat it as a later integration, not an MVP promise |

The low-risk path is a browser on a phone or waterproof tablet connected to the boat
Wi-Fi. A later Signal K web-app/plugin route can make Newjourney discoverable from an
onboard navigation computer. Signal K explicitly supports installable web apps and
plugins, but that does not mean every proprietary chartplotter can display one.
[Signal K configuration and web apps](https://demo.signalk.org/documentation/Configuration.html)

## Where Starlink fits

Starlink is a **future connectivity choice**, mainly for coastal-distance and offshore
boats that want fresh data beyond cellular coverage. It is not needed for a Portland
club race, and it is not part of the instrument network.

What it unlocks:

- Downloading fresh weather fields and chart/venue updates offshore
- Sending tracks or fleet positions when the crew chooses to share
- Crew communications and normal internet use
- Remote support and software updates

What it costs:

- A roof/deck-mounted terminal, cable run, power supply, local router/Wi-Fi, service
  plan, space, and a clear view of the sky
- Meaningful power draw. Starlink currently lists roughly 20–40 W average for Mini,
  50–100 W for several Standard kits, and 110–150 W for Performance kits; exact use
  changes with hardware and conditions. [Starlink power guide](https://starlink.com/en-lk/support/article/18836c7e-2d97-6153-fe67-c18427bd0558)
- Possible dropouts when the terminal is obstructed; Starlink's marine guide calls
  out obstructions above 20 degrees of elevation. [Starlink marine install guide](https://starlink.com/ws/support/article/9ad76566-e01e-2be4-09ee-fbb120a22e50)

The sensible relationship is therefore:

```text
instruments ──► Signal K ──► local boat Wi-Fi ──► Newjourney
                                                │
                                  cellular or Starlink ──► internet data
```

The app must continue to work locally if Starlink drops. The boat's sensors and
already-downloaded data are still useful without the internet.

## How this differs from Expedition

Expedition is built around a dedicated Windows navigation computer connected directly
to an extensive instrument system. It expects a navigator, powered nav station,
instrument calibration, and often paid weather/connectivity services. Its strength is
the depth of the professional setup.

Newjourney should meet sailors at three starting points:

- **No boat system:** use the phone; do not punish the sailor for lacking hardware.
- **Existing boat system:** read its already-installed sensors through Signal K rather
  than asking the owner to replace instruments.
- **Serious offshore boat:** use the same local data path, then add satellite/cellular
  connectivity for fresh data and sharing.

In other words, Expedition starts with the fully wired boat and works outward to the
screen. Newjourney starts with the phone and can grow inward toward the boat network.
Both can use the same core measurements; Newjourney's difference is progressive setup
and a much smaller number of choices.

## Recommended product path

1. **Portland MVP:** phone/tablet GPS, manual or forecast wind, local tracks, downloaded
   venue data. No hardware purchase required.
2. **Instrument bridge:** add a read-only Signal K connector. Support position, heading,
   water speed, wind, depth, and local AIS with source/freshness labels.
3. **Cockpit screen:** test a mounted waterproof tablet before investing in chartplotter
   integrations. This is the fastest way to learn what racers actually look at.
4. **Connected/offshore tier:** add deliberate forecast downloads, small synchronisation
   payloads, and optional fleet sharing over cellular or Starlink.
5. **Display integrations:** offer a Signal K web app first; consider vendor-specific
   MFD integrations only where there is a documented, maintainable route.

## Decisions still needed

- Do we support only Signal K, or also offer a simpler direct Bluetooth GPS path?
- What is the minimum supported phone/tablet and browser for the Portland pilot?
- Do we target a self-installed Raspberry Pi bridge, an existing Signal K appliance,
  or both?
- When is a route allowed to use a display with no verified land/depth pack?
- Which values can be shown from AIS, and which safety language is mandatory?

The architecture documents should answer these before promising hardware support in the
product UI.
