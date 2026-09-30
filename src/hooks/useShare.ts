/**
 * Sharing with the other copies of the app (Setup → Sharing): what changes
 * here goes out, and what comes in is taken, topic by topic, as chosen.
 *
 * A change taken from another copy is not sent back out: while it is applied
 * the store's own change is ignored. Instruments go out once a second, only
 * the channels chosen; taken in, they are this copy's instrument source (a
 * repeater), through useInstruments.
 */
import { useEffect } from 'react'
import { useStore } from '@/state/store'
import { filterReading, peerReadings, ShareLink, type ShareTopic } from '@/lib/share'
import type { Mark, StartLine } from '@/lib/types'
import type { Reading } from '@/lib/instruments/nmea0183'

export function useShare(): void {
  const share = useStore((s) => s.settings.share)
  const key = JSON.stringify(share ?? null)
  // `share` as a value: a new object each render must not reconnect.
  useEffect(() => startSharing(share), [key])
}

type ShareSettings = ReturnType<typeof useStore.getState>['settings']['share']

/** Share as the settings say, until the function it returns is called. */
export function startSharing(share: ShareSettings | undefined): () => void {
  const st = useStore.getState()
  if (!share?.on) {
    st.setShareStatus({ status: 'off', detail: null })
    return () => undefined
  }
  let applying = false
  const sends = (t: ShareTopic) => share.send.includes(t)
  const takes = (t: ShareTopic) => share.receive.includes(t)
  const courseNow = () => {
    const s = useStore.getState()
    return { marks: s.course.marks, activeMarkIndex: s.activeMarkIndex }
  }
  const link = new ShareLink(share.url, {
    onShared: (m) => {
      if (!takes(m.topic)) return
      applying = true
      try {
        if (m.topic === 'course') {
          const d = m.data as { marks?: Mark[]; activeMarkIndex?: number }
          if (!Array.isArray(d?.marks)) return
          useStore.setState((s) => ({
            course: { ...s.course, marks: d.marks! },
            activeMarkIndex: Math.min(Math.max(0, d.activeMarkIndex ?? 0), Math.max(0, d.marks!.length - 1)),
          }))
        } else if (m.topic === 'start') {
          const d = m.data as StartLine
          if (!d || typeof d !== 'object') return
          useStore.setState((s) => ({ course: { ...s.course, startLine: { ...s.course.startLine, ...d } } }))
        } else if (m.topic === 'instruments') {
          peerReadings.emit(m.data as Partial<Reading>)
        }
      } finally {
        applying = false
      }
      useStore.getState().setShareStatus({ lastIn: Date.now() })
    },
    onStatus: (status, detail) => {
      useStore.getState().setShareStatus({ status, detail: detail ?? null })
      // A copy that joins late catches up with what this one has.
      if (status === 'connected') {
        if (sends('course')) link.send('course', courseNow())
        if (sends('start')) link.send('start', useStore.getState().course.startLine)
      }
    },
  })
  link.start()

  // What changes here goes out, no more than four times a second a topic.
  const due = new Map<ShareTopic, ReturnType<typeof setTimeout>>()
  const soon = (t: ShareTopic, data: () => unknown) => {
    if (due.has(t)) return
    due.set(
      t,
      setTimeout(() => {
        due.delete(t)
        if (link.send(t, data())) useStore.getState().setShareStatus({ lastOut: Date.now() })
      }, 250),
    )
  }
  const unsub = useStore.subscribe((s, prev) => {
    if (applying) return
    if (sends('course') && (s.course.marks !== prev.course.marks || s.activeMarkIndex !== prev.activeMarkIndex)) soon('course', courseNow)
    if (sends('start') && s.course.startLine !== prev.course.startLine) soon('start', () => useStore.getState().course.startLine)
  })
  const tick = setInterval(() => {
    if (!sends('instruments')) return
    const r = useStore.getState().instrumentReading
    if (r && link.send('instruments', filterReading(r as Record<string, unknown>, share.channels))) useStore.getState().setShareStatus({ lastOut: Date.now() })
  }, 1000)

  return () => {
    unsub()
    clearInterval(tick)
    for (const t of due.values()) clearTimeout(t)
    link.stop()
  }
}
