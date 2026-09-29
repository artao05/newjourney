import { describe, expect, it } from 'vitest'
import { boatByMmsi, boatByTrackerName, fleetPolar } from './fleet'
import { POLAR_LIBRARY } from '@/data/polars'

const fleet = [
  { id: 'a', name: 'Wild Horses', sailNumber: 'USA-50', mmsi: 367000001, polarId: 'navigation' },
  { id: 'b', name: 'Sea Fever', trackerId: 'seafever', polarId: POLAR_LIBRARY[1].id },
  { id: 'c', name: 'Blue Moon' },
]

describe('the boats database', () => {
  it('finds a boat by her MMSI, and by what a tracker calls her', () => {
    expect(boatByMmsi(fleet, 367000001)?.id).toBe('a')
    expect(boatByMmsi(fleet, 1)).toBeUndefined()
    expect(boatByTrackerName(fleet, 'usa 50')?.id).toBe('a')
    expect(boatByTrackerName(fleet, 'SEAFEVER')?.id).toBe('b')
    expect(boatByTrackerName(fleet, 'blue-moon')?.id).toBe('c')
    expect(boatByTrackerName(fleet, '')).toBeUndefined()
  })

  it('gives each boat her polar: ours, a class, or none', () => {
    const ours = POLAR_LIBRARY[0].polar
    expect(fleetPolar(fleet[0], POLAR_LIBRARY, ours)).toBe(ours)
    expect(fleetPolar(fleet[1], POLAR_LIBRARY, ours)).toBe(POLAR_LIBRARY[1].polar)
    expect(fleetPolar(fleet[2], POLAR_LIBRARY, ours)).toBeNull()
  })
})
