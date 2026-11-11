# Expedition parity

**Started:** 2026-09-28, on branch `parity/expedition`
**Goal:** newjourney does everything Expedition does. Where a feature cannot be
built, this folder says exactly what building it would take.
**State on 2026-11-05:** stopped, not finished. Parity is 36.5 % (360 of 985 applicable
rows Done, by `node scripts/parity-score.ts`). The last parity code landed on 2026-09-30, and
the next item is M19. Phone phase 0 landed on 2026-11-05
([the plan](../05-spec/phone-and-hardware.md)) and left the score where it was. The branch went
to `origin` on 2026-11-03 as a backup, and again on 2026-11-11. It has no pull request and no
deploy, and whether it
merges into `main` is
[still open](../06-decisions/README.md#open-only-the-owner-can-settle-these).

Until now the project deliberately built about 5 % of Expedition's surface
([feature-inventory.md §10](../01-expedition-analysis/feature-inventory.md#10-feature-count-reality-check)),
and [roadmap.md](../05-spec/roadmap.md#non-goals-restated) listed "settings parity
with Expedition" as a non-goal. This branch reverses that on the owner's instruction.
`main` keeps the phone-first product; this branch aims at the whole surface.

## What "1:1" means here

- **Capability parity, and as much of it working as possible.** Every capability in
  the manual either works in newjourney or has a row in [needs.md](needs.md) naming
  what is missing: a licence, hardware, a data account, or an owner decision. Formats
  that others interoperate with are fair game, because reading them is how a sailor
  moves across: polar text files, marks CSV, GPX, NMEA 0183/2000, GRIB, S-57 and
  Expedition's simple serial protocol.
- **The look may follow Expedition's, kept simple and minimalist.** The owner decided
  this on 2026-09-30: a plain nav-station layout, dense number boxes, a flat chart and
  few colours are fine to copy. Expedition's name, logo, icon artwork and manual text
  are still not copied.
- **Owner decisions of 2026-09-30.** Download the public test files (D8). Build the
  local Node bridge for UDP/TCP, app-to-app sharing and watched folders (D4). Build
  the transmit outputs, tested against recordings and off by default (D3). Build the
  backend and run it locally, while deploying it stays with the owner (D1). As of 2026-11-03
  the downloads and the bridge are built (M16, M18). Transmit and the backend are not
  (M19, M20).
- **One codebase, two layouts.** The owner chose this on 2026-09-28. The phone keeps
  its tab bar: `main` has five tabs, and this branch has six, because the stripchart added
  one. From 1,024 px wide the same app becomes a nav station: a ribbon, a panel, the chart
  in the middle, number boxes, a status bar and keyboard shortcuts. Instruments arrive over
  Signal K (WebSocket) or Web Serial. Anything a browser cannot reach goes through a small
  native bridge. `bridge/` now does raw UDP, TCP, serial and watched folders. Radar Ethernet
  and the registry are not built, and [needs.md](needs.md) says so.
- **Done ("perfect") means** every row of [parity-matrix.md](parity-matrix.md) is
  either **Done**, with code plus a test, or **Blocked**, with a named need in
  [needs.md](needs.md). The parity score is Done ÷ (rows − N/A), and every report
  gives it.

## Files

| File | What it is |
|---|---|
| [needs.md](needs.md) | **Everything we would need** that code alone can't provide: licences, hardware, accounts, a native bridge, and owner decisions, with costs where known |
| [parity-matrix.md](parity-matrix.md) | Every capability in the manual, what newjourney does today, and what closing the gap takes |
| [worklist.md](worklist.md) | The ordered build list the loop works, one item per commit |
| [reports/](reports/) | One report per 3-hour tick, for the owner to review |

## How the loop works

**It is not running.** The last tick ended on 2026-09-30, and its cron job lived only in
that session, so nothing fires until the owner starts it again. The rest of this section is
how it ran, and how it would run again.

A session cron job fires every 3 hours, at :53 past 02, 05, 08, 11, 14, 17, 20 and
23 local time. Each tick:

- **Works the list top to bottom, one item per commit.** Each commit carries the
  change, its test, and the tick in [worklist.md](worklist.md), with the matrix rows
  it closes updated in the same commit.
- **Verifies before ticking.** `npm test`, `npx tsc -b --noEmit` and `npm run build`
  must all pass. Anything visible is also checked in the running app, following
  [RUNNING.md](../../RUNNING.md).
- **Writes blocked down rather than working around it.** An item that needs a
  decision only the owner can make is marked `blocked:` with the question, and the
  next item starts. Needs that are not code go in [needs.md](needs.md).
- **Stops at about 2.5 hours**, then writes `reports/YYYY-MM-DD-HHMM.md`: what landed
  (with SHAs), the parity score, what is next, and what is blocked. It commits the
  report and sends one push notification. Nothing is logged pass by pass, because
  [review-log.md](../05-spec/review-log.md) shows where that habit leads.
- **Sends nothing off the machine unasked.** Commits stay on this branch. Pushing,
  PRs, merges, deploys, repo settings, accounts and purchases all wait for the owner. The
  backup push of 2026-11-03 was the owner's, for that one time.
- **Stops when it's done.** When every item is ticked or blocked, the tick writes a
  final report and deletes the cron job. The job also expires 7 days after it was
  created, whichever comes first.
