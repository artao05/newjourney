/**
 * Public surface of the routing module.
 *
 * `worker.ts` is deliberately absent: it is a bundler entry point, not a
 * library export, and importing it from the main thread would pull the kernel
 * onto the UI thread. Go through `RoutingClient`.
 */

export {
  routeIsochrone,
  defaultConstraints,
  defaultScalings,
  isNight,
  solarElevationDeg,
  type RouteContext,
} from './isochrone'

export {
  NULL_LAND_MASK,
  PolygonLandMask,
  RasterLandMask,
  buildLandMask,
  extractPolygons,
  type LandMask,
  type PolygonCoords,
} from './land'

export {
  departureAdvice,
  planDepartures,
  sweepDepartures,
  type DepartureOption,
  type DepartureSweep,
  type RouteFn,
  type SweepOptions,
} from './departure'

export { RoutingClient, type RoutePayload, type SweepWindow } from './client'
