/**
 * The not-for-navigation notice: its one wording, and the first-launch dialog.
 *
 * One source for the words, so the dialog a sailor accepts and the Setup copy
 * they can reread never say different things.
 */

export function NotForNavigationText() {
  return (
    <>
      This is a prototype. Nothing here replaces official charts, official tide tables, or your
      own judgment. Routing output is derived from weather forecasts, which are uncertain by
      nature. The skipper is responsible for the safety of the vessel and crew.
    </>
  )
}

/**
 * Shown once, before first use. Setup is where a careful reader finds the notice;
 * this is where everyone else does. Without it a sailor who never opens Setup is
 * never told, and the numbers on the Start tab look as authoritative as an
 * instrument's.
 */
export function NotForNavigationDialog({ onAccept }: { onAccept: () => void }) {
  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nfn-title"
      aria-describedby="nfn-text"
    >
      <div className="modal__card">
        <h2 id="nfn-title">Not for navigation</h2>
        <p id="nfn-text" className="warnbox">
          <NotForNavigationText />
        </p>
        <button className="btn btn--primary" autoFocus onClick={onAccept}>
          I UNDERSTAND
        </button>
      </div>
    </div>
  )
}
