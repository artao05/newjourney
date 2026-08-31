/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Legend } from './Legend'
import { RAMPS } from '@/lib/maplayers/colormap'

/**
 * Collect all tick labels the legend renders (the `<span>`s inside the tick row).
 */
function tickTexts(container: HTMLElement): string[] {
  // The tick row is the div with position: relative after the colour bar.
  const spans = container.querySelectorAll<HTMLSpanElement>('div.legend > div:nth-child(3) span')
  return Array.from(spans).map((el) => el.textContent ?? '')
}

describe('Legend', () => {
  describe('discrete ramp tick coverage', () => {
    it('labels the domain end when the last stop falls short', () => {
      /**
       * The depth ramp's last stop is 30 m, but the layer domain goes to 40 m.
       * Without a tick at 40 the rightmost 25 % of the colour bar is unlabelled,
       * and the unit rides on "30 m" at 75 %, making it look like 30 is the
       * maximum — which it is not.
       */
      const { container } = render(
        <Legend
          ramp={RAMPS.depth}
          domain={[0, 40]}
          label="Water depth"
          unit="m"
          source="GEBCO"
        />,
      )
      const texts = tickTexts(container)
      // The domain end (40) must appear somewhere among the ticks, and the unit
      // must be on the very last tick — which should now BE at 40.
      expect(texts.some((t) => t.includes('40'))).toBe(true)
      expect(texts[texts.length - 1]).toContain('m')
      expect(texts[texts.length - 1]).toContain('40')
    })

    it('does not duplicate the end tick when a stop already sits on hi', () => {
      /**
       * Beaufort's last stop is 64 kn and the domain goes to [0, 64], so the
       * stop already provides a tick at 100 %. Adding a second one would create
       * overlapping labels.
       */
      const { container } = render(
        <Legend
          ramp={RAMPS.beaufort}
          domain={[0, 64]}
          label="Beaufort force"
          unit="kn"
          source="test"
        />,
      )
      const texts = tickTexts(container)
      const at64 = texts.filter((t) => t.includes('64'))
      expect(at64.length).toBe(1)
    })
  })
})
