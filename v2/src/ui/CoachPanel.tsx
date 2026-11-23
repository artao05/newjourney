import { useState } from 'react'
import { recurring, windBand } from '../coach/learn'
import { boatModel } from '../engine/boats'
import { actions, useUi, world } from '../state'
import { clockS, dur } from './format'

const CAT_LABEL: Record<string, string> = {
  start: 'Start',
  pointing: 'Pointing',
  tacking: 'Tacking',
  laylines: 'Laylines',
  shifts: 'Wind shifts',
  downwind: 'Downwind',
  speed: 'Speed',
}

export function CoachPanel() {
  const ai = useUi((s) => s.ai)
  const analysis = useUi((s) => s.analysis)
  const d = useUi((s) => s.debrief)
  const busy = useUi((s) => s.debriefBusy)
  const note = useUi((s) => s.debriefNote)
  const chat = useUi((s) => s.chat)
  const chatBusy = useUi((s) => s.chatBusy)
  const answers = useUi((s) => s.answers)
  const profile = useUi((s) => s.profile)
  const highlight = useUi((s) => s.highlight)
  const [q, setQ] = useState('')
  useUi((s) => s.version)
  const L = boatModel(world.boatId).preset.dims.loaM
  const rec = recurring(profile)
  const findingById = new Map(analysis?.findings.map((f) => [f.id, f]) ?? [])

  return (
    <div className="panel-body coach">
      <div className={`ai-badge ${ai?.ai ? 'on' : 'off'}`} title={ai?.reason ?? ''}>
        <span className="live-dot" />
        {ai?.ai ? `AI coach on (${ai.model})` : 'Built-in coach (AI off)'}
        {!ai?.ai && ai?.reason ? <small>{ai.reason}</small> : null}
      </div>

      <section className="psec">
        <button className="btn primary wide" disabled={busy} onClick={() => void actions.runDebrief()}>
          {busy ? 'Coach is reviewing your race…' : analysis ? 'Debrief again' : 'Debrief this session'}
        </button>
        {note ? <p className="muted">{note}</p> : null}
        {!analysis && !busy ? <p className="muted">Sail the course or race the fleet in the simulator (or sail for real with instruments connected). The coach debriefs automatically when you finish.</p> : null}
      </section>

      {analysis ? (
        <section className="psec stats">
          <div>
            <label>Upwind</label>
            <b>{analysis.stats.upwindPolarPct?.toFixed(0) ?? '–'}%</b>
            <span>of polar</span>
          </div>
          <div>
            <label>Downwind</label>
            <b>{analysis.stats.downwindPolarPct?.toFixed(0) ?? '–'}%</b>
            <span>of polar</span>
          </div>
          <div>
            <label>Tacks</label>
            <b>{analysis.stats.tacks}</b>
            <span>{analysis.stats.avgTackLossM !== null ? `${(analysis.stats.avgTackLossM / L).toFixed(1)} lengths each` : ''}</span>
          </div>
          <div>
            <label>Lost</label>
            <b>~{dur(analysis.lostS)}</b>
            <span>to fixable things</span>
          </div>
        </section>
      ) : null}

      {d ? (
        <section className="psec debrief">
          <div className="src-tag">{d.source === 'ai' ? 'AI coach' : 'Built-in coach'}</div>
          <h2>{d.headline}</h2>
          <p>{d.summary}</p>
        </section>
      ) : null}

      {analysis && analysis.findings.length ? (
        <section className="psec">
          <h3>Where you lost time</h3>
          <p className="muted">Tap one to see it on the map.</p>
          <ul className="findings">
            {(d?.mistakes.length ? d.mistakes : analysis.findings.map((f) => ({ finding_id: f.id, title: f.title, what_happened: f.detail, why_it_matters: '', fix: f.tip }))).map((m, i) => {
              const f = findingById.get(m.finding_id)
              const on = f && highlight && highlight.tFrom === f.tFrom
              return (
                <li key={`${m.finding_id}-${i}`} className={on ? 'on' : ''} onClick={() => f && actions.focusFinding(f.tFrom, f.tTo, f.at)}>
                  <div className="f-head">
                    {f ? <span className={`cat ${f.category}`}>{CAT_LABEL[f.category]}</span> : null}
                    <b>{m.title}</b>
                    {f ? <span className="cost">~{Math.round(f.costS)} s</span> : null}
                  </div>
                  <p>{m.what_happened}</p>
                  {m.why_it_matters ? <p className="muted">{m.why_it_matters}</p> : null}
                  <p className="fix">
                    <b>Try:</b> {m.fix}
                  </p>
                  {f ? <small className="muted">{clockS(f.tFrom)} · {f.metric}</small> : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {d && d.tendencies.length ? (
        <section className="psec">
          <h3>Your tendencies</h3>
          <ul className="plain">
            {d.tendencies.map((t, i) => (
              <li key={i}>
                <b>{t.title}.</b> {t.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d && d.strengths.length ? (
        <section className="psec">
          <h3>What went well</h3>
          <ul className="plain good">
            {d.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {d && d.questions.length ? (
        <section className="psec">
          <h3>The coach wants to know</h3>
          <p className="muted">Your answers are saved with your boat and shape future advice.</p>
          {d.questions.map((qq) => (
            <div key={qq.id} className="question">
              <p>{qq.question}</p>
              <small className="muted">{qq.why}</small>
              <textarea rows={2} value={answers[qq.id] ?? ''} onChange={(e) => actions.answer(qq.id, e.target.value)} aria-label={qq.question} />
            </div>
          ))}
          <button className="btn" disabled={chatBusy || !Object.values(answers).some((x) => x.trim())} onClick={() => void actions.submitAnswers()}>
            Send answers
          </button>
        </section>
      ) : null}

      {d && d.drills.length ? (
        <section className="psec">
          <h3>Drills for next time</h3>
          <ol className="plain">
            {d.drills.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {analysis ? (
        <section className="psec chat">
          <h3>Ask the coach</h3>
          <div className="chat-log">
            {chat.map((t, i) => (
              <div key={i} className={`msg ${t.role}`}>
                {t.text}
              </div>
            ))}
            {chatBusy ? <div className="msg assistant typing">…</div> : null}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              if (!q.trim()) return
              void actions.ask(q.trim())
              setQ('')
            }}
          >
            <input placeholder="Why did I lose on the second beat?" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question for the coach" />
            <button className="btn" disabled={chatBusy}>
              Ask
            </button>
          </form>
        </section>
      ) : null}

      <section className="psec learned">
        <h3>What the app has learned about your {boatModel(world.boatId).preset.name}</h3>
        {profile.sessions.length === 0 ? (
          <p className="muted">Nothing yet. Each debriefed session teaches it your real speeds, tack losses and habits.</p>
        ) : (
          <>
            <div className="kv">
              <span>Sessions</span>
              <b>{profile.sessions.length}</b>
              <span>Average tack</span>
              <b>{profile.tackLossM ? `${(profile.tackLossM.mean / L).toFixed(1)} boat lengths` : '–'}</b>
              {Object.entries(profile.polarFactor).map(([band, f]) => (
                <span key={band} style={{ display: 'contents' }}>
                  <span>{band} kn</span>
                  <b>
                    up {Math.round(f.up * 100)}% · down {Math.round(f.down * 100)}% of polar
                  </b>
                </span>
              ))}
            </div>
            <p className="muted">The instruments now show targets scaled to what your boat really does (marked "learned"), in the wind bands it has seen{analysis ? `, including ${windBand(analysis.stats.avgTws)} kn` : ''}.</p>
            {rec.length ? (
              <p>
                <b>Keeps coming up:</b> {rec.map((c) => CAT_LABEL[c]).join(', ')}
              </p>
            ) : null}
            {profile.notes.length ? (
              <ul className="plain">
                {profile.notes.slice(-6).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
            {profile.answers.length ? <p className="muted">{profile.answers.length} answers to the coach's questions on file.</p> : null}
            <button className="btn ghost xs danger" onClick={actions.forgetBoat}>
              Forget this boat
            </button>
          </>
        )}
      </section>
    </div>
  )
}
