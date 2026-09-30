/**
 * Race notes: the list on Race, and the sheet that edits one.
 *
 * A note is drawn on the Route chart (point, line or area) and then given its
 * text here. An area can also tell the router to keep out, or to expect the boat
 * to be slower inside it. That is how Expedition's race notes double as exclusion
 * zones and speed penalties.
 */

import { useState } from 'react'
import { useStore, type RaceNote } from '@/state/store'
import { notesFromGeoJSON, notesFromText, notesToGeoJSON } from '@/lib/raceNotesFile'

export function RaceNoteSheet({ note, onClose }: { note: RaceNote; onClose: () => void }) {
  const update = useStore((s) => s.updateRaceNote)
  const remove = useStore((s) => s.removeRaceNote)
  return (
    <div className="sheet" role="dialog" aria-label="Edit race note">
      <div className="sheet__grip" onClick={onClose} />
      <div className="field field--wide">
        <label htmlFor="note-text">Note</label>
        <input
          id="note-text"
          value={note.text}
          placeholder={note.kind === 'area' ? 'e.g. Traffic separation scheme' : 'e.g. Shoal, keep north'}
          onChange={(e) => update(note.id, { text: e.target.value })}
        />
      </div>
      {note.kind === 'area' && (
        <>
          <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={note.avoid}
              onChange={(e) => update(note.id, { avoid: e.target.checked })}
              aria-label="Routes keep out of this area"
            />
            <span>Routes keep out of this area</span>
          </label>
          <div className="field">
            <label htmlFor="note-speed">
              Boat speed inside <span className="note">% of polar</span>
            </label>
            <input
              id="note-speed"
              type="number"
              min="1"
              max="200"
              step="5"
              placeholder="unchanged"
              value={note.speedPct ?? ''}
              disabled={note.avoid}
              onChange={(e) => {
                const v = Number(e.target.value)
                update(note.id, {
                  speedPct: e.target.value.trim() === '' || !(v > 0) ? null : Math.min(200, v),
                })
              }}
              inputMode="numeric"
            />
          </div>
          <p className="note">
            Keep-out areas are for traffic schemes, exclusion zones in the sailing
            instructions, or ice. A speed below 100 % is for weed, a foul tide
            pocket, or a wind hole you trust more than the forecast.
          </p>
        </>
      )}
      <div className="actions">
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            remove(note.id)
            onClose()
          }}
        >
          DELETE NOTE
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          DONE
        </button>
      </div>
    </div>
  )
}

export function describeNote(n: RaceNote): string {
  if (n.kind !== 'area') return n.kind
  if (n.avoid) return 'area · keep out'
  if (n.speedPct != null) return `area · ${n.speedPct}% speed`
  return 'area'
}

export function RaceNotesList() {
  const notes = useStore((s) => s.raceNotes)
  const [editing, setEditing] = useState<string | null>(null)
  const [fileMsg, setFileMsg] = useState<string | null>(null)
  // Opening adds to the notes there are: files merge, as Expedition's do.
  const open = async (files: File[]) => {
    const add = useStore.getState().addRaceNote
    let n = 0
    const bad: string[] = []
    for (const f of files) {
      const text = await f.text()
      try {
        const got = /^\s*[{[]/.test(text) ? notesFromGeoJSON(text) : notesFromText(text).notes
        for (const note of got) add(note)
        n += got.length
        if (!got.length) bad.push(f.name)
      } catch {
        bad.push(f.name)
      }
    }
    setFileMsg(`${n} note${n === 1 ? '' : 's'} added${bad.length ? `; nothing read from ${bad.join(', ')}` : ''}.`)
  }
  const note = notes.find((n) => n.id === editing) ?? null
  return (
    <section aria-label="Race notes">
      <h2>Race notes</h2>
      {notes.length === 0 && (
        <p className="note">
          None. Draw one on the Route chart with <b>+ note</b>: a point, a line or an
          area, with text.
        </p>
      )}
      {notes.map((n) => (
        <div className="row" key={n.id}>
          <span>
            {n.text || <i>no text</i>}
            <br />
            <span className="note">{describeNote(n)}</span>
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => setEditing(n.id)} aria-label={`Edit note ${n.text || n.kind}`}>
            EDIT
          </button>
        </div>
      ))}
      <div className="actions" style={{ background: 'none', border: 'none', padding: '4px 0' }}>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          OPEN NOTES
          <input
            type="file"
            multiple
            accept=".geojson,.json,.txt,.csv"
            aria-label="Race note files to open"
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void open(files)
            }}
          />
        </label>
        <button
          className="btn btn--sm btn--ghost"
          disabled={!notes.length}
          onClick={async () => {
            const { downloadText } = await import('@/lib/gpx')
            downloadText('race-notes.geojson', notesToGeoJSON(notes), 'application/geo+json')
          }}
        >
          SAVE NOTES
        </button>
        <button className="btn btn--sm btn--ghost" disabled={!notes.length} onClick={() => useStore.setState({ raceNotes: [] })}>
          CLEAR NOTES
        </button>
      </div>
      {fileMsg && <p className="note" aria-label="Race notes file">{fileMsg}</p>}
      <p className="note">Open GeoJSON, or a text list of areas: a name line, then one position line a corner.</p>
      {note && <RaceNoteSheet note={note} onClose={() => setEditing(null)} />}
    </section>
  )
}
