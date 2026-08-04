/**
 * Shared contract for the map data-layer engine.
 * See docs/07-map-layers/render-architecture.md.
 *
 * Hard rule from that doc: this engine knows nothing about routing, polars or
 * tactics. Its only inputs are a WeatherCube, a parameter name, a time, and
 * style options. That keeps it testable in isolation and reusable on any screen.
 */

import type { Millis, WeatherCube } from '@/lib/types'

// --------------------------------------------------------------- projection

/**
 * The projection matrix MapLibre hands a custom layer.
 *
 * MapLibre v5 replaced the old `render(gl, matrix)` signature with
 * `render(gl, options: CustomRenderMethodInput)` because the globe projection
 * needs more than one matrix. For a `renderingMode: '2d'` layer the mercator
 * matrix is `options.defaultProjectionData.mainMatrix`, whose gl-matrix `mat4`
 * type is structurally looser than `number[]` — hence this alias rather than
 * spreading casts through every draw call.
 */
export type ProjectionMatrix = ArrayLike<number>

// ------------------------------------------------------------------ colours

/** A colour stop: value in the field's own units, plus sRGB 0-255. */
export interface ColorStop {
  value: number
  rgb: [number, number, number]
}

export interface ColorRamp {
  id: string
  label: string
  /** Units the stop values are expressed in, for the legend. */
  unit: string
  stops: ColorStop[]
  /**
   * True for ramps whose classes are meaningful in themselves (Beaufort), so
   * the legend draws discrete blocks rather than a continuous gradient.
   */
  discrete?: boolean
}

/** Linear-interpolated lookup. Clamps outside the stop range. */
export type RampSampler = (value: number) => [number, number, number]

// ------------------------------------------------------------------- layers

export type LayerKind = 'scalar' | 'vector'

/** How a vector field is drawn. Mirrors PredictWind's three modes. */
export type VectorMode = 'particles' | 'barbs' | 'arrows'

export interface LayerSpec {
  id: string
  label: string
  kind: LayerKind
  /**
   * Cube parameter keys. Scalar layers name one; vector layers name the u and v
   * components in that order.
   */
  params: [string] | [string, string]
  ramp: string
  /** Value range for the colour ramp, in the field's units. */
  domain: [number, number]
  unit: string
  /** Sensible default for a vector layer. */
  defaultMode?: VectorMode
}

/** Everything a renderer needs for one frame. */
export interface LayerFrame {
  cube: WeatherCube
  /** Valid time being displayed. Interpolated between cube steps. */
  t: Millis
  opacity: number
}

// ---------------------------------------------------------------- thinning

export interface ThinOptions {
  /** Target number of symbols across the viewport's shorter axis. */
  targetAcross: number
  /** Viewport bounds to restrict output to. */
  bounds: { west: number; south: number; east: number; north: number }
}

/** One symbol to draw: position, direction the wind is going TOWARD, magnitude. */
export interface VectorSample {
  lon: number
  lat: number
  /** Degrees, 0-360, the direction the flow is heading toward. */
  towardDeg: number
  /** Degrees, 0-360, the meteorological "from" direction. */
  fromDeg: number
  /** Magnitude in the field's units (knots for wind and current). */
  magnitude: number
}
