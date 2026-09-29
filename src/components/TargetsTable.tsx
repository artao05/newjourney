/**
 * The targets table: for every wind speed in the polar, the best upwind and
 * downwind angle, the speed there, and the VMG it makes. Expedition's upwind and
 * downwind target views, as the table a crew tapes by the companionway.
 *
 * Derived from the table, never stored, because Expedition derives targets and a
 * stored one goes stale the moment a point is edited.
 */

import { useMemo } from 'react'
import { deriveTargets } from '@/lib/polar'
import type { PolarTable, Targets } from '@/lib/types'

export function targetRows(polar: PolarTable, pct = 100): Targets[] {
  const k = pct / 100
  const out: Targets[] = []
  for (const tws of polar.tws) {
    try {
      const t = deriveTargets(polar, tws)
      out.push({ ...t, upBsp: t.upBsp * k, upVmg: t.upVmg * k, downBsp: t.downBsp * k, downVmg: t.downVmg * k })
    } catch {
      // A row that cannot be derived is left out, not shown as zero.
    }
  }
  return out
}

export function TargetsTable({ polar, polarPct }: { polar: PolarTable; polarPct: number }) {
  const rows = useMemo(() => targetRows(polar, polarPct), [polar, polarPct])
  return (
    <div className="tablewrap">
      <table className="targets" aria-label="Targets">
        <thead>
          <tr>
            <th>TWS</th>
            <th colSpan={3}>Upwind: TWA · BSP · VMG</th>
            <th colSpan={3}>Downwind: TWA · BSP · VMG</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.tws}>
              <td>{t.tws}</td>
              <td>{t.upTwa.toFixed(0)}°</td>
              <td>{t.upBsp.toFixed(2)}</td>
              <td>{t.upVmg.toFixed(2)}</td>
              <td>{t.downTwa.toFixed(0)}°</td>
              <td>{t.downBsp.toFixed(2)}</td>
              <td>{Math.abs(t.downVmg).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">At {polarPct}% of the polar, the Polar % set above.</p>
    </div>
  )
}
