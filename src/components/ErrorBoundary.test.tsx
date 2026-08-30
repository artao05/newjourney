/**
 * The screen-level error boundary.
 *
 * Its own docstring calls this "not defensive politeness — a safety
 * requirement", on the grounds that an app which white-screens fails at exactly
 * the moment you were relying on it. It had no test, which is an odd place to
 * leave the thing that is supposed to hold when everything else has not.
 *
 * A boundary is also the one component whose passing tests prove least by
 * default: it renders its children, and children that do not throw exercise
 * none of it. Every case here throws on purpose.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * React logs every caught error to `console.error` regardless of the boundary,
 * so the noise is expected rather than a symptom. Silenced, but captured, so a
 * test can still assert the report actually happens.
 */
let logged: unknown[][] = []

beforeEach(() => {
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

function Boom({ when = true, message = 'derived number exploded' }): React.ReactElement {
  if (when) throw new Error(message)
  return <p>recovered content</p>
}

describe('when nothing goes wrong', () => {
  it('is invisible and renders its children', () => {
    render(
      <ErrorBoundary name="Race">
        <p>live numbers</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('live numbers')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/hit a problem/)
  })
})

describe('when a screen throws', () => {
  it('degrades to a message naming the screen, not a blank page', () => {
    render(
      <ErrorBoundary name="Race">
        <Boom />
      </ErrorBoundary>,
    )
    // The name matters: "something broke" does not tell a sailor which of five
    // tabs to stop trusting.
    expect(screen.getByText(/The Race screen hit a problem/)).toBeTruthy()
    expect(document.body.textContent).toContain('derived number exploded')
    expect(document.body.textContent).not.toBe('')
  })

  it('says the other tabs still work, because they do', () => {
    render(
      <ErrorBoundary name="Weather">
        <Boom />
      </ErrorBoundary>,
    )
    expect(document.body.textContent).toMatch(/other tabs still work/)
  })

  it('reports the failure where a user can read it back', () => {
    // No telemetry in this app by design, so the console is the only channel and
    // the screen name has to be in it.
    render(
      <ErrorBoundary name="Start">
        <Boom />
      </ErrorBoundary>,
    )
    expect(logged.some((args) => String(args[0]).includes('[Start]'))).toBe(true)
  })

  it('keeps the stack behind a disclosure rather than in the way', () => {
    render(
      <ErrorBoundary name="Route">
        <Boom />
      </ErrorBoundary>,
    )
    const details = document.querySelector('details')
    expect(details).not.toBeNull()
    // Collapsed: the person reading this is on a boat, not triaging a bug.
    expect((details as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByText('Show details')).toBeTruthy()
  })

  it('survives a thrown value that is not an Error', () => {
    // `error.message || String(error)` exists for this. A string thrown from a
    // library would otherwise render as an empty message next to the label.
    function ThrowString(): React.ReactElement {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'the polar file is not a polar'
    }
    render(
      <ErrorBoundary name="Setup">
        <ThrowString />
      </ErrorBoundary>,
    )
    expect(document.body.textContent).toContain('the polar file is not a polar')
  })

  it('catches a falsy thrown value instead of white-screening', () => {
    function ThrowZero(): React.ReactElement {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 0
    }
    render(
      <ErrorBoundary name="Race">
        <ThrowZero />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/The Race screen hit a problem/)).toBeTruthy()
    expect(document.body.textContent).not.toBe('')
  })
})

describe('recovery', () => {
  it('retries the screen when asked, and shows it when the cause has gone', () => {
    /*
     * TRY AGAIN is only honest if the boundary really re-renders the child. A
     * reset that cleared the message without retrying would look identical until
     * the moment it mattered.
     */
    let fails = true
    function Flaky(): React.ReactElement {
      return <Boom when={fails} />
    }
    const view = render(
      <ErrorBoundary name="Race">
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/hit a problem/)).toBeTruthy()

    fails = false
    fireEvent.click(screen.getByText('TRY AGAIN'))
    expect(screen.getByText('recovered content')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/hit a problem/)
    view.unmount()
  })

  it('shows the failure again if the cause has not gone', () => {
    render(
      <ErrorBoundary name="Race">
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByText('TRY AGAIN'))
    // Not a regression: a boundary that hid a still-broken screen would be worse
    // than one that admits it.
    expect(screen.getByText(/hit a problem/)).toBeTruthy()
  })

  it('calls onReset so a parent can recreate a failed lazy component', () => {
    const onReset = vi.fn()
    let fails = true
    function Flaky(): React.ReactElement {
      return <Boom when={fails} />
    }
    render(
      <ErrorBoundary name="Route" onReset={onReset}>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/hit a problem/)).toBeTruthy()
    expect(onReset).not.toHaveBeenCalled()

    fails = false
    fireEvent.click(screen.getByText('TRY AGAIN'))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(screen.getByText('recovered content')).toBeTruthy()
  })

  it('starts clean for a different screen, so a crash does not follow you', () => {
    /*
     * What this pins is narrow, and worth saying so: a *fresh* boundary starts
     * clean. The remount itself comes from `App.tsx`, which gives each tab its
     * own `key` and renders only the active one — that is the half which makes
     * "the other tabs still work" true rather than aspirational, and it lives in
     * a file this test cannot reach.
     *
     * Recorded because the alternative is worse: a single shared boundary would
     * go on showing "the Race screen hit a problem" while the user stood on
     * Setup, and nothing here or in App.test.tsx would notice.
     */
    const { rerender } = render(
      <ErrorBoundary name="Race" key="race">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/The Race screen hit a problem/)).toBeTruthy()

    rerender(
      <ErrorBoundary name="Setup" key="setup">
        <p>setup content</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('setup content')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/hit a problem/)
  })
})
