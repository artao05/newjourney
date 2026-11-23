import { actions, useUi } from '../state'

const TERMS: Array<[string, string]> = [
  ['TWS (true wind speed)', 'How hard the wind blows, as if you were standing still. Colours on the map show it: white and green light, yellow and orange fresh, red strong.'],
  ['TWD (true wind direction)', 'The compass direction the wind comes from. When it changes, that is a "shift".'],
  ['TWA (true wind angle)', 'The angle between your bow and the wind. About 40–45° is close-hauled (sailing upwind), 90° a reach, 140–180° running downwind.'],
  ['Port / starboard tack', 'Starboard tack: wind coming over the right (starboard) side, shown green. Port tack: over the left, shown red. Starboard has right of way.'],
  ['Polar', 'A table of how fast your boat can sail at every wind speed and angle. "Polar %" compares your speed with it.'],
  ['Target speed and angle', 'The best upwind (or downwind) angle and speed from the polar: the balance of speed and pointing that gets you to the mark fastest.'],
  ['VMG (velocity made good)', 'How fast you are making progress straight upwind or downwind. Sailing higher or lower than target lowers it.'],
  ['Lift and header', 'A shift that lets you point closer to the mark is a lift; one that forces you away is a header. Tack on headers that last.'],
  ['Layline', 'The line from which you can just reach the mark on the other tack. Tack too early and you need two more tacks; too late ("overstand") and you sail extra distance.'],
  ['Favoured end', 'The end of the start line that is further upwind. Starting there is a free head start.'],
  ['Time to burn', 'Spare seconds before you must head for the line at full speed. Burn them by slowing down, so you cross on the gun at full speed.'],
  ['OCS', '"On course side": over the line before the gun. You must go back and restart.'],
  ['AIS', 'Automatic Identification System: boats broadcast position, course and speed. Here it shows the rest of the fleet.'],
  ['NMEA 2000 (N2K)', 'The instrument network on a boat. A Signal K server bridges it to this app over Wi-Fi.'],
  ['Isochrone routing', 'The router fans out every heading from your position, step by step through the forecast, and keeps the fastest path to the finish.'],
]

export function Help() {
  const open = useUi((s) => s.helpOpen)
  if (!open) return null
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Sailing terms" onClick={() => actions.setHelp(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New to racing? The words on the screen</h2>
          <button className="icon-btn" onClick={() => actions.setHelp(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <dl className="terms">
          {TERMS.map(([t, d]) => (
            <div key={t}>
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <h3>Keyboard</h3>
        <p className="muted">← → steer 2° (Shift for 10°) · T or Space tack/gybe · A autopilot · P pause · Esc cancel a map click</p>
        <p className="muted">Not for navigation. Forecasts and the simulator are for planning and practice.</p>
      </div>
    </div>
  )
}
