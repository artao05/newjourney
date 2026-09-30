/**
 * newjourney's local bridge: what a browser cannot reach, brought to the app.
 *
 * A browser cannot open a UDP or TCP socket, so instruments on the boat's
 * network (a multiplexer, a gateway, a chartplotter sending NMEA over Wi-Fi)
 * never reach a web page. This small Node program, run on the nav station,
 * listens to them and passes every line on to the app over a WebSocket on
 * this machine's loopback address.
 *
 *   node bridge/bridge.ts --udp 10110 --tcp 192.168.1.10:10110
 *   node bridge/bridge.ts --config bridge/bridge.config.json
 *
 * To the app (JSON, one object a message):
 *   {type:'hello', bridge, version, inputs}   on connecting
 *   {type:'lines', input, format, lines}      lines as they come, batched every 50 ms
 *   {type:'status', inputs}                   when an input's state changes
 * From the app:
 *   {type:'ping'}  answered {type:'pong', t}
 *
 * Nothing is sent to the boat: the bridge only listens (transmitting is M19,
 * behind a switch that is off). See bridge/README.md.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { startInput, type Input, type InputConfig, type InputStatus } from './inputs.ts'
import { startWsServer, type WsPeer, type WsServer } from './ws.ts'

export const BRIDGE_VERSION = 1
export const DEFAULT_PORT = 3080

export interface BridgeConfig {
  /** The WebSocket port the app connects to, on 127.0.0.1. */
  port?: number
  /** Listen on this address instead (another device on the LAN, say): think before you do. */
  host?: string
  /** Page origins allowed besides localhost ones, e.g. where the app is hosted. */
  allowedOrigins?: string[]
  inputs: InputConfig[]
  /** Batch lines this long before sending, ms. */
  batchMs?: number
}

export interface Bridge {
  port: number
  inputs(): InputStatus[]
  stop(): Promise<void>
}

/** Read the command line: --port, --udp PORT[@MULTICAST], --tcp HOST:PORT, --tcp-server PORT, --n2k (the next input is NMEA 2000), --allow ORIGIN, --config FILE. */
export function parseArgs(argv: string[]): BridgeConfig {
  const c: BridgeConfig = { inputs: [] }
  let n2k = false
  const fmt = () => {
    const f = n2k ? ('n2k' as const) : ('nmea0183' as const)
    n2k = false
    return f
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v == null) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--config') Object.assign(c, JSON.parse(readFileSync(next(), 'utf8')) as BridgeConfig)
    else if (a === '--port') c.port = Number(next())
    else if (a === '--host') c.host = next()
    else if (a === '--allow') (c.allowedOrigins ??= []).push(next())
    else if (a === '--n2k') n2k = true
    else if (a === '--udp') {
      const [port, multicast] = next().split('@')
      c.inputs.push({ kind: 'udp', port: Number(port), ...(multicast ? { multicast } : {}), format: fmt() })
    } else if (a === '--tcp') {
      const v = next()
      const k = v.lastIndexOf(':')
      c.inputs.push({ kind: 'tcp-client', host: v.slice(0, k), port: Number(v.slice(k + 1)), format: fmt() })
    } else if (a === '--tcp-server') c.inputs.push({ kind: 'tcp-server', port: Number(next()), format: fmt() })
    else if (a === '--help' || a === '-h') throw new Error('help')
    else throw new Error(`not understood: ${a}`)
  }
  return c
}

export async function startBridge(config: BridgeConfig): Promise<Bridge> {
  const peers = new Set<WsPeer>()
  const inputs: Input[] = []
  const batchMs = config.batchMs ?? 50
  const pending = new Map<string, string[]>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const statuses = () => inputs.map((i) => ({ ...i.status }))
  const broadcast = (msg: object) => {
    const text = JSON.stringify(msg)
    for (const p of peers) p.send(text)
  }
  const flush = () => {
    flushTimer = null
    for (const [id, lines] of pending) {
      const format = inputs.find((i) => i.status.id === id)?.status.format ?? 'nmea0183'
      broadcast({ type: 'lines', input: id, format, lines })
    }
    pending.clear()
  }
  const onLines = (id: string, lines: string[]) => {
    if (!peers.size) return
    const list = pending.get(id) ?? []
    list.push(...lines)
    pending.set(id, list)
    if (!flushTimer) flushTimer = setTimeout(flush, batchMs)
  }
  // Tell the app when an input's state changes, but not more than every half second.
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  const onStatus = () => {
    if (statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = null
      broadcast({ type: 'status', inputs: statuses() })
    }, 500)
  }

  const ws: WsServer = await startWsServer({
    port: config.port ?? DEFAULT_PORT,
    host: config.host ?? '127.0.0.1',
    allowedOrigins: config.allowedOrigins ?? [],
    onPeer: (p) => {
      peers.add(p)
      p.send(JSON.stringify({ type: 'hello', bridge: 'newjourney-bridge', version: BRIDGE_VERSION, inputs: statuses() }))
      p.onMessage = (text) => {
        let m: { type?: string } | null = null
        try {
          m = JSON.parse(text) as { type?: string }
        } catch {
          return
        }
        if (m?.type === 'ping') p.send(JSON.stringify({ type: 'pong', t: Date.now() }))
      }
      p.onClose = () => peers.delete(p)
    },
    onHttp: (_req, res) => {
      // A status page: what the bridge is listening to, for a person with a browser.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ bridge: 'newjourney-bridge', version: BRIDGE_VERSION, peers: peers.size, inputs: statuses() }, null, 2))
    },
  })
  for (const c of config.inputs) inputs.push(startInput(c, onLines, onStatus))

  return {
    port: ws.port,
    inputs: statuses,
    stop: async () => {
      if (flushTimer) clearTimeout(flushTimer)
      if (statusTimer) clearTimeout(statusTimer)
      for (const i of inputs) i.stop()
      for (const p of peers) p.close(1001)
      await ws.close()
    },
  }
}

const USAGE = `newjourney bridge: NMEA and AIS from the boat's network, to the app.

  node bridge/bridge.ts [--port 3080] [--udp 10110] [--tcp 192.168.1.10:10110] [--tcp-server 10111]
                        [--n2k --tcp 192.168.1.20:1457] [--allow https://app.example] [--config FILE]

  --udp PORT[@GROUP]   listen for UDP datagrams (broadcast, or a multicast group)
  --tcp HOST:PORT      connect to a TCP server (a multiplexer or gateway); reconnects
  --tcp-server PORT    accept TCP connections that send NMEA
  --n2k                the next input sends NMEA 2000 as text (Actisense or Yacht Devices RAW)
  --allow ORIGIN       a page origin allowed to connect besides localhost
  --port PORT          the WebSocket port for the app (default ${DEFAULT_PORT})

In the app: Setup → Instruments → Bridge, ws://127.0.0.1:${DEFAULT_PORT}.`

// Run from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config: BridgeConfig
  try {
    config = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.log(USAGE)
    process.exit(e instanceof Error && e.message === 'help' ? 0 : 1)
  }
  if (!config.inputs.length) {
    console.log(USAGE)
    console.log('\nNo inputs: give at least one of --udp, --tcp or --tcp-server.')
    process.exit(1)
  }
  const b = await startBridge(config)
  console.log(`bridge on ws://${config.host ?? '127.0.0.1'}:${b.port}`)
  for (const s of b.inputs()) console.log(`  ${s.id} (${s.format})`)
  const bye = () => void b.stop().then(() => process.exit(0))
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
