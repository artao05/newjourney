/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useStore } from '@/state/store'
import { AlarmBanner, AlarmWatcher, AlarmsSection } from './Alarms'

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({ alarms: [], alarmStates: {}, events: [], instrumentReading: null, instrumentDerived: null })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useStore.setState({ alarms: [], alarmStates: {}, events: [], instrumentReading: null })
})

describe('alarms in the app', () => {
  it('fires on a live channel, shows on the banner, logs an event, and is acknowledged', () => {
    useStore.getState().addAlarm({ name: 'Shallow', channel: 'depth', op: 'below', value: 3, hysteresis: 0.5, delayS: 0, enabled: true })
    useStore.setState({ instrumentReading: { depthM: 2.4 } })
    render(
      <>
        <AlarmWatcher />
        <AlarmBanner />
      </>,
    )
    act(() => vi.advanceTimersByTime(1100))
    const banner = screen.getByRole('alert', { name: 'Alarms' })
    expect(banner.textContent).toMatch(/Shallow/)
    expect(banner.textContent).toMatch(/2\.4/)
    expect(useStore.getState().events.at(-1)).toMatchObject({ kind: 'note', text: 'Alarm: Shallow' })
    fireEvent.click(within(banner).getByRole('button', { name: 'ACK' }))
    expect(banner.textContent).toMatch(/acknowledged/)
    expect(within(banner).queryByRole('button', { name: 'ACK' })).toBeNull()

    // Back past the margin: it clears, and the banner goes.
    act(() => useStore.setState({ instrumentReading: { depthM: 3.6 } }))
    act(() => vi.advanceTimersByTime(1100))
    expect(screen.queryByRole('alert', { name: 'Alarms' })).toBeNull()
  })

  it('adds, switches off and removes rules in Setup, and keeps them', () => {
    render(<AlarmsSection />)
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'sog' } })
    fireEvent.click(screen.getByRole('button', { name: 'Above' }))
    fireEvent.change(screen.getByLabelText(/^Threshold/), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'ADD ALARM' }))
    const rule = useStore.getState().alarms[0]
    expect(rule).toMatchObject({ channel: 'sog', op: 'above', value: 9, enabled: true, name: 'Sog above 9' })
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.alarms).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Sog above 9 on'))
    expect(useStore.getState().alarms[0].enabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove alarm Sog above 9' }))
    expect(useStore.getState().alarms).toEqual([])
  })
})
