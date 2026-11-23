/**
 * Wind-speed colours, white and green for light air through yellow and orange
 * to red for strong wind. Stops are placed where the racing decisions change:
 * under 6 kn is drifting, 6-12 kn full crew on the rail, 12-18 kn depowering,
 * 18-25 kn reefing or a jib change, 25+ kn small-craft territory.
 */
export const WIND_STOPS: Array<{ kn: number; rgb: [number, number, number]; label: string }> = [
  { kn: 0, rgb: [248, 250, 252], label: 'Calm' },
  { kn: 4, rgb: [209, 242, 220], label: 'Light' },
  { kn: 8, rgb: [120, 214, 150], label: '' },
  { kn: 12, rgb: [46, 170, 92], label: 'Moderate' },
  { kn: 16, rgb: [214, 211, 58], label: '' },
  { kn: 20, rgb: [245, 158, 40], label: 'Fresh' },
  { kn: 25, rgb: [232, 60, 48], label: 'Strong' },
  { kn: 32, rgb: [160, 20, 40], label: 'Gale' },
  { kn: 40, rgb: [110, 16, 90], label: '' },
]

export function windRgb(kn: number): [number, number, number] {
  const s = WIND_STOPS
  if (kn <= s[0]!.kn) return s[0]!.rgb
  for (let i = 1; i < s.length; i++) {
    const b = s[i]!
    if (kn <= b.kn) {
      const a = s[i - 1]!
      const f = (kn - a.kn) / (b.kn - a.kn)
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
      ]
    }
  }
  return s[s.length - 1]!.rgb
}

export function windCss(kn: number, alpha = 1): string {
  const [r, g, b] = windRgb(kn)
  return `rgba(${r},${g},${b},${alpha})`
}

/** Beaufort-ish words for beginners. */
export function windWords(kn: number): string {
  if (kn < 1) return 'calm'
  if (kn < 4) return 'light air'
  if (kn < 7) return 'light breeze'
  if (kn < 11) return 'gentle breeze'
  if (kn < 17) return 'moderate breeze'
  if (kn < 22) return 'fresh breeze'
  if (kn < 28) return 'strong breeze'
  if (kn < 34) return 'near gale'
  return 'gale'
}
