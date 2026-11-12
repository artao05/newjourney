# Getting newjourney onto a phone, and connected to a boat

Written 2026-11-03 against `parity/expedition` at `fbb40b4`. Phase 0's code was done on
2026-11-04 and its real-phone check is still to come. Nothing else here has been built,
bought or signed up for.

Each claim is marked by how far it has been checked:

- **Measured:** run or read in this repo on that date.
- **Docs:** taken from a vendor's page or a browser team's post, listed under
  [Sources](#sources).
- **Spike:** unknown until someone tries it on a real device.

## The short version

1. **Installing the web app on a phone already works.** It is live, but as far as the
   project's notes record, it has never run on a real phone or on the water. That test
   comes first, because it costs nothing and may change everything after it.
2. **Boat hardware needs a thin native app around this same code.** An iPhone browser
   can't reach the boat's Wi-Fi instruments from an HTTPS page, or use Bluetooth. Use
   [Capacitor](https://capacitorjs.com), and keep the app and its 1,858 tests rather
   than rewriting them.
3. **The biggest code change is not the native shell.** The app takes all its instruments
   from one source at a time and turns the phone's GPS off while it does. A phone needs
   to mix sources and fall back when Wi-Fi drops.
4. **Connect hardware in steps, cheapest first:** phone, external GPS, Bluetooth wind, a
   Wi-Fi gateway to the boat's network, then a Signal K server. Each step is tested on a
   recording, then at the dock, then on the water. Everything stays read-only.

```text
                    ┌─────────────── the phone ───────────────────┐
 Phone GPS, compass ───► native shell (Capacitor)                 │
 Bluetooth GNSS, wind ─► sockets · Bluetooth · background · files │
                    │        │ lines of NMEA, N2K, readings       │
 Boat Wi-Fi ────────┼────────┤                                    │
   gateway (TCP/UDP)│        ▼                                    │
   Signal K server  │   existing decoders ─► source merge (new)   │
                    │   nmea0183, n2k, AIS        │               │
                    │                             ▼               │
                    │   InstrumentPipeline ─► store ─► screens    │
                    └─────────────────────────────────────────────┘
 Cellular or Starlink ──► forecasts, updates (never instruments)
```

## Where it stood before phase 0

**Measured** on 2026-11-03. Phase 0 has since fixed the layout, first load, stored data and
timer sound rows, and the branch was pushed that day with CI green at `fbb40b4`:

| Area | Finding | Where |
|---|---|---|
| What sailors get | The live site is `main` at `5bad931`. `parity/expedition` is 172 commits ahead, has never been pushed, and has never run in CI. It exists only on this machine. | git |
| Route, 360 px wide | The action row doesn't wrap and its parent hides overflow. RESULTS is cut off and SETTINGS can't be reached at all. | `.actions` in `.screen--flush` |
| Start, 360 × 740 | TIMER runs off the right edge and the page scrolls sideways by 34 px. With three warnings showing, the tab bar sits at 919 px, below the 740 px screen. The preview browser forced two of those warnings by refusing GPS and wake lock, so a real phone may show fewer. | browser check |
| Race, 360 px wide | ADD BOAT and two fellow fields sit off-screen. It may sit inside a scrolling area: not checked. | browser check |
| Small targets | Buttons under 36 px: 5 on Start, 14 on Route, 14 on Strip, 23 on Weather. That is hard with wet hands. | browser check |
| First load | 215 KB of gzipped JS against 100 KB on `main`. Nothing fails a build for this. | `dist/assets` |
| Stored data | Nothing calls `navigator.storage.persist()`, so tracks and charts in IndexedDB have no protection from eviction. | grep of `src/` |
| Timer sound | If the audio context isn't running, a beep is dropped without a word. Vibration is the only other signal, and iPhones are expected not to have it. | `src/lib/beep.ts:33-35` |
| Instruments | One source at a time, and any feed turns the phone's GPS off. If Wi-Fi drops, the position stops updating with nothing to fall back on. | `src/App.tsx:153-164` |
| Signal K | No AIS (it subscribes to `self` only and ignores other vessels), no sign-in token, and no way to find the server. The user types the URL. | `src/lib/instruments/signalk.ts` |
| Bridge | **Can't serve a phone.** A connection from another machine gets no `hello` or data, and is closed if it sends anything except a valid link. `BridgeClient` has no key to offer. | `bridge/bridge.ts:253`, `:279` |
| Maps offline | Glyphs come from `demotiles.maplibre.org` and tiles from `tile.openstreetmap.org`, whose policy rules out heavy use. | `src/components/ChartSurface.tsx:49-53` |
| Saving files | At least 12 files use object URLs, file inputs or the share API for import and export, and a native web view may not honour a download link (**Spike**). They need one shared helper. | e.g. `src/lib/gpx.ts` |

The parts that carry over well: the NMEA 0183, NMEA 2000 and AIS decoders, the pipeline,
calibration and logging are plain TypeScript with no browser dependency in their logic.
Any new transport only has to hand them lines of text.

## Why a browser alone won't do

| Need | iPhone, installed web app | Android, Chrome | Native shell |
|---|---|---|---|
| GPS while on screen | Yes | Yes | Yes |
| GPS with the screen off | No | No | Yes: iOS background mode, Android foreground service |
| Keep screen on | Reports conflict; said fixed in iOS 18.4 (**Spike**) | Yes | Yes |
| Timer sound with the phone on silent | Web Audio is expected to be muted (**Spike**) | Follows media volume | Yes, through an audio session |
| Buzz | Expected missing | Yes | Yes |
| `ws://` to the boat from the HTTPS site | Assume blocked | Chrome's guidance allows private addresses after a permission prompt. It doesn't say whether that covers Android (**Spike**) | Not needed: native sockets |
| Raw TCP or UDP | No | No | Yes |
| Bluetooth sensors | No: WebKit opposes Web Bluetooth | Yes, Web Bluetooth | Yes |
| USB or Bluetooth serial | No | Chrome 148 and later, but wired ports appear only on devices configured for them (**Spike**) | Android yes; iPhone only for approved accessories |
| Storage that lasts | Better when installed, poorly documented | Good once persisted | Own app files |

Two routes that avoid the native shell, both too limited to be the main plan:

- **Serve the app from the boat's Signal K server over plain HTTP.** No install is needed
  and it reaches instruments, but the page isn't a secure context. That means no phone
  GPS, no service worker and nothing offline away from the boat. It is good as a free
  repeater on crew phones, so keep it as an extra.
- **Put a real certificate on the Pi** (a DNS name that points at its private address).
  This works in every browser, but it needs a domain, renewals and DNS on a boat that
  may be offline. That is too much to ask of a sailor.

Options ruled out: React Native or Flutter would throw away the working app, the map
layers and the tests. A plain Android Trusted Web Activity gains no iPhone support and no
native sockets.

## The phases

Sizes are rough: **S** is days, **M** is one to two weeks, **L** is several weeks.

Phases 0 to 4 run in order. Phase 5 can run alongside 2 to 4, and phase 6 comes last.

### Phase 0: a phone build that deserves a real test (S)

No native code and nothing to buy.

- [x] Push `parity/expedition` so it has a backup and its first CI run: done 2026-11-03,
      green. Still open: decide whether it or `main` ships next (D9 in
      [needs.md](../08-parity/needs.md)). Recommended: this branch, once this phase is done.
- [x] Fix the Route action row, the Start overflow, warnings that push the tab bar off-screen,
      and the Weather timeline. Fingers get targets of at least 34 px on buttons and selects.
- [x] Add a layout test, `npm run test:phone`, in CI. It runs at 360×640, 360×740, 390×844 and
      412×915, and fails on sideways scrolling, an unreachable or covered control, or a small
      target, on every tab and three sheets. It blocks the network, so screens that need a
      forecast are checked only by hand (`LIVE=1`), and Route with a route loaded not at all.
      **Reopened and fixed 2026-11-11:** it had passed only in Windows' font. On CI's runner it
      failed: segmented buttons 32 px tall, and 4 px of sideways scroll at 360 px
      ([RUNNING.md](../../RUNNING.md#whats-real-and-what-isnt)). The check now draws the app in
      Arial, which sets lines like Roboto and San Francisco, and fails a label wider than its
      button. That also caught Route's action row squeezing its labels instead of wrapping on a
      touch screen. All three are fixed, and the check passes in Chrome and in
      `test:phone:webkit`, Safari's engine, on Windows. The fix has not run in CI yet.
- [x] First-load JS: 113 KB, from 215 (Vite's figures, measured 2026-11-05), with a budget that
      fails the build. The budget counts in units of 1,024 bytes, so it reads 110.7 against a
      limit of 115. Not quite the 100 KB aimed for: React is about 60 KB of it, and the rest is
      what Start needs.
- [x] Ask for `navigator.storage.persist()` and show the result in Setup → Stored data.
- [x] Warn when the timer can't sound, with a tap to turn it on, and add TEST SOUND.
- [x] Update the docs that had gone stale ([below](#docs-this-plan-makes-stale)).
- [ ] **Run PILOT.md §2 on a real iPhone and Android phone.** It takes the owner and the phones.
      [RUNNING.md](../../RUNNING.md#on-a-real-phone) says how to get this branch onto each,
      by USB cable or a tunnel.

**Done when:** every item of [PILOT.md](../../PILOT.md) §2 passes on one real iPhone and
one real Android phone, with the results written down.

### Phase 1: the phone-only pilot (S, plus time on the water)

- [ ] Run the two-minute test in PILOT.md §3 with people who haven't seen the app.
- [ ] Measure what no test here can: battery per hour, heat in sun with the screen on,
      reading at arm's length, wet touch, and how far GPS wanders on a known line.
- [ ] Note which features anyone wanted. Let that reorder phases 2 to 6.

**Done when:** at least one real race has a saved GPX, and the battery and heat numbers
are written down. If the phone can't last a race or the start tool doesn't help, fix that
before any native work.

### Phase 2: the native shell (M)

Start with a one-day spike: wrap the app in Capacitor, build for Android, run Start and
the Route map on a mid-range phone, and watch WebGL and the routing worker.

- [ ] Add `@capacitor/core`, with `android/` and `ios/` projects built from `dist/`.
- [ ] Add a small `src/lib/platform/` layer, so screens call one API and web and native
      each supply their own: location, keep-awake, sound and buzz, saving and sharing
      files, and storage.
- [ ] Skip the service worker in the native app (`src/main.tsx:37`). Assets ship inside
      it, so decide how updates reach sailors: store releases, or signed web bundles.
- [ ] Sound the countdown through a native audio session, so silent mode can't mute a
      start.
- [ ] Send every export through the share sheet.
- [ ] Unlock landscape for a mounted phone or tablet. The manifest pins portrait today.
- [ ] Distribute privately: an APK on Android, and TestFlight on iPhone.

**iPhone builds need a Mac.** Development here is on Windows, so build Android first. For
iPhone, use a borrowed or cloud Mac, or GitHub's macOS runners. Debugging in the iOS web
view still needs Safari on a Mac.

**Done when:** PILOT.md §2 passes inside the native app on both platforms, and the
countdown is audible with the phone on silent.

### Phase 3: instrument plumbing, before any hardware (M)

This is where the code gets ready for a boat. All of it can be tested with a laptop.

- [ ] **Merge sources by channel.** Replace the single `InstrumentSource`
      (`src/hooks/useInstruments.ts:25`) with several feeds at once. Each channel
      (position, heading, wind, speed, depth) takes the best fresh source. This allows
      phone GPS with Bluetooth wind, for example.
- [ ] **Fall back and say so.** When a feed goes stale, use the next source, with a
      visible label. Phone GPS comes back on. A stale value must never look live.
- [ ] **Native sockets:** a TCP and UDP plugin that passes lines to the existing decoders
      as a new source kind, reconnecting with backoff like `BridgeClient`.
- [ ] **Signal K for a phone:** AIS (subscribe beyond `self`, or read its NMEA TCP
      output), sign-in tokens, and finding the server on the network.
- [ ] **A connect screen a sailor can use:** finds devices, shows what each one sends, and
      replaces typing URLs.
- [ ] **Network realities** (**Spike**, all of them): the iOS local network prompt, the
      Apple entitlement for multicast (granted on request), Android preferring cellular
      when boat Wi-Fi has no internet, phones dropping UDP in power saving, and limits on
      gateway connections. Prefer TCP where a device offers it.

Leave the bridge as the laptop's tool. A phone doesn't need it once it has sockets.

**Done when:** a phone on a laptop's hotspot shows `bridge/replay.ts` playing the Casco
Bay recording, AIS included. Turning Wi-Fi off goes to phone GPS and says so within a few
seconds, and turning it back on recovers without a tap.

### Phase 4: hardware, one rung at a time (M to L)

See [The hardware ladder](#the-hardware-ladder). Do only the rungs your boat needs.

### Phase 5: useful away from a signal (M to L, alongside 2 to 4)

- [ ] Self-host glyphs (worklist 20.6) and base map tiles (PMTiles).
- [ ] Downloadable region packs, with a screen showing what is on the phone: charts, tide
      constituents, land mask, and marks. Land avoidance and depth stop at Portland today.
- [ ] A deliberate "download forecast for this race" action, with its age always shown.
- [ ] The small backend (worklist M20): deployed under the owner's account, for the proxy
      and for sharing when the boat has no local network.
- [ ] Battery work: draw less when idle, and a low-power mode for long races.
- [ ] Background track recording through the native layer, buffered natively so a
      suspended web view loses nothing (**Spike**).

### Phase 6: public release (M, mostly waiting)

- [ ] Accounts: Apple Developer about $99 a year, Google Play about $25 once. A new
      personal Play account needs a closed test with 12 testers opted in for 14 days.
- [ ] A privacy policy, the store data forms, and location permission text. Android's
      background location needs its own declaration.
- [ ] A legal read of the not-for-navigation wording (needs.md §7). Apple's guideline 1.4
      lets it reject apps that risk physical harm.
- [ ] Settle D5 (commercial or not) and each data source's terms for store distribution.
      Tiles must be self-hosted first. Any AIS key must stay off the phone.
- [ ] Plan for a guideline 4.2 rejection. Apple rejects repackaged websites, and
      developers report this for Capacitor apps even with native features added. The
      honest case is local instruments, Bluetooth and background tracks, but no one can
      promise it passes. TestFlight and an APK keep a pilot running meanwhile.

## The hardware ladder

Each rung adds a measurement the phone can't honestly produce. Prices are rough, so check
them before buying.

| Rung | Hardware | What it adds | Rough cost | How it connects | App work |
|---|---|---|---|---|---|
| 0 | Phone, waterproof case, secure mount, lanyard, power on bigger boats | Start line, timer, track, manual wind | A case and mount | Built in | Phases 0–2 |
| 1 | Bluetooth GNSS (Bad Elf, Dual XGPS and others) | A steadier position with a clear view of the sky | Check current prices | iPhone: an approved accessory is reported to feed the system location, so the app may need no change (**Spike**). Android: a mock-location app, or read it directly | Little, plus a bow offset check |
| 2 | Bluetooth wind sensor (Calypso Ultrasonic) | Measured wind on a small boat with no network | Check current prices | Bluetooth LE to a new native source | Phase 3, plus a driver |
| 3 | Wi-Fi gateway on the boat's network (Yacht Devices YDWG-02, or a Wi-Fi NMEA 0183 multiplexer) | The boat's GPS, heading, wind, speed and depth, with no computer aboard | $150–400 | Phone joins its Wi-Fi; TCP such as `192.168.1.20:1457` into the existing decoders | Phase 3 |
| 4 | Signal K server (Raspberry Pi with OpenPlotter, or Victron Cerbo GX) plus a gateway | Several phones at once, logging, more device types, and a free repeater page | $100–250 plus gateway | Boat Wi-Fi, over a Signal K stream or its NMEA TCP output | Phase 3 |
| 5 | AIS receiver (dAISy, Vesper or Digital Yacht) | Local targets and CPA/TCPA alarms | $70–400 | Through rung 3 or 4 | Exists; needs a real device check |
| 6 | Laptop nav station plus phones | Full routing below deck, phone on deck | Already owned | Sharing between copies, once a phone can use it | Later |
| 7 | Transmit: autopilot, deck displays, processors | Writing to the boat | Needs a test boat | Worklist M19, off by default | **Last, on a real boat only** |

**Vakaros Atlas:** no public Bluetooth developer API turned up, so don't plan around it
without asking Vakaros. **Calypso:** a third-party Python driver exists, but it is AGPL.
Work from the vendor's manual, and don't copy its code.

**Where to start depends on the boat:**

- Dinghy or small one-design: rungs 0, 1, then 2.
- Keelboat with NMEA 2000: rungs 0, 3, then 5. Skip the Pi until you want several phones
  or logging.
- Older boat on NMEA 0183: rung 3 with a multiplexer, or rung 4 with a USB adapter.
- Serious offshore boat: rungs 4, 5 and 6, with a mounted tablet.

### The same steps for every device

1. **Record first.** Capture a real session and commit it as a test fixture
   (needs.md §5). The only recording today, `casco-bay-synthetic.nmea`, is made up.
2. **Replay it** into the phone with `bridge/replay.ts` and compare it with the device's
   own display.
3. **Bench:** power the device, connect the phone, and check rates, reconnects and what
   happens when it's unplugged.
4. **Dock:** with the boat's instruments on, check each number against the boat's own
   display, and check source labels and staleness warnings.
5. **Calibrate** with the existing tools: wind angle, boat speed, compass, and bow offset.
6. **Water:** a real sail, logged, then compare and write it up. Only now does the
   matrix's Hardware row (134 of them) count as Done.

### Keeping the boat safe

- **Read-only until a test boat decides otherwise.** Some gateways can write to the bus,
  so use listen-only settings where they exist.
- **Don't rely on a phone for collision avoidance.** Label internet AIS as such (see the
  [hardware brief](../00-overview/hardware-and-connectivity-brief.md)).
- **Keep AIS and VHF radio work with a qualified installer.** A transponder is a radio
  installation.
- **Give a Pi clean, fused power** through a marine-grade 12 V to 5 V converter, or it
  will be the first thing to fail in a race.
- **Follow NMEA 2000 wiring rules:** a powered backbone with two terminators. Add a device
  through a proper drop cable and T connector.
- **Assume the boat's Wi-Fi is shared.** Anyone on it can read an open Signal K server, so
  set up its security before writing is ever turned on.

## What to get

| Item | When | Cost |
|---|---|---|
| One iPhone and one Android phone, one of them mid-range | Phase 0 | Possibly owned |
| Waterproof case, mount and lanyard | Phase 1 | Check |
| Mac access, borrowed or cloud | Phase 2, for iPhone | Varies |
| Apple and Google developer accounts | Apple before TestFlight; Google at Phase 6 | About $99 a year; about $25 once |
| The first rung for your boat | Phase 4 | See the ladder |
| A boat and a day on the water, per rung | Phases 1 and 4 | Access |

## Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| P1 | Which phone do you sail with? | It goes first if you need it to. Otherwise Android, since development is on Windows. |
| P2 | Which boat comes first, and what's on it? | This picks the starting rung. |
| P3 | Push `parity/expedition`? | Done 2026-11-03, and again with phase 0 on 2026-11-11. Later commits still wait to be asked for. |
| P4 | Does phone work take priority over parity worklist M19–M23? | Yes. Pause them except M20's glyphs and backend, which phase 5 uses. |
| P5 | Use Capacitor? | Yes, after the one-day spike. |
| P6 | Private pilot or public stores? | Private until the pilot shows it helps. |
| P7 | Commercial or not (D5)? | Stay non-commercial for now. It decides how much data must be self-hosted. |

The [hardware brief](../00-overview/hardware-and-connectivity-brief.md#decisions-still-needed)
has its own open questions. This plan answers one, whether to offer a Bluetooth GPS path:
yes. The rest stay open there, such as the minimum supported phone and the required AIS
safety wording.

## Docs this plan makes stale

Dealt with on 2026-11-04: the Web Serial comment in `src/lib/instruments/webserial.ts`, the
`mixedContentWarning` text, and [RUNNING.md](../../RUNNING.md). Check [needs.md](../08-parity/needs.md)
§1 D2 and §6 for any line still calling Web Serial desktop only: Chrome 148 extends it to
Android, not yet tried here.

## Sources

Checked 2026-11-03. Several are forum posts, so treat them as reports and confirm them on
a device.

- [Chrome: Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
- [Intent to Ship: Web Serial API on Android](https://groups.google.com/a/chromium.org/g/blink-dev/c/HBJ-uYFvkpM)
  and [over Bluetooth](https://groups.google.com/a/chromium.org/g/blink-dev/c/BqUGCcurReE)
- [WebKit's position on Web Bluetooth](https://lists.w3.org/Archives/Public/public-web-bluetooth/2024Sep/0002.html)
- [WebKit bug: wake lock in home-screen apps](https://bugs.webkit.org/show_bug.cgi?id=254545)
  and [PWA capability notes](https://progressier.com/pwa-capabilities/screen-wake-lock)
- [Storage for the web](https://web.dev/storage-for-the-web) and
  [Apple forum: PWA data persistence](https://developer.apple.com/forums/thread/710157)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
  and [a report of a 4.2 rejection for a Capacitor app](https://developer.apple.com/forums/thread/812889)
- [Capacitor configuration](https://capacitorjs.com/docs/config) and
  [a background geolocation plugin](https://capawesome.io/plugins/background-geolocation/)
- [Apple forum: UDP broadcast and local network access](https://developer.apple.com/forums/thread/723094)
  and [multicast entitlement notes](https://developer.zebra.com/blog/link-os-sdk-ios-printer-network-discovery-api-impacted-ios-145-and-higher)
- [Google Play: testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-GB)
- [Practical Sailor: GPS receivers for phones](https://www.practical-sailor.com/marine-electronics/gps-receivers-for-smart-phone-navigators/)
  and [Apple forum: external GPS on iPhone](https://www.developer.apple.com/forums/thread/803014)
- [calypso-anemometer driver](https://github.com/daq-tools/calypso-anemometer)

Not sourced this session, from general knowledge, so confirm before relying on them: the
developer account prices, the iPhone silent switch muting Web Audio, iPhones lacking
`navigator.vibrate`, and the NMEA 2000 wiring and power advice.
