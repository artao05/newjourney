/**
 * Sends the live channels out over a WebSocket while Setup → Channels out is
 * on (lib/api/channelsOut.ts). Mounted only then, so nothing runs otherwise.
 */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useChannelSnapshot } from '@/hooks/useChannels'
import { ChannelsOut, type OutStatus } from '@/lib/api/channelsOut'
import { useStore } from '@/state/store'

/** How the link is doing, for Setup to show. */
export const useChannelsOutStatus = create<{ status: OutStatus; sent: number }>()(() => ({ status: 'off', sent: 0 }))

export function ChannelsOutBridge() {
  const snap = useChannelSnapshot()
  const { url, format, rateHz } = useStore((s) => s.settings.channelsOut)
  const out = useRef<ChannelsOut | null>(null)

  useEffect(() => {
    const c = new ChannelsOut({ url, format, rateHz }, (status) => useChannelsOutStatus.setState({ status }))
    out.current = c
    c.start()
    return () => {
      c.stop()
      out.current = null
      useChannelsOutStatus.setState({ status: 'off' })
    }
  }, [url, format, rateHz])

  useEffect(() => {
    const c = out.current
    if (!c) return
    c.push(snap, Date.now())
    useChannelsOutStatus.setState({ sent: c.sent })
  }, [snap])

  return null
}
