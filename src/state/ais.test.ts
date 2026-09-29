import { afterEach, describe, expect, it } from 'vitest'
import { NmeaDecoder } from '@/lib/instruments/nmea0183'
import { feedAis, useAis } from './ais'

afterEach(() => useAis.getState().clear())

describe('AIS from the instrument feed', () => {
  it('takes the ! lines from the NMEA stream and keeps the targets they describe', async () => {
    const d = new NmeaDecoder(undefined, (l) => feedAis(l))
    d.feed('$GPRMC,120000,A,4336.0,N,07015.0,W,5.0,90.0,290926,,*00\r\n!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C\r\n')
    await Promise.resolve()
    const [t] = useAis.getState().targets
    expect(t).toMatchObject({ mmsi: 477553000, status: 5, cog: 51 })
  })
})
