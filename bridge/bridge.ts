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
 *   {type:'file', watch, name, kind, size, mtime, data}   a file that landed in a watched folder, in base64
 * From the app:
 *   {type:'ping'}  answered {type:'pong', t}
 *   {type:'share', topic, data, from}   passed to every other copy of the app, here and on
 *                                       linked bridges, as {type:'shared', topic, data, from, t}
 *
 * Bridge to bridge (--peer URL --key SECRET, on each side): a link starts with
 * {type:'link', key, bridge}, and share messages go both ways with the bridges
 * they have passed through, so none goes round in a circle. A connection from
 * another machine must present the key before anything is sent to it.
 *
 * Nothing is sent to the boat: the bridge only listens (transmitting is M19,
 * behind a switch that is off). See bridge/README.md.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { startInput, type Input, type InputConfig, type InputStatus } from './inputs.ts'
import { startWsServer, type WsPeer, type WsServer } from './ws.ts'
import { startWatch, type WatchConfig, type WatchedFile, type WatchStatus } from './watch.ts'

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
  /** Other bridges to link to, as ws://HOST:PORT, for the app on other machines. */
  peers?: string[]
  /** The secret a link (or any connection from another machine) must give. */
  key?: string
  /** This bridge's name in a chain of links; random if not given. */
  id?: string
  /** Folders to watch: a file that lands in one goes to the app. */
  watch?: WatchConfig[]
}

interface Share {
  type: 'share'
  topic: string
  data: unknown
  from: string
  t?: number
  via?: string[]
  /** The message's id, given by the first bridge it reaches. */
  mid?: string
}

/** An outgoing link to another bridge, kept open with back-off. */
class OutLink {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private delay = 1000
  private stopped = false
  open = false
  readonly url: string
  private readonly hello: string
  private readonly onShare: (m: Share, from: OutLink) => void
  constructor(url: string, hello: string, onShare: (m: Share, from: OutLink) => void) {
    this.url = url
    this.hello = hello
    this.onShare = onShare
    this.dial()
  }
  private dial() {
    if (this.stopped) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.open = true
      this.delay = 1000
      ws.send(this.hello)
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as Share
        if (m.type === 'share') this.onShare(m, this)
      } catch {
        /* not ours */
      }
    }
    ws.onerror = () => undefined
    ws.onclose = () => {
      this.open = false
      if (this.stopped) return
      this.timer = setTimeout(() => this.dial(), this.delay)
      this.delay = Math.min(this.delay * 2, 30_000)
    }
  }
  send(text: string) {
    if (this.open) this.ws?.send(text)
  }
  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
  }
}

/** A connection from this machine (the loopback address). */
const local = (remote: string) => remote.startsWith('127.') || remote.startsWith('::1') || remote.startsWith('::ffff:127.')

export interface Bridge {
  port: number
  inputs(): InputStatus[]
  watches(): WatchStatus[]
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
    else if (a === '--peer') (c.peers ??= []).push(next())
    else if (a === '--key') c.key = next()
    else if (a === '--scan') {
      // The folder just given: send its files to each app that connects, not only new ones.
      const last = c.watch?.at(-1)
      if (!last) throw new Error('--scan follows a --watch')
      last.scan = true
    } else if (a === '--watch') {
      // DIR, or DIR=grib|chart|tracking to say what its files are.
      const v = next()
      const k = v.lastIndexOf('=')
      const kind = k > 0 ? v.slice(k + 1) : ''
      c.watch = [...(c.watch ?? []), kind === 'grib' || kind === 'chart' || kind === 'tracking' ? { dir: v.slice(0, k), kind } : { dir: v }]
    }
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
  const id = config.id ?? `bridge-${Math.random().toString(36).slice(2, 8)}`
  const peers = new Set<WsPeer>()
  // Other bridges linked in, and ours linked out.
  const links = new Set<WsPeer>()
  const outLinks: OutLink[] = []
  const inputs: Input[] = []
  const batchMs = config.batchMs ?? 50
  const pending = new Map<string, string[]>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const statuses = () => inputs.map((i) => ({ ...i.status }))
  const broadcastText = (text: string) => {
    for (const p of peers) p.send(text)
  }
  const broadcast = (msg: object) => broadcastText(JSON.stringify(msg))
  const fileMessage = (f: WatchedFile) =>
    JSON.stringify({ type: 'file', watch: f.watch, name: f.name, kind: f.kind, size: f.size, mtime: f.mtime, data: f.data.toString('base64') })
  // A shared message: to every copy of the app here but the one it came from, and on down the links.
  // Messages seen lately, by id: linked both ways, one can arrive by two roads, and is passed on once.
  const seen = new Set<string>()
  const relay = (m: Share, source: WsPeer | OutLink | null) => {
    if (typeof m.topic !== 'string' || typeof m.from !== 'string') return
    if ((m.via ?? []).includes(id)) return
    const mid = typeof m.mid === 'string' ? m.mid : `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    if (seen.has(mid)) return
    seen.add(mid)
    if (seen.size > 2000) seen.delete(seen.values().next().value as string)
    const t = m.t ?? Date.now()
    const onward = JSON.stringify({ type: 'share', topic: m.topic, data: m.data, from: m.from, t, mid, via: [...(m.via ?? []), id] })
    const toApps = JSON.stringify({ type: 'shared', topic: m.topic, data: m.data, from: m.from, t })
    for (const p of peers) if (p !== source) p.send(toApps)
    for (const l of links) if (l !== source) l.send(onward)
    for (const o of outLinks) if (o !== source) o.send(onward)
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

  // Before the server listens: an app that connects at once may ask for a scanned folder.
  const watches = (config.watch ?? []).map((w) => startWatch(w, (f) => broadcastText(fileMessage(f))))
  const ws: WsServer = await startWsServer({
    port: config.port ?? DEFAULT_PORT,
    host: config.host ?? '127.0.0.1',
    allowedOrigins: config.allowedOrigins ?? [],
    onPeer: (p) => {
      const here = local(p.remote)
      // From this machine, an app: straight in. From another, nothing until it gives the key.
      if (here) {
        peers.add(p)
        p.send(JSON.stringify({ type: 'hello', bridge: 'newjourney-bridge', version: BRIDGE_VERSION, inputs: statuses() }))
        // A scanned folder's files, to this app as it arrives.
        for (const [k, w] of watches.entries()) {
          if (!config.watch?.[k]?.scan) continue
          for (const f of w.existing()) p.send(fileMessage(f))
        }
      }
      p.onMessage = (text) => {
        let m: { type?: string; key?: string } | null = null
        try {
          m = JSON.parse(text) as { type?: string; key?: string }
        } catch {
          return
        }
        if (m?.type === 'link') {
          if (!config.key || m.key !== config.key) {
            p.close(4003)
            return
          }
          peers.delete(p)
          links.add(p)
          p.send(JSON.stringify({ type: 'linked', bridge: id }))
          return
        }
        if (!here && !links.has(p)) {
          p.close(4003)
          return
        }
        if (m?.type === 'ping') p.send(JSON.stringify({ type: 'pong', t: Date.now() }))
        else if (m?.type === 'share') relay(m as unknown as Share, p)
      }
      p.onClose = () => {
        peers.delete(p)
        links.delete(p)
      }
    },
    onHttp: (_req, res) => {
      // A status page: what the bridge is listening to, for a person with a browser.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ bridge: 'newjourney-bridge', version: BRIDGE_VERSION, peers: peers.size, links: links.size + outLinks.length, inputs: statuses() }, null, 2))
    },
  })
  for (const c of config.inputs) inputs.push(startInput(c, onLines, onStatus))
  for (const url of config.peers ?? []) outLinks.push(new OutLink(url, JSON.stringify({ type: 'link', key: config.key ?? '', bridge: id }), relay))

  return {
    port: ws.port,
    inputs: statuses,
    watches: () => watches.map((w) => ({ ...w.status })),
    stop: async () => {
      for (const w of watches) w.stop()
      if (flushTimer) clearTimeout(flushTimer)
      if (statusTimer) clearTimeout(statusTimer)
      for (const i of inputs) i.stop()
      for (const o of outLinks) o.stop()
      for (const p of [...peers, ...links]) p.close(1001)
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
  --peer ws://HOST:PORT  link to the bridge on another machine, to share with the app there
  --key SECRET         the secret linked bridges share (needed on both sides)
  --watch DIR[=KIND]   send files that land in DIR to the app (KIND: grib, chart or tracking; else by name)
  --scan               after a --watch: also send the files already there to each app that connects
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
  if (!config.inputs.length && !config.peers?.length && !config.key && !config.watch?.length) {
    console.log(USAGE)
    console.log('\nNothing to do: give an input (--udp, --tcp, --tcp-server) or a link (--peer, --key).')
    process.exit(1)
  }
  const b = await startBridge(config)
  console.log(`bridge on ws://${config.host ?? '127.0.0.1'}:${b.port}`)
  for (const s of b.inputs()) console.log(`  ${s.id} (${s.format})`)
  const bye = () => void b.stop().then(() => process.exit(0))
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
