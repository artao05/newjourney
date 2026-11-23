import { useEffect, useState } from 'react'
import { MapView } from './map/MapView'
import { actions, useUi } from './state'
import { CoachPanel } from './ui/CoachPanel'
import { Help } from './ui/Help'
import { Instruments, Legend, RaceHud, Timeline, Tips } from './ui/Overlays'
import { CoursePanel, PlanPanel, RacePanel, SimPanel } from './ui/Panels'
import { TopBar } from './ui/TopBar'

const TITLES = { plan: 'Plan', course: 'Course', race: 'Race', sim: 'Simulate', coach: 'Coach' } as const

export function App() {
  const tab = useUi((s) => s.tab)
  const clickMode = useUi((s) => s.clickMode)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.key === 'ArrowLeft') actions.helm(e.shiftKey ? -10 : -2)
      else if (e.key === 'ArrowRight') actions.helm(e.shiftKey ? 10 : 2)
      else if (e.key === 't' || e.key === ' ') {
        e.preventDefault()
        actions.tack()
      } else if (e.key === 'a') actions.autopilot()
      else if (e.key === 'p') actions.toggleRun()
      else if (e.key === 'Escape') useUi.setState({ clickMode: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <TopBar />
      <main className="stage">
        <MapView />
        <div className="overlay-left">
          <Instruments />
          <Tips />
        </div>
        <div className="overlay-top">
          <RaceHud />
        </div>
        <div className="overlay-bottom-left">
          <Legend />
        </div>
        {clickMode ? (
          <div className="click-hint">
            {clickMode === 'addMark' ? 'Click the map to drop a mark' : 'Click the map to place your boat'} · <button onClick={() => useUi.setState({ clickMode: null })}>Done</button>
          </div>
        ) : null}
        <p className="nfn">Not for navigation</p>
      </main>
      <aside className={`panel ${open ? 'open' : 'closed'}`} aria-label={TITLES[tab]}>
        <button className="panel-handle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span>{TITLES[tab]}</span>
          <i>{open ? '▾' : '▴'}</i>
        </button>
        {tab === 'plan' ? <PlanPanel /> : null}
        {tab === 'course' ? <CoursePanel /> : null}
        {tab === 'race' ? <RacePanel /> : null}
        {tab === 'sim' ? <SimPanel /> : null}
        {tab === 'coach' ? <CoachPanel /> : null}
      </aside>
      <Timeline />
      <Help />
    </div>
  )
}
