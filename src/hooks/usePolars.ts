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
  const navigation = useMemo(() => latticeOf(polar), [polar])
  const performance = useMemo(
    () => (roles.performance === 'navigation' ? navigation : latticeOf(roleTable(roles.performance, polar))),
    [roles.performance, navigation, polar],
  )
  const start = useMemo(
    () => (roles.start === 'navigation' ? navigation : latticeOf(roleTable(roles.start, polar))),
    [roles.start, navigation, polar],
  )
  return { navigation, performance, start }
}
