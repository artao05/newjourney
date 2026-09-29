/**
 * Number boxes: any channel, in any box, as many boxes as you like.
 *
 * This is Expedition's most-used display. A box shows one channel, or cycles
 * through up to ten (its "alternating" boxes), every ALTERNATE_MS. Tapping a box
 * edits it. The layout persists. Values come from the live channel snapshot, so a
 * box and a fixed tile showing the same channel always agree.
 */

import { useMemo, useRef, useState } from 'react'
import { MAX_ALTERNATING, useStore, type NumberBox } from '@/state/store'
import { CHANNELS, CHANNEL_GROUPS, channel } from '@/lib/channels/catalogue'
import { formatChannel, isSignedAngle } from '@/lib/channels/format'
import { useChannelSnapshot } from '@/hooks/useChannels'
import { dampedValue, situationIndex, situationOf } from '@/lib/channels/boxValue'

/** The longest damping a box can ask for, seconds: history kept beyond it is dropped. */
const MAX_DAMP_S = 120
const SITUATION_LABEL = ['upwind', 'reaching', 'downwind', 'prestart']

/** How long each channel of an alternating box stays up. */
export const ALTERNATE_MS = 2000

/** Which of a box's channels is showing at time `t`. */
export function alternatingIndex(count: number, t: number): number {
  return count <= 1 ? 0 : Math.floor(t / ALTERNATE_MS) % count
}

export function NumberBoxes() {
  const boxes = useStore((s) => s.numberBoxes)
  const addNumberBox = useStore((s) => s.addNumberBox)
  const units = useStore((s) => s.settings.units)
  const snap = useChannelSnapshot()
  const [editing, setEditing] = useState<string | null>(null)
  const now = snap['time'] ?? Date.now()
  // Each damped channel's recent values, a point a snapshot.
  const history = useRef(new Map<string, Array<[number, number]>>())
  useMemo(() => {
    const want = new Set(boxes.filter((b) => (b.dampS ?? 0) > 0).flatMap((b) => b.channels))
    for (const id of history.current.keys()) if (!want.has(id)) history.current.delete(id)
    for (const id of want) {
      const v = snap[id]
      const h = history.current.get(id) ?? []
      if (v != null && Number.isFinite(v) && h.at(-1)?.[0] !== now) h.push([now, v])
      history.current.set(id, h.filter(([t]) => now - t <= MAX_DAMP_S * 1000))
    }
  }, [snap, boxes, now])

  return (
    <>
      <div className="nboxes" role="list" aria-label="Number boxes">
        {boxes.map((box) => {
          const k = box.situation ? situationIndex(situationOf(snap, box.reachBandDeg ?? 10), box.channels.length) : alternatingIndex(box.channels.length, now)
          const def = channel(box.channels[k])
          const damped = def && (box.dampS ?? 0) > 0
          const angle = def?.unit === 'deg' ? (isSignedAngle(def.id) ? 'signed' : 'unsigned') : 'none'
          const shown = def ? (damped ? dampedValue(history.current.get(def.id) ?? [], now, box.dampS!, angle) : snap[def.id]) : null
          const value = def ? formatChannel(def, shown, units, box.decimals ?? null) : null
          const raw = damped && def ? formatChannel(def, snap[def.id], units, box.decimals ?? null) : null
          return (
            <button
              key={box.id}
              role="listitem"
              className={`nbox nbox--${box.size}${value ? '' : ' nbox--null'}`}
              onClick={() => setEditing(box.id)}
              aria-label={`${def?.name ?? 'unknown channel'}: ${value ? `${value.text} ${value.unit}` : 'no value'}`}
            >
              <span className="nbox__label">
                {def?.name ?? box.channels[k]}
                {box.channels.length > 1 && (
                  <span className="nbox__alt">
                    {' '}
                    {box.situation ? SITUATION_LABEL[k] : `${k + 1}/${box.channels.length}`}
                  </span>
                )}
              </span>
              <span className={`nbox__value${value && value.text.length > 7 ? ' nbox__value--long' : ''}`} style={damped ? { fontStyle: 'italic' } : undefined} data-damped={damped || undefined}>
                {value ? value.text : '—'}
                {value?.unit ? <span className="nbox__unit">{value.unit}</span> : null}
              </span>
              {/* Damped, the value as it comes stays beside it, small. */}
              {damped && <span className="nbox__raw" aria-label="raw" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{raw ? raw.text : '—'}</span>}
            </button>
          )
        })}
        <button className="nbox nbox--add" onClick={() => addNumberBox('sog')} aria-label="Add a number box">
          + BOX
        </button>
      </div>
      {editing && (
        <NumberBoxSheet
          box={boxes.find((b) => b.id === editing) ?? null}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/** Every channel, grouped, those produced today first within each group. */
function ChannelSelect({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (id: string) => void
  label: string
}) {
  const groups = useMemo(
    () =>
      CHANNEL_GROUPS.map((g) => ({
        g,
        channels: CHANNELS.filter((c) => c.group === g).sort(
          (a, b) => Number(b.today) - Number(a.today),
        ),
      })).filter((x) => x.channels.length > 0),
    [],
  )
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map(({ g, channels }) => (
        <optgroup key={g} label={g}>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.today ? '' : ' (not yet)'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function NumberBoxSheet({ box, onClose }: { box: NumberBox | null; onClose: () => void }) {
  const update = useStore((s) => s.updateNumberBox)
  const remove = useStore((s) => s.removeNumberBox)
  if (!box) return null
  const setChannel = (i: number, id: string) =>
    update(box.id, { channels: box.channels.map((c, j) => (j === i ? id : c)) })

  return (
    <div className="sheet" role="dialog" aria-label="Edit number box">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Channels</h2>
      {box.channels.map((id, i) => (
        <div className="field field--wide" key={`${i}-${id}`}>
          <label>{box.situation ? (['Upwind', 'Reaching', 'Downwind', 'Before the start'][i] ?? `Then ${i + 1}`) : i === 0 ? 'Shows' : `Then ${i + 1}`}</label>
          <ChannelSelect label={`Channel ${i + 1}`} value={id} onChange={(v) => setChannel(i, v)} />
          {box.channels.length > 1 && (
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => update(box.id, { channels: box.channels.filter((_, j) => j !== i) })}
              aria-label={`Remove channel ${i + 1}`}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {box.channels.length < MAX_ALTERNATING && (
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => update(box.id, { channels: [...box.channels, box.channels[box.channels.length - 1]] })}
        >
          + ALTERNATE WITH ANOTHER
        </button>
      )}
      <p className="note">
        More than one channel makes the box alternate between them, every{' '}
        {ALTERNATE_MS / 1000} s. Channels marked "not yet" show a dash until newjourney
        can compute them, or an instrument supplies them.
      </p>
      <h2>Showing</h2>
      <div className="field">
        <label htmlFor="nb-damp">Damping</label>
        <select id="nb-damp" value={box.dampS ?? 0} onChange={(e) => update(box.id, { dampS: Number(e.target.value) })}>
          <option value={0}>none, as it comes</option>
          <option value={5}>5 s</option>
          <option value={10}>10 s</option>
          <option value={30}>30 s</option>
          <option value={60}>1 min</option>
          <option value={120}>2 min</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="nb-dec">Decimals</label>
        <select id="nb-dec" value={box.decimals ?? ''} onChange={(e) => update(box.id, { decimals: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">the channel's own</option>
          <option value={0}>0</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </div>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!box.situation} aria-label="By situation" onChange={(e) => update(box.id, { situation: e.target.checked })} />
        <span>By situation: its channels are then upwind, reaching, downwind and, if a fourth, before the start.</span>
      </label>
      {box.situation && (
        <div className="field">
          <label htmlFor="nb-band">Reaching from <span className="note">degrees past the target TWA</span></label>
          <input id="nb-band" type="number" min="0" max="60" step="1" value={box.reachBandDeg ?? 10} onChange={(e) => update(box.id, { reachBandDeg: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
        </div>
      )}
      <h2>Size</h2>
      <div className="seg" role="group" aria-label="Box size">
        {(['sm', 'md', 'lg'] as const).map((z) => (
          <button key={z} aria-pressed={box.size === z} onClick={() => update(box.id, { size: z })}>
            {z === 'sm' ? 'Small' : z === 'md' ? 'Medium' : 'Wide'}
          </button>
        ))}
      </div>
      <div className="actions">
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            remove(box.id)
            onClose()
          }}
        >
          REMOVE BOX
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          DONE
        </button>
      </div>
    </div>
  )
}
