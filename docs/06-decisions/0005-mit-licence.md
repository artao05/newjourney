# ADR-0005: MIT for the code

**Status:** accepted
**Date:** 2026-11-04

## Context

Question 5 on the [decision list](README.md): MIT or Apache-2.0, before first public release. The
[licensing matrix](../02-data-sources/licensing-matrix.md#6-recommended-licence-for-this-project)
proposed "MIT (or Apache-2.0 if we want the patent grant)".

The code settled this without a record. `LICENSE` has been MIT since the first commit (`6df4f84`,
2026-08-04), and the repository and the Pages site are public. This record was written from the
repo on `main`, at `0aa1ede`, on 2026-11-04.

## Decision

- Application code: MIT.
- Documentation: CC BY 4.0, as `LICENSE` and the README say.
- The land mask derives from OpenStreetMap, so `src/data/landmask.ts` and
  `public/venue/portland-land.bin` are ODbL 1.0, as the file's header says.
- Third-party data keeps its own licence.

## Consequences

**Easy.** Anyone can use the code, including in a closed product. A paid hosted service could sit
beside it later, though this record does not decide that: commercial use is
[still open](README.md#open-only-the-owner-can-settle-these).

**Hard.**

- MIT has no explicit patent grant.
- GPL code stays out, as [the matrix](../02-data-sources/licensing-matrix.md#5-gpl-contamination--the-real-risk)
  says. OpenCPN and XTide can be read but not copied or linked. Tide predictions come from NOAA's
  API and the magnetic variation is one NOAA figure (`src/data/venues.ts`), so nothing here needs
  their code.
- `LICENSE` names MIT, gives `docs/` as CC BY 4.0, and points to the matrix for third-party data.
  It does not name ODbL. The land mask's exception is stated only in the README and in
  `landmask.ts`, and the mask has not been split into a separately licensed data package, which is
  what the matrix recommends.

**Foreclosed.** Relicensing gets harder as contributors arrive, since the copyright line reads
"newjourney contributors".

## Alternatives considered

**Apache-2.0.** The patent grant is the reason to prefer it. Nothing in the repo records anyone
needing that grant, and `LICENSE` was MIT from the start.

**GPL.** It would allow linking the GPL prior art, but it would rule out the split the matrix
describes.
