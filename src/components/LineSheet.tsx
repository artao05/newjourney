/**
 * Adjust the start line: Expedition's per-end options, in one sheet.
 *
 * Set an end from the other by range and bearing, nudge an end up or down the
 * wind, swap the ends, and choose which approaches count toward time to line.
 * Bearings are in the app's north (°T or °M), as the committee boat gives them.
 */

import { useState } from 'react'
import { useStore, DEFAULT_APPROACHES, type StartApproaches } from '@/state/store'
import { endFromOther, nudgeUpwind } from '@/lib/lineAdjust'
import { magneticToTrue } from '@/lib/magnetic'
import { variationHere } from '@/hooks/useVariation'

const APPROACH_LABELS: Array<[keyof StartApproaches, string]> = [
  ['ends', 'Line ends'],
  ['gps', 'GPS (COG and SOG as now)'],
  ['reach', 'Reaching to the line'],
  ['port', 'Port layline'],
  ['starboard', 'Starboard layline'],
]

export function LineSheet({ onClose }: { onClose: () => void }) {
  const line = useStore((s) => s.course.startLine)
  const setStartEnd = useStore((s) => s.setStartEnd)
  const wind = useStore((s) => s.wind)
  const northRef = useStore((s) => s.settings.northRef)
  const approaches = useStore((s) => s.startApproaches)
  const setApproaches = useStore((s) => s.setStartApproaches)
  const [end, setEnd] = useState<'port' | 'starboard'>('port')
  const [range, setRange] = useState(200)
  const [brg, setBrg] = useState(270)
  const [nudge, setNudge] = useState(10)
  const other = end === 'port' ? line.starboard : line.port
  const self = end === 'port' ? line.port : line.starboard
  const toTrue = (b: number) =>
    northRef === 'magnetic' ? magneticToTrue(b, variationHere()) : b

  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="Adjust the start line">
      <div className="sheet__grip" onClick={onClose} />
      <div className="seg" role="group" aria-label="Line end" style={{ marginBottom: 8 }}>
        <button aria-pressed={end === 'port'} onClick={() => setEnd('port')}>Pin end</button>
        <button aria-pressed={end === 'starboard'} onClick={() => setEnd('starboard')}>RC end</button>
      </div>

      <h2>From the other end</h2>
      <div className="field">
        <label htmlFor="line-range">Range <span className="note">m</span></label>
        <input id="line-range" type="number" step="10" min="1" value={range}
          onChange={(e) => setRange(Number(e.target.value))} inputMode="numeric" />
      </div>
      <div className="field">
        <label htmlFor="line-brg">
          Bearing <span className="note">°{northRef === 'magnetic' ? 'M' : 'T'} from the other end</span>
        </label>
        <input id="line-brg" type="number" step="1" value={brg}
          onChange={(e) => setBrg(Number(e.target.value))} inputMode="numeric" />
      </div>
      <button
        className="btn btn--sm"
        disabled={!other || !(range > 0)}
        onClick={() => other && setStartEnd(end, endFromOther(other, range, toTrue(brg)))}
      >
        SET {end === 'port' ? 'PIN' : 'RC'} END
      </button>

      <h2>Nudge up the wind</h2>
      <div className="field">
        <label htmlFor="line-nudge">Metres <span className="note">+ up, − down</span></label>
        <input id="line-nudge" type="number" step="5" value={nudge}
          onChange={(e) => setNudge(Number(e.target.value))} inputMode="numeric" />
      </div>
      <button
        className="btn btn--sm"
        disabled={!self || !wind}
        onClick={() => self && wind && setStartEnd(end, nudgeUpwind(self, wind.twd, nudge))}
      >
        NUDGE {end === 'port' ? 'PIN' : 'RC'}
      </button>

      <h2>Time to line counts</h2>
      {APPROACH_LABELS.map(([k, label]) => (
        <label key={k} className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={approaches[k]}
            onChange={(e) => setApproaches({ ...approaches, [k]: e.target.checked })}
            aria-label={label}
          />
          <span>{label}</span>
        </label>
      ))}
      <p className="note">
        Time to line is the quickest of the approaches ticked, as in Expedition.
      </p>

      <div className="actions">
        <button
          className="btn btn--sm btn--ghost"
          disabled={!line.port || !line.starboard}
          onClick={() => {
            const { port, starboard } = line
            setStartEnd('port', starboard)
            setStartEnd('starboard', port)
          }}
        >
          SWAP ENDS
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          DONE
        </button>
      </div>
      {!Object.values(approaches).some(Boolean) && (
        <button className="btn btn--sm btn--ghost" onClick={() => setApproaches({ ...DEFAULT_APPROACHES })}>
          Nothing counts: tick all again
        </button>
      )}
    </div>
  )
}
