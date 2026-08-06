/**
 * A number box. Deliberately dumb: it renders a value or a clear em-dash.
 *
 * The em-dash matters. Every field in `TacticalNumbers` and `StartNumbers` is
 * nullable, and showing "0.0" when we actually mean "we don't know" is the
 * failure mode this whole project is trying to avoid.
 */

interface Props {
  label: string
  value: number | string | null | undefined
  unit?: string
  /** Decimal places when `value` is a number. */
  dp?: number
  sub?: string
  tone?: 'stbd' | 'port' | 'warn' | null
  small?: boolean
  onClick?: () => void
}

export function Tile({ label, value, unit, dp = 1, sub, tone, small, onClick }: Props) {
  const known = value !== null && value !== undefined && value !== '' &&
    !(typeof value === 'number' && !Number.isFinite(value))
  const text =
    !known ? '—' : typeof value === 'number' ? value.toFixed(dp) : String(value)

  const cls = [
    'tile',
    known ? '' : 'tile--null',
    tone && known ? `tile--${tone}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const Inner = (
    <>
      <div className="tile__label">{label}</div>
      <div className={`tile__value${small ? ' tile__value--sm' : ''}`}>
        {text}
        {known && unit ? <span className="tile__unit">{unit}</span> : null}
      </div>
      {sub ? <div className="tile__sub">{sub}</div> : null}
    </>
  )

  return onClick ? (
    <button className={cls} onClick={onClick} type="button">
      {Inner}
    </button>
  ) : (
    <div className={cls}>{Inner}</div>
  )
}

/** mm:ss, or -mm:ss after the gun. Handles null. */
export function fmtClock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const neg = seconds < 0
  const s = Math.floor(Math.abs(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${neg ? '-' : ''}${m}:${String(r).padStart(2, '0')}`
}

/**
 * A duration as a coarse human phrase: "12 min", "3 h", "2 days".
 *
 * For elapsed times long enough that precision stops meaning anything. `fmtClock`
 * would render a day-old race timer as "1323:38", which is technically minutes and
 * seconds and practically nonsense.
 */
export function fmtAgo(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s}s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min`
  const hr = s / 3600
  // Days from 24 h, not 36: at a 36 h cutoff `Math.round(36/24)` is already 2, so
  // "1 day" was unreachable. "1 day ago" also reads better than "24 h ago".
  if (hr < 24) return `${Math.round(hr)} h`
  const days = Math.round(hr / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** Signed seconds as +18s / -4s — for time to burn, where the sign is the point. */
export function fmtSigned(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const s = Math.round(seconds)
  if (Math.abs(s) >= 60) {
    const m = Math.floor(Math.abs(s) / 60)
    const r = Math.abs(s) % 60
    return `${s < 0 ? '-' : '+'}${m}:${String(r).padStart(2, '0')}`
  }
  return `${s > 0 ? '+' : ''}${s}s`
}
