/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearErrors, errorsText, readErrors, recordError } from './errorLog'
import { formatChannel } from './channels/format'

beforeEach(() => clearErrors())

describe('the error log', () => {
  it('keeps what went wrong for 60 days, and reads back as text', () => {
    const day = 24 * 3600_000
    recordError('Route', new Error('isochrone blew up'), 0)
    recordError('window', 'a string was thrown', 30 * day)
    expect(readErrors(30 * day).map((e) => [e.where, e.message])).toEqual([
      ['Route', 'isochrone blew up'],
      ['window', 'a string was thrown'],
    ])
    // Past 60 days the first goes.
    expect(readErrors(61 * day).map((e) => e.where)).toEqual(['window'])
    expect(errorsText(readErrors(30 * day)).split('\n')[0]).toMatch(/^1970-01-01T00:00:00\.000Z \[Route\] isochrone blew up$/)
    clearErrors()
    expect(readErrors()).toEqual([])
  })

  it('keeps the last 200', () => {
    for (let i = 0; i < 205; i++) recordError('x', `e${i}`, i)
    const all = readErrors(300)
    expect(all).toHaveLength(200)
    expect(all[0].message).toBe('e5')
  })
})

describe('temperatures', () => {
  it('read in Fahrenheit with imperial units', () => {
    expect(formatChannel({ id: 'air-temperature', unit: 'degC' }, 20, 'imperial')).toEqual({ text: '68.0', unit: '°F' })
    expect(formatChannel({ id: 'air-temperature', unit: 'degC' }, 20, 'metric')).toEqual({ text: '20.0', unit: '°C' })
    expect(formatChannel({ id: 'air-temperature', unit: 'degC' }, 0, 'imperial', 0)).toEqual({ text: '32', unit: '°F' })
  })
})
