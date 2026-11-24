import { useState, type ReactNode } from 'react'
import { parseLatLon } from '@/lib/latlon'
import { bearing, distance } from '@/lib/geo'
import { boatModel, BOATS } from '../engine/boats'
import { biasGainM, LAYOUTS, lineBias, type LayoutId } from '../engine/course'
import type { MarkRole, SimBoat } from '../engine/types'
import { actions, useUi, world, type RouteMode } from '../state'
import { clock, deg, dur, fmtLat, fmtLon, kn, mmss, nm } from './format'
import { Icon } from './Icons'

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="psec">
      <h3>
        {title}
        {hint ? <span className="hint" title={hint}>?</span> : null}
      </h3>
      {children}
    </section>
  )
}

function center() {
  const ln = world.line
  return ln ? { lat: (ln.pin.lat + ln.committee.lat) / 2, lon: (ln.pin.lon + ln.committee.lon) / 2 } : world.own.pos
}

// ------------------------------------------------------------ Plan

export function PlanPanel() {
  const busy = useUi((s) => s.forecastBusy)
  const err = useUi((s) => s.forecastError)
  const arrows = useUi((s) => s.arrows)
  const colors = useUi((s) => s.colors)
  const laylines = useUi((s) => s.showLaylines)
  const legs = useUi((s) => s.legPlan)
  const route = useUi((s) => s.route)
  const routeBusy = useUi((s) => s.routeBusy)
  const routeErr = useUi((s) => s.routeError)
  const routeMode = useUi((s) => s.routeMode)
  const info = useUi((s) => s.routeInfo)
  const follow = useUi((s) => s.followRoute)
  const viewT = useUi((s) => s.viewT)
  const markId = useUi((s) => s.routeMarkId) ?? world.sequence[0]?.id ?? world.marks[0]?.id ?? null
  useUi((s) => s.version)
  const total = legs.reduce((a, l) => a + (Number.isFinite(l.timeS) ? l.timeS : 0), 0)
  const routeTacks = route ? route.legs.reduce((n, l, i) => n + (i > 0 && l.tack !== route.legs[i - 1]!.tack ? 1 : 0), 0) : 0
  return (
    <div className="panel-body">
      <Section title="Forecast" hint="The wind overlay on the map. Drag the time bar at the bottom to see how it changes.">
        <p className="muted">{world.forecast.label}</p>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void actions.loadLiveForecast(center())}>
            {busy ? 'Loading…' : 'Live forecast here'}
          </button>
          <button className="btn ghost" onClick={() => actions.demoForecastHere(center())}>
            Demo breeze here
          </button>
        </div>
        {err ? <p className="err">{err}</p> : null}
        <div className="toggles">
          <label>
            <input type="checkbox" checked={colors} onChange={() => actions.toggle('colors')} /> Wind speed colours
          </label>
          <label>
            <input type="checkbox" checked={arrows} onChange={() => actions.toggle('arrows')} /> Direction arrows
          </label>
          <label>
            <input type="checkbox" checked={laylines} onChange={() => actions.toggle('showLaylines')} /> Laylines
          </label>
        </div>
      </Section>

      <Section title="Course plan" hint="Leg by leg from the forecast and your boat's polar: which way to go and how long it takes.">
        {legs.length === 0 ? (
          <p className="muted">Add marks in the Course tab to plan a race.</p>
        ) : (
          <>
            <ol className="legs">
              {legs.map((l, i) => (
                <li key={i}>
                  <div className="leg-head">
                    <b>
                      {i + 1}. {l.kind === 'beat' ? 'Beat' : l.kind === 'run' ? 'Run' : 'Reach'} to {l.toName}
                    </b>
                    <span>{Number.isFinite(l.timeS) ? dur(l.timeS) : '–'}</span>
                  </div>
                  <div className="leg-meta">
                    {nm(l.distanceNm)} · {deg(l.bearing)} · wind {deg(l.twd)} {kn(l.tws, 0)} kn · sail {Math.round(l.sailTwa)}° TWA at {kn(l.bsp)} kn
                  </div>
                  {l.kind !== 'reach' && l.headings ? (
                    <div className="leg-advice">
                      Start on <b className={l.firstTack === 'starboard' ? 'stbd' : 'port'}>{l.firstTack}</b> ({l.firstTack === 'starboard' ? deg(l.headings.starboard) : deg(l.headings.port)}). {l.favoured}.
                    </div>
                  ) : (
                    <div className="leg-advice">{l.favoured}.</div>
                  )}
                </li>
              ))}
            </ol>
            <p className="muted">Estimated race time {dur(total)}.</p>
          </>
        )}
      </Section>

      <Section title="Optimal route" hint="The isochrone router sails every possible heading through the forecast and keeps the fastest path, tacks included.">
        <div className="seg route-mode" role="tablist" aria-label="What to route">
          {ROUTE_MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={routeMode === m.id} className={routeMode === m.id ? 'on' : ''} title={m.hint} onClick={() => actions.setRouteMode(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
        <p className="muted route-what">{routeExplain(routeMode, viewT)}</p>
        {routeMode === 'mark' ? (
          <select aria-label="Mark to route to" value={markId ?? ''} onChange={(e) => actions.setRouteMark(e.target.value)}>
            {world.marks.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="row">
          <button className="btn primary" disabled={routeBusy !== null} onClick={() => void actions.calculateRoute()}>
            {routeBusy !== null ? `Routing… ${Math.round(routeBusy * 100)}%` : route ? 'Recalculate' : 'Calculate'}
          </button>
          {route ? (
            <button className="btn ghost" onClick={actions.clearRoute}>
              Clear
            </button>
          ) : null}
        </div>
        {routeErr ? <p className="err">{routeErr}</p> : null}
        <label className="follow-route" title="On auto helm your boat sails the yellow line: its tacks and gybes, its side of the course. Off, it sails its own race (with the learner's mistakes, if those are on).">
          <input type="checkbox" checked={follow} onChange={(e) => actions.setFollowRoute(e.target.checked)} />
          <span>
            <b>Your boat sails this route</b>
            <small>{followNote(follow, route !== null, routeMode, info?.arrivals.length ?? 0)}</small>
          </span>
        </label>
        {route && info ? (
          <>
            <p className="route-title">
              <b>{info.label}</b>
              <span>
                from {info.from}, {clock(info.t0)}
              </span>
            </p>
            <div className="route-sum">
              <div>
                <label>Time</label>
                <b>{route.elapsedS ? dur(route.elapsedS) : '–'}</b>
              </div>
              <div>
                <label>Tacks/gybes</label>
                <b>{routeTacks}</b>
              </div>
              <div>
                <label>vs straight line</label>
                <b>{route.directTimeS && route.elapsedS ? `${Math.round((route.elapsedS / route.directTimeS) * 100)}%` : '–'}</b>
              </div>
            </div>
            {info.arrivals.length > 1 ? (
              <ol className="arrivals">
                {info.arrivals.map((a, i) => (
                  <li key={i}>
                    <span>{a.name}</span>
                    <b>{a.t === null ? '–' : `+${dur((a.t - info.t0) / 1000)}`}</b>
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="muted">The yellow line on the map. It changes tack where the forecast shifts or more pressure makes it worth it.</p>
          </>
        ) : null}
      </Section>
    </div>
  )
}

const ROUTE_MODES: Array<{ id: RouteMode; name: string; hint: string }> = [
  { id: 'course', name: 'Whole course', hint: 'The race: from the start line at the gun, around every mark, to the finish' },
  { id: 'here', name: 'From here', hint: 'From your boat now, around the marks still to go' },
  { id: 'mark', name: 'To one mark', hint: 'From your boat now to a single mark' },
]

/** What the follow switch means right now. */
function followNote(on: boolean, haveRoute: boolean, mode: RouteMode, marks: number): string {
  if (!on) return 'Off: your boat sails its own race. The line is there to compare.'
  if (!haveRoute) return 'Calculate a route, then start a sequence or sail the course to watch it.'
  if (world.own.helm === 'manual') return 'You are steering. Give the helm back to the virtual skipper (A) and it sails the route.'
  if (mode === 'mark' && !world.follow) return 'Only for the next mark of the course: your boat sails its own race to this one.'
  return `On auto helm your boat sails the line${marks > 1 ? ', mark by mark' : ''}, without the learner's mistakes. Tack cost isn't in the route, so expect to finish a little after it says.`
}

function routeExplain(mode: RouteMode, viewT: number): string {
  if (mode === 'mark') return 'From your boat now, straight to one mark: a practice beat, or getting to the racecourse.'
  if (mode === 'here') return 'From where your boat is now, around the marks still to go, to the finish. During a race it recalculates every 2 minutes and at each mark.'
  return world.gunT !== null
    ? `The race: from the favoured end of the start line at the gun (${clock(world.gunT)}), around every mark in order, to the finish.`
    : `The race: from the favoured end of the start line, around every mark in order, to the finish. Gun time is the time bar's: ${clock(viewT)}. Drag it to plan a later start.`
}

// ------------------------------------------------------------ Course

export function CoursePanel() {
  const clickMode = useUi((s) => s.clickMode)
  const selected = useUi((s) => s.selectedMarkId)
  useUi((s) => s.version)
  const [coord, setCoord] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<MarkRole>('mark')
  const [err, setErr] = useState<string | null>(null)
  const [beat, setBeat] = useState(0.9)
  const add = () => {
    const p = parseLatLon(coord)
    if (!p) {
      setErr('Could not read that position. Try 43 35.1 N 70 9.6 W, or 43.585, -70.16.')
      return
    }
    setErr(null)
    actions.addMark(p, role, name.trim() || undefined)
    setCoord('')
    setName('')
  }
  const seq = world.course.sequence
  const gates = world.course.gates ?? []
  const inGate = new Set(gates.flatMap((g) => [g.aId, g.bId]))
  const stops = world.sequence
  return (
    <div className="panel-body">
      <Section title="Add marks" hint="Click on the map, or type coordinates. Drag a mark on the map to move it.">
        <button className={`btn ${clickMode === 'addMark' ? 'primary' : ''}`} onClick={() => actions.setClickMode('addMark')}>
          {clickMode === 'addMark' ? 'Click the map to drop marks… (done)' : 'Click on the map to add'}
        </button>
        <div className="form">
          <input placeholder="43 35.10 N 070 09.60 W" value={coord} onChange={(e) => setCoord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="Coordinates" />
          <div className="row">
            <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Mark name" />
            <select value={role} onChange={(e) => setRole(e.target.value as MarkRole)} aria-label="Mark role">
              <option value="mark">Mark</option>
              <option value="pin">Start pin</option>
              <option value="committee">Committee boat</option>
            </select>
            <button className="btn" onClick={add}>
              Add
            </button>
          </div>
          {err ? <p className="err">{err}</p> : null}
        </div>
      </Section>

      <Section title="Standard courses" hint="Lays a standard course square to the current wind, around the middle of the map. Distances scale with the beat.">
        <div className="row">
          <select value={beat} onChange={(e) => setBeat(Number(e.target.value))} aria-label="Beat length">
            {[0.5, 0.7, 0.9, 1.2, 1.5, 2].map((x) => (
              <option key={x} value={x}>
                {x} nm beat
              </option>
            ))}
          </select>
        </div>
        <div className="layouts">
          {LAYOUTS.map((l) => (
            <button key={l.id} className={`layout ${world.course.layout === l.id ? 'on' : ''}`} title={l.hint} onClick={() => actions.layLayout(l.id, center(), beat)}>
              <LayoutIcon id={l.id} />
              <b>{l.name}</b>
              <small>{l.order}</small>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Gates" hint="A gate is two marks: boats round either one. Open: you sail between the marks, then round either. Closed: you may not sail between them, so you round the outside of one.">
        {gates.length === 0 ? <p className="muted">No gates. Make one from a course mark below (the Gate button in the list), or lay W2, W4 or the trapezoid.</p> : null}
        <ul className="gates">
          {gates.map((g) => (
            <li key={g.id}>
              <b>{g.name}</b>
              <div className="seg sm" role="radiogroup" aria-label={`${g.name} open or closed`}>
                <button role="radio" aria-checked={g.open} className={g.open ? 'on' : ''} onClick={() => actions.setGateOpen(g.id, true)} title="Boats sail between the marks and round either">
                  Open
                </button>
                <button role="radio" aria-checked={!g.open} className={!g.open ? 'on closed' : ''} onClick={() => actions.setGateOpen(g.id, false)} title="No sailing between the marks: round the outside of one">
                  Closed
                </button>
              </div>
              <button className="btn ghost xs" onClick={() => actions.removeGate(g.id)} title="Turn the gate back into one mark">
                Single mark
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Marks">
        <ul className="marks">
          {world.marks.map((m) => (
            <li key={m.id} className={selected === m.id ? 'sel' : ''} onClick={() => useUi.setState({ selectedMarkId: m.id })}>
              <span className={`role ${m.role}`}>{m.role === 'pin' ? 'Pin' : m.role === 'committee' ? 'RC' : 'Mark'}</span>
              <input className="name" value={m.name} onChange={(e) => actions.renameMark(m.id, e.target.value)} aria-label="Mark name" />
              <span className="pos">
                {fmtLat(m.lat)}
                <br />
                {fmtLon(m.lon)}
              </span>
              {m.role === 'mark' ? (
                <button className="btn ghost xs" onClick={() => actions.addToSequence(m.id)} title="Add to the course">
                  + course
                </button>
              ) : null}
              {m.role === 'mark' && seq.includes(m.id) && !inGate.has(m.id) ? (
                <button className="btn ghost xs" onClick={() => actions.makeGate(m.id)} title="Make this mark a gate: a second mark goes alongside it">
                  <Icon name="gate" size={14} /> Gate
                </button>
              ) : null}
              <button className="btn ghost xs danger" onClick={() => actions.deleteMark(m.id)} title="Delete" aria-label="Delete">
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Course order" hint="The order marks are rounded. The last one is the finish.">
        {seq.length === 0 ? <p className="muted">No marks in the course yet.</p> : null}
        <ol className="seq">
          {seq.map((id, i) => {
            // A gate shows as one entry, measured to its middle.
            const m = stops.find((x) => x.id === id)
            const prev = i === 0 ? world.line && { lat: (world.line.pin.lat + world.line.committee.lat) / 2, lon: (world.line.pin.lon + world.line.committee.lon) / 2 } : stops.find((x) => x.id === seq[i - 1])
            return (
              <li key={`${id}-${i}`}>
                <span>
                  {m?.name ?? '?'}
                  {m?.gate ? <em className={m.gate.open ? 'gate-open' : 'gate-closed'}> {m.gate.open ? 'open gate' : 'closed gate'}</em> : null}
                  {i === seq.length - 1 ? <em> finish</em> : null}
                </span>
                <span className="muted">{m && prev ? `${nm(distance(prev, m))} ${deg(bearing(prev, m))}` : ''}</span>
                <button className="btn ghost xs" onClick={() => actions.moveInSequence(i, -1)} aria-label="Move up">
                  <Icon name="up" size={14} />
                </button>
                <button className="btn ghost xs" onClick={() => actions.moveInSequence(i, 1)} aria-label="Move down">
                  <Icon name="down" size={14} />
                </button>
                <button className="btn ghost xs danger" onClick={() => actions.removeFromSequence(i)} aria-label="Remove from course">
                  <Icon name="close" size={14} />
                </button>
              </li>
            )
          })}
        </ol>
      </Section>
    </div>
  )
}

// ------------------------------------------------------------ Race

function cpa(own: SimBoat, other: SimBoat): { cpaNm: number; tcpaS: number } | null {
  const k = Math.cos((own.pos.lat * Math.PI) / 180)
  const dx = (other.pos.lon - own.pos.lon) * 60 * k
  const dy = (other.pos.lat - own.pos.lat) * 60
  const v = (b: SimBoat) => [b.bsp * Math.sin((b.hdg * Math.PI) / 180), b.bsp * Math.cos((b.hdg * Math.PI) / 180)]
  const [ox, oy] = v(own)
  const [tx, ty] = v(other)
  const rvx = tx! - ox!
  const rvy = ty! - oy!
  const rv2 = rvx * rvx + rvy * rvy
  if (rv2 < 1e-6) return null
  const tH = -(dx * rvx + dy * rvy) / rv2
  if (tH < 0) return null
  const cx = dx + rvx * tH
  const cy = dy + rvy * tH
  return { cpaNm: Math.hypot(cx, cy), tcpaS: tH * 3600 }
}

export function RacePanel() {
  const seqMin = useUi((s) => s.seqMinutes)
  useUi((s) => s.version)
  const ln = world.line
  const own = world.own
  const ttg = world.timeToGunS()
  const L = boatModel(world.boatId).preset.dims.loaM
  const bias = ln ? lineBias(ln, own.twd) : null
  const gain = ln ? biasGainM(ln, own.twd) : null
  const standings = world.standings()
  return (
    <div className="panel-body">
      <Section title="Start sequence" hint="Pick the sequence length and press Go. Long beep each minute, short beeps in the last 10 seconds.">
        <div className="row">
          <div className="seg">
            {([10, 5, 3] as const).map((m) => (
              <button key={m} className={seqMin === m ? 'on' : ''} onClick={() => actions.setSeqMinutes(m)}>
                {m} min
              </button>
            ))}
          </div>
          <button className="btn go" onClick={() => actions.startSequence(seqMin)}>
            Go
          </button>
        </div>
        {ttg !== null ? (
          <div className="row">
            <span className="big-count">{ttg > 0 ? mmss(ttg) : `+${mmss(-ttg)}`}</span>
            <button className="btn ghost sm" onClick={actions.syncGun}>
              Sync to minute
            </button>
            <button className="btn ghost sm danger" onClick={actions.stopRace}>
              Abandon
            </button>
          </div>
        ) : null}
      </Section>

      <Section title="Start line" hint="Ping each end as you sail past it, or set them in the Course tab.">
        <div className="row">
          <button className="btn" onClick={() => actions.pingEnd('pin')}>
            Ping pin here
          </button>
          <button className="btn" onClick={() => actions.pingEnd('committee')}>
            Ping boat here
          </button>
        </div>
        {ln ? (
          <div className="kv">
            <span>Length</span>
            <b>
              {Math.round(distance(ln.pin, ln.committee) * 1852)} m ({((distance(ln.pin, ln.committee) * 1852) / L).toFixed(0)} lengths)
            </b>
            <span>Favoured end</span>
            <b>{bias === null ? '–' : Math.abs(bias) < 2 ? 'Square line' : `${bias > 0 ? 'Pin' : 'Committee boat'} by ${Math.abs(bias).toFixed(0)}°`}</b>
            <span>Worth</span>
            <b>{gain === null ? '–' : `${Math.round(gain)} m (${(gain / L).toFixed(1)} lengths)`}</b>
          </div>
        ) : (
          <p className="muted">No start line yet.</p>
        )}
      </Section>

      <Section title={world.boats.length > 1 ? `Fleet · AIS (${world.boats.length - 1})` : 'Fleet · AIS'} hint="Other boats as AIS targets: position, course and speed every few seconds. CPA is how close they will pass.">
        {world.boats.length <= 1 ? <p className="muted">No AIS targets. Start a sequence to bring in the simulated fleet.</p> : null}
        <table className="ais">
          <thead>
            <tr>
              <th>#</th>
              <th>Boat</th>
              <th>SOG</th>
              <th>COG</th>
              <th title="Closest point of approach">CPA</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((b, i) => {
              const c = b.own ? null : cpa(own, b)
              return (
                <tr key={b.id} className={b.own ? 'own' : ''}>
                  <td>{i + 1}</td>
                  <td>
                    <i className="swatch" style={{ background: b.color }} />
                    {b.name}
                    {!b.own ? <small> {b.mmsi}</small> : null}
                    {b.ocs ? <em className="bad"> OCS</em> : null}
                  </td>
                  <td>{kn(b.bsp)}</td>
                  <td>{deg(b.hdg)}</td>
                  <td className={c && c.cpaNm < 0.03 && c.tcpaS < 120 ? 'bad' : ''}>{b.own ? '' : c ? `${Math.round(c.cpaNm * 1852)} m · ${mmss(c.tcpaS)}` : '–'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

// ------------------------------------------------------------ Simulate

export function SimPanel() {
  const clickMode = useUi((s) => s.clickMode)
  const running = useUi((s) => s.running)
  const speed = useUi((s) => s.speed)
  const fleet = useUi((s) => s.fleetSize)
  const seqMin = useUi((s) => s.seqMinutes)
  const source = useUi((s) => s.source)
  const n2kUrl = useUi((s) => s.n2kUrl)
  const n2kStatus = useUi((s) => s.n2kStatus)
  const n2kDetail = useUi((s) => s.n2kDetail)
  const gps = useUi((s) => s.gpsStatus)
  useUi((s) => s.version)
  const own = world.own
  const preset = boatModel(world.boatId).preset
  return (
    <div className="panel-body">
      {source !== 'sim' ? (
        <Section title="Instruments" hint="On the boat, a Signal K server (for example on a Raspberry Pi with an NMEA 2000 gateway) streams the network to the app.">
          {source === 'n2k' ? (
            <>
              <div className="row">
                <input value={n2kUrl} onChange={(e) => actions.setN2kUrl(e.target.value)} aria-label="Signal K stream URL" />
                <button className="btn" onClick={() => actions.setSource('n2k')}>
                  Connect
                </button>
              </div>
              <p className="muted">
                Status: <b>{n2kStatus}</b>
                {n2kDetail ? ` (${n2kDetail})` : ''}
              </p>
            </>
          ) : (
            <p className="muted">{gps ?? 'Waiting for the phone’s GPS…'}</p>
          )}
          <button className="btn ghost" onClick={() => actions.setSource('sim')}>
            Back to the simulator
          </button>
        </Section>
      ) : null}

      <Section title="Your boat" hint="Place the simulated boat anywhere, then sail the course or race the fleet.">
        <div className="row">
          <select value={world.boatId} onChange={(e) => actions.setBoat(e.target.value)} aria-label="Boat class">
            {BOATS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className={`btn ${clickMode === 'placeBoat' ? 'primary' : ''}`} onClick={() => actions.setClickMode('placeBoat')}>
            {clickMode === 'placeBoat' ? 'Click the map…' : 'Place on map'}
          </button>
        </div>
        <p className="muted">{preset.blurb}</p>
        <label className="check">
          <input type="checkbox" checked={world.mistakes} onChange={(e) => actions.setMistakes(e.target.checked)} />
          <span>
            <b>Learner crew</b>: makes typical mistakes (sails low, tacks too much, slow tacks, late start, overstands) so the coach has something to talk about.
          </span>
        </label>
      </Section>

      <Section title="Run it">
        <div className="row">
          <button className="btn primary" onClick={actions.sailCourse}>
            Sail the course
          </button>
          <button className="btn go" onClick={() => actions.startSequence(seqMin)}>
            Race the fleet ({seqMin} min start)
          </button>
        </div>
        <div className="row">
          <label className="inline">
            Fleet
            <input type="range" min={0} max={6} value={fleet} onChange={(e) => actions.setFleetSize(Number(e.target.value))} aria-label="Fleet size" />
            <b>{fleet}</b>
          </label>
        </div>
        <div className="row">
          <button className="btn" onClick={actions.toggleRun}>
            {running ? 'Pause' : 'Resume'}
          </button>
          <div className="seg">
            {[1, 4, 8, 16, 32].map((x) => (
              <button key={x} className={speed === x ? 'on' : ''} onClick={() => actions.setSpeed(x)}>
                {x}×
              </button>
            ))}
          </div>
        </div>
        <p className="muted">
          {own.intent}
          {own.phase === 'racing' ? ` · ${own.tacks} tacks so far` : ''}
        </p>
      </Section>

      <Section title="Helm" hint="Take the helm yourself. Arrow keys steer, T or space tacks/gybes, A gives it back to the autopilot.">
        <div className="helm">
          <button className="btn" onClick={() => actions.helm(-10)} title="Steer 10° to port" aria-label="Steer 10° to port">
            <Icon name="rot-left" size={14} /> 10°
          </button>
          <button className="btn" onClick={() => actions.helm(-2)} title="Steer 2° to port" aria-label="Steer 2° to port">
            <Icon name="left" size={14} /> 2°
          </button>
          <button className="btn go" onClick={actions.tack}>
            {Math.abs(own.twa) < 90 ? 'Tack' : 'Gybe'}
          </button>
          <button className="btn" onClick={() => actions.helm(2)} title="Steer 2° to starboard" aria-label="Steer 2° to starboard">
            2° <Icon name="right" size={14} />
          </button>
          <button className="btn" onClick={() => actions.helm(10)} title="Steer 10° to starboard" aria-label="Steer 10° to starboard">
            10° <Icon name="rot-right" size={14} />
          </button>
        </div>
        <button className={`btn ${own.helm === 'auto' ? 'on' : ''}`} onClick={actions.autopilot}>
          {own.helm === 'auto' ? 'Virtual skipper is steering' : 'Give it back to the virtual skipper'}
        </button>
      </Section>
    </div>
  )
}

/** A small sketch of each standard course, wind from the top. */
function LayoutIcon({ id }: { id: LayoutId }) {
  const stroke = 'currentColor'
  const dot = (x: number, y: number, k?: string) => <circle key={k ?? `${x},${y}`} cx={x} cy={y} r={2.4} fill="var(--warn)" />
  const gate = (x: number, y: number) => [dot(x - 3.5, y, `g1${x}`), dot(x + 3.5, y, `g2${x}`)]
  const line = <line x1={14} y1={44} x2={26} y2={44} stroke="var(--ink-dim)" strokeWidth={1.6} />
  const shapes: Record<LayoutId, ReactNode> = {
    w2: (
      <>
        <path d="M20 44 L20 8 L20 48" stroke={stroke} strokeWidth={1.2} strokeDasharray="2 2" fill="none" />
        {dot(20, 8)}
        {gate(20, 50)}
      </>
    ),
    w4: (
      <>
        <path d="M18 44 L18 8 M22 8 L22 48" stroke={stroke} strokeWidth={1.2} strokeDasharray="2 2" fill="none" />
        {dot(20, 8)}
        {gate(20, 50)}
        <text x={30} y={28} fontSize={8} fill="var(--ink-dim)">×4</text>
      </>
    ),
    triangle: (
      <>
        <path d="M20 44 L20 8 L6 28 L20 50 Z" stroke={stroke} strokeWidth={1.2} strokeDasharray="2 2" fill="none" />
        {dot(20, 8)}
        {dot(6, 28)}
        {dot(20, 50)}
      </>
    ),
    trapezoid: (
      <>
        <path d="M20 44 L24 8 L8 14 L8 46 L24 46" stroke={stroke} strokeWidth={1.2} strokeDasharray="2 2" fill="none" />
        {dot(24, 8)}
        {dot(8, 14)}
        {gate(8, 48)}
      </>
    ),
  }
  return (
    <svg viewBox="0 0 40 56" width={34} height={48} aria-hidden>
      {line}
      {shapes[id]}
    </svg>
  )
}
