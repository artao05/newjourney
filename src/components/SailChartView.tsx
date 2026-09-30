/**
 * The sail chart in Setup: load, save, edit and see it, with the boat's wind
 * now marked. Each cell is coloured by its sail, so the crossovers show as
 * edges between colours, the way a sailmaker draws one. Tapping a cell picks
 * its sail from those on board. The sail inventory lives here too.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { SailChartError, parseSailChart, sailAt, sailColour, sailsIn, serialiseSailChart } from '@/lib/sailchart'

export function SailChartView({ twa, tws }: { twa: number | null; tws: number | null }) {
  const chart = useStore((s) => s.sailChart)
  const setSailChart = useStore((s) => s.setSailChart)
  const now = chart && twa != null && tws != null ? sailAt(chart, twa, tws) : null
  const sails = useStore((s) => s.sails)
  const setSails = useStore((s) => s.setSails)
  const [picking, setPicking] = useState<{ i: number; j: number } | null>(null)
  const [newSail, setNewSail] = useState('')
  const onBoard = sails.filter((x) => x.onBoard).map((x) => x.name)
  const pickFrom = [...new Set([...onBoard, ...(chart ? sailsIn(chart) : [])])]
  const setCell = (i: number, j: number, name: string) => {
    if (!chart) return
    setSailChart({ ...chart, cells: chart.cells.map((row, a) => (a === i ? row.map((c, b) => (b === j ? name : c)) : row)) })
    setPicking(null)
  }
  const newChart = () =>
    setSailChart({ twa: [40, 60, 80, 100, 120, 140, 160, 180], tws: [4, 6, 8, 10, 12, 14, 16, 20, 25], cells: Array.from({ length: 9 }, () => Array(8).fill('')) })

  const load = async (file: File) => {
    try {
      setSailChart(parseSailChart(await file.text()))
    } catch (e) {
      alert(e instanceof SailChartError ? e.message : `Could not read that sail chart: ${e}`)
    }
  }
  const save = async () => {
    if (!chart) return
    const { downloadText } = await import('@/lib/gpx')
    downloadText('sailchart.txt', serialiseSailChart(chart), 'text/tab-separated-values')
  }
  // The live point sits in the nearest cell, as sailAt reads it.
  const nearestIdx = (values: number[], v: number) =>
    values.reduce((b, x, i) => (Math.abs(x - v) < Math.abs(values[b] - v) ? i : b), 0)
  const hi = chart && twa != null && tws != null
    ? { i: nearestIdx(chart.tws, tws), j: nearestIdx(chart.twa, Math.min(180, Math.abs(twa))) }
    : null

  return (
    <section aria-label="Sail chart">
      <h2>Sail chart</h2>
      {chart ? (
        <>
          <div className="tablewrap">
            <table className="sailchart" aria-label="Sails by TWA and TWS">
              <thead>
                <tr>
                  <th>TWS \ TWA</th>
                  {chart.twa.map((a) => (
                    <th key={a}>{a}°</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chart.tws.map((w, i) => (
                  <tr key={w}>
                    <th>{w} kn</th>
                    {chart.cells[i].map((s, j) => (
                      <td
                        key={j}
                        onClick={() => setPicking({ i, j })}
                        aria-label={`Sail at ${chart.tws[i]} kn, ${chart.twa[j]}°`}
                        style={{ background: s ? sailColour(s) : undefined, cursor: 'pointer' }}
                        className={hi && hi.i === i && hi.j === j ? 'sailchart__now' : undefined}
                        aria-current={hi && hi.i === i && hi.j === j ? 'true' : undefined}
                      >
                        {s}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {picking && (
            <div className="field" aria-label="Pick a sail">
              <label htmlFor="sail-pick">
                {chart.tws[picking.i]} kn, {chart.twa[picking.j]}°
              </label>
              <select id="sail-pick" value={chart.cells[picking.i][picking.j]} onChange={(e) => setCell(picking.i, picking.j, e.target.value)}>
                <option value="">no sail</option>
                {pickFrom.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="note">
            {now ? (
              <>
                Now: <b>{now}</b>, for the wind the boat has.{' '}
              </>
            ) : twa == null || tws == null ? (
              'Set a wind to see which sail it calls for now. '
            ) : (
              'No sail is named for the wind now. '
            )}
            {sailsIn(chart).length} sails: {sailsIn(chart).join(', ')}.
          </p>
        </>
      ) : (
        <p className="note">
          None loaded. A sail chart is a tab-separated table: TWA across the top row,
          TWS down the first column, and a sail name in each cell, as Expedition and a
          spreadsheet write it.
        </p>
      )}
      <h2>Sails</h2>
      <table className="targets" aria-label="Sail inventory" style={{ width: '100%' }}>
        <tbody>
          {sails.map((x, k) => (
            <tr key={k}>
              <td>
                <input aria-label={`Sail ${k + 1} name`} value={x.name} onChange={(e) => setSails(sails.map((y, m) => (m === k ? { ...y, name: e.target.value } : y)))} />
              </td>
              <td>
                <label>
                  <input type="checkbox" checked={x.onBoard} onChange={(e) => setSails(sails.map((y, m) => (m === k ? { ...y, onBoard: e.target.checked } : y)))} /> on board
                </label>
              </td>
              <td>
                <button className="btn btn--sm btn--ghost" aria-label={`Remove sail ${x.name}`} onClick={() => setSails(sails.filter((_, m) => m !== k))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
        <input aria-label="New sail" placeholder="e.g. J2" value={newSail} onChange={(e) => setNewSail(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
        <button
          className="btn btn--sm btn--ghost"
          disabled={!newSail.trim() || sails.some((x) => x.name === newSail.trim())}
          onClick={() => {
            setSails([...sails, { name: newSail.trim(), onBoard: true }])
            setNewSail('')
          }}
        >
          ADD SAIL
        </button>
        {chart && sailsIn(chart).some((n) => !sails.some((x) => x.name === n)) && (
          <button className="btn btn--sm btn--ghost" onClick={() => setSails([...sails, ...sailsIn(chart).filter((n) => !sails.some((x) => x.name === n)).map((name) => ({ name, onBoard: true }))])}>
            ADD THE CHART'S SAILS
          </button>
        )}
      </div>
      <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
        {!chart && (
          <button className="btn btn--sm btn--ghost" onClick={newChart}>
            NEW SAIL CHART
          </button>
        )}
        <label className="btn btn--sm btn--ghost" style={{ display: 'block', textAlign: 'center' }}>
          LOAD SAIL CHART
          <input
            type="file"
            accept=".txt,.tsv,.csv,text/plain"
            aria-label="Load a sail chart"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void load(f)
              e.target.value = ''
            }}
          />
        </label>
        <button className="btn btn--sm btn--ghost" onClick={() => void save()} disabled={!chart}>
          SAVE
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => setSailChart(null)} disabled={!chart}>
          CLEAR
        </button>
      </div>
    </section>
  )
}
