import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { NmeaDecoder, type Reading } from '../src/lib/instruments/nmea0183'
import { decodeAis } from '../src/lib/ais/decode'
import { BridgeClient } from '../src/lib/instruments/bridge'
import { parseArgs, startBridge, type Bridge } from './bridge'
import { LineSplitter } from './inputs'
import { replay } from './replay'
import { acceptKey, decodeFrames, encodeFrame, originAllowed } from './ws'

const RECORDING = readFileSync(new URL('./fixtures/casco-bay-synthetic.nmea', import.meta.url), 'latin1').split(/\r?\n/).filter(Boolean)

/** A masked client frame, as a browser sends it. */
function clientFrame(text: string, opcode = 0x1, fin = true): Buffer {
  const body = Buffer.from(text)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const n = body.length
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 255])
  const masked = Buffer.from(body.map((b, i) => b ^ mask[i & 3]))
  return Buffer.concat([head, mask, masked])
}

describe('the bridge’s WebSocket', () => {
  it('answers the handshake as RFC 6455’s example does', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('reads masked frames of every length, split anywhere, and writes its own', () => {
    const long = 'x'.repeat(70_000)
    const f = encodeFrame(long)
    expect([f[0], f[1]]).toEqual([0x81, 127])
    expect(decodeFrames(f).frames[0].payload.toString()).toBe(long)
    const both = Buffer.concat([clientFrame('hello'), clientFrame('y'.repeat(300))])
    const half = decodeFrames(both.subarray(0, 20))
    expect(half.frames.map((x) => x.payload.toString())).toEqual(['hello'])
    const all = decodeFrames(Buffer.concat([half.rest, both.subarray(20)]))
    expect(all.frames[0].payload.toString()).toBe('y'.repeat(300))
    expect(all.rest.length).toBe(0)
  })

  it('lets in pages from this machine, and from origins it is told of, and no others', () => {
    expect(originAllowed('http://localhost:5173', [])).toBe(true)
    expect(originAllowed('http://127.0.0.1:4173', [])).toBe(true)
    expect(originAllowed('https://evil.example', [])).toBe(false)
    expect(originAllowed('https://app.example', ['https://app.example'])).toBe(true)
    expect(originAllowed(undefined, [])).toBe(true)
  })

  it('splits a stream into lines however it is cut, and drops a runaway', () => {
    const s = new LineSplitter()
    expect(s.push('$GPRMC,1')).toEqual([])
    expect(s.push('23*00\r\n$IIMWV')).toEqual(['$GPRMC,123*00'])
    expect(s.push(',1*00\n' + 'z'.repeat(2000) + '\n')).toEqual(['$IIMWV,1*00'])
  })

  it('reads its command line', () => {
    expect(parseArgs(['--udp', '10110', '--tcp', '192.168.1.10:10110', '--n2k', '--tcp-server', '1457', '--port', '3090', '--allow', 'https://a.example'])).toEqual({
      port: 3090,
      allowedOrigins: ['https://a.example'],
      inputs: [
        { kind: 'udp', port: 10110, format: 'nmea0183' },
        { kind: 'tcp-client', host: '192.168.1.10', port: 10110, format: 'nmea0183' },
        { kind: 'tcp-server', port: 1457, format: 'n2k' },
      ],
    })
    expect(parseArgs(['--udp', '10110@239.192.0.1']).inputs[0]).toMatchObject({ multicast: '239.192.0.1' })
  })
})

/** A WebSocket client (Node's own), collecting what the bridge sends. */
async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const got: Array<{ type: string; [k: string]: unknown }> = []
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('ws failed'))
  })
  return { ws, got }
}

const until = async (ok: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the bridge', () => {
  let bridge: Bridge | null = null
  afterEach(async () => {
    await bridge?.stop()
    bridge = null
  })

  it('passes a recording sent over UDP to the app, line for line, and our decoders read it', async () => {
    bridge = await startBridge({ port: 0, inputs: [{ kind: 'udp', port: 0, bind: '127.0.0.1' }], batchMs: 10 })
    await until(() => bridge!.inputs()[0].state === 'listening')
    const udpPort = Number(bridge.inputs()[0].address.split(':')[1])
    const { ws, got } = await client(bridge.port)
    await until(() => got.some((m) => m.type === 'hello'))
    expect(got[0]).toMatchObject({ type: 'hello', bridge: 'newjourney-bridge', version: 1, inputs: [{ kind: 'udp', state: 'listening' }] })
    const sent = RECORDING.slice(0, 61)
    await new Promise<void>((done) => replay({ lines: sent, host: '127.0.0.1', port: udpPort, rate: 400, onDone: done }))
    const lines = () => got.filter((m) => m.type === 'lines').flatMap((m) => m.lines as string[])
    await until(() => lines().length >= sent.length)
    expect(lines()).toEqual(sent)
    // Through the app's own decoders: a position, a heading, the apparent wind and depth, and a ferry on AIS.
    const dec = new NmeaDecoder()
    const r: Reading = {}
    for (const x of dec.feed(lines().join('\r\n') + '\r\n')) Object.assign(r, x)
    expect(r.lat).toBeCloseTo(43.64, 2)
    expect(r.headingTrue).toBeCloseTo(265, 0)
    expect(r.awa).toBeCloseTo(-30, 0)
    expect(r.aws).toBeCloseTo(17, 0)
    // The last depth sent, at nine seconds: 12 + 3·sin(9/40) m.
    expect(r.depthM).toBeCloseTo(12.7, 1)
    const ais = decodeAis(lines().filter((l) => l.startsWith('!AIVDM')).join('\n'))
    expect(ais[0]).toMatchObject({ mmsi: 367123450, type: 1 })
    ws.close()
  })

  it('reads a TCP server it connects to, and a TCP client that connects to it', async () => {
    // A multiplexer on the LAN, as a TCP server: it sends once the app is listening.
    const muxed: Socket[] = []
    const mux = createServer((s) => muxed.push(s))
    await new Promise<void>((r) => mux.listen(0, '127.0.0.1', () => r()))
    const muxPort = (mux.address() as { port: number }).port
    bridge = await startBridge({ port: 0, inputs: [{ kind: 'tcp-client', host: '127.0.0.1', port: muxPort }, { kind: 'tcp-server', port: 0, bind: '127.0.0.1' }], batchMs: 10 })
    const { ws, got } = await client(bridge.port)
    await until(() => bridge!.inputs()[1].state === 'listening' && muxed.length > 0)
    muxed[0].write(RECORDING.slice(0, 6).join('\r\n') + '\r\n')
    const srvPort = Number(bridge.inputs()[1].address.split(':')[1])
    const s = connect(srvPort, '127.0.0.1', () => s.write(RECORDING.slice(6, 12).join('\n') + '\n'))
    const by = (id: string) => got.filter((m) => m.type === 'lines' && m.input === id).flatMap((m) => m.lines as string[])
    await until(() => by(`tcp:127.0.0.1:${muxPort}`).length >= 6 && by(`tcp-server:0`).length >= 6)
    expect(by(`tcp:127.0.0.1:${muxPort}`)).toEqual(RECORDING.slice(0, 6))
    expect(by('tcp-server:0')).toEqual(RECORDING.slice(6, 12))
    s.destroy()
    ws.close()
    mux.close()
  })

  it("feeds the app's own bridge client: readings and AIS from a recording replayed over UDP", async () => {
    bridge = await startBridge({ port: 0, inputs: [{ kind: 'udp', port: 0, bind: '127.0.0.1' }], batchMs: 10 })
    await until(() => bridge!.inputs()[0].state === 'listening')
    const udpPort = Number(bridge.inputs()[0].address.split(':')[1])
    const reading: Reading = {}
    const ais: string[] = []
    let connected = false
    const app = new BridgeClient(`ws://127.0.0.1:${bridge.port}`, {
      onReading: (r) => Object.assign(reading, r),
      onAisLine: (l) => ais.push(l),
      onStatus: (s) => (connected = s === 'connected'),
    })
    app.start()
    await until(() => connected)
    await new Promise<void>((done) => replay({ lines: RECORDING.slice(0, 130), host: '127.0.0.1', port: udpPort, rate: 500, onDone: done }))
    await until(() => app.lines >= 130)
    expect(reading).toMatchObject({ sog: 6.2, cog: 265 })
    expect(reading.bsp).toBeCloseTo(6.2, 1)
    expect(ais.length).toBeGreaterThanOrEqual(2)
    app.stop()
  })

  it('passes NMEA 2000 from a gateway, as text, to the app’s NMEA 2000 decoder', async () => {
    bridge = await startBridge({ port: 0, inputs: [{ kind: 'tcp-server', port: 0, bind: '127.0.0.1', format: 'n2k' }], batchMs: 10 })
    await until(() => bridge!.inputs()[0].state === 'listening')
    const reading: Reading = {}
    let connected = false
    const app = new BridgeClient(`ws://127.0.0.1:${bridge.port}`, { onReading: (r) => Object.assign(reading, r), onStatus: (s) => (connected = s === 'connected') })
    app.start()
    await until(() => connected)
    const port = Number(bridge.inputs()[0].address.split(':')[1])
    // Apparent wind 7.72 m/s at 330° as a Yacht Devices RAW frame, and water depth 12.4 m as Actisense N2K ASCII.
    const gateway = connect(port, '127.0.0.1', () =>
      gateway.write(['17:33:21.107 R 09FD0223 00 04 03 FC E0 FA FF FF', 'A173321.107 23FF3 1F50B 00D8040000' + '0CFEFF'].join('\r\n') + '\r\n'),
    )
    await until(() => reading.awa != null && reading.depthM != null)
    expect(reading.awa).toBeCloseTo(-30, 1)
    expect(reading.depthM).toBeCloseTo(12.4, 6)
    gateway.destroy()
    app.stop()
  })

  it('passes what one copy of the app shares to the others, here and over linked bridges, once each', async () => {
    // b links to a, and a back to b: a circle, which must neither loop nor deliver twice.
    const b = await startBridge({ port: 0, inputs: [], key: 'sail', id: 'b' })
    const a = await startBridge({ port: 0, inputs: [], key: 'sail', id: 'a', peers: [`ws://127.0.0.1:${b.port}`] })
    await b.stop()
    const b2 = await startBridge({ port: b.port, inputs: [], key: 'sail', id: 'b', peers: [`ws://127.0.0.1:${a.port}`] })
    // And one with the wrong key, which gets nothing.
    const c = await startBridge({ port: 0, inputs: [], key: 'wrong', id: 'c', peers: [`ws://127.0.0.1:${a.port}`] })
    try {
      const nav = await client(a.port)
      const deck = await client(a.port)
      const below = await client(b2.port)
      const other = await client(c.port)
      // a's link to b dials again (after a second) now b is back.
      await new Promise((r) => setTimeout(r, 1600))
      nav.ws.send(JSON.stringify({ type: 'share', topic: 'course', data: { marks: [1, 2] }, from: 'nav' }))
      const shared = (x: { got: Array<{ type: string }> }) => x.got.filter((m) => m.type === 'shared')
      await until(() => shared(deck).length > 0 && shared(below).length > 0)
      await new Promise((r) => setTimeout(r, 200))
      expect(shared(deck)).toEqual([expect.objectContaining({ type: 'shared', topic: 'course', data: { marks: [1, 2] }, from: 'nav' })])
      expect(shared(below)).toHaveLength(1)
      // Not back to the one that sent it, and not through a link with the wrong key.
      expect(shared(nav)).toHaveLength(0)
      expect(shared(other)).toHaveLength(0)
      // Back the other way, over the link.
      below.ws.send(JSON.stringify({ type: 'share', topic: 'start', data: { gunTime: 1 }, from: 'below' }))
      await until(() => shared(nav).length > 0)
      expect(shared(nav)[0]).toMatchObject({ topic: 'start', from: 'below' })
      for (const x of [nav, deck, below, other]) x.ws.close()
    } finally {
      await Promise.all([a.stop(), b2.stop(), c.stop()])
    }
  })

  it('turns away a web page from anywhere else', async () => {
    bridge = await startBridge({ port: 0, inputs: [] })
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port: bridge!.port, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } })
      req.on('response', (res) => resolve(res.statusCode ?? 0))
      req.on('upgrade', () => resolve(101))
      req.on('error', () => resolve(-1))
      req.end()
    })
    expect(status).toBe(403)
  })
})
