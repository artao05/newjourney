/**
 * Channels out's settings, apart from the sender (channelsOut.ts) because the store
 * holds them on every load, and the sender and its channel catalogue load only once
 * channels out is on.
 */

export type OutFormat = 'json' | 'signalk'

export interface ChannelsOutSettings {
  enabled: boolean
  url: string
  format: OutFormat
  /** Frames a second. */
  rateHz: number
}

export const DEFAULT_CHANNELS_OUT: ChannelsOutSettings = { enabled: false, url: 'ws://localhost:8765', format: 'json', rateHz: 1 }
