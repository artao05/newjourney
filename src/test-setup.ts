/**
 * Hand the event loop back to vitest after every test.
 *
 * Vitest's runner goes from one test to the next on promises alone, and the
 * worker only reads the main process's RPC replies when the loop is free. A file
 * of synchronous tests is therefore one unbroken block: isochrone.test.ts runs
 * about two minutes of route solves back to back. A task update sent at the start
 * went unanswered for longer than the RPC's 60 s timeout, and the run failed with
 * `Timeout calling "onTaskUpdate"` even though every assertion passed. One
 * macrotask per test lets the replies land. It costs about a millisecond a test.
 */

import { afterEach } from 'vitest'

// Captured now, before any test can install fake timers, so the yield can never
// wait on a clock that a test has frozen.
const realSetTimeout = globalThis.setTimeout

afterEach(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)))
