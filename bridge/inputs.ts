/**
 * Where the bridge's lines come from: NMEA 0183 and AIS (or NMEA 2000 frames
 * as text) over UDP, as a TCP client of a gateway or multiplexer, or as a TCP
 * server the instruments connect to. Each input splits its bytes into lines
 * and hands them on; a TCP client that loses its server keeps trying.
 */
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { connect, createServer, type Server, type Socket } from 'node:net'

export type InputFormat = 'nmea0183' | 'n2k'

export type InputConfig =
  | { kind: 'udp'; port: number; bind?: string; multicast?: string; format?: InputFormat; id?: string }
  | { kind: 'tcp-client'; host: string; port: number; format?: InputFormat; id?: string }
  | { kind: 'tcp-server'; port: number; bind?: string; format?: InputFormat; id?: string }

export type InputState = 'starting' | 'listening' | 'connected' | 'reconnecting' | 'error' | 'stopped'

export interface InputStatus {
  id: string
  kind: InputConfig['kind']
  format: InputFormat
  /** host:port, as the input sees it. */
  address: string
  state: InputState
  detail: string | null
  lines: number
  lastAt: number | null
}

/** Chunks into lines, however they were cut; a line longer than NMEA allows (and then some) is dropped. */
export class LineSplitter {
  private rest = ''
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/\r?\n/)
    this.rest = parts.pop() ?? ''
    if (this.rest.length > 4096) this.rest = ''
    return parts.map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= 1024)
  }
}

export function inputId(c: InputConfig): string {
  if (c.id) return c.id
  return c.kind === 'tcp-client' ? `tcp:${c.host}:${c.port}` : `${c.kind === 'udp' ? 'udp' : 'tcp-server'}:${c.port}`
}

export interface Input {
  status: InputStatus
  stop(): void
}

/**
 * Start one input. `onLines` gets its lines as they come; `onStatus` each time
 * its state changes.
 */
export function startInput(c: InputConfig, onLines: (id: string, lines: string[]) => void, onStatus: (s: InputStatus) => void): Input {
  const status: InputStatus = {
    id: inputId(c),
    kind: c.kind,
    format: c.format ?? 'nmea0183',
    address: c.kind === 'tcp-client' ? `${c.host}:${c.port}` : `${('bind' in c && c.bind) || '0.0.0.0'}:${c.port}`,
    state: 'starting',
    detail: null,
    lines: 0,
    lastAt: null,
  }
  const set = (state: InputState, detail: string | null = null) => {
    status.state = state
    status.detail = detail
    onStatus({ ...status })
  }
  const got = (lines: string[]) => {
    if (!lines.length) return
    status.lines += lines.length
    status.lastAt = Date.now()
    onLines(status.id, lines)
  }
  let stopped = false

  if (c.kind === 'udp') {
    const sock: UdpSocket = createSocket({ type: 'udp4', reuseAddr: true })
    // A datagram is usually one or a few whole sentences; split it all the same.
    sock.on('message', (msg) => got(new LineSplitter().push(msg.toString('latin1') + '\n')))
    sock.on('error', (e) => set('error', e.message))
    sock.bind(c.port, c.bind ?? '0.0.0.0', () => {
      // Port 0 asks for any free one: say which it got.
      status.address = `${c.bind ?? '0.0.0.0'}:${sock.address().port}`
      if (c.multicast) {
        try {
          sock.addMembership(c.multicast)
        } catch (e) {
          set('error', `multicast ${c.multicast}: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
      }
      set('listening', c.multicast ? `multicast ${c.multicast}` : null)
    })
    return {
      status,
      stop: () => {
        stopped = true
        sock.close()
        set('stopped')
      },
    }
  }

  if (c.kind === 'tcp-server') {
    const clients = new Set<Socket>()
    const server: Server = createServer((s) => {
      clients.add(s)
      const split = new LineSplitter()
      s.on('data', (d) => got(split.push(d.toString('latin1'))))
      s.on('close', () => {
        clients.delete(s)
        set('listening', `${clients.size} connected`)
      })
      s.on('error', () => s.destroy())
      set('connected', `${clients.size} connected`)
    })
    server.on('error', (e) => set('error', e.message))
    server.listen(c.port, c.bind ?? '0.0.0.0', () => {
      const a = server.address()
      if (a && typeof a === 'object') status.address = `${c.bind ?? '0.0.0.0'}:${a.port}`
      set('listening')
    })
    return {
      status,
      stop: () => {
        stopped = true
        for (const s of clients) s.destroy()
        server.close()
        set('stopped')
      },
    }
  }

  // A TCP client: connect, read, and when the far end goes, try again, backing off to 30 s.
  let sock: Socket | null = null
  let delay = 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  const dial = () => {
    if (stopped) return
    const split = new LineSplitter()
    const s = connect({ host: c.host, port: c.port })
    sock = s
    s.on('connect', () => {
      delay = 1000
      set('connected')
    })
    s.on('data', (d) => got(split.push(d.toString('latin1'))))
    s.on('error', (e) => set('reconnecting', e.message))
    s.on('close', () => {
      if (stopped) return
      set('reconnecting', status.detail ?? 'closed')
      timer = setTimeout(dial, delay)
      delay = Math.min(delay * 2, 30_000)
    })
  }
  dial()
  return {
    status,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      sock?.destroy()
      set('stopped')
    },
  }
}
