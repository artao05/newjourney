/**
 * Wind barb sprites.
 *
 * Implements docs/07-map-layers/render-architecture.md §4: "Barbs: not a single
 * rotatable glyph — a barb's *shape* encodes speed. Generate an SVG/canvas
 * sprite per 5-knot bucket at load time and pick with a data-driven `icon-image`
 * expression."
 *
 * Everything here is about getting the convention right, because a barb that is
 * mirrored or off by 180° looks entirely plausible in a screenshot and is
 * instantly wrong to anyone who has read a synoptic chart.
 *
 * ## The conventions, and where they come from
 *
 * - Barbs are drawn to the **nearest 5 knots**, so one sprite per bucket covers
 *   a 5-knot band. Below 3 kn the plot is a bare circle: calm has no direction
 *   to draw, and an arbitrary stem would invent one.
 * - A **half barb is 5 kn, a full barb 10 kn, a pennant (filled triangle) 50
 *   kn**. Feathers are drawn from the **outer end inward**, pennants outermost.
 * - The stem runs from the station **into the wind** — meteorological direction
 *   is where the wind comes FROM — so the feathered end points at the source.
 *   In sprite space the stem therefore points **up**, and the caller sets
 *   `icon-rotate` to the `fromDeg` of the sample (never `towardDeg`; those
 *   differ by 180°, and `src/lib/wind.ts` owns the conversion).
 * - Feathers sit on the **right** of the up-pointing stem. Derivation, so it can
 *   be audited rather than trusted: feathers point toward low pressure, and by
 *   Buys Ballot's law in the northern hemisphere low pressure is on your left
 *   when your back is to the wind. Facing downwind in sprite space means facing
 *   *down* the image, and your left hand then points to the image's right.
 *
 * **Southern hemisphere barbs mirror**: the circulation, and therefore the low
 * pressure side, flips, so the feathers hang off the left of the stem. v1 draws
 * northern-hemisphere barbs only. Adding it is a horizontal flip of the feather
 * geometry and a second sprite set keyed on the sign of the latitude — deliberately
 * deferred, not forgotten.
 *
 * Keep `icon-pitch-alignment: 'viewport'` and `icon-rotation-alignment: 'map'`
 * on the symbol layer: a barb tilted into the map plane at high pitch is
 * unreadable (§4).
 */

// ------------------------------------------------------------------- buckets

/** Below this the plot is a bare circle. */
const CALM_KN = 3

/** Top bucket. Everything above it draws the same sprite. */
const MAX_BUCKET_KN = 75

export const CALM_ID = 'barb-calm'

export interface BarbSprite {
  id: string
  minKn: number
  maxKn: number
  svg: string
  width: number
  height: number
}

/** How a bucket speed decomposes into glyph elements. */
export interface BarbLayout {
  /** 50 kn each, drawn outermost. */
  pennants: number
  /** 10 kn each. */
  fulls: number
  /** 5 kn. Zero or one. */
  halves: number
}

/** Speed rounded to the barb bucket it is drawn as, in knots. 0 means calm. */
function bucketKn(kn: number): number {
  if (!Number.isFinite(kn) || kn < CALM_KN) return 0
  return Math.min(MAX_BUCKET_KN, Math.round(kn / 5) * 5)
}

/**
 * The feather decomposition for a speed: `47 kn -> 45 kn -> 4 full + 1 half`.
 *
 * Exported so tests and any future canvas renderer assert against the semantics
 * rather than counting elements in an SVG string.
 */
export function barbLayout(kn: number): BarbLayout {
  const b = bucketKn(kn)
  const pennants = Math.floor(b / 50)
  const afterPennants = b - pennants * 50
  const fulls = Math.floor(afterPennants / 10)
  const halves = (afterPennants - fulls * 10) / 5
  return { pennants, fulls, halves }
}

/** Zero-padded so ids sort in speed order in a sprite sheet. */
const idFor = (bucket: number): string =>
  bucket === 0 ? CALM_ID : `barb-${String(bucket).padStart(2, '0')}`

/** The sprite id for a speed in knots. */
export function barbIdForSpeed(kn: number): string {
  return idFor(bucketKn(kn))
}

/** Lower edge of the speed band that rounds to `bucket`. */
const lowerEdge = (bucket: number): number => (bucket === 0 ? 0 : Math.max(CALM_KN, bucket - 2.5))

/** Upper edge, exclusive. The top bucket has none. */
const upperEdge = (bucket: number): number =>
  bucket === 0 ? CALM_KN : bucket >= MAX_BUCKET_KN ? Infinity : bucket + 2.5

// -------------------------------------------------------------------- sprites

interface Geometry {
  size: number
  color: string
  strokeWidth: number
}

/**
 * Sprite geometry, all derived from `size` so a caller can ask for a bigger
 * glyph without re-tuning six constants.
 *
 * The station sits at the **centre** of a square sprite and only the upper half
 * carries ink. MapLibre rotates an icon about its anchor, so a centred station
 * plus the default `icon-anchor: 'center'` makes `icon-rotate` exactly the wind
 * direction with no offset arithmetic to get wrong. The price is that the usable
 * stem is half the sprite, less the room the outermost feather needs to lean
 * into: `stem = size/2 - lean - margin`. Every constant below falls out of that
 * one inequality, which is why the ink-inside-the-box test is not busywork —
 * it is the check that the inequality still holds.
 */
function svgFor(bucket: number, g: Geometry): string {
  const { size, color, strokeWidth: sw } = g
  const c = size / 2
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
  const close = '</svg>'

  if (bucket === 0) {
    const r = size * 0.11
    return `${open}<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${n(sw)}"/>${close}`
  }

  const feather = size * 0.22
  // Feathers lean toward the tip, ~22° off perpendicular, which is what makes a
  // barb read as a barb rather than a comb.
  const lean = feather * 0.4
  const margin = size * 0.038
  const stem = c - lean - margin
  const tipY = c - stem
  // Five slots is the worst case (45 kn: four full barbs and a half), so the
  // spacing has to fit 4 * step inside the stem with the innermost feather still
  // clear of the station.
  const step = size * 0.078
  const pennantBase = size * 0.095
  const pennantGap = size * 0.03

  const { pennants, fulls, halves } = barbLayout(bucket)
  // A lone half barb is inset by one slot. Drawn at the tip it reads as a full
  // barb at a glance, which is a 5 kn error in the direction that matters most.
  let o = pennants === 0 && fulls === 0 ? step : 0

  const ink: string[] = []
  for (let i = 0; i < pennants; i++) {
    const y0 = tipY + o
    const y1 = y0 + pennantBase
    ink.push(
      `<polygon points="${n(c)},${n(y0)} ${n(c + feather)},${n(y0)} ${n(c)},${n(y1)}" fill="${color}" stroke="none"/>`,
    )
    o += pennantBase + pennantGap
  }
  for (let i = 0; i < fulls; i++) {
    const y = tipY + o
    ink.push(line(c, y, c + feather, y - lean, color, sw))
    o += step
  }
  for (let i = 0; i < halves; i++) {
    const y = tipY + o
    ink.push(line(c, y, c + feather / 2, y - lean / 2, color, sw))
    o += step
  }

  const shaft = line(c, c, c, tipY, color, sw)
  return `${open}<g stroke-linecap="round">${shaft}${ink.join('')}</g>${close}`
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  sw: number,
): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="${n(sw)}"/>`
}

/** 2 dp, no trailing zeros — keeps the sprite strings short and diffable. */
const n = (x: number): string => Number(x.toFixed(2)).toString()

/**
 * One sprite per 5-knot bucket, 0..75+ kn: a calm circle plus 5, 10, ... 75.
 * Sixteen images, a few kilobytes of SVG, built once at map load and handed to
 * `map.addImage` via `barbToImageData`.
 */
export function buildBarbSprites(opts?: {
  color?: string
  strokeWidth?: number
  size?: number
}): BarbSprite[] {
  const size = opts?.size ?? 44
  const g: Geometry = {
    size,
    // Default to the theme's brightest ink rather than a ramp colour: barbs are
    // read as a shape, and tinting the shape by speed duplicates information the
    // shape already carries while making light airs vanish on a dark chart.
    color: opts?.color ?? '#eaf2fa',
    strokeWidth: opts?.strokeWidth ?? Math.max(1, size * 0.038),
  }

  const sprites: BarbSprite[] = []
  for (let bucket = 0; bucket <= MAX_BUCKET_KN; bucket += 5) {
    sprites.push({
      id: idFor(bucket),
      minKn: lowerEdge(bucket),
      maxKn: upperEdge(bucket),
      svg: svgFor(bucket, g),
      width: size,
      height: size,
    })
  }
  return sprites
}

/**
 * A MapLibre `step` expression mapping a speed property to a sprite id.
 *
 * The break points are the bucket edges, so this and `barbIdForSpeed` are the
 * same function evaluated in two places — which is why both are tested against
 * the same speeds.
 */
export function barbImageExpression(property: string): unknown[] {
  const expr: unknown[] = ['step', ['get', property], CALM_ID]
  for (let bucket = 5; bucket <= MAX_BUCKET_KN; bucket += 5) {
    expr.push(lowerEdge(bucket), idFor(bucket))
  }
  return expr
}

// ---------------------------------------------------------------- rasterising

/**
 * Rasterise one sprite for `map.addImage(sprite.id, imageData, { pixelRatio })`.
 *
 * Browser only, and deliberately so: this is the only function in the module
 * that touches the DOM, which is what lets the SVG generation and the bucketing
 * above be unit-tested in Node. Rejects with a clear message rather than
 * throwing a `ReferenceError` off the back of a missing global.
 */
export async function barbToImageData(
  sprite: BarbSprite,
  pixelRatio = 2,
): Promise<ImageData> {
  const w = Math.max(1, Math.round(sprite.width * pixelRatio))
  const h = Math.max(1, Math.round(sprite.height * pixelRatio))

  // `Image` + a DOM canvas first, and `OffscreenCanvas` only as the worker-side
  // fallback. It looks backwards, but `createImageBitmap` on an SVG blob is the
  // path with the patchiest support — notably on iOS Safari, which is the single
  // browser this app most has to work in. `addImage` runs on the main thread
  // anyway, so the well-supported path is also the one we actually take.
  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sprite.svg)}`
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('barbToImageData: no 2d context on canvas')
    ctx.drawImage(img, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  }

  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(
      new Blob([sprite.svg], { type: 'image/svg+xml' }),
    )
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('barbToImageData: no 2d context on OffscreenCanvas')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return ctx.getImageData(0, 0, w, h)
  }

  throw new Error('barbToImageData: needs a browser (DOM canvas or OffscreenCanvas)')
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('barbToImageData: SVG failed to decode'))
    img.src = url
  })
}
