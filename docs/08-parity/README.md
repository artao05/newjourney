# Expedition parity

**Started:** 2026-09-28, on branch `parity/expedition`
**Goal:** newjourney does everything Expedition does. Where a feature cannot be
built, this folder says exactly what building it would take.

Until now the project deliberately built about 5 % of Expedition's surface
([feature-inventory.md §10](../01-expedition-analysis/feature-inventory.md#10-feature-count-reality-check)),
and [roadmap.md](../05-spec/roadmap.md#non-goals-restated) listed "settings parity
with Expedition" as a non-goal. This branch reverses that on the owner's instruction.
`main` keeps the phone-first product; this branch aims at the whole surface.

## What "1:1" means here

- **Capability parity, not a copy.** Every capability in the manual either works in
  newjourney or has a row in [needs.md](needs.md) naming what is missing: a licence,
  hardware, a data account, a native helper, or an owner decision. Expedition's name,
  logo, icons, manual text and ribbon trade dress are not copied. Formats that others
  interoperate with are fair game, because reading them is how a sailor moves across:
  polar text files, marks CSV, GPX, NMEA 0183/2000, GRIB, S-57 and Expedition's simple
  serial protocol.
- **One codebase, two layouts.** The owner chose this on 2026-09-28. The phone keeps
  its four tabs. At laptop and tablet widths the same app becomes a nav station:
  chart in the middle, then panes for marks, routes and race, then number boxes, a
  stripchart and keyboard shortcuts. Instruments arrive over Signal K (WebSocket) or
  Web Serial. Anything a browser cannot reach, such as raw UDP, radar Ethernet or the
  registry, goes through a small native bridge, and [needs.md](needs.md) says so.
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
  PRs, merges, deploys, repo settings, accounts and purchases all wait for the owner.
- **Stops when it's done.** When every item is ticked or blocked, the tick writes a
  final report and deletes the cron job. The job also expires 7 days after it was
  created, whichever comes first.
