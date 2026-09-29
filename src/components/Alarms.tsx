/**
 * Alarms in the app: the watcher that runs the rules once a second, the
 * banner that shows on every screen, and the Setup section that edits them.
 *
 * A firing alarm sounds three long beeps and buzzes, and keeps doing so every
 * ten seconds until it is acknowledged. Acknowledged, it stays listed until it
 * clears, so nobody forgets the depth is still low.
 */

import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { useChannelSnapshot } from '@/hooks/useChannels'
import { evaluate, sounding } from '@/lib/alarms/engine'
import { beep } from '@/lib/beep'
import { CHANNELS } from '@/lib/channels/catalogue'
import { formatChannel } from '@/lib/channels/format'

const NAMES = new Map(CHANNELS.map((c) => [c.id, c]))
const REPEAT_MS = 10_000

export function AlarmWatcher() {
  const snap = useChannelSnapshot()
  const lastSound = useRef(0)

  useEffect(() => {
    const s = useStore.getState()
    if (s.alarms.length === 0) return
    const now = Date.now()
    const e = evaluate(s.alarms, snap, s.alarmStates, now)
    s.setAlarmStates(e.states)
    for (const r of e.fired) s.addEvent('note', `Alarm: ${r.name}`, now)
    const loud = sounding(s.alarms, e.states)
    if (loud.length && (e.fired.length || now - lastSound.current >= REPEAT_MS)) {
      lastSound.current = now
      for (let i = 0; i < 3; i++) beep('long', i * 0.8)
    }
  }, [snap])

  return null
}

export function AlarmBanner() {
  const alarms = useStore((s) => s.alarms)
  const states = useStore((s) => s.alarmStates)
  const ack = useStore((s) => s.acknowledgeAlarms)
  const active = alarms.filter((a) => states[a.id]?.active)
  if (active.length === 0) return null
  const loud = sounding(alarms, states)
  return (
    <div className={`alarmbar ${loud.length ? 'alarmbar--loud' : ''}`} role="alert" aria-label="Alarms">
      {active.map((a) => {
        const st = states[a.id]
        const def = NAMES.get(a.channel)
        const f = def ? formatChannel(def, st.value) : null
        return (
          <span key={a.id} className="alarmbar__item">
            <b>{a.name}</b> {f ? `${f.text}${f.unit ?? ''}` : ''}
            {st.acknowledged ? ' · acknowledged' : ''}
          </span>
        )
      })}
      {loud.length > 0 && (
        <button className="btn btn--sm" onClick={() => ack()}>
          ACK
        </button>
      )}
    </div>
  )
}

export function AlarmsSection() {
  const alarms = useStore((s) => s.alarms)
  const addAlarm = useStore((s) => s.addAlarm)
  const updateAlarm = useStore((s) => s.updateAlarm)
  const removeAlarm = useStore((s) => s.removeAlarm)
  const states = useStore((s) => s.alarmStates)
  const [channel, setChannel] = useState('depth')
  const [op, setOp] = useState<'above' | 'below'>('below')
  const [value, setValue] = useState(3)
  const [hyst, setHyst] = useState(0.5)
  const [delay, setDelay] = useState(5)
  const live = CHANNELS.filter((c) => c.today)

  return (
    <section aria-label="Alarms">
      <h2>Alarms</h2>
      {alarms.length > 0 && (
        <table className="targets" aria-label="Alarm rules">
          <tbody>
            {alarms.map((a) => (
              <tr key={a.id}>
                <td style={{ textAlign: 'left' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={a.enabled} aria-label={`${a.name} on`}
                      onChange={(e) => updateAlarm(a.id, { enabled: e.target.checked })} />
                    {a.name}
                  </label>
                </td>
                <td>
                  {a.op} {a.value}
                  {a.hysteresis ? ` ±${a.hysteresis}` : ''} · {a.delayS} s
                </td>
                <td>{states[a.id]?.active ? 'ON' : ''}</td>
                <td>
                  <button className="btn btn--sm btn--ghost" aria-label={`Remove alarm ${a.name}`} onClick={() => removeAlarm(a.id)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="field">
        <label htmlFor="alarm-channel">Channel</label>
        <select id="alarm-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {live.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div className="seg" role="group" aria-label="Alarm when" style={{ marginBottom: 8 }}>
        <button aria-pressed={op === 'below'} onClick={() => setOp('below')}>Below</button>
        <button aria-pressed={op === 'above'} onClick={() => setOp('above')}>Above</button>
      </div>
      <div className="field">
        <label htmlFor="alarm-value">Threshold <span className="note">{NAMES.get(channel)?.unit ?? ''}</span></label>
        <input id="alarm-value" type="number" step="0.1" value={value} onChange={(e) => setValue(Number(e.target.value))} />
      </div>
      <div className="field">
        <label htmlFor="alarm-hyst">Clears after coming back by</label>
        <input id="alarm-hyst" type="number" step="0.1" min="0" value={hyst} onChange={(e) => setHyst(Math.max(0, Number(e.target.value) || 0))} />
      </div>
      <div className="field">
        <label htmlFor="alarm-delay">Holds for <span className="note">s, before it fires</span></label>
        <input id="alarm-delay" type="number" step="1" min="0" value={delay} onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))} />
      </div>
      <button
        className="btn btn--sm"
        disabled={!Number.isFinite(value)}
        onClick={() =>
          addAlarm({
            name: `${NAMES.get(channel)?.name ?? channel} ${op} ${value}`,
            channel,
            op,
            value,
            hysteresis: hyst,
            delayS: delay,
            enabled: true,
          })
        }
      >
        ADD ALARM
      </button>
      <p className="note">
        An alarm fires once its channel has been past the threshold for the hold time, beeps and buzzes until
        acknowledged, and clears once the value is back by the margin. A second with no data changes nothing.
      </p>
    </section>
  )
}
