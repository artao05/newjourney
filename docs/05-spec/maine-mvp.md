# Maine MVP — what stands between the prototype and a day on Casco Bay

**Started:** 2026-09-27, on branch `mvp/maine-pilot`
**Goal:** a build that can be deployed and genuinely used to start races in Maine. That
is the Tier 0 start-line tool from [mvp-scope.md](mvp-scope.md), on a phone, offline,
with nothing on screen that is wrong without saying so.

The gaps below come from checking [mvp-scope.md](mvp-scope.md) against the code on
2026-09-26. Each is ordered by how badly it would hurt a sailor who relied on it. An
item is ticked only when its acceptance check has passed. The tick lands in the same
commit as the fix, so this file's history says which commit did each item.

## How this list is worked

- **Top to bottom, one item per commit.** Each commit carries the fix, its test, and
  the tick below.
- **Verified before ticked.** `npm test`, `tsc -b --noEmit` and `npm run build` must
  all pass. Anything visible is also checked in the running app: `npm run dev` for UI,
  and the production build under `npm run preview` for anything the service worker
  touches.
- **Blocked is written down, not worked around.** If an item needs a decision only the
  owner can make, it is marked `blocked:` with the question, and the next item starts.
- **Nothing leaves the machine unasked.** Commits stay on this branch. Pushing, opening
  a PR, merging, deploying and changing repo settings wait for the owner.
- **Done means stop.** When every item is ticked or blocked, the work is reported and
  stops. Nothing is logged pass by pass: [review-log.md](review-log.md) is what that
  habit produced.

---

## P0 — would mislead or strand a sailor on the water

- [x] **1. CLEAR keeps the start line.** CLEAR sits among the Race tab's mark controls
      but calls `clearCourse`, which also nulls both pinged ends and the gun time. A
      sailor tidying up marks during a sequence loses the line and the countdown.
      *Accept:* clearing marks leaves the start line and gun time intact. There is a
      store test and a screen test, and putting the bug back makes them fail.
- [x] **2. Offline from the first visit.** The service worker registers after the
      first page has loaded, so the entry script is not cached until a second online
      visit. A sailor who opens the link once at home gets a blank app on the water.
      *Accept:* the install step precaches the shell, the entry and lazy chunks, and
      the venue packs. A test pins that list. In the production preview, the entry
      chunk is in the cache after one visit.
- [x] **3. Not for navigation, on first launch.** Today the notice only appears at the
      foot of Setup. *Accept:* a one-time acknowledgement before first use,
      remembered once given, and the Setup notice stays. Screen tests cover both
      states.
- [x] **4. Wind you can see the source of, and set from the Start screen.** Line bias
      and laylines rest on the wind. The top-bar chip shows the manual default
      (270° · 12 kn) without saying it is manual, and setting it means leaving Start
      for Setup. *Accept:* the chip names its source and flags a default nobody has
      set. Start has a quick wind control. Screen tests cover both.
- [x] **5. The ping records the bow.** It stores the antenna position, while
      [start-line-math.md](../03-algorithms/start-line-math.md) specifies the bow.
      `bowPosition()` already falls back to the antenna when heading is unknown.
      *Accept:* a ping while moving lands bow-to-GPS metres ahead along the heading,
      a ping while stopped lands at the antenna, and a mutation fails the test.

## P1 — needed to run a real pilot

- [x] **6. Tracks survive and can be sent.** A recorded track is lost on reload, and
      `trackToGpx` exists but nothing calls it. *Accept:* an Export button produces
      GPX that round-trips through `parseGpx`, and the track survives a reload under a
      stated size cap.
- [x] **7. GPS honesty at start scale.** Warn when the fix's accuracy exceeds half a
      boat length, as mvp-scope asks, instead of fixed 6 m / 15 m colours. *Accept:* a
      screen test on either side of the threshold.
- [x] **8. Say when the screen may sleep.** Wake lock fails silently where it is not
      supported. *Accept:* a visible warning when it is unavailable or refused, with a
      test.
- [x] **9. Installable on iPhone and Android.** iOS ignores SVG home-screen icons, and
      the manifest has only SVG. *Accept:* a 180×180 `apple-touch-icon.png` plus
      192/512 PNG manifest icons, linked and tested. PNG size is checked from the file
      header.
- [x] **10. CI, and a Pages deploy that is ready to switch on.** *Accept:* a workflow
      runs tests, typecheck and build on every push and PR. A second one deploys
      `dist/` to GitHub Pages on pushes to `main`. Neither does anything until merged
      and Pages is set to "GitHub Actions", which is the owner's call.

## P2 — Maine specifically, and the rest of mvp-scope

- [x] **11. Magnetic north for Maine.** Variation at Portland is 14.5° W (NOAA, WMM-2025, 2026-09-27). A wind
      bearing read off a compass and typed in as true is 15° wrong, which on a start
      line is the whole bias. *Accept:* the venue's variation comes from NOAA with a
      link and date, wind can be entered and shown in °M, and the T↔M sign is pinned
      by a test.
- [ ] **12. Fix a mis-ping without re-pinging.** mvp-scope's "adjust by dragging on a
      simple plan view" is absent. *Accept:* a line end can be dragged on the start
      display, the pixel↔lat/lon mapping is unit-tested, and it is checked in the app.
- [ ] **13. A pilot guide.** *Accept:* one page covering install on iPhone and
      Android, a dock-side checklist (airplane mode, wake lock, GPS permission,
      sunlight), the two-minute test from mvp-scope, and what to send back (the GPX
      from item 6).

---

When this list is done, the build is ready to deploy. What it still will not have done
is face a sailor, and [mvp-scope.md](mvp-scope.md#what-we-learn-from-the-mvp) says that
is what this MVP is for.
