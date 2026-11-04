# ADR-0004: Forecasts from Open-Meteo, into a `WeatherCube`

**Status:** accepted
**Date:** 2026-11-04

## Context

Question 4 on the [decision list](README.md): the Open-Meteo aggregator, or our own GRIB ingest,
for v1 weather. The research calls Open-Meteo the
[recommended starting point](../02-data-sources/weather-models.md#1-aggregator-open-meteo-recommended-starting-point),
and the [technical spec](../05-spec/technical-spec.md#4-the-weather-pipeline) describes a server
pipeline from GRIB to cubes to a CDN, behind a provider abstraction.

The code settled this without a record. `src/lib/weather/openmeteo.ts` and `field.ts` date from
the first prototype commit (`de92b4c`, 2026-08-04). This record was written from the code on
`main`, at `0aa1ede`, on 2026-11-04.

## Decision

The app fetches forecasts from Open-Meteo's hosted API, straight from the browser, into a
`WeatherCube`. The router reads the cube through `WeatherField` (`src/lib/types.ts`,
`src/lib/weather/field.ts`), and the Weather tab's layers read it directly. The wind chip's forecast
is a point request to the same API. We run no GRIB ingest.

## Consequences

**Easy.** No infrastructure, no key and no schedule to run. To the router, a new provider is a new
field, and each wind and current sample names its source.

**Hard.**

- Open-Meteo's free tier is for non-commercial use. This record does not decide commercial use,
  which is [still open](README.md#open-only-the-owner-can-settle-these).
- It has request limits. On 2026-09-29, during testing, its marine API answered "Daily API request
  limit exceeded", which leaves routing with wind only. On 2026-11-04, also during testing, its
  forecast API answered "Hourly API request limit exceeded", which leaves Route with no forecast.
- The service worker never caches the weather API, so a stale forecast cannot pass as current. So
  a forecast must be fetched with a signal, and there is no offline forecast between sessions.
- Open-Meteo does not say which model run it is serving.

**Foreclosed.** Nothing. A new source has to produce the same cube, and what reads the cube does
not change.

## Alternatives considered

**Our own GRIB ingest.** The technical spec's pipeline. It needs a server, a scheduler and storage,
and the prototype had none. It is the likely path if Open-Meteo's terms or limits become a problem.

**NOMADS straight from the browser.** NOMADS sent no CORS headers when checked on 2026-11-04, so a
page cannot fetch it.

**Self-hosting Open-Meteo.** Its server is AGPL-3.0 and could carry commercial use. That is a
cost for later, if the commercial question is answered yes.
