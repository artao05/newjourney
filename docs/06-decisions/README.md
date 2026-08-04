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

## Decisions awaiting a record

Open questions from the research that need deciding before Phase 1 code:

| # | Question | Blocking |
|---|---|---|
| 1 | PWA-only vs. Capacitor-wrapped native | Phase 1 |
| 2 | React vs. Svelte | Phase 1 |
| 3 | Client-side vs. server-side routing as the default | Phase 4 |
| 4 | Open-Meteo aggregator vs. own GRIB ingest for v1 weather | Phase 3 |
| 5 | MIT vs. Apache-2.0 for the code | Before first public release |
| 6 | ORC polar data: bulk vs. user-initiated lookup only | Phase 2 |
| 7 | NOAA chart display service vs. self-rendered ENC tiles | Phase 3 |
| 8 | Accounts in v1, or local-only with export codes | Phase 5 |
