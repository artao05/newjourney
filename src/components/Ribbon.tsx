/**
 * The command ribbon of the nav station: the screens as text tabs across the
 * top, and under them the commands of the chart on show, in labelled groups,
 * so nothing hides in a chip over the chart. A screen puts its commands in with
 * <RibbonGroups>, a portal into the ribbon; on the phone there is no ribbon
 * and the same commands stay where they were. The status bar along the foot
 * works the same way, with <StatusItems>.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The ribbon's command row, where the chart screen's groups go; null off the nav station. */
export const RibbonContext = createContext<HTMLElement | null>(null)

export function useRibbon(): HTMLElement | null {
  return useContext(RibbonContext)
}

/** One group of commands with its caption under it, as ribbons have. */
export function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ribbon__group" role="group" aria-label={label}>
      <div className="ribbon__items">{children}</div>
      <span className="ribbon__caption">{label}</span>
    </div>
  )
}

/** A screen's command groups, in the ribbon when there is one. */
export function RibbonGroups({ children }: { children: ReactNode }) {
  const slot = useRibbon()
  return slot ? createPortal(children, slot) : null
}

/** The status bar along the foot of the nav station, where the chart screen says what it is working from. */
export const StatusBarContext = createContext<HTMLElement | null>(null)

/** A screen's status items, in the status bar when there is one. */
export function StatusItems({ children }: { children: ReactNode }) {
  const slot = useContext(StatusBarContext)
  return slot ? createPortal(children, slot) : null
}
