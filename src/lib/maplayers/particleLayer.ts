/**
 * GPU particle / streamline layer — a MapLibre CustomLayerInterface.
 *
 * Implements the technique in docs/07-map-layers/render-architecture.md §5:
 * wind encoded into an RGBA texture, particle positions held in a second
 * texture and advected on the GPU with ping-pong framebuffers, trails produced
 * by fading the previous frame rather than storing history. Cost is one draw
 * call regardless of particle count.
 *
 * Uses MapLibre's own WebGL context via CustomLayerInterface, so it shares the
 * context lifecycle and respects the layer stack.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import type { Millis, WeatherCube } from '@/lib/types'
import {
  QUAD,
  bindAttribute,
  bindFramebuffer,
  bindTexture,
  createBuffer,
  createProgram,
  createTexture,
  defaultParticleCount,
  encodeVectorField,
  timeIndices,
  type EncodedField,
  type Program,
} from './glutil'
import type { ProjectionMatrix } from './types'

// --------------------------------------------------------------- shaders

const QUAD_VERT = `
precision mediump float;
attribute vec2 a_pos;
varying vec2 v_tex;
void main() {
  v_tex = a_pos;
  gl_Position = vec4(1.0 - 2.0 * a_pos, 0.0, 1.0);
}`

/**
 * Advection pass. Reads a particle position, samples the wind, writes the new
 * position. Positions live in [0,1] over the cube's bbox, packed 16-bit across
 * two channels each — 8 bits would quantise a 5-degree box to ~2 km steps and
 * make particles visibly stair-step.
 */
const UPDATE_FRAG = `
precision highp float;
uniform sampler2D u_particles;
uniform sampler2D u_wind0;
uniform sampler2D u_wind1;
uniform float u_wind_mix;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform float u_rand_seed;
uniform float u_speed;
uniform float u_drop_rate;
uniform vec2 u_aspect;
varying vec2 v_tex;

// Cheap hash. Good enough for respawn jitter; nobody is doing cryptography here.
const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
  float t = dot(rand_constants.xy, co);
  return fract(sin(t) * (rand_constants.z + t));
}

vec4 sampleWind(const vec2 uv) {
  vec4 a = texture2D(u_wind0, uv);
  vec4 b = texture2D(u_wind1, uv);
  return mix(a, b, u_wind_mix);
}

void main() {
  vec4 enc = texture2D(u_particles, v_tex);
  // 16-bit position: R/B are the high bytes, G/A the low.
  vec2 pos = vec2(enc.r / 255.0 + enc.b, enc.g / 255.0 + enc.a);

  vec4 w = sampleWind(pos);
  // Alpha 0 means the cube has no coverage here. Treat it as a dead cell and
  // force a respawn rather than advecting a particle through invented calm.
  float covered = step(0.5, w.a);

  vec2 velocity = mix(u_wind_min, u_wind_max, w.rg);
  float speed_t = length(velocity) / length(u_wind_max);

  // Scale by the inverse aspect so particles cross a wide box at the same
  // apparent rate as a tall one, and so zooming does not change the feel.
  vec2 offset = vec2(velocity.x, -velocity.y) * 0.0001 * u_speed * u_aspect;
  pos = pos + offset * covered;

  // Respawn: randomly, when leaving the domain, or in a dead cell. Without the
  // random term particles pool in convergence zones and drain the rest of the map.
  vec2 seed = (pos + v_tex) * u_rand_seed;
  float drop = 1.0 - step(1.0 - u_drop_rate * (0.2 + speed_t), rand(seed));
  bool outside = pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0;
  float reset = max(max(drop, float(outside)), 1.0 - covered);

  vec2 random_pos = vec2(rand(seed + 1.3), rand(seed + 2.1));
  pos = mix(pos, random_pos, reset);

  gl_FragColor = vec4(fract(pos * 255.0), floor(pos * 255.0) / 255.0);
}`

const DRAW_VERT = `
precision mediump float;
attribute float a_index;
uniform sampler2D u_particles;
uniform float u_particles_res;
uniform vec4 u_bbox;         // west, south, east, north in mercator-normalised units
uniform mat4 u_matrix;
uniform sampler2D u_wind0;
uniform sampler2D u_wind1;
uniform float u_wind_mix;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform float u_point_size;
varying float v_speed_t;

void main() {
  vec4 enc = texture2D(u_particles, vec2(
    fract(a_index / u_particles_res),
    floor(a_index / u_particles_res) / u_particles_res));
  vec2 pos = vec2(enc.r / 255.0 + enc.b, enc.g / 255.0 + enc.a);

  vec4 w = mix(texture2D(u_wind0, pos), texture2D(u_wind1, pos), u_wind_mix);
  vec2 velocity = mix(u_wind_min, u_wind_max, w.rg);
  v_speed_t = length(velocity) / length(u_wind_max);
  // Hide uncovered particles rather than parking them at the origin.
  if (w.a < 0.5) v_speed_t = -1.0;

  // Map the [0,1] cube position into mercator, then through MapLibre's matrix.
  vec2 merc = vec2(
    mix(u_bbox.x, u_bbox.z, pos.x),
    mix(u_bbox.w, u_bbox.y, pos.y));
  gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
  gl_PointSize = u_point_size;
}`

const DRAW_FRAG = `
precision mediump float;
uniform sampler2D u_color_ramp;
uniform float u_opacity;
varying float v_speed_t;
void main() {
  if (v_speed_t < 0.0) discard;
  vec2 ramp_pos = vec2(fract(16.0 * v_speed_t), floor(16.0 * v_speed_t) / 16.0);
  vec4 c = texture2D(u_color_ramp, ramp_pos);
  gl_FragColor = vec4(c.rgb, c.a * u_opacity);
}`

/** Screen-space pass that fades the previous frame to produce trails. */
const SCREEN_VERT = `
precision mediump float;
attribute vec2 a_pos;
varying vec2 v_tex;
void main() {
  v_tex = a_pos;
  gl_Position = vec4(1.0 - 2.0 * a_pos, 0.0, 1.0);
}`

const SCREEN_FRAG = `
precision mediump float;
uniform sampler2D u_screen;
uniform float u_fade;
varying vec2 v_tex;
void main() {
  vec4 c = texture2D(u_screen, 1.0 - v_tex);
  // Multiply rather than assign: premultiplied alpha would otherwise brighten
  // the trail on every pass and the whole layer would bloom to white.
  gl_FragColor = vec4(floor(255.0 * c * u_fade) / 255.0);
}`

// ----------------------------------------------------------------- options

export interface ParticleLayerOptions {
  id?: string
  /** Cube parameter keys for the u and v components. */
  params?: [string, string]
  /** Particle count; defaults to a device-appropriate budget. */
  count?: number
  /** Advection rate multiplier. */
  speedFactor?: number
  /** Trail persistence, 0..1. Higher is longer. */
  fadeOpacity?: number
  /** Fraction of particles respawned per frame. */
  dropRate?: number
  pointSize?: number
  opacity?: number
  /** RGBA LUT (16x16) mapping normalised speed to colour. */
  colorRamp?: Uint8Array
  /** Advection updates per second. Deliberately below the display refresh rate. */
  updateHz?: number
}

const DEFAULTS = {
  speedFactor: 0.35,
  fadeOpacity: 0.955,
  dropRate: 0.003,
  pointSize: 1.6,
  opacity: 1,
  updateHz: 25,
}

/** Fallback ramp: cool for light air through warm for heavy. */
function defaultRamp(): Uint8Array {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [127, 212, 255]],
    [0.25, [79, 195, 247]],
    [0.5, [255, 213, 74]],
    [0.75, [255, 138, 74]],
    [1.0, [255, 77, 77]],
  ]
  const out = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let a = stops[0]
    let b = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        a = stops[s]
        b = stops[s + 1]
        break
      }
    }
    const span = b[0] - a[0] || 1
    const f = (t - a[0]) / span
    out[i * 4] = a[1][0] + (b[1][0] - a[1][0]) * f
    out[i * 4 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f
    out[i * 4 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f
    out[i * 4 + 3] = 255
  }
  return out
}

/** Web Mercator normalised coordinates, matching MapLibre's projection matrix. */
function mercatorX(lon: number): number {
  return (180 + lon) / 360
}
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  return (
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360
  )
}

// ------------------------------------------------------------------- layer

export class ParticleLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const

  private map: MapLibreMap | null = null
  private gl: WebGLRenderingContext | null = null
  private opts: Required<Omit<ParticleLayerOptions, 'id' | 'colorRamp' | 'params'>> & {
    colorRamp: Uint8Array
    params: [string, string]
  }

  private drawProgram: Program | null = null
  private updateProgram: Program | null = null
  private screenProgram: Program | null = null

  private quadBuffer: WebGLBuffer | null = null
  private indexBuffer: WebGLBuffer | null = null
  private framebuffer: WebGLFramebuffer | null = null

  private particleTexture0: WebGLTexture | null = null
  private particleTexture1: WebGLTexture | null = null
  private screenTexture: WebGLTexture | null = null
  private backgroundTexture: WebGLTexture | null = null
  private rampTexture: WebGLTexture | null = null
  private windTexture0: WebGLTexture | null = null
  private windTexture1: WebGLTexture | null = null

  private particleRes = 0
  private particleCount = 0
  private screenW = 0
  private screenH = 0

  private cube: WeatherCube | null = null
  private encoded: EncodedField | null = null
  private encodedNext: EncodedField | null = null
  private windMix = 0
  private lastUpdate = 0
  private visible = true
  private frames = 0

  constructor(options: ParticleLayerOptions = {}) {
    this.id = options.id ?? 'wind-particles'
    this.opts = {
      params: options.params ?? ['u10', 'v10'],
      count: options.count ?? defaultParticleCount(),
      speedFactor: options.speedFactor ?? DEFAULTS.speedFactor,
      fadeOpacity: options.fadeOpacity ?? DEFAULTS.fadeOpacity,
      dropRate: options.dropRate ?? DEFAULTS.dropRate,
      pointSize: options.pointSize ?? DEFAULTS.pointSize,
      opacity: options.opacity ?? DEFAULTS.opacity,
      updateHz: options.updateHz ?? DEFAULTS.updateHz,
      colorRamp: options.colorRamp ?? defaultRamp(),
    }
  }

  // -------------------------------------------------------- lifecycle

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext) {
    this.map = map
    this.gl = gl

    this.drawProgram = createProgram(gl, DRAW_VERT, DRAW_FRAG)
    this.updateProgram = createProgram(gl, QUAD_VERT, UPDATE_FRAG)
    this.screenProgram = createProgram(gl, SCREEN_VERT, SCREEN_FRAG)

    this.quadBuffer = createBuffer(gl, QUAD)
    this.framebuffer = gl.createFramebuffer()
    this.rampTexture = createTexture(gl, gl.LINEAR, this.opts.colorRamp, 16, 16)

    this.setParticleCount(this.opts.count)
    this.resizeScreen()
  }

  onRemove() {
    const gl = this.gl
    if (!gl) return
    for (const t of [
      this.particleTexture0,
      this.particleTexture1,
      this.screenTexture,
      this.backgroundTexture,
      this.rampTexture,
      this.windTexture0,
      this.windTexture1,
    ]) {
      if (t) gl.deleteTexture(t)
    }
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer)
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer)
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer)
    for (const p of [this.drawProgram, this.updateProgram, this.screenProgram]) {
      if (p) gl.deleteProgram(p.program)
    }
    this.gl = null
    this.map = null
  }

  // ------------------------------------------------------------ public

  /** Swap in a new forecast cube, or a new valid time within the current one. */
  setData(cube: WeatherCube, t: Millis) {
    this.cube = cube
    const gl = this.gl
    if (!gl) return
    const [uKey, vKey] = this.opts.params
    const u = cube.data[uKey]
    const v = cube.data[vKey]
    if (!u || !v) {
      this.encoded = null
      return
    }

    const { i0, i1, frac } = timeIndices(cube.t0, cube.dtMs, cube.nt, t)
    const cells = cube.nx * cube.ny
    this.encoded = encodeVectorField(u, v, cube.nx, cube.ny, i0 * cells)
    this.encodedNext =
      i1 === i0 ? this.encoded : encodeVectorField(u, v, cube.nx, cube.ny, i1 * cells)
    this.windMix = frac

    if (this.windTexture0) gl.deleteTexture(this.windTexture0)
    if (this.windTexture1 && this.windTexture1 !== this.windTexture0) {
      gl.deleteTexture(this.windTexture1)
    }
    this.windTexture0 = createTexture(
      gl,
      gl.LINEAR,
      this.encoded.data,
      this.encoded.width,
      this.encoded.height,
    )
    this.windTexture1 = createTexture(
      gl,
      gl.LINEAR,
      this.encodedNext.data,
      this.encodedNext.width,
      this.encodedNext.height,
    )
    this.map?.triggerRepaint()
  }

  setColorRamp(ramp: Uint8Array) {
    this.opts.colorRamp = ramp
    const gl = this.gl
    if (!gl) return
    if (this.rampTexture) gl.deleteTexture(this.rampTexture)
    this.rampTexture = createTexture(gl, gl.LINEAR, ramp, 16, 16)
    this.map?.triggerRepaint()
  }

  setOptions(patch: Partial<ParticleLayerOptions>) {
    Object.assign(this.opts, patch)
    if (patch.count && patch.count !== this.particleCount) this.setParticleCount(patch.count)
    this.map?.triggerRepaint()
  }

  /**
   * Stop advecting without removing the layer. Called when the tab is hidden or
   * the Start screen is active — during a start sequence nothing should be
   * spending GPU on decoration.
   */
  setVisible(visible: boolean) {
    this.visible = visible
    if (visible) this.map?.triggerRepaint()
  }

  private setParticleCount(count: number) {
    const gl = this.gl
    if (!gl) return
    const res = Math.ceil(Math.sqrt(count))
    this.particleRes = res
    this.particleCount = res * res

    const state = new Uint8Array(this.particleCount * 4)
    for (let i = 0; i < state.length; i++) state[i] = Math.floor(Math.random() * 256)

    if (this.particleTexture0) gl.deleteTexture(this.particleTexture0)
    if (this.particleTexture1) gl.deleteTexture(this.particleTexture1)
    this.particleTexture0 = createTexture(gl, gl.NEAREST, state, res, res)
    this.particleTexture1 = createTexture(gl, gl.NEAREST, state, res, res)

    const indices = new Float32Array(this.particleCount)
    for (let i = 0; i < this.particleCount; i++) indices[i] = i
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer)
    this.indexBuffer = createBuffer(gl, indices)
  }

  private resizeScreen() {
    const gl = this.gl
    if (!gl) return
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (w === this.screenW && h === this.screenH) return
    this.screenW = w
    this.screenH = h
    const empty = new Uint8Array(w * h * 4)
    if (this.screenTexture) gl.deleteTexture(this.screenTexture)
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture)
    this.screenTexture = createTexture(gl, gl.NEAREST, empty, w, h)
    this.backgroundTexture = createTexture(gl, gl.NEAREST, empty, w, h)
  }

  // ------------------------------------------------------------- render

  /*
   * MapLibre v5 changed the custom-layer render signature: it no longer passes a
   * bare matrix but a `CustomRenderMethodInput`, because the globe projection
   * needs more than one matrix. For a '2d' renderingMode layer the mercator
   * matrix we want is `defaultProjectionData.mainMatrix`.
   */
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const matrix = options.defaultProjectionData.mainMatrix
    if (!this.encoded || !this.cube || !this.visible) return
    if (
      !this.drawProgram ||
      !this.updateProgram ||
      !this.screenProgram ||
      !this.particleTexture0 ||
      !this.particleTexture1 ||
      !this.screenTexture ||
      !this.backgroundTexture ||
      !this.rampTexture ||
      !this.windTexture0 ||
      !this.windTexture1 ||
      !this.quadBuffer ||
      !this.indexBuffer
    ) {
      return
    }

    this.resizeScreen()

    // Advect on a fixed clock, not per rendered frame. Tying advection to a
    // 120 Hz display makes the flow look rushed and burns battery for nothing;
    // the doc notes slower updates are both cheaper and easier to read.
    const now = performance.now()
    const interval = 1000 / this.opts.updateHz
    const shouldUpdate = now - this.lastUpdate >= interval
    if (shouldUpdate) this.lastUpdate = now

    const prevBlend = gl.getParameter(gl.BLEND) as boolean
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)

    // 1. Draw the faded previous frame plus this frame's particles into the
    //    offscreen texture. The fade is what produces the trails.
    bindFramebuffer(gl, this.framebuffer, this.screenTexture)
    gl.viewport(0, 0, this.screenW, this.screenH)
    this.drawFadedTexture(gl, this.backgroundTexture, this.opts.fadeOpacity)
    this.drawParticles(gl, matrix)

    // 2. Composite onto the map.
    bindFramebuffer(gl, null)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.drawFadedTexture(gl, this.screenTexture, 1)
    if (!prevBlend) gl.disable(gl.BLEND)

    // 3. Swap screen buffers so this frame becomes next frame's background.
    const tmp = this.backgroundTexture
    this.backgroundTexture = this.screenTexture
    this.screenTexture = tmp

    if (shouldUpdate) this.updateParticles(gl)

    this.frames++
    // Keep the animation going. MapLibre only repaints on demand for custom
    // layers, so an animated layer must ask for the next frame itself.
    this.map?.triggerRepaint()
  }

  private drawFadedTexture(
    gl: WebGLRenderingContext,
    texture: WebGLTexture,
    opacity: number,
  ) {
    const p = this.screenProgram!
    gl.useProgram(p.program)
    bindAttribute(gl, this.quadBuffer!, p.attributes.a_pos, 2)
    bindTexture(gl, texture, 2)
    gl.uniform1i(p.uniforms.u_screen ?? null, 2)
    gl.uniform1f(p.uniforms.u_fade ?? null, opacity)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  private drawParticles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: ProjectionMatrix,
  ) {
    const p = this.drawProgram!
    const enc = this.encoded!
    const cube = this.cube!
    gl.useProgram(p.program)

    bindAttribute(gl, this.indexBuffer!, p.attributes.a_index, 1)
    bindTexture(gl, this.rampTexture!, 2)
    bindTexture(gl, this.particleTexture0!, 1)
    bindTexture(gl, this.windTexture0!, 0)
    bindTexture(gl, this.windTexture1!, 3)

    gl.uniform1i(p.uniforms.u_wind0 ?? null, 0)
    gl.uniform1i(p.uniforms.u_wind1 ?? null, 3)
    gl.uniform1i(p.uniforms.u_particles ?? null, 1)
    gl.uniform1i(p.uniforms.u_color_ramp ?? null, 2)
    gl.uniform1f(p.uniforms.u_particles_res ?? null, this.particleRes)
    gl.uniform1f(p.uniforms.u_wind_mix ?? null, this.windMix)
    gl.uniform2f(p.uniforms.u_wind_min ?? null, enc.uMin, enc.vMin)
    gl.uniform2f(p.uniforms.u_wind_max ?? null, enc.uMax, enc.vMax)
    gl.uniform1f(p.uniforms.u_point_size ?? null, this.opts.pointSize)
    gl.uniform1f(p.uniforms.u_opacity ?? null, this.opts.opacity)
    gl.uniformMatrix4fv(p.uniforms.u_matrix ?? null, false, matrix as Float32Array)
    gl.uniform4f(
      p.uniforms.u_bbox ?? null,
      mercatorX(cube.bbox.west),
      mercatorY(cube.bbox.south),
      mercatorX(cube.bbox.east),
      mercatorY(cube.bbox.north),
    )

    gl.drawArrays(gl.POINTS, 0, this.particleCount)
  }

  private updateParticles(gl: WebGLRenderingContext) {
    const p = this.updateProgram!
    const enc = this.encoded!
    const cube = this.cube!

    bindFramebuffer(gl, this.framebuffer, this.particleTexture1!)
    gl.viewport(0, 0, this.particleRes, this.particleRes)
    gl.disable(gl.BLEND)

    gl.useProgram(p.program)
    bindAttribute(gl, this.quadBuffer!, p.attributes.a_pos, 2)
    bindTexture(gl, this.windTexture0!, 0)
    bindTexture(gl, this.particleTexture0!, 1)
    bindTexture(gl, this.windTexture1!, 3)

    gl.uniform1i(p.uniforms.u_wind0 ?? null, 0)
    gl.uniform1i(p.uniforms.u_wind1 ?? null, 3)
    gl.uniform1i(p.uniforms.u_particles ?? null, 1)
    gl.uniform1f(p.uniforms.u_wind_mix ?? null, this.windMix)
    gl.uniform2f(p.uniforms.u_wind_min ?? null, enc.uMin, enc.vMin)
    gl.uniform2f(p.uniforms.u_wind_max ?? null, enc.uMax, enc.vMax)
    gl.uniform1f(p.uniforms.u_rand_seed ?? null, Math.random())
    gl.uniform1f(p.uniforms.u_speed ?? null, this.opts.speedFactor)
    gl.uniform1f(p.uniforms.u_drop_rate ?? null, this.opts.dropRate)
    // Normalise for box shape so a wide cube does not advect faster in x.
    const lonSpan = Math.max(1e-6, cube.bbox.east - cube.bbox.west)
    const latSpan = Math.max(1e-6, cube.bbox.north - cube.bbox.south)
    gl.uniform2f(p.uniforms.u_aspect ?? null, 1 / lonSpan, 1 / latSpan)

    gl.drawArrays(gl.TRIANGLES, 0, 6)

    const tmp = this.particleTexture0
    this.particleTexture0 = this.particleTexture1
    this.particleTexture1 = tmp

    bindFramebuffer(gl, null)
  }

  /** Frames rendered since add — used by the diagnostics readout. */
  get frameCount(): number {
    return this.frames
  }
}
