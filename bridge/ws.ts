/**
 * A small WebSocket server (RFC 6455), enough for the bridge: the opening
 * handshake, text frames both ways (masked from the browser, as it must be),
 * fragmented messages, ping and pong, and the closing handshake. No
 * extensions and no binary messages, which the bridge does not use.
 *
 * Only pages from an allowed origin may connect. The bridge listens on the
 * loopback address, but any web page open in a browser on this machine could
 * otherwise reach it; the origin check keeps the boat's data, and later its
 * outputs, to the app.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The Sec-WebSocket-Accept answer to a client's key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** A server-to-client frame: unmasked, final. */
export function encodeFrame(payload: Buffer | string, opcode = 0x1): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const n = body.length
  let head: Buffer
  if (n < 126) head = Buffer.from([0x80 | opcode, n])
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
  else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, body])
}

export interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** Whole frames at the front of `buf`, unmasked, and the bytes left over for the next read. */
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = []
  let at = 0
  for (;;) {
    if (buf.length - at < 2) break
    const b0 = buf[at]
    const b1 = buf[at + 1]
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let off = at + 2
    if (len === 126) {
      if (buf.length - off < 2) break
      len = buf.readUInt16BE(off)
      off += 2
    } else if (len === 127) {
      if (buf.length - off < 8) break
      const big = buf.readBigUInt64BE(off)
      if (big > BigInt(16 * 1024 * 1024)) throw new Error('frame too large')
      len = Number(big)
      off += 8
    }
    const maskAt = off
    if (masked) off += 4
    if (buf.length - off < len) break
    const payload = Buffer.from(buf.subarray(off, off + len))
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)]
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload })
    at = off + len
  }
  return { frames, rest: buf.subarray(at) }
}

export interface WsPeer {
  /** Where the connection came from, and the page's origin. */
  readonly remote: string
  readonly origin: string
  send(text: string): void
  close(code?: number): void
  onMessage: (text: string) => void
  onClose: () => void
}

function peer(socket: Duplex, remote: string, origin: string): WsPeer {
  let buffered: Buffer = Buffer.alloc(0)
  let parts: Buffer[] = []
  let closed = false
  const p: WsPeer = {
    remote,
    origin,
    send(text) {
      if (!closed) socket.write(encodeFrame(text))
    },
    close(code = 1000) {
      if (closed) return
      closed = true
      const body = Buffer.alloc(2)
      body.writeUInt16BE(code, 0)
      socket.end(encodeFrame(body, 0x8))
    },
    onMessage: () => undefined,
    onClose: () => undefined,
  }
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    let got: ReturnType<typeof decodeFrames>
    try {
      got = decodeFrames(buffered)
    } catch {
      p.close(1009)
      return
    }
    buffered = Buffer.from(got.rest)
    for (const f of got.frames) {
      if (f.opcode === 0x8) {
        p.close()
        continue
      }
      if (f.opcode === 0x9) {
        if (!closed) socket.write(encodeFrame(f.payload, 0xa))
        continue
      }
      if (f.opcode === 0xa) continue
      // Text, or a continuation of it: put the pieces together.
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        parts.push(f.payload)
        if (f.fin) {
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          p.onMessage(text)
        }
      }
    }
  })
  const gone = () => {
    if (closed && !socket.destroyed) socket.destroy()
    closed = true
    p.onClose()
  }
  socket.on('close', gone)
  socket.on('error', () => socket.destroy())
  return p
}

/** Localhost pages, on any port, plus the origins named. */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true // not a browser: a script on this machine, like the tests
  if (allowed.includes(origin)) return true
  try {
    const u = new URL(origin)
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return false
  }
}

export interface WsServer {
  server: Server
  port: number
  close(): Promise<void>
}

/**
 * Listen for WebSocket connections on host:port. `onPeer` gets each one;
 * `onHttp` answers a plain request (the bridge's status page).
 */
export function startWsServer(o: {
  port: number
  host?: string
  allowedOrigins?: string[]
  onPeer: (p: WsPeer) => void
  onHttp?: (req: IncomingMessage, res: ServerResponse) => void
}): Promise<WsServer> {
  const sockets = new Set<Duplex>()
  const server = createServer((req, res) => {
    if (o.onHttp) o.onHttp(req, res)
    else {
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('WebSocket only\n')
    }
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key']
    const origin = req.headers.origin
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!originAllowed(origin, o.allowedOrigins ?? [])) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
    )
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    o.onPeer(peer(socket, `${req.socket.remoteAddress}:${req.socket.remotePort}`, origin ?? ''))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host ?? '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        server,
        port: typeof addr === 'object' && addr ? addr.port : o.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}
