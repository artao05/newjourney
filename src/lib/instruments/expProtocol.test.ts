import { beforeEach, describe, expect, it } from 'vitest'
import { ack, actionFor, expChecksum, frame, parseExpLine } from './expProtocol'
import { NmeaDecoder, withChecksum } from './nmea0183'
import { applyExpAction } from '@/state/expCommands'
import { useStore } from '@/state/store'

describe("Expedition's text protocol: framing and checksum", () => {
  it('checksums from the # itself, as the manual’s own example shows', () => {
    expect(expChecksum('#G,12.34')).toBe('62')
    expect(frame('#G,12.34')).toBe('#G,12.34*62\r\n')
    expect(frame('G,KILL')).toBe(`#G,KILL*${expChecksum('#G,KILL')}\r\n`)
  })

  it('refuses a line with a wrong checksum', () => {
    expect(parseExpLine('#G,12.34*63')).toBeNull()
    expect(parseExpLine('$GPHDT,1.0,T')).toBeNull()
  })

  it('reads a data line into channel numbers and values, and says whose they are', () => {
    expect(parseExpLine(frame('#0,1,6.25,5,32.5,6,x'))).toEqual({
      kind: 'data',
      boat: '0',
      group: 'boat',
      values: [[1, 6.25], [5, 32.5]],
    })
    expect(parseExpLine(frame('#E,3,1.5'))).toMatchObject({ group: 'external', values: [[3, 1.5]] })
    expect(parseExpLine(frame('#X,2,270'))).toMatchObject({ group: 'system' })
  })

  it('reads a command, and builds the acknowledgement from its checksum', () => {
    const c = parseExpLine('#G,12.34*62')
    expect(c).toEqual({ kind: 'command', cmd: 'G', args: ['12.34'], checksum: '62' })
    expect(ack(c as { checksum: string })).toBe(frame('#ACK,62'))
    expect(parseExpLine(frame('#ACK,62'))).toBeNull()
  })
})

describe('the commands, as actions', () => {
  const act = (body: string) => actionFor(parseExpLine(frame(body)) as never)

  it('maps the countdown, the line ends and the marks', () => {
    expect(act('#G,SYNC')).toEqual({ do: 'gun-sync' })
    expect(act('#G,KILL')).toEqual({ do: 'gun-kill' })
    expect(act('#G,-1')).toEqual({ do: 'gun-kill' })
    expect(act('#G,4.5')).toEqual({ do: 'gun-set', minutes: 4.5 })
    expect(act('#L,P')).toEqual({ do: 'ping', end: 'port' })
    expect(act('#L,S,43.66,-70.25')).toEqual({ do: 'set-end', end: 'starboard', lat: 43.66, lon: -70.25 })
    expect(act('#L,S,95,0')).toMatchObject({ do: 'unsupported' })
    expect(act('#M,NEXT')).toEqual({ do: 'mark-next' })
    expect(act('#M,MOB')).toEqual({ do: 'mob' })
    expect(act('#C,GETCOURSENUM')).toMatchObject({ do: 'unsupported' })
  })
})

describe('carrying the commands out', () => {
  beforeEach(() => {
    useStore.setState({
      state: { t: 0, position: { lat: 43.66, lon: -70.25 }, cog: 0, sog: 0, accuracyM: 3, heading: null, bsp: null, heelDeg: null },
      course: {
        id: 'c', name: 'c',
        marks: [
          { id: 'a', name: 'A', position: { lat: 43.7, lon: -70.2 }, roundTo: 'port' },
          { id: 'b', name: 'B', position: { lat: 43.6, lon: -70.3 }, roundTo: 'port' },
        ],
        startLine: { port: null, starboard: null, gunTime: null },
      },
      activeMarkIndex: 0,
    })
  })

  it('sets, syncs and stops the countdown', () => {
    const now = 1_000_000
    applyExpAction({ do: 'gun-set', minutes: 5 }, now)
    expect(useStore.getState().course.startLine.gunTime).toBe(now + 300_000)
    applyExpAction({ do: 'gun-sync' }, now + 20_000)
    expect(useStore.getState().course.startLine.gunTime).toBe(now + 20_000 + 300_000)
    applyExpAction({ do: 'gun-kill' }, now)
    expect(useStore.getState().course.startLine.gunTime).toBeNull()
  })

  it('pings and sets the line ends, and steps the active mark', () => {
    applyExpAction({ do: 'ping', end: 'port' })
    expect(useStore.getState().course.startLine.port).toEqual({ lat: 43.66, lon: -70.25 })
    applyExpAction({ do: 'set-end', end: 'starboard', lat: 43.661, lon: -70.249 })
    expect(useStore.getState().course.startLine.starboard).toEqual({ lat: 43.661, lon: -70.249 })
    expect(applyExpAction({ do: 'mark-next' })).toBe('Active mark: B.')
    expect(applyExpAction({ do: 'mark-next' })).toBe('Active mark: B.')
    applyExpAction({ do: 'mark-prev' })
    expect(useStore.getState().activeMarkIndex).toBe(0)
  })

  it('does not answer a query while the link is read-only', () => {
    expect(applyExpAction({ do: 'mark-query' })).toMatch(/not sent/)
  })

  it('arrives mixed in with NMEA on the same stream', () => {
    const lines: string[] = []
    const d = new NmeaDecoder((l) => lines.push(l))
    d.feed(withChecksum('IIHDT,10.0,T') + '\r\n' + frame('#G,5') + withChecksum('IIHDT,11.0,T') + '\r\n')
    expect(d.reading.headingTrue).toBe(11)
    expect(lines).toEqual([frame('#G,5').trim()])
  })
})
