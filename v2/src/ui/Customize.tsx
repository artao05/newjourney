import { useState } from 'react'
import { actions, ALL_FIELDS, FIELD_PRESETS, useUi, type FieldId, type FieldMode } from '../state'
import { Icon } from './Icons'

const FIELD_INFO: Record<FieldId, { name: string; hint: string }> = {
  bsp: { name: 'Boat speed', hint: 'Speed through the water, against target' },
  twa: { name: 'True wind angle', hint: 'Angle to the wind, and which tack you are on' },
  tws: { name: 'Wind speed', hint: 'True wind speed, in knots' },
  twd: { name: 'Wind direction', hint: 'Where the wind comes from: watch it for shifts' },
  hdg: { name: 'Heading', hint: 'Where the bow points' },
  vmg: { name: 'VMG', hint: 'Progress straight upwind or downwind' },
  awa: { name: 'Apparent wind', hint: 'The wind you feel on board' },
  polar: { name: 'Polar %', hint: 'Your speed against what the boat can do' },
  intent: { name: "Skipper's note", hint: 'What the boat is doing and why, in a sentence' },
  tips: { name: 'Coach tips', hint: 'Short prompts while you sail, like "Headed 6°"' },
}

/** Choose which data boxes show, separately for setting up and for the race view. */
export function Customize() {
  const open = useUi((s) => s.customizeOpen)
  const raceView = useUi((s) => s.raceView)
  const fields = useUi((s) => s.fields)
  const auto = useUi((s) => s.raceViewAuto)
  const [mode, setMode] = useState<FieldMode | null>(null)
  if (!open) return null
  const m: FieldMode = mode ?? (raceView ? 'race' : 'setup')
  const chosen = fields[m]
  const rest = ALL_FIELDS.filter((f) => !chosen.includes(f))
  const close = () => {
    setMode(null)
    actions.setCustomize(false)
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...chosen]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    actions.setFields(m, next)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Data on screen" onClick={close}>
      <div className="modal-card customize" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Data on screen</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="seg cust-mode" role="tablist" aria-label="Which screen">
          <button role="tab" aria-selected={m === 'setup'} className={m === 'setup' ? 'on' : ''} onClick={() => setMode('setup')}>
            Setting up
          </button>
          <button role="tab" aria-selected={m === 'race'} className={m === 'race' ? 'on' : ''} onClick={() => setMode('race')}>
            Race view
          </button>
        </div>

        <div className="cust-presets">
          {FIELD_PRESETS.map((p) => (
            <button key={p.id} className={`btn sm ${sameList(p.fields, chosen) ? 'on' : ''}`} title={p.hint} onClick={() => actions.setFields(m, p.fields)}>
              {p.name}
            </button>
          ))}
        </div>

        <ol className="cust-list" aria-label="Shown, in order">
          {chosen.map((f, i) => (
            <li key={f}>
              <label>
                <input type="checkbox" checked onChange={() => actions.setFields(m, chosen.filter((x) => x !== f))} />
                <span>
                  <b>{FIELD_INFO[f].name}</b>
                  <small>{FIELD_INFO[f].hint}</small>
                </span>
              </label>
              <span className="cust-order">
                <button className="btn xs ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${FIELD_INFO[f].name} up`}>
                  <Icon name="up" size={14} />
                </button>
                <button className="btn xs ghost" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${FIELD_INFO[f].name} down`}>
                  <Icon name="down" size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
        {rest.length ? (
          <ul className="cust-list off" aria-label="Hidden">
            {rest.map((f) => (
              <li key={f}>
                <label>
                  <input type="checkbox" checked={false} onChange={() => actions.setFields(m, [...chosen, f])} />
                  <span>
                    <b>{FIELD_INFO[f].name}</b>
                    <small>{FIELD_INFO[f].hint}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}

        <label className="cust-auto">
          <input type="checkbox" checked={auto} onChange={(e) => actions.setRaceViewAuto(e.target.checked)} />
          Switch to the race view when a start sequence begins, and to the coach at the finish
        </label>
      </div>
    </div>
  )
}

function sameList(a: FieldId[], b: FieldId[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
