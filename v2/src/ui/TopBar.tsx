import { actions, BOATS, useUi, world, type Source, type Tab } from '../state'
import { clockS, fmtLat, fmtLon, mmss } from './format'
import { Icon } from './Icons'

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'plan', label: 'Plan', hint: 'Forecast, wind overlay and the optimal route' },
  { id: 'course', label: 'Course', hint: 'Place marks and set the course' },
  { id: 'race', label: 'Race', hint: 'Start sequence, line and fleet' },
  { id: 'sim', label: 'Simulate', hint: 'Sail a simulated boat and fleet' },
  { id: 'coach', label: 'Coach', hint: 'AI debrief and what the app has learned' },
]

export function TopBar() {
  const tab = useUi((s) => s.tab)
  const source = useUi((s) => s.source)
  const theme = useUi((s) => s.theme)
  const seq = useUi((s) => s.seqMinutes)
  useUi((s) => s.version)
  const ttg = world.timeToGunS()
  const inSeq = ttg !== null && world.own.phase !== 'finished'
  const debriefReady = useUi((s) => s.debrief !== null)
  const raceView = useUi((s) => s.raceView)

  return (
    <header className="topbar">
      <div className="brand" title="NewJourney">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path d="M12 2 L12 18 M12 3 C17 7 18 13 17 17 L12 17 Z" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M11 6 C7 9 6 13 6.5 16 L11 16 Z" fill="var(--ink-dim)" />
          <path d="M3 19.5 C7 21.5 17 21.5 21 19.5" fill="none" stroke="var(--wind)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span>NewJourney</span>
      </div>

      <nav className="tabs" role="tablist" hidden={raceView}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => actions.setTab(t.id)}>
            {t.label}
            {t.id === 'coach' && debriefReady && tab !== 'coach' ? <span className="dot" aria-label="debrief ready" /> : null}
          </button>
        ))}
      </nav>

      {raceView ? (
        <button className="btn sm race-exit" onClick={() => actions.setRaceView(false)} title="Bring back the panels (R)">
          Show panels
        </button>
      ) : null}

      <div className={`start-pick ${inSeq && ttg! > 0 ? 'running' : ''}`} title="Start sequence">
        {inSeq && ttg! > 0 ? (
          <>
            <span className="countdown">{mmss(ttg)}</span>
            <button className="btn ghost sm" onClick={actions.syncGun} title="Round to the nearest minute">
              Sync
            </button>
            <button className="btn ghost sm" onClick={actions.stopRace}>
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="lbl">Start</span>
            <div className="seg sm">
              {([10, 5, 3] as const).map((m) => (
                <button key={m} className={seq === m ? 'on' : ''} onClick={() => actions.setSeqMinutes(m)}>
                  {m}′
                </button>
              ))}
            </div>
            <button className="btn go sm" onClick={() => actions.startSequence(seq)}>
              Go
            </button>
          </>
        )}
      </div>

      <button
        className={`icon-btn ${raceView ? 'on' : ''}`}
        onClick={() => actions.setRaceView(!raceView)}
        title={raceView ? 'Leave the race view (R)' : 'Race view: just the instruments and race data (R)'}
        aria-pressed={raceView}
        aria-label="Race view"
      >
        <Icon name="expand" />
      </button>

      <div className="topbar-right">
        <div className="status" aria-label="Own boat position and clock">
          <div className="status-cell" title="Your boat's position">
            <span className="status-k">Pos</span>
            <span className="status-v">
              {fmtLat(world.own.pos.lat)}
              <br />
              {fmtLon(world.own.pos.lon)}
            </span>
          </div>
          <div className="status-cell" title={source === 'sim' ? 'Simulation clock' : 'Clock'}>
            <span className="status-k">{source === 'sim' ? 'Sim time' : 'Time'}</span>
            <span className="status-v big">{clockS(world.t)}</span>
          </div>
        </div>
        <span className={`lamp ${source}`} title={source === 'sim' ? 'Simulated data' : source === 'n2k' ? 'NMEA 2000 via Signal K' : 'Phone GPS'} />
        <select aria-label="Boat" value={world.boatId} onChange={(e) => actions.setBoat(e.target.value)}>
          {BOATS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select aria-label="Data source" value={source} onChange={(e) => actions.setSource(e.target.value as Source)} className={`src src-${source}`}>
          <option value="sim">Simulator</option>
          <option value="n2k">NMEA 2000 (Signal K)</option>
          <option value="gps">Phone GPS</option>
        </select>
        <button
          className="icon-btn"
          onClick={() => actions.setTheme(theme === 'night' ? 'day' : 'night')}
          title={theme === 'night' ? 'Day mode (sunlight)' : 'Night mode'}
          aria-label={theme === 'night' ? 'Day mode' : 'Night mode'}
        >
          <Icon name={theme === 'night' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-btn" onClick={() => actions.setHelp(true)} title="Sailing terms explained" aria-label="Help">
          <Icon name="help" />
        </button>
      </div>
    </header>
  )
}
