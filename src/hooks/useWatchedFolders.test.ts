/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { fileKind } from '@/lib/share'
import { useWeatherFiles } from '@/state/weatherFiles'
import { useTracking } from '@/state/tracking'
import { realFile } from '../realFiles'
import { openWatched } from './useWatchedFolders'

describe('files from watched folders', () => {
  it('knows a file by its name', () => {
    expect(fileKind('gfs.t06z.pgrb2.0p25.f003')).toBe('grib')
    expect(fileKind('saildocs.grb')).toBe('grib')
    expect(fileKind('14983_1.KAP')).toBe('chart')
    expect(fileKind('US5PWMDC.000')).toBe('chart')
    expect(fileKind('ENC_ROOT.zip')).toBe('chart')
    expect(fileKind('positions.csv')).toBe('tracking')
    expect(fileKind('fleet.gpx')).toBe('tracking')
    expect(fileKind('notes.docx')).toBeNull()
  })

  it('opens a GRIB that lands as a weather file, and a position report as tracks', async () => {
    const before = useWeatherFiles.getState().files.length
    const grib = await openWatched({ watch: 'watch:grib', name: 'gfs-portland.grb2', kind: 'auto', size: 0, mtime: Date.now(), bytes: realFile('gfs-portland-20260930-00z-f006.grb2') })
    expect(grib).toMatchObject({ kind: 'grib', ok: true, detail: '3 fields' })
    expect(useWeatherFiles.getState().files).toHaveLength(before + 1)

    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><name>Sea Fever</name><trkseg>
      <trkpt lat="43.64" lon="-70.22"><time>2026-09-30T16:00:00Z</time></trkpt>
      <trkpt lat="43.65" lon="-70.21"><time>2026-09-30T16:10:00Z</time></trkpt></trkseg></trk></gpx>`
    const tracks = useTracking.getState().tracks.length
    const t = await openWatched({ watch: 'watch:reports', name: 'report.gpx', kind: 'auto', size: 0, mtime: Date.now(), bytes: new TextEncoder().encode(gpx) })
    expect(t).toMatchObject({ kind: 'tracking', ok: true })
    expect(useTracking.getState().tracks.length).toBe(tracks + 1)

    expect(await openWatched({ watch: 'w', name: 'notes.docx', kind: 'auto', size: 0, mtime: 0, bytes: new Uint8Array() })).toMatchObject({ ok: false, kind: 'unknown' })
  })
})
