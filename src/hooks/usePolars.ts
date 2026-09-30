/**
 * The polar for each of Expedition's roles, as lookup lattices.
 *
 * Navigation is the loaded polar. Performance and start are either the same
 * table ('navigation') or a class from the library. Built once per table, since
 * a lattice is 18,000 speeds.
 */

import { useMemo } from 'react'
import { useStore } from '@/state/store'
import { findPolar } from '@/data/polars'
import { buildLattice } from '@/lib/polar'
import type { PolarLattice, PolarTable } from '@/lib/types'

/** The polar with its speeds scaled by the wind weight; the same table at 1. */
export function weighted(table: PolarTable | null | undefined, weight: number): PolarTable | null | undefined {
  if (!table || !(weight > 0) || weight === 1) return table
  return { ...table, rows: table.rows.map((r) => ({ ...r, bsp: r.bsp.map((v) => v * weight) })) }
}

function latticeOf(table: PolarTable | null | undefined): PolarLattice | null {
  if (!table) return null
  try {
    return buildLattice(table)
  } catch {
    return null
  }
}

/** The table a role uses: the navigation polar, or a library class. */
export function roleTable(roleId: string, navigation: PolarTable | null): PolarTable | null {
  if (roleId === 'navigation') return navigation
  return findPolar(roleId)?.polar ?? navigation
}

export function usePolarLattices(): {
  navigation: PolarLattice | null
  performance: PolarLattice | null
  start: PolarLattice | null
} {
  const polar = useStore((s) => s.polar)
  const roles = useStore((s) => s.polarRoles)
  const weight = useStore((s) => s.boat.windWeight ?? 1)
  const navigation = useMemo(() => latticeOf(weighted(polar, weight)), [polar, weight])
  const performance = useMemo(
    () => (roles.performance === 'navigation' ? navigation : latticeOf(weighted(roleTable(roles.performance, polar), weight))),
    [roles.performance, navigation, polar, weight],
  )
  const start = useMemo(
    () => (roles.start === 'navigation' ? navigation : latticeOf(weighted(roleTable(roles.start, polar), weight))),
    [roles.start, navigation, polar, weight],
  )
  return { navigation, performance, start }
}
