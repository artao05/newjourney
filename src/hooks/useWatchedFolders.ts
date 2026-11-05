/**
 * Files from the folders the bridge watches (bridge/watch.ts), opened as
 * they land, each as if it had been picked: a GRIB into the weather files, a
 * raster chart or ENC cell onto the chart, a position report into tracking.
 */
import { useEffect } from 'react'
import { useStore } from '@/state/store'
import { fileKind, ShareLink, type WatchedFile } from '@/lib/share'

/**
 * Open one file as its kind says; say what became of it.
 *
 * The decoders load here, when a file lands. This hook runs on every phone, few of
 * which will ever watch a folder, and importing them above put the GRIB, chart and
 * tracking code in the first download.
 */
export async function openWatched(f: WatchedFile): Promise<{ kind: string; ok: boolean; detail: string }> {
  const kind = f.kind === 'auto' ? fileKind(f.name) : f.kind
  const file = () => new File([f.bytes.slice()], f.name, { lastModified: f.mtime })
  try {
    if (kind === 'grib') {
      const { openWeatherFiles } = await import('@/state/weatherFiles')
      const [w] = await openWeatherFiles([file()])
      return { kind, ok: !w?.error, detail: w?.error ?? `${w?.catalogue.length ?? 0} fields` }
    }
    if (kind === 'chart') {
      const { installChartFiles, openRasterFile } = await import('@/state/charts')
      if (/\.kap$/i.test(f.name)) {
        const r = await openRasterFile(f.name, f.bytes)
        return { kind, ok: true, detail: `${r.name}, 1:${r.scale.toLocaleString('en-US')}` }
      }
      const r = await installChartFiles([{ name: f.name, bytes: f.bytes }])
      return { kind, ok: r.errors.length === 0, detail: r.errors[0] ?? `${r.installed.length} cell${r.installed.length === 1 ? '' : 's'}` }
    }
    if (kind === 'tracking') {
      const { importTrackingFiles } = await import('@/state/tracking')
      const r = await importTrackingFiles([file()], useStore.getState().fleet)
      return { kind, ok: r.errors.length === 0, detail: r.errors[0] ?? `${r.tracks} track${r.tracks === 1 ? '' : 's'}, ${r.matched} matched` }
    }
    return { kind: 'unknown', ok: false, detail: 'not a GRIB, chart or position report by its name' }
  } catch (e) {
    return { kind: kind ?? 'unknown', ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export function useWatchedFolders(): void {
  const on = useStore((s) => s.settings.watchFolders?.on ?? false)
  const url = useStore((s) => s.settings.watchFolders?.url ?? '')
  useEffect(() => {
    if (!on || !url) return
    const link = new ShareLink(url, {
      onShared: () => undefined,
      onFile: (f) => {
        void openWatched(f).then((r) => useStore.getState().logWatched({ name: f.name, ...r }))
      },
    })
    link.start()
    return () => link.stop()
  }, [on, url])
}
