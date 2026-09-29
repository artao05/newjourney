/**
 * Number boxes: any channel, in any box, as many boxes as you like.
 *
 * This is Expedition's most-used display. A box shows one channel, or cycles
 * through up to ten (its "alternating" boxes), every ALTERNATE_MS. Tapping a box
 * edits it. The layout persists. Values come from the live channel snapshot, so a
 * box and a fixed tile showing the same channel always agree.
 */

import { useMemo, useState } from 'react'
import { MAX_ALTERNATING, useStore, type NumberBox } from '@/state/store'
import { CHANNELS, CHANNEL_GROUPS, channel } from '@/lib/channels/catalogue'
import { formatChannel } from '@/lib/channels/format'
import { useChannelSnapshot } from '@/hooks/useChannels'

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

  return (
    <>
      <div className="nboxes" role="list" aria-label="Number boxes">
        {boxes.map((box) => {
          const k = alternatingIndex(box.channels.length, now)
          const def = channel(box.channels[k])
          const value = def ? formatChannel(def, snap[def.id], units) : null
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
                    {k + 1}/{box.channels.length}
                  </span>
                )}
              </span>
              <span className={`nbox__value${value && value.text.length > 7 ? ' nbox__value--long' : ''}`}>
                {value ? value.text : '—'}
                {value?.unit ? <span className="nbox__unit">{value.unit}</span> : null}
              </span>
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
          <label>{i === 0 ? 'Shows' : `Then ${i + 1}`}</label>
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
