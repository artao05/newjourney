/**
 * The polar editor: Expedition's polar table, edited in place.
 *
 * Each wind speed is a row of TWA/BSP points. Change a speed or an angle and the
 * row's targets (the best upwind and downwind VMG) are re-derived as you type,
 * because the manual's trap is real: raise a point near the target and it can
 * become the new target. Saving makes the edited table the navigation polar,
 * kept on this device like any imported one. The file export in Setup writes it
 * out as Expedition text.
 */

import { useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { deriveTargets, validatePolar } from '@/lib/polar'
import type { PolarTable } from '@/lib/types'

function clone(p: PolarTable): PolarTable {
  return {
    ...p,
    tws: p.tws.slice(),
    rows: p.rows.map((r) => ({ twa: r.twa.slice(), bsp: r.bsp.slice() })),
  }
}

export function PolarEditor({ onClose }: { onClose: () => void }) {
  const polar = useStore((s) => s.polar)
  const setPolar = useStore((s) => s.setPolar)
  const boat = useStore((s) => s.boat)
  const [draft, setDraft] = useState<PolarTable | null>(() => (polar ? clone(polar) : null))
  const [row, setRow] = useState(0)

  const issues = useMemo(
    () => (draft ? validatePolar(draft, { loaM: boat.loaMetres }) : []),
    [draft, boat.loaMetres],
  )
  const errors = issues.filter((i) => i.severity === 'error')
  const targets = useMemo(() => {
    if (!draft || errors.length) return null
    try {
      return deriveTargets(draft, draft.tws[row])
    } catch {
      return null
    }
  }, [draft, row, errors.length])

  if (!draft) {
    return (
      <div className="sheet" role="dialog" aria-label="Polar editor">
        <div className="sheet__grip" onClick={onClose} />
        <div className="warnbox">No polar loaded to edit. Pick a class first.</div>
      </div>
    )
  }

  const set = (fn: (p: PolarTable) => void) =>
    setDraft((d) => {
      if (!d) return d
      const next = clone(d)
      fn(next)
      return next
    })
  const r = draft.rows[row]

  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Polar editor">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Wind speed</h2>
      <div className="seg" role="group" aria-label="Wind speed row">
        {draft.tws.map((t, i) => (
          <button key={i} aria-pressed={row === i} onClick={() => setRow(i)}>
            {t} kn
          </button>
        ))}
      </div>
      <div className="rows" role="table" aria-label="Polar points">
        <div className="row" role="row">
          <span>
            <b>TWA °</b>
          </span>
          <span>
            <b>BSP kn</b>
          </span>
        </div>
        {r.twa.map((a, j) => (
          <div className="row" role="row" key={j}>
            <input
              aria-label={`TWA ${j + 1}`}
              type="number"
              step="1"
              value={a}
              style={{ width: 80 }}
              onChange={(e) => set((p) => void (p.rows[row].twa[j] = Number(e.target.value)))}
              inputMode="decimal"
            />
            <input
              aria-label={`BSP at ${a}°`}
              type="number"
              step="0.05"
              value={r.bsp[j]}
              style={{ width: 90 }}
              onChange={(e) => set((p) => void (p.rows[row].bsp[j] = Number(e.target.value)))}
              inputMode="decimal"
            />
          </div>
        ))}
      </div>
      {targets && (
        <p className="note" aria-label="Targets">
          Targets at {draft.tws[row]} kn: upwind {targets.upTwa.toFixed(1)}° at {targets.upBsp.toFixed(2)} kn
          (VMG {targets.upVmg.toFixed(2)}), downwind {targets.downTwa.toFixed(1)}° at{' '}
          {targets.downBsp.toFixed(2)} kn (VMG {Math.abs(targets.downVmg).toFixed(2)}).
        </p>
      )}
      {issues.map((i, n) => (
        <div key={n} className={i.severity === 'error' ? 'errbox' : 'warnbox'}>
          {i.message}
        </div>
      ))}
      <div className="actions">
        <button className="btn btn--sm btn--ghost" onClick={onClose}>
          CANCEL
        </button>
        <button
          className="btn btn--sm btn--primary"
          disabled={errors.length > 0}
          onClick={() => {
            const name = / \(edited\)$/.test(draft.name) ? draft.name : `${draft.name} (edited)`
            setPolar('custom', { ...draft, name, source: 'edited in newjourney' })
            onClose()
          }}
        >
          SAVE AS MY POLAR
        </button>
      </div>
    </div>
  )
}
