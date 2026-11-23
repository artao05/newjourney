/**
 * Boats the app knows. Each polar comes from the engine's own velocity
 * prediction (src/lib/polar.ts generatePolar), so a new boat needs only its
 * dimensions. A learned correction from the coach is applied on top (learn.ts).
 */
import { buildLattice, generatePolar, type BoatDims } from '@/lib/polar'
import type { PolarLattice, PolarTable } from '@/lib/types'

export interface BoatPreset {
  id: string
  name: string
  blurb: string
  dims: BoatDims
  /** Time for a tack, seconds, for a crew doing it well. */
  tackS: number
  /** Fraction of speed kept through a good tack. */
  tackKeep: number
}

export const BOATS: BoatPreset[] = [
  {
    id: 'j70',
    name: 'J/70',
    blurb: 'One-design sportboat, 23 ft. Fast, forgiving, great for learning.',
    dims: { type: 'sportboat', loaM: 6.93, lwlM: 6.25, beamM: 2.25, dispKg: 794, sailAreaM2: 22.3 },
    tackS: 7,
    tackKeep: 0.62,
  },
  {
    id: 'laser',
    name: 'Single-hander dinghy',
    blurb: '14 ft dinghy. Tacks fast, very sensitive to pointing.',
    dims: { type: 'dinghy', loaM: 4.23, lwlM: 3.81, beamM: 1.37, dispKg: 130, sailAreaM2: 7.06 },
    tackS: 5,
    tackKeep: 0.55,
  },
  {
    id: 'j105',
    name: 'J/105',
    blurb: '35 ft keelboat with a sprit. Classic club racer.',
    dims: { type: 'keelboat', loaM: 10.5, lwlM: 8.97, beamM: 3.35, dispKg: 3_810, sailAreaM2: 53.7 },
    tackS: 9,
    tackKeep: 0.7,
  },
  {
    id: 'cruiser40',
    name: '40 ft cruiser-racer',
    blurb: 'Comfortable 40-footer. Slow tacks, holds speed well.',
    dims: { type: 'cruiser', loaM: 12.2, lwlM: 10.7, beamM: 3.9, dispKg: 8_200, sailAreaM2: 80 },
    tackS: 12,
    tackKeep: 0.72,
  },
]

export interface BoatModel {
  preset: BoatPreset
  polar: PolarTable
  lattice: PolarLattice
}

const cache = new Map<string, BoatModel>()

export function boatModel(id: string): BoatModel {
  const hit = cache.get(id)
  if (hit) return hit
  const preset = BOATS.find((b) => b.id === id) ?? BOATS[0]!
  const polar = generatePolar(preset.dims, preset.name)
  const lattice = buildLattice(polar, { twsMax: 40, twsStep: 0.5, twaStep: 1 })
  const m = { preset, polar, lattice }
  cache.set(id, m)
  return m
}
