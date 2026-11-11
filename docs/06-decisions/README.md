# Architecture Decision Records

One file per decision, numbered, immutable once accepted. Supersede rather than edit.

**Format:** `NNNN-short-title.md`

```markdown
# ADR-NNNN: Title

**Status:** proposed | accepted | superseded by ADR-XXXX
**Date:** YYYY-MM-DD

## Context
What forces are at play? What did we learn in research that bears on this?

## Decision
What we're doing.

## Consequences
What becomes easy. What becomes hard. What we've foreclosed.

## Alternatives considered
And why not.
```

## The eight questions from the research

These needed deciding before Phase 1 code, and the code went ahead without a record. On
2026-11-03 each one the code had settled got an ADR, written from what the code does. They
record what was built, not a discussion, and the owner can supersede any of them. ADR numbers
follow the question numbers, so 0006 stays free for ORC.

| # | Question | Where it stands | Record |
|---|---|---|---|
| 1 | PWA-only vs. Capacitor-wrapped native | PWA only so far. A plan recommends trying Capacitor, undecided | [ADR-0001](0001-pwa-only.md) |
| 2 | React vs. Svelte | React | [ADR-0002](0002-react.md) |
| 3 | Client-side vs. server-side routing as the default | On the device, in a worker, with no server option | [ADR-0003](0003-client-side-routing.md) |
| 4 | Open-Meteo aggregator vs. own GRIB ingest for v1 weather | Open-Meteo, behind `WeatherField` | [ADR-0004](0004-open-meteo-behind-weatherfield.md) |
| 5 | MIT vs. Apache-2.0 for the code | MIT | [ADR-0005](0005-mit-licence.md) |
| 6 | ORC polar data: bulk vs. user-initiated lookup only | **Open**, see below | |
| 7 | NOAA chart display service vs. self-rendered ENC tiles | On `parity/expedition`, neither: cells decoded on the device. `main` has no ENC | [ADR-0007](0007-decode-enc-on-device.md) |
| 8 | Accounts in v1, or local-only with export codes | No accounts. Files, not codes | [ADR-0008](0008-no-accounts.md) |

These records are this branch's. `main` has had its own since 2026-11-09
([pull request #4](https://github.com/artao05/newjourney/pull/4)), written from its own code, so
the wording differs. Apart from ADR-0007, which `main` has no need of, they record the same
decisions.

## Open: only the owner can settle these

| Question | What the code does meanwhile | Tracked in |
|---|---|---|
| **ORC polar data** (question 6). May ORC data be used, and how? | No ORC data is bundled, and nothing fetches a certificate. Setup reads a polar file a user already has, in Expedition's text format or as CSV (qtVlm, ORC). The bundled polars are generated (`src/data/polars.ts`). ORC has not been asked. That is the interim policy, not an answer. | [needs.md D6](../08-parity/needs.md#1-decisions-only-the-owner-can-make), §4 of the [licensing matrix](../02-data-sources/licensing-matrix.md) |
| **Commercial or not.** | Nothing is charged for. The app uses Open-Meteo's free hosted API and OpenSeaMap's tiles, and on `parity/expedition` RainViewer. Each limits commercial or heavy use. | [needs.md D5](../08-parity/needs.md#1-decisions-only-the-owner-can-make), [licensing matrix §1](../02-data-sources/licensing-matrix.md#1-data-sources) |
| **Does `parity/expedition` merge into `main`?** | They stay apart. `main` is the phone-first product on GitHub Pages. The branch is on `origin` as a backup since 2026-11-03, with no pull request and no deploy. | [needs.md D9](../08-parity/needs.md#1-decisions-only-the-owner-can-make) |

[needs.md](../08-parity/needs.md#1-decisions-only-the-owner-can-make) has the rest of the owner's
decisions for the parity work, D1 to D9, and marks which are settled. The
[phone and hardware plan](../05-spec/phone-and-hardware.md) of 2026-11-03 adds its own, P1 to
P7. All but P3, the push, are open. Its P5, whether to use Capacitor, would supersede ADR-0001 if
the answer is yes.
