/**
 * The marks library, in folders: Expedition's marks database.
 *
 * Imported GPX files land here, one folder per file, and so does any course
 * saved for later. A course is then built from them: one mark at a time with
 * ADD, or a whole folder with USE AS COURSE. The library is kept apart from the
 * course, so clearing a race's marks never loses the season's buoys.
 */

import { useMemo, useState } from 'react'
import { useStore, type LibraryMark } from '@/state/store'
import { fmtPosition } from '@/components/MarkSheet'

export function MarksLibrary() {
  const library = useStore((s) => s.library)
  const course = useStore((s) => s.course)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const removeFromLibrary = useStore((s) => s.removeFromLibrary)
  const addMark = useStore((s) => s.addMark)
  const replaceMarks = useStore((s) => s.replaceMarks)
  const [open, setOpen] = useState<string | null>(null)

  const folders = useMemo(() => {
    const by = new Map<string, LibraryMark[]>()
    for (const m of library) by.set(m.folder, [...(by.get(m.folder) ?? []), m])
    return [...by.entries()]
  }, [library])

  /** GPX, or Expedition's marks CSV, whose group column names the folders. */
  const importFile = async (file: File) => {
    const fallback = file.name.replace(/\.[^.]+$/, '') || 'Imported'
    try {
      const text = await file.text()
      if (/\.csv$/i.test(file.name)) {
        const { parseMarksCsv } = await import('@/lib/marksCsv')
        const { marks, skipped } = parseMarksCsv(text)
        if (marks.length === 0) {
          alert('No marks could be read from that CSV.')
          return
        }
        const byFolder = new Map<string, typeof marks>()
        for (const m of marks) {
          const f = m.folder ?? fallback
          byFolder.set(f, [...(byFolder.get(f) ?? []), m])
        }
        for (const [f, ms] of byFolder) addToLibrary(f, ms)
        setOpen([...byFolder.keys()][0])
        if (skipped > 0) alert(`${marks.length} marks filed; ${skipped} lines could not be read and were skipped.`)
        return
      }
      const { parseGpx } = await import('@/lib/gpx')
      const parsed = parseGpx(text)
      if (parsed.waypoints.length === 0) {
        alert('That GPX has no waypoints or route points to file.')
        return
      }
      addToLibrary(fallback, parsed.waypoints)
      setOpen(fallback)
    } catch (err) {
      alert(`Could not read that file: ${err instanceof Error ? err.message : err}`)
    }
  }

  const exportFolder = async (folder: string, marks: LibraryMark[], as: 'csv' | 'gpx' | 'table') => {
    const { downloadText, marksToGpx } = await import('@/lib/gpx')
    const { marksToCsv, rangeBearingTable } = await import('@/lib/marksCsv')
    const safe = folder.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'marks'
    if (as === 'gpx') {
      downloadText(`${safe}.gpx`, marksToGpx(marks.map((m) => ({ ...m, roundTo: 'port' as const })), folder))
    }
    else if (as === 'csv') downloadText(`${safe}.csv`, marksToCsv(marks), 'text/csv')
    else downloadText(`${safe}-ranges.csv`, rangeBearingTable(marks), 'text/csv')
  }

  return (
    <section aria-label="Marks library">
      <h2>Marks library</h2>
      {folders.length === 0 && (
        <p className="note">
          Empty. Import a GPX of the club&apos;s marks, or save a course here to use it
          again.
        </p>
      )}
      {folders.map(([folder, marks]) => (
        <div key={folder} className="libfolder">
          <button
            className="libfolder__head"
            aria-expanded={open === folder}
            onClick={() => setOpen(open === folder ? null : folder)}
          >
            {open === folder ? '▾' : '▸'} {folder} <span className="note">{marks.length}</span>
          </button>
          {open === folder && (
            <>
              {marks.map((m) => (
                <div className="row" key={m.id}>
                  <span>
                    {m.name}
                    <br />
                    <span className="note">{fmtPosition(m.position)}</span>
                  </span>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => addMark(m.name, m.position)}
                    aria-label={`Add ${m.name} to the course`}
                  >
                    ADD
                  </button>
                </div>
              ))}
              <div className="actions" style={{ background: 'none', border: 'none', padding: '6px 0' }}>
                <button className="btn btn--sm" onClick={() => replaceMarks(marks)}>
                  USE AS COURSE
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => removeFromLibrary(marks.map((m) => m.id))}
                >
                  DELETE FOLDER
                </button>
              </div>
              <div className="actions" style={{ background: 'none', border: 'none', padding: '0 0 6px' }}>
                <button className="btn btn--sm btn--ghost" onClick={() => void exportFolder(folder, marks, 'csv')}>
                  CSV
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => void exportFolder(folder, marks, 'gpx')}>
                  GPX
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => void exportFolder(folder, marks, 'table')}
                  title="Range and bearing between every pair of marks, as a CSV table"
                >
                  TABLE
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
        <label className="btn btn--sm btn--ghost" style={{ display: 'block', textAlign: 'center' }}>
          IMPORT GPX / CSV
          <input
            type="file"
            accept=".gpx,.csv,application/gpx+xml,text/csv"
            aria-label="Import marks into the library"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
        </label>
        <button
          className="btn btn--sm btn--ghost"
          disabled={course.marks.length === 0}
          onClick={() => {
            const folder = `Course ${new Date().toISOString().slice(0, 10)}`
            addToLibrary(folder, course.marks)
            setOpen(folder)
          }}
        >
          SAVE COURSE HERE
        </button>
      </div>
    </section>
  )
}
