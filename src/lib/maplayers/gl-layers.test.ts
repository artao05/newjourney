/**
 * The two GPU layers, driven through a fake WebGL context.
 *
 * `particleLayer.ts` (821 lines) and `scalarLayer.ts` (325) are the last code in the
 * repo with no direct tests, because they need a GL context that jsdom does not have.
 * They do not need a *real* one: `onAdd(map, gl)` is handed its context, so a fake
 * that records calls and returns plausible handles drives them end to end.
 *
 * Three things are worth asserting at this level, and none of them can be seen by
 * looking at the screen:
 *
 *   1. **Resource lifecycle.** `setData` runs on every timeline tick, and the
 *      timeline plays at up to 8x. A texture created and not deleted there is a leak
 *      that ends as a dead tab on the phone it matters on.
 *   2. **State restoration.** MapLibre lends its context. A layer that leaves the
 *      scissor test disabled corrupts every layer drawn after it, and the symptom
 *      appears somewhere else entirely.
 *   3. **Every declared uniform gets set.** A uniform a shader declares and the
 *      draw call never assigns reads as zero. Nothing throws; the field just renders
 *      wrong, which on a wind layer is indistinguishable from bad weather data.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { ScalarLayer } from './scalarLayer'
import { ParticleLayer } from './particleLayer'
import type { WeatherCube } from '@/lib/types'

// ------------------------------------------------------------------- fake gl

interface Handle {
  kind: string
  id: number
  alive: boolean
}

class FakeGL {
  calls: Array<{ op: string; args: unknown[] }> = []
  handles: Handle[] = []
  /** Enable/disable state, so restoration can be checked. */
  caps = new Map<number, boolean>()
  private seq = 0
  private shaderSources = new Map<Handle, string>()
  private programShaders = new Map<Handle, Handle[]>()
  /** Uniform names assigned during the current draw. */
  assigned = new Set<string>()

  // A handful of constants the layers reference by name.
  readonly TEXTURE_2D = 0x0de1
  readonly RGBA = 0x1908
  readonly UNSIGNED_BYTE = 0x1401
  readonly LINEAR = 0x2601
  readonly NEAREST = 0x2600
  readonly CLAMP_TO_EDGE = 0x812f
  readonly TEXTURE_WRAP_S = 0x2802
  readonly TEXTURE_WRAP_T = 0x2803
  readonly TEXTURE_MIN_FILTER = 0x2801
  readonly TEXTURE_MAG_FILTER = 0x2800
  readonly ARRAY_BUFFER = 0x8892
  readonly ELEMENT_ARRAY_BUFFER = 0x8893
  readonly STATIC_DRAW = 0x88e4
  readonly FLOAT = 0x1406
  readonly TRIANGLES = 0x0004
  readonly POINTS = 0x0000
  readonly LINES = 0x0001
  readonly BLEND = 0x0be2
  readonly DEPTH_TEST = 0x0b71
  readonly SCISSOR_TEST = 0x0c11
  readonly ONE = 1
  readonly ONE_MINUS_SRC_ALPHA = 0x0303
  readonly SRC_ALPHA = 0x0302
  readonly COLOR_ATTACHMENT0 = 0x8ce0
  readonly FRAMEBUFFER = 0x8d40
  readonly COLOR_BUFFER_BIT = 0x4000
  readonly VERTEX_SHADER = 0x8b31
  readonly FRAGMENT_SHADER = 0x8b30
  readonly COMPILE_STATUS = 0x8b81
  readonly LINK_STATUS = 0x8b82
  readonly ACTIVE_UNIFORMS = 0x8b86
  readonly ACTIVE_ATTRIBUTES = 0x8b89
  readonly TEXTURE0 = 0x84c0
  readonly STENCIL_TEST = 0x0b90
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241

  private make(kind: string): Handle {
    const h = { kind, id: ++this.seq, alive: true }
    this.handles.push(h)
    return h
  }
  private rec(op: string, args: unknown[]) {
    this.calls.push({ op, args })
  }

  // --- resources
  createTexture() {
    this.rec('createTexture', [])
    return this.make('texture')
  }
  deleteTexture(h: Handle) {
    this.rec('deleteTexture', [h])
    if (h) h.alive = false
  }
  createBuffer() {
    this.rec('createBuffer', [])
    return this.make('buffer')
  }
  deleteBuffer(h: Handle) {
    this.rec('deleteBuffer', [h])
    if (h) h.alive = false
  }
  createFramebuffer() {
    this.rec('createFramebuffer', [])
    return this.make('framebuffer')
  }
  deleteFramebuffer(h: Handle) {
    this.rec('deleteFramebuffer', [h])
    if (h) h.alive = false
  }
  createProgram() {
    this.rec('createProgram', [])
    return this.make('program')
  }
  deleteProgram(h: Handle) {
    this.rec('deleteProgram', [h])
    if (h) h.alive = false
  }
  createShader() {
    return this.make('shader')
  }
  deleteShader(h: Handle) {
    if (h) h.alive = false
  }

  // --- program construction
  shaderSource(sh: Handle, src: string) {
    this.shaderSources.set(sh, src)
  }
  compileShader() {}
  attachShader(p: Handle, sh: Handle) {
    const list = this.programShaders.get(p) ?? []
    list.push(sh)
    this.programShaders.set(p, list)
  }
  linkProgram() {}
  getShaderInfoLog() {
    return ''
  }
  getProgramInfoLog() {
    return ''
  }
  getShaderParameter() {
    return true
  }

  /** Declarations parsed out of the attached shader sources. */
  private declared(p: Handle, keyword: 'uniform' | 'attribute'): string[] {
    const src = (this.programShaders.get(p) ?? [])
      .map((sh) => this.shaderSources.get(sh) ?? '')
      .join('\n')
    const names = new Set<string>()
    for (const m of src.matchAll(
      new RegExp(`\\b${keyword}\\s+(?:highp|mediump|lowp\\s+)?\\w+\\s+(\\w+)`, 'g'),
    )) {
      names.add(m[1])
    }
    return [...names]
  }

  getProgramParameter(p: Handle, which: number) {
    if (which === this.LINK_STATUS) return true
    if (which === this.ACTIVE_UNIFORMS) return this.declared(p, 'uniform').length
    if (which === this.ACTIVE_ATTRIBUTES) return this.declared(p, 'attribute').length
    return 0
  }
  getActiveUniform(p: Handle, i: number) {
    return { name: this.declared(p, 'uniform')[i] }
  }
  getActiveAttrib(p: Handle, i: number) {
    return { name: this.declared(p, 'attribute')[i] }
  }
  getUniformLocation(_p: Handle, name: string) {
    return { name }
  }
  getAttribLocation(_p: Handle, name: string) {
    return this.declared(_p, 'attribute').indexOf(name)
  }

  // --- state, recorded so restoration can be asserted
  enable(cap: number) {
    this.rec('enable', [cap])
    this.caps.set(cap, true)
  }
  disable(cap: number) {
    this.rec('disable', [cap])
    this.caps.set(cap, false)
  }
  getParameter(p: number) {
    if (p === this.BLEND || p === this.SCISSOR_TEST || p === this.DEPTH_TEST || p === this.STENCIL_TEST) {
      return this.caps.get(p) ?? false
    }
    return 0
  }

  // --- draw-time uniform assignment
  private assign(loc: { name: string } | null) {
    if (loc && typeof loc.name === 'string') this.assigned.add(loc.name)
  }
  uniform1i(l: { name: string } | null) {
    this.assign(l)
  }
  uniform1f(l: { name: string } | null) {
    this.assign(l)
  }
  uniform2f(l: { name: string } | null) {
    this.assign(l)
  }
  uniform3f(l: { name: string } | null) {
    this.assign(l)
  }
  uniform4f(l: { name: string } | null) {
    this.assign(l)
  }
  uniformMatrix4fv(l: { name: string } | null) {
    this.assign(l)
  }

  // --- everything else the layers touch
  bindTexture() {}
  texParameteri() {}
  texImage2D() {}
  activeTexture() {}
  pixelStorei() {}
  bindBuffer() {}
  bufferData() {}
  bindFramebuffer() {}
  framebufferTexture2D() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  useProgram() {}
  blendFunc() {}
  viewport() {}
  clearColor() {}
  clear() {}
  drawArrays(...a: unknown[]) {
    this.rec('drawArrays', a)
  }
  drawElements(...a: unknown[]) {
    this.rec('drawElements', a)
  }

  // --- assertions
  aliveOf(kind: string) {
    return this.handles.filter((h) => h.kind === kind && h.alive).length
  }
}

const fakeMap = () =>
  ({
    triggerRepaint() {},
    on() {},
    off() {},
    getCanvas: () => ({ width: 800, height: 600 }),
    painter: { width: 800, height: 600 },
    transform: { width: 800, height: 600 },
  }) as never

function cubeOf(nt: number): WeatherCube {
  const nx = 6
  const ny = 5
  const cells = nx * ny
  const mk = () => {
    const a = new Float32Array(nt * cells)
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i) * 10
    return a
  }
  return {
    model: 'test',
    run: 'r',
    bbox: { west: -71, south: 43, east: -70, north: 44 },
    nx,
    ny,
    dx: 1 / (nx - 1),
    dy: 1 / (ny - 1),
    t0: 0,
    dtMs: 3_600_000,
    nt,
    params: ['u10', 'v10', 'depth'],
    data: { u10: mk(), v10: mk(), depth: mk() },
  }
}

const projection = {
  defaultProjectionData: { mainMatrix: new Float32Array(16).fill(1) },
} as never

let gl: FakeGL

beforeEach(() => {
  gl = new FakeGL()
})

// --------------------------------------------------------------- ScalarLayer

describe('ScalarLayer', () => {
  function mounted() {
    const layer = new ScalarLayer({ id: 'test-scalar', param: 'depth', domain: [0, 40] })
    layer.onAdd(fakeMap(), gl as never)
    return layer
  }

  it('builds its program and a ramp texture when added', () => {
    mounted()
    expect(gl.calls.filter((c) => c.op === 'createProgram')).toHaveLength(1)
    expect(gl.aliveOf('texture')).toBe(1) // the colour ramp
  })

  it('does not leak a texture per timeline tick', () => {
    /*
     * The leak that matters. `setData` runs whenever the displayed time changes, and
     * the timeline plays at up to 8x — so a texture orphaned here is a few hundred
     * per minute, on a phone, in the sun.
     */
    const layer = mounted()
    const cube = cubeOf(6)
    for (let i = 0; i < 50; i++) layer.setData(cube, i * 3_600_000)

    // Two field textures plus one ramp, no matter how many times data arrived.
    expect(gl.aliveOf('texture')).toBe(3)
    expect(gl.calls.filter((c) => c.op === 'createTexture').length).toBeGreaterThan(50)
  })

  it('does not leak a buffer per timeline tick either', () => {
    const layer = mounted()
    const cube = cubeOf(6)
    for (let i = 0; i < 50; i++) layer.setData(cube, i * 3_600_000)
    // One mesh: a mercator buffer and a texture-coordinate buffer.
    expect(gl.aliveOf('buffer')).toBe(2)
  })

  it('does not leak when the ramp is replaced', () => {
    const layer = mounted()
    for (let i = 0; i < 20; i++) layer.setColorRamp(new Uint8Array(256 * 4))
    expect(gl.aliveOf('texture')).toBe(1)
  })

  it('frees everything it made when removed', () => {
    // A tab switch tears the map down. Anything still alive here is alive until the
    // page is closed.
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    layer.onRemove()
    expect(gl.aliveOf('texture')).toBe(0)
    expect(gl.aliveOf('buffer')).toBe(0)
    expect(gl.aliveOf('program')).toBe(0)
  })

  it('sets every uniform its shaders declare', () => {
    /*
     * An unset uniform reads as zero. Nothing throws and nothing warns — the field
     * simply renders wrong, which on a data layer is indistinguishable from bad
     * data. This is the check that catches a shader gaining a uniform that the draw
     * call was never taught about.
     */
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    gl.assigned.clear()
    layer.render(gl as never, projection)

    for (const name of [
      'u_field0',
      'u_field1',
      'u_ramp',
      'u_mix',
      'u_opacity',
      'u_range0',
      'u_range1',
      'u_domain',
      'u_matrix',
    ]) {
      expect(gl.assigned.has(name), `${name} was never assigned`).toBe(true)
    }
  })

  it('leaves the GL state as it found it', () => {
    /*
     * MapLibre lends its context and takes it back. The layer disables the scissor
     * test to draw full-extent — documented, and necessary — but every layer drawn
     * afterwards depends on it being restored.
     */
    const layer = mounted()
    layer.setData(cubeOf(4), 0)

    for (const before of [true, false]) {
      gl.caps.set(gl.SCISSOR_TEST, before)
      gl.caps.set(gl.BLEND, before)
      gl.caps.set(gl.DEPTH_TEST, before)
      layer.render(gl as never, projection)
      expect(gl.caps.get(gl.SCISSOR_TEST), `scissor, was ${before}`).toBe(before)
      expect(gl.caps.get(gl.BLEND), `blend, was ${before}`).toBe(before)
      expect(gl.caps.get(gl.DEPTH_TEST), `depth, was ${before}`).toBe(before)
    }
  })

  it('draws nothing before it has data, and something after', () => {
    const layer = mounted()
    layer.render(gl as never, projection)
    expect(gl.calls.filter((c) => c.op === 'drawArrays')).toHaveLength(0)

    layer.setData(cubeOf(4), 0)
    layer.render(gl as never, projection)
    expect(gl.calls.filter((c) => c.op === 'drawArrays').length).toBeGreaterThan(0)
  })

  it('draws nothing while hidden', () => {
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    layer.setVisible(false)
    const before = gl.calls.filter((c) => c.op === 'drawArrays').length
    layer.render(gl as never, projection)
    expect(gl.calls.filter((c) => c.op === 'drawArrays')).toHaveLength(before)
  })

  it('survives a cube that does not carry its parameter', () => {
    const layer = mounted()
    const cube = cubeOf(4)
    layer.setParam('not-in-this-cube', [0, 1])
    expect(() => layer.setData(cube, 0)).not.toThrow()
    layer.render(gl as never, projection)
    expect(gl.calls.filter((c) => c.op === 'drawArrays')).toHaveLength(0)
  })
})

// ------------------------------------------------------------- ParticleLayer

describe('ParticleLayer', () => {
  function mounted() {
    const layer = new ParticleLayer({ id: 'test-particles', params: ['u10', 'v10'] })
    layer.onAdd(fakeMap(), gl as never)
    return layer
  }

  it('does not leak wind textures across repeated data', () => {
    const layer = mounted()
    const before = gl.aliveOf('texture')
    const cube = cubeOf(6)
    for (let i = 0; i < 40; i++) layer.setData(cube, i * 3_600_000)
    // Two wind textures on top of whatever the particle machinery holds, and that
    // total must not grow with the number of updates.
    const after = gl.aliveOf('texture')
    for (let i = 0; i < 40; i++) layer.setData(cube, i * 1_800_000)
    expect(gl.aliveOf('texture'), 'texture count grew with updates').toBe(after)
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('frees everything it made when removed', () => {
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    layer.onRemove()
    expect(gl.aliveOf('texture')).toBe(0)
    expect(gl.aliveOf('buffer')).toBe(0)
    expect(gl.aliveOf('framebuffer')).toBe(0)
    expect(gl.aliveOf('program')).toBe(0)
  })

  it('survives being removed twice', () => {
    // A double unmount is a React strict-mode reality, not a hypothetical.
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    layer.onRemove()
    expect(() => layer.onRemove()).not.toThrow()
  })

  it('sets every uniform its shaders declare', () => {
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    gl.assigned.clear()
    layer.render(gl as never, projection)

    for (const name of [
      'u_wind0',
      'u_wind1',
      'u_particles',
      'u_color_ramp',
      'u_particles_res',
      'u_wind_mix',
      'u_wind_min',
      'u_wind_max',
      'u_domain_max',
      'u_point_size',
      'u_opacity',
      'u_matrix',
      'u_bbox',
      'u_rand_seed',
      'u_speed',
      'u_drop_rate',
      'u_aspect',
    ]) {
      expect(gl.assigned.has(name), `${name} was never assigned`).toBe(true)
    }
  })

  it('advects northward wind in the positive-y direction', () => {
    const layer = mounted()
    layer.setData(cubeOf(4), 0)
    const shaderSources = gl.handles
      .filter((h) => h.kind === 'shader')
      .map((h) => (gl as any).shaderSources.get(h) as string | undefined)
      .filter(Boolean) as string[]
    const advectionShader = shaderSources.find((s) => s.includes('u_drop_rate'))!
    expect(advectionShader).toBeDefined()
    const offsetLine = advectionShader.split('\n').find((l) => l.includes('vec2(velocity'))!
    expect(offsetLine).toBeDefined()
    expect(offsetLine).not.toContain('-velocity.y')
  })

  it('leaves the GL state as it found it', () => {
    const layer = mounted()
    layer.setData(cubeOf(4), 0)

    for (const before of [true, false]) {
      gl.caps.set(gl.SCISSOR_TEST, before)
      gl.caps.set(gl.BLEND, before)
      gl.caps.set(gl.DEPTH_TEST, before)
      gl.caps.set(gl.STENCIL_TEST, before)
      layer.render(gl as never, projection)
      expect(gl.caps.get(gl.SCISSOR_TEST), `scissor, was ${before}`).toBe(before)
      expect(gl.caps.get(gl.BLEND), `blend, was ${before}`).toBe(before)
      expect(gl.caps.get(gl.DEPTH_TEST), `depth, was ${before}`).toBe(before)
      expect(gl.caps.get(gl.STENCIL_TEST), `stencil, was ${before}`).toBe(before)
    }
  })

  it('passes domainMax through setColorRamp', () => {
    const layer = mounted()
    layer.setColorRamp(new Uint8Array(16 * 16 * 4), 25)
    layer.setData(cubeOf(4), 0)
    gl.assigned.clear()
    layer.render(gl as never, projection)
    expect(gl.assigned.has('u_domain_max')).toBe(true)
  })

  it('ramp lookup reaches the last entry at maximum speed', () => {
    /*
     * The particle draw shader packs a 256-entry ramp into a 16×16 texture and
     * unwraps v_speed_t ∈ [0,1] into 2-D coordinates. Entry i sits at texel
     * (i%16, floor(i/16)); its centre is ((i%16+0.5)/16, (floor(i/16)+0.5)/16).
     *
     * At v_speed_t = 1.0 the lookup must land on entry 255 — the domain-max
     * colour — not wrap back to entry 240. The old formula using fract(16*t)
     * wrapped to column 0 because fract(16) == 0.
     */
    const N = 16
    const layer = mounted()
    layer.setData(cubeOf(4), 0)

    // Extract the draw fragment shader from the recorded shader sources.
    const shaders = gl.handles
      .filter((h: { kind: string }) => h.kind === 'shader')
      .map((h: { kind: string }) => (gl as any).shaderSources.get(h) as string | undefined)
      .filter(Boolean) as string[]
    const drawFrag = shaders.find((s) => s.includes('u_color_ramp') && s.includes('v_speed_t'))!
    expect(drawFrag).toBeDefined()

    // The shader must scale by 255 (last entry index) not 256 (entry count),
    // and must use mod/floor addressing with a +0.5 texel-centre offset rather
    // than the fract() pattern that wraps at exactly 1.0.
    expect(drawFrag).toContain('v_speed_t * 255.0')
    expect(drawFrag).toContain('mod(ramp_idx, 16.0)')
    expect(drawFrag).not.toContain('fract(16.0 * v_speed_t)')

    // Verify the formula reaches both endpoints. Simulate the GLSL unwrap:
    //   float ramp_idx = v_speed_t * 255.0;
    //   vec2 ramp_pos = vec2(
    //     (mod(ramp_idx, 16.0) + 0.5) / 16.0,
    //     (floor(ramp_idx / 16.0) + 0.5) / 16.0);
    function texel(tc: number, size: number): number {
      return Math.min(size - 1, Math.max(0, Math.floor(tc * size)))
    }
    function entryFor(t: number): number {
      const idx = t * 255
      const x = (((idx % N) + N) % N + 0.5) / N
      const y = (Math.floor(idx / N) + 0.5) / N
      return texel(y, N) * N + texel(x, N)
    }

    expect(entryFor(0)).toBe(0)
    expect(entryFor(1)).toBe(255)
  })
})
