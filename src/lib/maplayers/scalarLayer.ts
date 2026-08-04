/**
 * Smooth scalar field layer — a MapLibre CustomLayerInterface.
 *
 * Implements docs/07-map-layers/render-architecture.md §3: a data texture
 * sampled with LINEAR filtering through a colour LUT, mixed between two forecast
 * time steps in the shader. Used for wave height, SST, gust, rain and pressure.
 *
 * The whole point is that it is NOT blocky. A blocky field is a nearest-neighbour
 * sampling bug, not a data-resolution limit, and it is the visible signature of a
 * naive implementation.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import type { Millis, WeatherCube } from '@/lib/types'
import type { ProjectionMatrix } from './types'
import {
  bindAttribute,
  bindTexture,
  createBuffer,
  createProgram,
  createTexture,
  encodeScalarField,
  timeIndices,
  type Program,
} from './glutil'

/**
 * Latitude strips used to approximate the Mercator projection across the field.
 *
 * Mercator y is nonlinear in latitude, so a single quad with linearly
 * interpolated texture coordinates would smear the field toward the poles.
 * Subdividing into strips and computing the exact Mercator y per strip boundary
 * makes the error negligible while keeping this a single draw call.
 */
const STRIPS = 64

const VERT = `
precision mediump float;
attribute vec2 a_merc;
attribute vec2 a_tex;
uniform mat4 u_matrix;
varying vec2 v_tex;
void main() {
  v_tex = a_tex;
  gl_Position = u_matrix * vec4(a_merc, 0.0, 1.0);
}`

const FRAG = `
precision highp float;
uniform sampler2D u_field0;
uniform sampler2D u_field1;
uniform sampler2D u_ramp;
uniform float u_mix;
uniform float u_opacity;
uniform vec2 u_range0;   // min, max of field0 in physical units
uniform vec2 u_range1;
uniform vec2 u_domain;   // colour ramp domain in physical units
varying vec2 v_tex;

float decode(const vec4 c, const vec2 range) {
  // 16-bit value split across R (high) and G (low).
  float norm = (c.r * 255.0 * 256.0 + c.g * 255.0) / 65535.0;
  return mix(range.x, range.y, norm);
}

void main() {
  vec4 a = texture2D(u_field0, v_tex);
  vec4 b = texture2D(u_field1, v_tex);
  // Coverage: if either sample is missing, draw nothing. A gap must stay a gap
  // rather than becoming a confident zero.
  if (a.a < 0.5 || b.a < 0.5) discard;

  float value = mix(decode(a, u_range0), decode(b, u_range1), u_mix);
  float t = clamp((value - u_domain.x) / max(1e-6, u_domain.y - u_domain.x), 0.0, 1.0);

  vec4 c = texture2D(u_ramp, vec2(t, 0.5));
  gl_FragColor = vec4(c.rgb * c.a * u_opacity, c.a * u_opacity);
}`

export interface ScalarLayerOptions {
  id?: string
  /** Cube parameter key, e.g. 'hs' or 'gust'. */
  param?: string
  /** Colour ramp domain in the field's physical units. */
  domain?: [number, number]
  opacity?: number
  /** RGBA LUT, `width x 1`. Supply from `colormap.rampToLUT`. */
  colorRamp?: Uint8Array
  colorRampWidth?: number
}

function mercatorX(lon: number): number {
  return (180 + lon) / 360
}
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  return (
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360
  )
}

/** Grey fallback so a missing ramp is visibly wrong rather than invisible. */
function fallbackRamp(): Uint8Array {
  const w = 256
  const out = new Uint8Array(w * 4)
  for (let i = 0; i < w; i++) {
    const v = Math.round((i / (w - 1)) * 255)
    out[i * 4] = v
    out[i * 4 + 1] = v
    out[i * 4 + 2] = v
    out[i * 4 + 3] = 200
  }
  return out
}

export class ScalarLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const

  private map: MapLibreMap | null = null
  private gl: WebGLRenderingContext | null = null
  private program: Program | null = null
  private mercBuffer: WebGLBuffer | null = null
  private texBuffer: WebGLBuffer | null = null
  private vertexCount = 0

  private fieldTexture0: WebGLTexture | null = null
  private fieldTexture1: WebGLTexture | null = null
  private rampTexture: WebGLTexture | null = null

  private range0: [number, number] = [0, 1]
  private range1: [number, number] = [0, 1]
  private mix = 0
  private hasData = false
  private visible = true

  private param: string
  private domain: [number, number]
  private opacity: number
  private ramp: Uint8Array
  private rampWidth: number

  constructor(options: ScalarLayerOptions = {}) {
    this.id = options.id ?? 'scalar-field'
    this.param = options.param ?? 'hs'
    this.domain = options.domain ?? [0, 8]
    this.opacity = options.opacity ?? 0.7
    this.ramp = options.colorRamp ?? fallbackRamp()
    this.rampWidth = options.colorRampWidth ?? this.ramp.length / 4
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext) {
    this.map = map
    this.gl = gl
    this.program = createProgram(gl, VERT, FRAG)
    this.rampTexture = createTexture(gl, gl.LINEAR, this.ramp, this.rampWidth, 1)
  }

  onRemove() {
    const gl = this.gl
    if (!gl) return
    for (const t of [this.fieldTexture0, this.fieldTexture1, this.rampTexture]) {
      if (t) gl.deleteTexture(t)
    }
    if (this.mercBuffer) gl.deleteBuffer(this.mercBuffer)
    if (this.texBuffer) gl.deleteBuffer(this.texBuffer)
    if (this.program) gl.deleteProgram(this.program.program)
    this.gl = null
    this.map = null
  }

  setColorRamp(ramp: Uint8Array, width?: number) {
    this.ramp = ramp
    this.rampWidth = width ?? ramp.length / 4
    const gl = this.gl
    if (!gl) return
    if (this.rampTexture) gl.deleteTexture(this.rampTexture)
    this.rampTexture = createTexture(gl, gl.LINEAR, this.ramp, this.rampWidth, 1)
    this.map?.triggerRepaint()
  }

  setParam(param: string, domain: [number, number]) {
    this.param = param
    this.domain = domain
    this.hasData = false
  }

  setOpacity(opacity: number) {
    this.opacity = opacity
    this.map?.triggerRepaint()
  }

  setVisible(visible: boolean) {
    this.visible = visible
    this.map?.triggerRepaint()
  }

  setData(cube: WeatherCube, t: Millis) {
    const gl = this.gl
    if (!gl) return
    const field = cube.data[this.param]
    if (!field) {
      this.hasData = false
      this.map?.triggerRepaint()
      return
    }

    const cells = cube.nx * cube.ny
    const { i0, i1, frac } = timeIndices(cube.t0, cube.dtMs, cube.nt, t)
    const e0 = encodeScalarField(field, cube.nx, cube.ny, i0 * cells)
    const e1 = i1 === i0 ? e0 : encodeScalarField(field, cube.nx, cube.ny, i1 * cells)

    if (this.fieldTexture0) gl.deleteTexture(this.fieldTexture0)
    if (this.fieldTexture1 && this.fieldTexture1 !== this.fieldTexture0) {
      gl.deleteTexture(this.fieldTexture1)
    }
    this.fieldTexture0 = createTexture(gl, gl.LINEAR, e0.data, e0.width, e0.height)
    this.fieldTexture1 = createTexture(gl, gl.LINEAR, e1.data, e1.width, e1.height)
    this.range0 = [e0.min, e0.max]
    this.range1 = [e1.min, e1.max]
    this.mix = frac

    this.buildGeometry(cube)
    this.hasData = true
    this.map?.triggerRepaint()
  }

  /**
   * Mercator-corrected strip mesh over the cube's bbox.
   *
   * Texture v runs 1 at the south edge to 0 at the north, because the cube's
   * rows are stored south-to-north while texture space is top-down.
   */
  private buildGeometry(cube: WeatherCube) {
    const gl = this.gl
    if (!gl) return
    const { west, south, east, north } = cube.bbox
    const mx0 = mercatorX(west)
    const mx1 = mercatorX(east)

    const merc: number[] = []
    const tex: number[] = []
    for (let s = 0; s < STRIPS; s++) {
      const f0 = s / STRIPS
      const f1 = (s + 1) / STRIPS
      const lat0 = south + (north - south) * f0
      const lat1 = south + (north - south) * f1
      const my0 = mercatorY(lat0)
      const my1 = mercatorY(lat1)
      // texImage2D maps the first data row to v == 0, and the cube stores rows
      // south-to-north, so v == f measured northward from the south edge.
      const v0 = f0
      const v1 = f1

      merc.push(mx0, my0, mx1, my0, mx0, my1)
      tex.push(0, v0, 1, v0, 0, v1)
      merc.push(mx0, my1, mx1, my0, mx1, my1)
      tex.push(0, v1, 1, v0, 1, v1)
    }

    if (this.mercBuffer) gl.deleteBuffer(this.mercBuffer)
    if (this.texBuffer) gl.deleteBuffer(this.texBuffer)
    this.mercBuffer = createBuffer(gl, new Float32Array(merc))
    this.texBuffer = createBuffer(gl, new Float32Array(tex))
    this.vertexCount = merc.length / 2
  }

  /**
   * MapLibre v5 passes a `CustomRenderMethodInput` rather than a bare matrix,
   * because the globe projection needs more than one. For a `'2d'` layer the
   * mercator-to-clip transform is `defaultProjectionData.mainMatrix`.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ) {
    const matrix: ProjectionMatrix = options.defaultProjectionData.mainMatrix
    if (!this.hasData || !this.visible) return
    const p = this.program
    if (
      !p ||
      !this.mercBuffer ||
      !this.texBuffer ||
      !this.fieldTexture0 ||
      !this.fieldTexture1 ||
      !this.rampTexture
    ) {
      return
    }

    gl.useProgram(p.program)
    bindAttribute(gl, this.mercBuffer, p.attributes.a_merc, 2)
    bindAttribute(gl, this.texBuffer, p.attributes.a_tex, 2)
    bindTexture(gl, this.fieldTexture0, 0)
    bindTexture(gl, this.fieldTexture1, 1)
    bindTexture(gl, this.rampTexture, 2)

    gl.uniform1i(p.uniforms.u_field0 ?? null, 0)
    gl.uniform1i(p.uniforms.u_field1 ?? null, 1)
    gl.uniform1i(p.uniforms.u_ramp ?? null, 2)
    gl.uniform1f(p.uniforms.u_mix ?? null, this.mix)
    gl.uniform1f(p.uniforms.u_opacity ?? null, this.opacity)
    gl.uniform2f(p.uniforms.u_range0 ?? null, this.range0[0], this.range0[1])
    gl.uniform2f(p.uniforms.u_range1 ?? null, this.range1[0], this.range1[1])
    gl.uniform2f(p.uniforms.u_domain ?? null, this.domain[0], this.domain[1])
    gl.uniformMatrix4fv(p.uniforms.u_matrix ?? null, false, matrix as Float32Array)

    // See the note in particleLayer: MapLibre leaves a scissor box set, which
    // silently clips a full-extent custom layer away.
    const prevBlend = gl.getParameter(gl.BLEND) as boolean
    const prevScissor = gl.getParameter(gl.SCISSOR_TEST) as boolean
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount)
    if (!prevBlend) gl.disable(gl.BLEND)
    if (prevScissor) gl.enable(gl.SCISSOR_TEST)
  }
}
