# ADR-0003: Routing runs on the device, in a Web Worker

**Status:** accepted
**Date:** 2026-11-03

## Context

Question 3 on the [decision list](README.md): client-side or server-side routing as the default.
The product spec leaned to "on-device by default, server as an optional accelerator"
([§8](../05-spec/product-spec.md#8-open-questions)). The
[technical spec](../05-spec/technical-spec.md#5-the-routing-kernel) puts the kernel in a Web
Worker as a pure function of its inputs, and sketches an optional `/route` endpoint for big
problems.

The code settled this without a record: `src/lib/routing/worker.ts` and `isochrone.ts` date from
the first prototype commit (`de92b4c`, 2026-08-04). No server exists on `main` or on
`parity/expedition`. The backend the owner accepted in
[D1](../08-parity/needs.md#1-decisions-only-the-owner-can-make) is a proxy, an ingest and a relay.
It is not built yet (worklist M20), and it has no routing in it. This record was written from the
code on 2026-11-03.

## Decision

All routing runs on the sailor's device, in a Web Worker: isochrone solves and departure sweeps,
and on `parity/expedition` the grid solver and the ensemble and fleet runs too. There is no
server-side routing, not even as an option.

## Consequences

**Easy.** A route costs us no server time. Routing itself sends nothing anywhere and needs no
connection once a forecast is in hand, though fetching that forecast does send its area to
Open-Meteo. The kernel (`isochrone.ts`) has no browser dependency, so it tests in plain Node.

**Hard.** The device is the limit. The time budgets in `src/lib/routing/isochrone.test.ts` run on
a desktop or a CI runner, not a phone, so the spec's phone targets remain unmeasured. An ensemble
or a departure sweep is many solves, one after another, on the sailor's battery. Cancelling kills
the worker, because a cooperative flag would need a yield point in the inner loop.

**Foreclosed.** Nothing. The kernel could move to a server with little change, under a record
superseding this one.

## Alternatives considered

**Server-side by default.** Faster, and it could run larger ensembles, but it needs a connection
on the water, a running service and a cost per route. That is the opposite of
[the spec's principle](../05-spec/product-spec.md#3-product-principles) that offline is the
default assumption.

**On the device, with a server as an optional accelerator.** The spec's lean. It was not built,
and nothing needs it yet.

**WASM for the kernel.** The technical spec allows it "if profiling demands". The kernel is
TypeScript, and the repo has no WASM.
