/**
 * Logs the live channels while the track is recording: one row a second,
 * flushed in batches, and at once when the page is hidden, which on a phone is
 * the last moment sure to run before the OS drops the app.
 */

import { useEffect, useRef } from 'react'
import { useChannelSnapshot } from '@/hooks/useChannels'
import { ChannelLogger } from '@/lib/logging/logger'
import { logStore } from '@/lib/logging/idbStore'

export function ChannelLogRecorder() {
  const snap = useChannelSnapshot()
  const logger = useRef<ChannelLogger | null>(null)
  logger.current ??= new ChannelLogger(logStore())

  useEffect(() => {
    logger.current!.record(Date.now(), snap)
  }, [snap])

  useEffect(() => {
    const flush = () => void logger.current?.flush()
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    const timer = window.setInterval(flush, 10_000)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.clearInterval(timer)
      flush()
    }
  }, [])

  return null
}
