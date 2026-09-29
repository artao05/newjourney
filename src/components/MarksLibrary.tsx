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

  const importGpx = async (file: File) => {
    try {
      const { parseGpx } = await import('@/lib/gpx')
      const parsed = parseGpx(await file.text())
      if (parsed.waypoints.length === 0) {
        alert('That GPX has no waypoints or route points to file.')
        return
      }
      const folder = file.name.replace(/\.[^.]+$/, '') || 'Imported'
      addToLibrary(folder, parsed.waypoints)
      setOpen(folder)
    } catch (err) {
      alert(`Could not read that GPX: ${err instanceof Error ? err.message : err}`)
    }
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
            </>
          )}
        </div>
      ))}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0' }}>
        <label className="btn btn--sm btn--ghost" style={{ display: 'block', textAlign: 'center' }}>
          IMPORT GPX
          <input
            type="file"
            accept=".gpx,application/gpx+xml"
            aria-label="Import GPX into the library"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importGpx(f)
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
