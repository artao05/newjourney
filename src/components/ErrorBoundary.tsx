/**
 * A screen-level error boundary.
 *
 * This is not defensive politeness — it is a safety requirement. A navigation
 * app that white-screens because one derived number threw is worse than useless
 * on the water, because it fails at exactly the moment you were relying on it.
 * A crashed tab must degrade to "this screen is broken", never to a blank page,
 * and the other tabs must keep working.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown to the user so they know which part failed. */
  name: string
  /** Called on retry — lets the parent recreate a failed lazy component. */
  onReset?: () => void
}

interface State {
  hasError: boolean
  /** Whatever was thrown — not necessarily an Error instance. */
  error: unknown
  info: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep the stack where a user can read it back to us; there is no
    // telemetry in this app and there should not be one for a tracking product.
    this.setState({ info: info.componentStack ?? null })
    console.error(`[${this.props.name}]`, error, info.componentStack)
  }

  reset = () => {
    this.props.onReset?.()
    this.setState({ hasError: false, error: null, info: null })
  }

  render() {
    const { hasError, error, info } = this.state
    if (!hasError) return this.props.children

    // Safely extract message and stack from whatever was thrown — it could be
    // an Error, a string, a number, null, or undefined.
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown error')
    const stack = error instanceof Error ? error.stack : undefined

    return (
      <div className="screen panel">
        <div className="errbox">
          <b>The {this.props.name} screen hit a problem.</b>
          <br />
          The other tabs still work. If this keeps happening, the details below
          are what we need to fix it.
        </div>
        <div className="rows">
          <div className="row">
            <span>Error</span>
            <span>{message || String(error)}</span>
          </div>
        </div>
        {info && (
          <details style={{ marginTop: 10 }}>
            <summary className="note" style={{ cursor: 'pointer' }}>
              Show details
            </summary>
            <pre
              style={{
                fontSize: 10,
                lineHeight: 1.5,
                color: 'var(--ink-faint)',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
              }}
            >
              {stack}
              {info}
            </pre>
          </details>
        )}
        <button className="btn btn--sm" onClick={this.reset} style={{ marginTop: 10 }}>
          TRY AGAIN
        </button>
      </div>
    )
  }
}
