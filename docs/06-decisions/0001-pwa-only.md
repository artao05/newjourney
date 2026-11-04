# ADR-0001: PWA only, with no native wrapper

**Status:** accepted
**Date:** 2026-11-04

## Context

Question 1 on the [decision list](README.md): PWA only, or wrapped in Capacitor. The product
spec leaned to "PWA first, wrap with Capacitor when background tracking becomes essential"
([§8](../05-spec/product-spec.md#8-open-questions)), and the roadmap keeps a native wrapper
in [phase 6](../05-spec/roadmap.md#phase-6--depth).

The code settled this without a record. The web manifest and service worker have been there
since the first prototype commit (`de92b4c`, 2026-08-04), and `package.json` has never named
Capacitor. This record was written from the code on `main`, at `0aa1ede`, on 2026-11-04.

## Decision

newjourney ships as an installable PWA and nothing else.

## Consequences

**Easy.** One codebase on every platform. No store review. A push to `main` reaches sailors
through GitHub Pages, and an installed copy picks up the new build, because the service worker
fetches the page network first (`public/sw.js`).

**Hard.**

- No background GPS. The app tracks only while it is open and on screen, which is why it holds
  a wake lock, and why [PILOT.md](../../PILOT.md) asks sailors to turn off auto-lock when the
  browser will not hold one.
- The browser limits any path to a boat's instruments. A page has no UDP or TCP sockets, and an
  HTTPS page can be blocked from `ws://` on a boat's network. The app reads only the phone's GPS
  today (`src/hooks/useSensors.ts`).
- No app-store discovery.

**Foreclosed.** Nothing permanent. A wrapper can come later, with a new record superseding
this one. The spec's trigger, background tracking becoming essential, has no evidence behind it
yet, since no result from a phone on the water is recorded. A phone and hardware plan of
2026-11-03, which is not on `main`, gives a second reason, reaching boat hardware from a phone,
and recommends Capacitor after a one-day spike. The owner has not decided that.

## Alternatives considered

**A Capacitor wrapper.** It would give background GPS, native sockets, better sensors and store
discovery. It would also add two native projects and store review. It was never built, and the
plan above recommends trying it.

**A fully native app.** Nothing in the repo tried it. It would mean at least two codebases, and
the point of the project is the opposite of a heavy install.
