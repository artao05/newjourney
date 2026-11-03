# ADR-0008: No accounts; everything stays on the device

**Status:** accepted
**Date:** 2026-11-03

## Context

Question 8 on the [decision list](README.md): accounts in v1, or local-only with export codes. The
product spec said "probably not until fleet sharing"
([§8](../05-spec/product-spec.md#8-open-questions)), and the
[technical spec](../05-spec/technical-spec.md#9-security-and-privacy) calls position data the most
sensitive thing here, and local by default.

The code settled this without a record: there has never been sign-in code or a server to sign in
to. This record was written from the code on 2026-11-03.

## Decision

There are no accounts, on `main` or on `parity/expedition`. Everything a sailor sets or records
stays in that browser: settings, the boat and the course in `localStorage` (`newjourney.v1`), the
track under its own key (`newjourney.track.v1`), and on `parity/expedition` logs and chart cells in
IndexedDB too.

Things move between devices as files. On `main`, that is the track and the course as GPX. On
`parity/expedition`, it is also the configuration as JSON (`src/lib/config.ts`), marks as CSV, and
polars as text. The "export codes" in the question were not built. Files did the job.

## Consequences

**Easy.** The first useful answer needs no sign-up. There is no server to run, and we hold no
personal or position data. Fetching a forecast does send Open-Meteo its area, or a position rounded
to 0.01°.

**Hard.**

- A browser that clears its data takes everything with it, and there is no restore beyond the
  files a sailor exported.
- There is no sync between a phone and a laptop.
- Sharing between copies of the app on `parity/expedition` runs through the bridge, with a shared
  key between linked bridges (`--key`), and not through an identity.
- §4 of the [licensing matrix](../02-data-sources/licensing-matrix.md) speaks of storing an ORC
  certificate in the user's account. There is no such account, and that question is
  [still open](README.md#open-only-the-owner-can-settle-these).

**Foreclosed.** Nothing. The planned relay for sharing over the internet (worklist 20.4, not built)
is the first thing likely to need an identity. If it does, a new record supersedes this one.

## Alternatives considered

**Accounts in v1.** They would bring sync and a home for fleet membership. They would also bring a
database, a backend and privacy duties, and nothing built so far needs them.

**Export codes.** The spec's idea: a short code to carry settings across. Files are simpler, and
they also work with other tools.
