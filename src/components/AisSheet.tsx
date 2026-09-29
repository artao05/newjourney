/**
 * The AIS targets heard: distress beacons first, then by how close each will
 * come, with range, bearing, CPA and TCPA from our own course and speed.
 */
import { shownTargets, targetsInAreas, type AisFilter } from '@/lib/ais/targets'
import { zonesFromNotes } from '@/lib/routing/settings'
import { useState } from 'react'
import { useAis } from '@/state/ais'
import { useStore } from '@/state/store'
import { boatByMmsi } from '@/lib/fleet'

const f1 = (v: number | null | undefined, dp = 1) => (v == null ? '—' : v.toFixed(dp))
const ALERT: Record<string, string> = { SART: 'AIS-SART', MOB: 'Man overboard', EPIRB: 'EPIRB' }

export function AisSheet({ onClose }: { onClose: () => void }) {
  const targets = useAis((s) => s.targets)
  const filter = useAis((s) => s.filter)
  const setFilter = useAis((s) => s.setFilter)
  const state = useStore((s) => s.state)
  const fleet = useStore((s) => s.fleet)
  const own = state ? { position: state.position, sog: state.sog, cog: state.cog } : null
  const rows = shownTargets(targets, own, filter)
  const raceNotes = useStore((s) => s.raceNotes)
  const inAvoid = new Set(targetsInAreas(targets, (zonesFromNotes(raceNotes).avoidAreas ?? []).map((p) => p[0])).map((t) => t.mmsi))
  const raw = useAis((s) => s.raw)
  const [onlyText, setOnlyText] = useState(filter.only.join(', '))
  const [ownText, setOwnText] = useState(filter.ownMmsi != null ? String(filter.ownMmsi) : '')
  const toggle = (k: keyof AisFilter, label: string) => (
    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input type="checkbox" checked={Boolean(filter[k])} onChange={(e) => setFilter({ [k]: e.target.checked })} />
      {label}
    </label>
  )
  return (
    <div className="sheet sheet--tall" role="dialog" aria-label="AIS targets">
      <div className="sheet__grip" onClick={onClose} />
      <h2>AIS targets</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label htmlFor="ais-range">
          Within{' '}
          <input
            id="ais-range"
            type="number"
            min="1"
            step="1"
            value={filter.maxRangeNm}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v > 0) setFilter({ maxRangeNm: v })
            }}
            style={{ width: 56 }}
          />{' '}
          nm
        </label>
        {toggle('classB', 'Class B')}
        {toggle('aton', 'Aids to navigation')}
        {toggle('hideMoored', 'Hide moored and anchored')}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label htmlFor="ais-vector">
          Vector{' '}
          <select id="ais-vector" value={filter.vectorMin} onChange={(e) => setFilter({ vectorMin: Number(e.target.value) })}>
            <option value={0}>none</option>
            <option value={3}>3 min</option>
            <option value={6}>6 min</option>
            <option value={12}>12 min</option>
            <option value={30}>30 min</option>
          </select>
        </label>
        {toggle('trails', 'Trails')}
        {toggle('labels', 'Names')}
        <label htmlFor="ais-colour">
          Colour by{' '}
          <select id="ais-colour" value={filter.colourBy} onChange={(e) => setFilter({ colourBy: e.target.value as AisFilter['colourBy'] })}>
            <option value="class">class</option>
            <option value="danger">risk and motion</option>
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label htmlFor="ais-own">
          Our MMSI{' '}
          <input
            id="ais-own"
            inputMode="numeric"
            value={ownText}
            onChange={(e) => {
              setOwnText(e.target.value)
              const v = e.target.value.trim()
              setFilter({ ownMmsi: /^\d{9}$/.test(v) ? Number(v) : null })
            }}
            style={{ width: 96 }}
          />
        </label>
        <label htmlFor="ais-only">
          Only{' '}
          <input
            id="ais-only"
            placeholder="all vessels"
            value={onlyText}
            onChange={(e) => {
              setOnlyText(e.target.value)
              setFilter({ only: (e.target.value.match(/\d{9}/g) ?? []).map(Number) })
            }}
            style={{ width: 180 }}
          />
        </label>
      </div>
      {!own && <p className="note">No fix of our own, so no range, CPA or TCPA.</p>}
      {rows.length === 0 ? (
        <p className="note">No AIS targets heard. They come from an AIS receiver on the instrument feed.</p>
      ) : (
        <table className="table" aria-label="Targets" style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Vessel</th>
              <th>Range nm</th>
              <th>Brg °</th>
              <th>CPA nm</th>
              <th>TCPA min</th>
              <th>SOG kn</th>
              <th>COG °</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.mmsi} style={t.alert ? { color: 'var(--bad, #ff6b6b)', fontWeight: 600 } : undefined}>
                <td>
                  {t.alert ? `${ALERT[t.alert]} · ` : ''}
                  {(() => {
                    // One of our fleet: her name and colour from the boats database.
                    const b = boatByMmsi(fleet, t.mmsi)
                    return b ? <span style={{ color: b.colour }}>{b.name}</span> : t.name || t.mmsi
                  })()}
                  <span className="note"> {t.cls}</span>
                  {inAvoid.has(t.mmsi) && <span style={{ color: 'var(--warn)' }}> · in an avoid area</span>}
                </td>
                <td style={{ textAlign: 'center' }}>{f1(t.a?.rangeNm, 2)}</td>
                <td style={{ textAlign: 'center' }}>{f1(t.a?.bearing, 0)}</td>
                <td style={{ textAlign: 'center' }}>{t.a && t.a.tcpaMin >= 0 ? f1(t.a.cpaNm, 2) : '—'}</td>
                <td style={{ textAlign: 'center' }}>{!t.a ? '—' : t.a.tcpaMin >= 0 ? f1(t.a.tcpaMin, 0) : 'past'}</td>
                <td style={{ textAlign: 'center' }}>{f1(t.sog)}</td>
                <td style={{ textAlign: 'center' }}>{f1(t.cog, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details style={{ marginTop: 8 }}>
        <summary>Raw messages ({raw.length})</summary>
        <pre aria-label="Raw AIS messages" style={{ fontSize: 10, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {raw
            .slice(-50)
            .map((r) => `${new Date(r.t).toISOString().slice(11, 19)} ${r.line}`)
            .join('\n')}
        </pre>
        <button
          className="btn btn--sm btn--ghost"
          disabled={!raw.length}
          onClick={async () => {
            const { downloadText } = await import('@/lib/gpx')
            downloadText('ais.nmea', raw.map((r) => r.line).join('\r\n') + '\r\n', 'text/plain')
          }}
        >
          EXPORT
        </button>
      </details>
      <button className="btn btn--sm" onClick={onClose} style={{ marginTop: 8 }}>
        Done
      </button>
    </div>
  )
}
