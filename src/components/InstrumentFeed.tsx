/**
 * The instrument feed as something to mount, so the shell can load it, with the
 * clients and decoders behind it, only while a feed is on.
 */

import { useInstruments, type InstrumentSource } from '@/hooks/useInstruments'
import { useStore } from '@/state/store'

export function InstrumentFeed({ source }: { source: NonNullable<InstrumentSource> }) {
  const pipeline = useStore((s) => s.pipeline)
  const calibration = useStore((s) => s.calibration)
  useInstruments(source, pipeline, calibration)
  return null
}
