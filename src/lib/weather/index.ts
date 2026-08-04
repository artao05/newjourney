/**
 * The weather data layer.
 *
 * Read in this order if you are new to it:
 *   docs/02-data-sources/weather-models.md §1 and §7  — where the data comes from
 *   docs/05-spec/technical-spec.md §4                 — pipeline, wire format, providers
 *   docs/01-expedition-analysis/how-it-computes.md §3, §4 — merge order, interpolation
 *
 * Everything above this module talks to `WeatherField` and never to Open-Meteo,
 * so replacing the aggregator with our own GRIB-derived cubes is a one-file job.
 */

export {
  MODELS,
  cubeNotes,
  clearWeatherCache,
  fetchPointForecast,
  fetchWindCube,
} from './openmeteo'
export type { FetchWindCubeOptions, FetchedCube, ModelId, ModelInfo, PointForecast } from './openmeteo'

export {
  DEFAULT_SCALE,
  MISSING,
  PARAM_SCALE,
  cubeCoverage,
  cubeIndex,
  cubeSizeBytes,
  currentFromUv,
  decodeCube,
  emptyCubeData,
  encodeCube,
  sampleCube,
  sampleCubeDirection,
  scaleFor,
  uvFromCurrent,
  uvFromWind,
  windFromUv,
} from './cube'

export { ConstantField, CubeField, ScaledField, StackedField, twdTws } from './field'
export type { ConstantFieldOptions, FieldScalings } from './field'
