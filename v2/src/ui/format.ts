export const kn = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d))
export const deg = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(((x % 360) + 360) % 360).toString().padStart(3, '0')}°`)
export const sdeg = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.abs(Math.round(x))}°`)

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function clockS(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** m:ss, with a sign for negative values. */
export function mmss(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–'
  const neg = s < 0
  const a = Math.abs(Math.round(s))
  return `${neg ? '−' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

export function dur(s: number): string {
  if (s < 90) return `${Math.round(s)} s`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export function nm(x: number): string {
  return x < 0.1 ? `${Math.round(x * 1852)} m` : `${x.toFixed(2)} nm`
}

export function fmtLat(lat: number): string {
  const a = Math.abs(lat)
  return `${Math.floor(a)}° ${((a % 1) * 60).toFixed(3)}′ ${lat >= 0 ? 'N' : 'S'}`
}

export function fmtLon(lon: number): string {
  const a = Math.abs(lon)
  return `${Math.floor(a)}° ${((a % 1) * 60).toFixed(3)}′ ${lon >= 0 ? 'E' : 'W'}`
}
