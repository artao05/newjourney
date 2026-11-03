# ADR-0002: React and TypeScript

**Status:** accepted
**Date:** 2026-11-03

## Context

Question 2 on the [decision list](README.md): React or Svelte. The
[technical spec](../05-spec/technical-spec.md#2-client-stack) said "React + TypeScript (or
Svelte)", that team familiarity dominates, and that TypeScript is non-negotiable in a
math-heavy codebase where unit confusion is the main bug class.

The code settled this without a record: the first prototype commit (`de92b4c`, 2026-08-04) is
React. This record was written from the code on 2026-11-03.

## Decision

The whole UI is React with TypeScript, on `main` and on `parity/expedition`. State is in Zustand
(`src/state/store.ts`), the build is Vite, and MapLibre GL is used directly, with no React
wrapper.

## Consequences

**Easy.** Tests mount the real screens (`src/screens/screens.test.tsx`). The logic stays apart
from the framework: nothing in `src/lib/` imports React, so the routing kernel and the maths
test in plain Node.

**Hard.** React and ReactDOM are a fixed part of every first load. On 2026-11-03 the first load
was 100 KB of gzipped JS on `main` and 215 KB on `parity/expedition`, and no test holds either
to a budget.

**Foreclosed.** Changing framework now means rewriting every screen and component. `src/lib/`
would survive.

## Alternatives considered

**Svelte.** A compiler-based framework has a smaller runtime, which matters on a first load over
a poor dockside connection. No Svelte prototype or size comparison exists in the repo. It lost
because the prototype was written in React, and nothing since has forced a change.
