/**
 * The sail chart in Setup: load, save, and see it, with the boat's wind now
 * marked. Each cell is coloured by its sail, so the crossovers show as edges
 * between colours, the way a sailmaker draws one.
 */

import { useStore } from '@/state/store'
import { SailChartError, parseSailChart, sailAt, sailColour, sailsIn, serialiseSailChart } from '@/lib/sailchart'

export function SailChartView({ twa, tws }: { twa: number | null; tws: number | null }) {
  const chart = useStore((s) => s.sailChart)
  const setSailChart = useStore((s) => s.setSailChart)
  const now = chart && twa != null && tws != null ? sailAt(chart, twa, tws) : null

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
                        style={{ background: s ? sailColour(s) : undefined }}
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
      <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
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
