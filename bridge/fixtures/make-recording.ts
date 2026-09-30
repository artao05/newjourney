/**
 * Writes bridge/fixtures/casco-bay-synthetic.nmea: five minutes of a made-up
 * boat beating off Portland, as a boat's instrument network would send it, to
 * test the bridge and the app without a boat. SYNTHETIC: worked out here, not
 * recorded. A real recording is still a need (docs/08-parity/needs.md §5).
 *
 *   node bridge/fixtures/make-recording.ts
 *
 * Wind 12 kn from 220°T, the boat at 6.2 kn tacking every two minutes between
 * 265°T and 175°T, variation 14.5° W, depth rolling round 12 m. Once a second:
 * RMC, VTG, HDG, VHW, MWV (apparent), DPT. Every ten seconds a ferry's AIS
 * position report (type 1).
 */
import { writeFileSync } from 'node:fs'

const checksum = (body: string) => {
  let x = 0
  for (const ch of body) x ^= ch.charCodeAt(0)
  return x.toString(16).toUpperCase().padStart(2, '0')
}
const sentence = (body: string, lead = '$') => `${lead}${body}*${checksum(body)}`

const f = (v: number, d: number) => v.toFixed(d)
const RAD = Math.PI / 180
const wrap = (d: number) => ((d % 360) + 360) % 360

function dm(deg: number, lat: boolean): string {
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const m = (a - d) * 60
  return `${String(d).padStart(lat ? 2 : 3, '0')}${m.toFixed(4).padStart(7, '0')},${lat ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W'}`
}

/** An AIS type 1 position report, armoured into one !AIVDM sentence. */
function aisType1(o: { mmsi: number; lat: number; lon: number; sog: number; cog: number; heading: number; second: number }): string {
  const bits: number[] = []
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2)
  }
  const signed = (v: number, n: number) => put(v < 0 ? 2 ** n + v : v, n)
  put(1, 6) // type
  put(0, 2) // repeat
  put(o.mmsi, 30)
  put(0, 4) // under way using engine
  signed(-128, 8) // rate of turn not available
  put(Math.round(o.sog * 10), 10)
  put(1, 1) // high accuracy
  signed(Math.round(o.lon * 600000), 28)
  signed(Math.round(o.lat * 600000), 27)
  put(Math.round(o.cog * 10), 12)
  put(Math.round(o.heading), 9)
  put(o.second, 6)
  put(0, 2) // no special manoeuvre
  put(0, 3) // spare
  put(0, 1) // RAIM off
  put(0, 19) // radio status
  let payload = ''
  for (let i = 0; i < bits.length; i += 6) {
    let v = 0
    for (let k = 0; k < 6; k++) v = v * 2 + (bits[i + k] ?? 0)
    payload += String.fromCharCode(v < 40 ? v + 48 : v + 56)
  }
  return sentence(`AIVDM,1,1,,A,${payload},0`, '!')
}

const t0 = Date.UTC(2026, 8, 30, 16, 0, 0)
const TWD = 220
const TWS = 12
const BSP = 6.2
const VAR = -14.5
let lat = 43.64
let lon = -70.22
let ferry = { lat: 43.652, lon: -70.25 }
const out: string[] = []
for (let s = 0; s < 300; s++) {
  const t = new Date(t0 + s * 1000)
  const hh = String(t.getUTCHours()).padStart(2, '0')
  const mm = String(t.getUTCMinutes()).padStart(2, '0')
  const ss = String(t.getUTCSeconds()).padStart(2, '0')
  const time = `${hh}${mm}${ss}.00`
  const date = `${String(t.getUTCDate()).padStart(2, '0')}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCFullYear()).slice(2)}`
  const hdg = Math.floor(s / 120) % 2 === 0 ? 265 : 175
  // Apparent wind: the true wind less the boat's own motion.
  const tw = { x: TWS * Math.sin((TWD + 180) * RAD), y: TWS * Math.cos((TWD + 180) * RAD) }
  const bv = { x: BSP * Math.sin(hdg * RAD), y: BSP * Math.cos(hdg * RAD) }
  const aw = { x: tw.x - bv.x, y: tw.y - bv.y }
  const aws = Math.hypot(aw.x, aw.y)
  const awFrom = wrap(Math.atan2(-aw.x, -aw.y) / RAD)
  const awa = wrap(awFrom - hdg)
  const depth = 12 + 3 * Math.sin(s / 40)
  out.push(sentence(`GPRMC,${time},A,${dm(lat, true)},${dm(lon, false)},${f(BSP, 1)},${f(hdg, 1)},${date},${f(Math.abs(VAR), 1)},W`))
  out.push(sentence(`GPVTG,${f(hdg, 1)},T,${f(wrap(hdg - VAR), 1)},M,${f(BSP, 1)},N,${f(BSP * 1.852, 1)},K,A`))
  out.push(sentence(`HCHDG,${f(wrap(hdg - VAR), 1)},,,${f(Math.abs(VAR), 1)},W`))
  out.push(sentence(`IIVHW,${f(hdg, 1)},T,${f(wrap(hdg - VAR), 1)},M,${f(BSP, 2)},N,${f(BSP * 1.852, 2)},K`))
  out.push(sentence(`IIMWV,${f(awa, 1)},R,${f(aws, 1)},N,A`))
  out.push(sentence(`IIDPT,${f(depth, 1)},0.5`))
  if (s % 10 === 0) {
    out.push(aisType1({ mmsi: 367123450, lat: ferry.lat, lon: ferry.lon, sog: 11.5, cog: 95, heading: 96, second: t.getUTCSeconds() }))
  }
  // Move on a second: the boat at BSP on her heading, the ferry east at 11.5 kn.
  lat += (BSP / 3600 / 60) * Math.cos(hdg * RAD)
  lon += ((BSP / 3600 / 60) * Math.sin(hdg * RAD)) / Math.cos(lat * RAD)
  ferry = { lat: ferry.lat, lon: ferry.lon + (11.5 / 3600 / 60) / Math.cos(ferry.lat * RAD) }
}
const path = new URL('./casco-bay-synthetic.nmea', import.meta.url)
writeFileSync(path, out.join('\r\n') + '\r\n')
console.log(`wrote ${out.length} lines to ${path.pathname}`)
