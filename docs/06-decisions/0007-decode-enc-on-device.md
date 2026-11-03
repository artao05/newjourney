# ADR-0007: ENC cells decoded on the device

**Status:** accepted, on `parity/expedition` only. `main` has no ENC display.
**Date:** 2026-11-03

## Context

Question 7 on the [decision list](README.md): NOAA's chart display service, or self-rendered ENC
tiles. The [research](../02-data-sources/charts-and-bathymetry.md#strategy) planned the service
for the MVP and our own vector tiles for v1.

`main` did neither. Its chart is an OpenStreetMap and OpenSeaMap raster overlay, and the display
service appears only as a source link in `src/data/venues.ts`.

`parity/expedition` then settled the question a third way, without a record, because Expedition
parity needs the chart's objects as well as its picture. The ISO 8211 and S-57 readers landed on
2026-09-29 (`ed5ee1c`, `547ce78`). This record was written from the code on 2026-11-03. Since
whether the branch merges is [still open](README.md#open-only-the-owner-can-settle-these), this
record says nothing about `main`.

## Decision

On `parity/expedition`, a sailor opens S-57 cells, and the app decodes them itself, in a worker
(`src/lib/charts/iso8211.ts`, `s57.ts`, `s57Worker.ts`). It keeps the raw files in IndexedDB
(`library.ts`) and draws the features as MapLibre GeoJSON layers in a simplified S-52 style
(`s52.ts`). No tiles are pre-rendered, and no chart service or server is involved. BSB/KAP raster
charts are also decoded in a worker (`bsb.ts`) and drawn as image tiles. The base map under them
stays OSM and OpenSeaMap.

## Consequences

**Easy.**

- Cells work with no server, and they stay on the device once opened, with no signal.
- The app holds the features, so it can shade against a safety depth, offer display categories,
  answer chart-object queries, and route against the cells (`encRouting.ts`). A picture from a
  service can do none of that.
- The tile pipeline in [needs.md](../08-parity/needs.md#4-services-and-infrastructure) is no longer
  needed for display.

**Hard.**

- A sailor has to get the cells. None ship with the app.
- The rendition is simplified, and it is not IHO's presentation library. The app stays not for
  navigation.
- We carry our own readers, checked so far on one real cell, NOAA's US5PWMDC, and not against GDAL
  or NOAA's own rendering.
- Decoding speed and the size of an exchange set are limited by the device. That has not been
  measured on a phone.

**Foreclosed.** S-63 encrypted cells stay out of reach on the client, because a web app cannot
hide the manufacturer key ([needs.md §2](../08-parity/needs.md#2-licences-subscriptions-and-agreements)).
This choice did not cause that, but it does not solve it either.

## Alternatives considered

**NOAA's chart display service (WMTS/WMS).** Charts on screen in an afternoon, with NOAA's own
symbology. But it is online only, it is US only, and it is a picture that cannot be queried or
routed against.

**Our own vector tiles from ENC, packaged as PMTiles.** The research's v1 plan, and what the
technical spec assumes. It needs a build machine or backend and a pipeline, and offline regions must
be built ahead of time. It was not built, and no comparison of the two on a phone exists.

**NOAA's MBTiles.** Pre-built offline tile sets, but also a picture.
