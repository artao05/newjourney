/**
 * Setup → Logs: the channel logs kept on this device, a day each, to export as
 * CSV or delete. Logging runs while REC is on.
 */

import { useCallback, useEffect, useState } from 'react'
import { useStore } from '@/state/store'
import { logStore } from '@/lib/logging/idbStore'
import { dayOf, logToCsv, type LogRow } from '@/lib/logging/logger'
import { LogImportError, importLog } from '@/lib/logging/importLog'

export function LogsSection() {
  const recording = useStore((s) => s.recording)
  const [days, setDays] = useState<Array<{ day: string; rows: number }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)

  const importFile = async (file: File) => {
    setError(null)
    setImported(null)
    try {
      const got = importLog(file.name, await file.text())
      const byDay = new Map<string, LogRow[]>()
      for (const r of got.rows) byDay.set(dayOf(r.t), [...(byDay.get(dayOf(r.t)) ?? []), r])
      for (const [day, rows] of byDay) await logStore().append(day, rows)
      const extra = [
        got.skipped ? `${got.skipped} lines skipped` : '',
        got.unknownColumns.length ? `columns not known here: ${got.unknownColumns.slice(0, 6).join(', ')}` : '',
      ].filter(Boolean)
      setImported(
        `Imported ${got.rows.length.toLocaleString()} seconds from ${got.kind.toUpperCase()} into ${byDay.size} day${
          byDay.size === 1 ? '' : 's'
        }${extra.length ? ` (${extra.join('; ')})` : ''}.`,
      )
      await refresh()
    } catch (e) {
      setError(e instanceof LogImportError ? e.message : `Could not read that file: ${e instanceof Error ? e.message : e}`)
    }
  }

  const refresh = useCallback(async () => {
    try {
      setDays((await logStore().days()).sort((a, b) => b.day.localeCompare(a.day)))
    } catch (e) {
      setError(`The logs could not be read: ${e instanceof Error ? e.message : e}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, recording])

  const exportDay = async (day: string) => {
    const { downloadText } = await import('@/lib/gpx')
    downloadText(`log-${day}.csv`, logToCsv(await logStore().read(day)), 'text/csv')
  }

  const deleteDay = async (day: string) => {
    if (!window.confirm(`Delete the log for ${day}? This cannot be undone.`)) return
    await logStore().deleteDay(day)
    await refresh()
  }

  return (
    <section aria-label="Logs">
      <h2>Logs</h2>
      <p className="note">
        While REC is on, every live channel is logged once a second, a log a day. The oldest days go
        first when the logs pass about a week of racing. IMPORT reads a CSV log with a time column and
        channel-named columns, an NMEA recording, or a GPX track.
      </p>
      {error && <p className="warnbox">{error}</p>}
      {days && days.length === 0 && <p className="note">No logs yet.</p>}
      {days && days.length > 0 && (
        <table className="targets" aria-label="Channel logs">
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td style={{ textAlign: 'left' }}>{d.day}</td>
                <td>{d.rows.toLocaleString()} s</td>
                <td>
                  <button className="btn btn--sm btn--ghost" onClick={() => void exportDay(d.day)} aria-label={`Export the log for ${d.day}`}>
                    CSV
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => void deleteDay(d.day)} aria-label={`Delete the log for ${d.day}`}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {imported && <p className="note" role="status">{imported}</p>}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          IMPORT
          <input
            type="file"
            accept=".csv,.txt,.nmea,.log,.gpx,text/csv,text/plain,application/gpx+xml"
            aria-label="Import a log"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void importFile(f)
            }}
          />
        </label>
        <button className="btn btn--sm btn--ghost" onClick={() => void refresh()}>
          REFRESH
        </button>
      </div>
    </section>
  )
}
