# Overview

## The one-paragraph version

Professional sailing tactical software — Expedition, Deckman, Adrena — costs upwards of
€1,250, runs only on Windows, expects a nav station wired to marine instruments, and takes
a season to learn. The data those products are built on is now, almost entirely, free:
ECMWF opened its whole real-time catalogue under CC-BY-4.0, NOAA gives away ENC charts,
tide harmonics and every forecast model it runs, GEBCO gives away global bathymetry, and
OpenStreetMap gives away the coastline. Meanwhile every sailor already carries a
GPS-equipped computer. This project builds the tactical tools those products offer — start
line, laylines, targets, weather routing — as a free, offline-capable web app that a
sixteen-year-old can understand in five minutes.

## Where to start reading

| If you want… | Read |
|---|---|
| The product argument | [../05-spec/product-spec.md](../05-spec/product-spec.md) |
| What we're building first | [../05-spec/mvp-scope.md](../05-spec/mvp-scope.md) |
| What Expedition actually does | [../01-expedition-analysis/feature-inventory.md](../01-expedition-analysis/feature-inventory.md) |
| How Expedition probably does it | [../01-expedition-analysis/how-it-computes.md](../01-expedition-analysis/how-it-computes.md) |
| What data we can legally use | [../02-data-sources/README.md](../02-data-sources/README.md) |
| How the routing algorithm works | [../03-algorithms/routing-isochrone.md](../03-algorithms/routing-isochrone.md) |
| How it gets built | [../05-spec/technical-spec.md](../05-spec/technical-spec.md) |
| Terms you don't recognise | [glossary.md](glossary.md) |

## The three theses

**1. The hard part isn't the algorithm.** Isochrone weather routing is published
literature from the 1980s and there are open implementations. The hard part is that every
existing implementation assumes a user who already knows what a polar, a layline, and a
GRIB are.

**2. The most valuable feature is the one that admits uncertainty.** Expedition's reverse
isochrones let a navigator see *how critical* a route is — whether the optimum is a knife
edge or a broad plateau. It's buried behind two checkboxes and requires interpretation
skill. For a beginner, that information matters more than the route itself, because the
characteristic beginner failure is treating the magenta line as truth. We make it the
default view.

**3. The start line is the wedge.** It needs no weather data, no charts, no polar, and no
backend — just a phone GPS. It's the highest-frequency, highest-stakes 30 seconds in
racing. And dedicated hardware selling for $400–900 does little more than what a phone can
compute for free.

## Non-negotiables

- Never present a computed number as more certain than it is.
- Never require setup before the first useful answer.
- Never assume connectivity.
- Never claim to be a substitute for official charts, official tide data, or judgment.
