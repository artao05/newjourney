/**
 * Setup → Sharing: share the course, the start line and the instruments with
 * other copies of the app, through the bridge on this machine (and, linked,
 * on others).
 */
import { useStore } from '@/state/store'
import { SHARE_TOPICS, type ShareTopic } from '@/lib/share'
import { useTick } from '@/hooks/useSensors'

const STATUS = {
  off: 'Off',
  connecting: 'Connecting to the bridge…',
  connected: 'Sharing',
  closed: 'The bridge went away; trying again',
  error: 'No bridge; trying again',
} as const

export function ShareSection() {
  const share = useStore((s) => s.settings.share)
  const status = useStore((s) => s.shareStatus)
  const updateSettings = useStore((s) => s.updateSettings)
  const now = useTick(1)
  const set = (patch: Partial<typeof share>) => updateSettings({ share: { ...share, ...patch } })
  const toggle = (list: 'send' | 'receive', t: ShareTopic, on: boolean) =>
    set({ [list]: on ? [...share[list].filter((x) => x !== t), t] : share[list].filter((x) => x !== t) })
  const ago = (t: number | null) => (t == null ? 'never' : `${Math.max(0, Math.round((now - t) / 1000))} s ago`)

  return (
    <section aria-label="Sharing">
      <h2>Sharing</h2>
      <p className="note">
        With other copies of newjourney: on this computer, or on another linked to it (run the bridge on both,
        with <code>--peer ws://OTHER:3080 --key SECRET</code>). Instruments taken in drive this copy, as a repeater.
      </p>
      <div className="field">
        <label htmlFor="share-url">Bridge</label>
        <input id="share-url" value={share.url} spellCheck={false} onChange={(e) => set({ url: e.target.value.trim() })} />
      </div>
      <table className="targets" aria-label="What is shared">
        <thead>
          <tr>
            <th>Topic</th>
            <th>Send</th>
            <th>Take in</th>
          </tr>
        </thead>
        <tbody>
          {SHARE_TOPICS.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>
                <input type="checkbox" aria-label={`Send ${t.name}`} checked={share.send.includes(t.id)} onChange={(e) => toggle('send', t.id, e.target.checked)} />
              </td>
              <td>
                <input type="checkbox" aria-label={`Take in ${t.name}`} checked={share.receive.includes(t.id)} onChange={(e) => toggle('receive', t.id, e.target.checked)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field field--wide">
        <label htmlFor="share-channels">Instrument channels sent</label>
        <input
          id="share-channels"
          placeholder="all of them; or e.g. awa, aws, bsp, headingTrue"
          value={share.channels.join(', ')}
          spellCheck={false}
          onChange={(e) => set({ channels: e.target.value.split(/[\s,]+/).filter(Boolean) })}
        />
      </div>
      <button className={share.on ? 'btn btn--sm btn--ghost' : 'btn btn--sm'} onClick={() => set({ on: !share.on })}>
        {share.on ? 'STOP SHARING' : 'SHARE'}
      </button>
      <p className="note" role="status">
        {STATUS[status.status]}
        {status.detail && status.status !== 'connected' ? ` (${status.detail})` : ''}
        {share.on && status.status === 'connected' ? ` · sent ${ago(status.lastOut)}, taken in ${ago(status.lastIn)}` : ''}
      </p>
      <WatchedFolders />
    </section>
  )
}

/** Files from the folders the bridge watches, opened as they land. */
function WatchedFolders() {
  const watch = useStore((s) => s.settings.watchFolders)
  const log = useStore((s) => s.watchLog)
  const updateSettings = useStore((s) => s.updateSettings)
  const url = useStore((s) => s.settings.share.url)
  return (
    <div aria-label="Watched folders" role="group">
      <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Watched folders</h3>
      <p className="note">
        GRIB files, raster charts, ENC cells and position reports that land in a folder the bridge watches
        (<code>node bridge/bridge.ts --watch C:\Downloads\grib</code>) open here as they arrive.
      </p>
      <button
        className={watch?.on ? 'btn btn--sm btn--ghost' : 'btn btn--sm'}
        onClick={() => updateSettings({ watchFolders: { on: !watch?.on, url: watch?.url || url } })}
      >
        {watch?.on ? 'STOP TAKING FILES' : 'TAKE FILES FROM THE BRIDGE'}
      </button>
      {log.length > 0 && (
        <ul className="note" aria-label="Files taken in" style={{ paddingLeft: 18 }}>
          {log.map((e) => (
            <li key={`${e.name}-${e.at}`} style={e.ok ? undefined : { color: 'var(--port)' }}>
              {new Date(e.at).toLocaleTimeString()} {e.name}: {e.kind}, {e.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
