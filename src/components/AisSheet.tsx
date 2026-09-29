/**
 * The AIS targets heard: distress beacons first, then by how close each will
 * come, with range, bearing, CPA and TCPA from our own course and speed.
 */
import { shownTargets, type AisFilter } from '@/lib/ais/targets'
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
      <button className="btn btn--sm" onClick={onClose} style={{ marginTop: 8 }}>
        Done
      </button>
    </div>
  )
}
