/**
 * Line icons for the interface, drawn on a 16-unit grid with a 1.5 stroke in
 * the text colour, so they sit with the labels the way icons do on a
 * chartplotter. Decorative: the button around each one carries the name.
 */
import type { ReactNode } from 'react'

export type IconName = 'sun' | 'moon' | 'help' | 'close' | 'up' | 'down' | 'play' | 'pause' | 'expand' | 'sliders' | 'gate' | 'chevron-up' | 'chevron-down' | 'rot-left' | 'rot-right' | 'left' | 'right' | 'crosshair'

const PATHS: Record<IconName, ReactNode> = {
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </>
  ),
  moon: <path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" />
      <path d="M8 11.4v.1" strokeWidth="2" />
    </>
  ),
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  play: <path d="M5 3.2v9.6L12.6 8Z" fill="currentColor" />,
  pause: <path d="M5 3.5v9M11 3.5v9" strokeWidth="2.4" />,
  expand: <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />,
  sliders: (
    <>
      <path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0" />
      <circle cx="10.5" cy="4" r="1.5" />
      <circle cx="5.5" cy="8" r="1.5" />
      <circle cx="12.5" cy="12" r="1.5" />
    </>
  ),
  gate: (
    <>
      <circle cx="3.5" cy="8" r="1.8" />
      <circle cx="12.5" cy="8" r="1.8" />
      <path d="M5.8 8h4.4" strokeDasharray="1.4 1.4" />
    </>
  ),
  'chevron-up': <path d="M4 10l4-4 4 4" />,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'rot-left': <path d="M3.5 6.5A5 5 0 1 1 3 9.5M3.5 2.8v3.7h3.7" />,
  'rot-right': <path d="M12.5 6.5A5 5 0 1 0 13 9.5M12.5 2.8v3.7H8.8" />,
  left: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  right: <path d="M6 3.5L10.5 8 6 12.5" />,
  crosshair: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    </>
  ),
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  )
}
