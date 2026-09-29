/**
 * NMEA 0183 straight off a serial port, through Web Serial.
 *
 * Desktop Chrome and Edge only (and not iOS at all): a USB-serial or RS-422
 * adaptor on the laptop at the chart table, reading the instrument bus the
 * way Expedition does on a PC. The bytes go through the same `NmeaDecoder` as
 * everything else, so a bad checksum is dropped here too.
 */

import { NmeaDecoder, type Reading } from './nmea0183'
import { N2kDecoder } from './n2k'
import type { SignalKStatus } from './signalk'

export const BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200] as const

/** The part of the Web Serial port this uses, so a test can hand in its own. */
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: {
    getReader(): {
      read(): Promise<{ value?: Uint8Array; done: boolean }>
      cancel(): Promise<void>
      releaseLock(): void
    }
  } | null
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>
  getPorts(): Promise<SerialPortLike[]>
}

function serial(): SerialLike | null {
  const nav = typeof navigator === 'undefined' ? null : (navigator as unknown as { serial?: SerialLike })
  return nav?.serial ?? null
}

export function webSerialAvailable(): boolean {
  return serial() != null
}

/** The port chosen in this session; a browser remembers the grant, not the object. */
let chosen: SerialPortLike | null = null

/** Ask for a port. It needs a tap: browsers only show the picker in answer to one. */
export async function choosePort(): Promise<SerialPortLike | null> {
  const s = serial()
  if (!s) return null
  chosen = await s.requestPort()
  return chosen
}

/** The chosen port, or one granted before (after a reload), or null. */
export async function grantedPort(): Promise<SerialPortLike | null> {
  if (chosen) return chosen
  const ports = (await serial()?.getPorts()) ?? []
  return ports[0] ?? null
}

export interface SerialOptions {
  onReading: (r: Partial<Reading>) => void
  onStatus?: (s: SignalKStatus, detail?: string) => void
  /** Expedition protocol lines (`#...`) that arrive on the same port. */
  onHashLine?: (line: string) => void
  /**
   * What the port speaks: NMEA 0183 sentences, or NMEA 2000 frames as text (a
   * Yacht Devices USB gateway in RAW mode, or canboat's CSV).
   */
  format?: 'nmea0183' | 'n2k'
}

/** Reads NMEA lines from a port until stopped. */
export class SerialNmeaSource {
  readonly decoder: NmeaDecoder
  readonly n2k = new N2kDecoder()
  private n2kBuffer = ''
  private stopped = false
  private reader: ReturnType<NonNullable<SerialPortLike['readable']>['getReader']> | null = null

  constructor(
    private readonly port: () => Promise<SerialPortLike | null>,
    private readonly baudRate: number,
    private readonly opts: SerialOptions,
  ) {
    this.decoder = new NmeaDecoder(opts.onHashLine)
  }

  async start(): Promise<void> {
    this.opts.onStatus?.('connecting')
    const port = await this.port()
    if (this.stopped) return
    if (!port) {
      this.opts.onStatus?.('error', 'Choose the serial port again: press CONNECT SERIAL.')
      return
    }
    try {
      await port.open({ baudRate: this.baudRate })
    } catch (e) {
      this.opts.onStatus?.('error', e instanceof Error ? e.message : String(e))
      return
    }
    if (this.stopped || !port.readable) {
      await port.close().catch(() => {})
      return
    }
    this.opts.onStatus?.('connected')
    const text = new TextDecoder()
    this.reader = port.readable.getReader()
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done || this.stopped) break
        if (!value) continue
        const chunk = text.decode(value, { stream: true })
        if (this.opts.format === 'n2k') {
          const lines = (this.n2kBuffer + chunk).split(/\r?\n/)
          this.n2kBuffer = (lines.pop() ?? '').slice(-512)
          for (const l of lines) {
            const r = this.n2k.line(l)
            if (r && Object.keys(r).length) this.opts.onReading(r)
          }
        } else {
          for (const r of this.decoder.feed(chunk)) this.opts.onReading(r)
        }
      }
    } catch (e) {
      // Unplugging the adaptor ends up here.
      if (!this.stopped) this.opts.onStatus?.('error', e instanceof Error ? e.message : String(e))
    } finally {
      this.reader.releaseLock()
      this.reader = null
      await port.close().catch(() => {})
    }
    if (!this.stopped) this.opts.onStatus?.('closed')
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.reader?.cancel().catch(() => {})
    this.opts.onStatus?.('off')
  }
}
