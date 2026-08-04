/**
 * Minimal WebGL helpers for the custom map layers.
 *
 * Written rather than vendored: the two layers here need ~150 lines of shader
 * between them, and the maintained particle libraries either pull in deck.gl (a
 * second rendering stack alongside MapLibre) or expect pre-baked PNG tiles
 * rather than the in-memory Float32Array our WeatherCube already provides.
 * See docs/07-map-layers/render-architecture.md §5.
 *
 * Technique credit: the GPU ping-pong advection approach is the one described by
 * mapbox/webgl-wind (ISC). This is an independent implementation of a published
 * technique, not a port.
 */

export interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
  attributes: Record<string, number>
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`shader compile failed: ${log}`)
  }
  return shader
}

/**
 * Build a program and eagerly resolve every uniform and attribute it declares.
 * Resolving up front means a typo in a uniform name fails at layer-add time
 * with a clear error, rather than silently drawing nothing every frame.
 */
export function createProgram(
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): Program {
  const program = gl.createProgram()
  if (!program) throw new Error('could not create program')
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    throw new Error(`program link failed: ${log}`)
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  const nUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < nUniforms; i++) {
    const info = gl.getActiveUniform(program, i)
    if (info) uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name)
  }
  const attributes: Record<string, number> = {}
  const nAttrs = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number
  for (let i = 0; i < nAttrs; i++) {
    const info = gl.getActiveAttrib(program, i)
    if (info) attributes[info.name] = gl.getAttribLocation(program, info.name)
  }
  return { program, uniforms, attributes }
}

export function createBuffer(gl: WebGLRenderingContext, data: BufferSource): WebGLBuffer {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error('could not create buffer')
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  return buffer
}

/**
 * A texture with LINEAR filtering and CLAMP_TO_EDGE wrapping.
 *
 * LINEAR is the entire difference between a smooth field and the blocky quilt
 * that marks a naive implementation. Blockiness is a sampling bug, not a
 * data-resolution problem. CLAMP_TO_EDGE stops the field wrapping around the
 * antimeridian and painting Atlantic weather onto the Pacific.
 */
export function createTexture(
  gl: WebGLRenderingContext,
  filter: number,
  data: Uint8Array | null,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('could not create texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  return texture
}

export function bindTexture(gl: WebGLRenderingContext, texture: WebGLTexture, unit: number) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
}

export function bindFramebuffer(
  gl: WebGLRenderingContext,
  framebuffer: WebGLFramebuffer | null,
  texture?: WebGLTexture,
) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  if (texture) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  }
}

export function bindAttribute(
  gl: WebGLRenderingContext,
  buffer: WebGLBuffer,
  attribute: number,
  numComponents: number,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(attribute)
  gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0)
}

/** A unit quad as two triangles, for full-screen and framebuffer passes. */
export const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1])

/**
 * Encode a cube parameter pair (u, v) into an RGBA byte texture.
 *
 * u goes in R, v in G, each normalised against the pair's own observed range —
 * the same encoding windgl uses, and the reason the range must travel alongside
 * the texture. B carries the normalised magnitude so the fragment shader can
 * colour by speed without recomputing a square root, and A flags coverage: 0
 * means "no data here", which the shader must honour rather than drawing a
 * zero-wind particle. A gap has to stay a gap.
 */
export interface EncodedField {
  data: Uint8Array
  width: number
  height: number
  uMin: number
  uMax: number
  vMin: number
  vMax: number
  magMax: number
}

export function encodeVectorField(
  u: Float32Array,
  v: Float32Array,
  nx: number,
  ny: number,
  offset: number,
): EncodedField {
  const n = nx * ny
  let uMin = Infinity
  let uMax = -Infinity
  let vMin = Infinity
  let vMax = -Infinity
  let magMax = 0
  for (let i = 0; i < n; i++) {
    const uu = u[offset + i]
    const vv = v[offset + i]
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue
    if (uu < uMin) uMin = uu
    if (uu > uMax) uMax = uu
    if (vv < vMin) vMin = vv
    if (vv > vMax) vMax = vv
    const m = Math.hypot(uu, vv)
    if (m > magMax) magMax = m
  }
  // A field of one constant value, or an entirely missing one, must not divide
  // by zero — collapse to a unit range and let everything land mid-texture.
  if (!Number.isFinite(uMin)) {
    uMin = -1
    uMax = 1
    vMin = -1
    vMax = 1
    magMax = 1
  }
  if (uMax - uMin < 1e-9) {
    uMin -= 0.5
    uMax += 0.5
  }
  if (vMax - vMin < 1e-9) {
    vMin -= 0.5
    vMax += 0.5
  }
  if (magMax < 1e-9) magMax = 1

  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const uu = u[offset + i]
    const vv = v[offset + i]
    const j = i * 4
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) {
      data[j] = 128
      data[j + 1] = 128
      data[j + 2] = 0
      data[j + 3] = 0 // no coverage
      continue
    }
    data[j] = Math.round(((uu - uMin) / (uMax - uMin)) * 255)
    data[j + 1] = Math.round(((vv - vMin) / (vMax - vMin)) * 255)
    data[j + 2] = Math.round(Math.min(1, Math.hypot(uu, vv) / magMax) * 255)
    data[j + 3] = 255
  }
  return { data, width: nx, height: ny, uMin, uMax, vMin, vMax, magMax }
}

/**
 * Encode a scalar parameter into an RGBA texture as a 16-bit value split across
 * R and G, with A as the coverage flag. 8 bits is not enough for pressure, where
 * the interesting signal is a few millibars out of ~1000.
 */
export interface EncodedScalar {
  data: Uint8Array
  width: number
  height: number
  min: number
  max: number
}

export function encodeScalarField(
  s: Float32Array,
  nx: number,
  ny: number,
  offset: number,
  domain?: [number, number],
): EncodedScalar {
  const n = nx * ny
  let min = Infinity
  let max = -Infinity
  if (domain) {
    min = domain[0]
    max = domain[1]
  } else {
    for (let i = 0; i < n; i++) {
      const x = s[offset + i]
      if (!Number.isFinite(x)) continue
      if (x < min) min = x
      if (x > max) max = x
    }
    if (!Number.isFinite(min)) {
      min = 0
      max = 1
    }
  }
  if (max - min < 1e-9) max = min + 1

  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const x = s[offset + i]
    const j = i * 4
    if (!Number.isFinite(x)) {
      data[j + 3] = 0
      continue
    }
    const norm = Math.max(0, Math.min(1, (x - min) / (max - min)))
    const q = Math.round(norm * 65535)
    data[j] = q >> 8
    data[j + 1] = q & 0xff
    data[j + 2] = 0
    data[j + 3] = 255
  }
  return { data, width: nx, height: ny, min, max }
}

/**
 * The cube time step bracketing `t`, plus the fraction between them.
 * Returning the pair rather than a single index is what lets the shader mix two
 * textures and animate smoothly between 1-hourly forecast steps.
 */
export function timeIndices(
  t0: number,
  dtMs: number,
  nt: number,
  t: number,
): { i0: number; i1: number; frac: number } {
  if (nt <= 1 || dtMs <= 0) return { i0: 0, i1: 0, frac: 0 }
  const raw = (t - t0) / dtMs
  const clamped = Math.max(0, Math.min(nt - 1, raw))
  const i0 = Math.floor(clamped)
  const i1 = Math.min(nt - 1, i0 + 1)
  return { i0, i1, frac: clamped - i0 }
}

/**
 * Device-appropriate particle count.
 *
 * A particle layer is the easiest way to destroy battery life and thermal
 * headroom on a phone in direct sun on a boat — which is exactly where this app
 * runs. Budget deliberately rather than defaulting to a desktop demo's numbers.
 */
export function defaultParticleCount(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency ?? 4
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  if (coarse) return cores <= 4 ? 16384 : 65536
  if (mem && mem <= 4) return 65536
  return 262144
}
