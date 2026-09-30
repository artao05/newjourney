/**
 * Replay a recording of NMEA (and AIS) lines over UDP, as a boat's network
 * would send them: to test the bridge and the app with no boat.
 *
 *   node bridge/replay.ts bridge/fixtures/casco-bay-synthetic.nmea --to 127.0.0.1:10110 --rate 8 --loop
 *
 * `--rate` is lines a second. Each line goes in its own datagram.
 */
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function replay(o: { lines: string[]; host: string; port: number; rate: number; loop?: boolean; onDone?: () => void }): () => void {
  const sock = createSocket('udp4')
  let i = 0
  const timer = setInterval(
    () => {
      if (i >= o.lines.length) {
        if (!o.loop) {
          stop()
          o.onDone?.()
          return
        }
        i = 0
      }
      sock.send(Buffer.from(o.lines[i++] + '\r\n', 'latin1'), o.port, o.host)
    },
    Math.max(1, 1000 / o.rate),
  )
  const stop = () => {
    clearInterval(timer)
    sock.close()
  }
  return stop
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  const opt = (name: string) => {
    const k = args.indexOf(name)
    return k >= 0 ? args[k + 1] : undefined
  }
  if (!file) {
    console.log('usage: node bridge/replay.ts FILE [--to HOST:PORT] [--rate LINES_A_SECOND] [--loop]')
    process.exit(1)
  }
  const [host, port] = (opt('--to') ?? '127.0.0.1:10110').split(':')
  const lines = readFileSync(file, 'latin1').split(/\r?\n/).filter((l) => l.trim())
  console.log(`replaying ${lines.length} lines to ${host}:${port}`)
  replay({ lines, host, port: Number(port), rate: Number(opt('--rate') ?? 8), loop: args.includes('--loop'), onDone: () => process.exit(0) })
}
