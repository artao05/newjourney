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
2026-11-04 each one the code on `main` had settled got an ADR, written from what the code does.
They record what was built, not a discussion, and the owner can supersede any of them. ADR numbers
follow the question numbers, so 0006 and 0007 stay free.

| # | Question | Where it stands on `main` | Record |
|---|---|---|---|
| 1 | PWA-only vs. Capacitor-wrapped native | PWA only so far. A plan recommends trying Capacitor, undecided | [ADR-0001](0001-pwa-only.md) |
| 2 | React vs. Svelte | React | [ADR-0002](0002-react.md) |
| 3 | Client-side vs. server-side routing as the default | On the device, in a worker, with no server option | [ADR-0003](0003-client-side-routing.md) |
| 4 | Open-Meteo aggregator vs. own GRIB ingest for v1 weather | Open-Meteo, into a `WeatherCube` | [ADR-0004](0004-open-meteo-behind-weatherfield.md) |
| 5 | MIT vs. Apache-2.0 for the code | MIT | [ADR-0005](0005-mit-licence.md) |
| 6 | ORC polar data: bulk vs. user-initiated lookup only | **Open**, see below | |
| 7 | NOAA chart display service vs. self-rendered ENC tiles | Not reached. `main` has no ENC | |
| 8 | Accounts in v1, or local-only with export codes | No accounts. Files, not codes | [ADR-0008](0008-no-accounts.md) |

## Open: only the owner can settle these

| Question | What the code does meanwhile | Tracked in |
|---|---|---|
| **ORC polar data** (question 6). May ORC data be used, and how? | No ORC data is bundled, and nothing fetches a certificate. Setup reads a polar file a user already has, in Expedition's text format or as CSV (qtVlm, ORC). The bundled polars are generated (`src/data/polars.ts`). The matrix's interim policy, fetching a user's own certificate into their account, is not built. No request to ORC is recorded. | §4 of the [licensing matrix](../02-data-sources/licensing-matrix.md) |
| **Commercial or not.** | Nothing is charged for. The app uses Open-Meteo's free hosted API and OpenSeaMap's tiles, and each limits commercial or heavy use. | [Licensing matrix §1](../02-data-sources/licensing-matrix.md#1-data-sources) |
| **Does `parity/expedition` merge into `main`?** | They stay apart. That branch has been on `origin` as a backup since 2026-11-03, with no pull request and no deploy. It has its own copies of these records, and an ADR-0007 for its charts. | Here |
