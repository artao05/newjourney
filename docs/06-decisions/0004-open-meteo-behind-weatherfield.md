# ADR-0004: Forecasts from Open-Meteo, behind `WeatherField`

**Status:** accepted
**Date:** 2026-11-03

## Context

Question 4 on the [decision list](README.md): the Open-Meteo aggregator, or our own GRIB ingest,
for v1 weather. The research calls Open-Meteo the
[recommended starting point](../02-data-sources/weather-models.md#1-aggregator-open-meteo-recommended-starting-point),
and the [technical spec](../05-spec/technical-spec.md#4-the-weather-pipeline) describes a server
pipeline from GRIB to cubes to a CDN, behind a provider abstraction.

The code settled this without a record. `src/lib/weather/openmeteo.ts` and `field.ts` date from
the first prototype commit (`de92b4c`, 2026-08-04). This record was written from the code on
2026-11-03.

## Decision

The app fetches forecasts from Open-Meteo's hosted API, straight from the browser, into a
`WeatherCube`. Everything downstream reads them through `WeatherField` (`src/lib/types.ts`,
`src/lib/weather/field.ts`). We run no GRIB ingest.

On `parity/expedition`, GRIB files a sailor opens are decoded on the device into the same cube and
field (`src/lib/weather/grib2.ts`, `grib1.ts`). That is reading files, not ingest. Nothing fetches
GRIB yet: the NOMADS and ECMWF download is worklist 20.2, and it needs the backend in
[D1](../08-parity/needs.md#1-decisions-only-the-owner-can-make).

## Consequences

**Easy.** No infrastructure, no key and no schedule to run. A new provider is a new field, and
each sample names its source.

**Hard.**

- Open-Meteo's free tier is for non-commercial use. This record does not decide commercial use,
  which is [still open](README.md#open-only-the-owner-can-settle-these).
- It has a daily request limit. On 2026-09-29, during testing, its marine API answered "Daily API
  request limit exceeded", which leaves routing with wind only.
- The service worker never caches the weather API, so a stale forecast cannot pass as current. So
  a forecast must be fetched with a signal, and there is no offline forecast between sessions.
- Open-Meteo does not say which model run it is serving.

**Foreclosed.** Nothing. A new source has to produce the same cube, as the GRIB readers on
`parity/expedition` do, and what reads `WeatherField` does not change.

## Alternatives considered

**Our own GRIB ingest.** The technical spec's pipeline. It needs a server, a scheduler and storage,
and the prototype had none. It is the likely path if Open-Meteo's terms or limits become a problem.

**NOMADS straight from the browser.** NOMADS sends no CORS headers, so a page cannot fetch it. That
is one of the reasons for D1.

**Self-hosting Open-Meteo.** Its server is AGPL-3.0 and could carry commercial use. That is a
cost for later, if the commercial question is answered yes.
