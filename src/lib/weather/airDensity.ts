/**
 * Air density, for scaling the wind a polar reads: a polar is measured in air of
 * some density, and denser air pushes harder at the same speed.
 *
 * Moist air as dry air plus water vapour, each an ideal gas, with the vapour
 * pressure from the relative humidity and the Magnus saturation curve. The
 * reference is Expedition's: 1013.25 hPa, 15 °C and 80 % humidity, about
 * 1.219 kg/m³. With no humidity the air is taken as dry.
 */
const R_DRY = 287.05
const R_VAPOUR = 461.5

/** Saturation vapour pressure over water, hPa (Magnus–Tetens). */
export function saturationHpa(tC: number): number {
  return 6.1078 * 10 ** ((7.5 * tC) / (tC + 237.3))
}

/** kg/m³ from pressure (hPa), temperature (°C) and relative humidity (%), if known. */
export function airDensity(pHpa: number, tC: number, rhPct: number | null = null): number {
  const T = tC + 273.15
  const pv = rhPct == null ? 0 : (Math.min(100, Math.max(0, rhPct)) / 100) * saturationHpa(tC)
  const pd = pHpa - pv
  return (pd * 100) / (R_DRY * T) + (pv * 100) / (R_VAPOUR * T)
}

export const RHO_REF = airDensity(1013.25, 15, 80)

/**
 * The factor on the wind speed that gives the same force in the reference air:
 * TWS × √(ρ / ρref). Bounded to ±15 %, beyond which the inputs are wrong, not the air.
 */
export function densityWindFactor(rho: number): number {
  if (!(rho > 0)) return 1
  return Math.min(1.15, Math.max(0.85, Math.sqrt(rho / RHO_REF)))
}
