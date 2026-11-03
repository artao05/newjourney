# ADR-0001: PWA only, with no native wrapper

**Status:** accepted
**Date:** 2026-11-03

## Context

Question 1 on the [decision list](README.md): PWA only, or wrapped in Capacitor. The product
spec leaned to "PWA first, wrap with Capacitor when background tracking becomes essential"
([§8](../05-spec/product-spec.md#8-open-questions)), and the roadmap keeps a native wrapper
in [phase 6](../05-spec/roadmap.md#phase-6--depth).

The code settled this without a record. The web manifest and service worker have been there
since the first prototype commit (`de92b4c`, 2026-08-04), and `package.json` has never named
Capacitor. This record was written from the code on 2026-11-03.

## Decision

newjourney ships as an installable PWA and nothing else, on `main` and on
`parity/expedition`. The nav-station layout on that branch is the same PWA on a wider screen.
`bridge/`, also on that branch, is a separate and optional Node program for what a browser
cannot reach. It does not wrap the app, and the app runs without it.

## Consequences

**Easy.** One codebase on every platform. No store review. A push to `main` reaches sailors
through GitHub Pages, and an installed copy picks up the new build, because the service worker
fetches the page network first (`public/sw.js`).

**Hard.**

- No background GPS. The app tracks only while it is open and on screen, which is why it holds
  a wake lock, and why [PILOT.md](../../PILOT.md) asks sailors to turn off auto-lock when the
  browser will not hold one.
- The browser limits the instrument paths. Web Serial needs Chrome or Edge on a computer. There
  are no UDP or TCP sockets, hence the bridge. An HTTPS page cannot open `ws://` on a boat's
  network, and Setup warns about that.
- No app-store discovery.

**Foreclosed.** Nothing permanent. A wrapper can come later, with a new record superseding
this one. The spec's trigger, background tracking becoming essential, has no evidence behind it
yet, since no result from a phone on the water is recorded.

## Alternatives considered

**A Capacitor wrapper.** It would give background GPS, better sensors and store discovery. It
would also add two native projects and store review, for a need nobody has yet shown. It was
never built.

**A fully native app.** Nothing in the repo tried it. It would mean at least two codebases, and
the point of the project is the opposite of a heavy install.
