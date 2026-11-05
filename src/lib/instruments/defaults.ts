/**
 * Where instrument feeds usually are. Apart from their clients because the store
 * needs these on every load, and the clients and their decoders only load once a
 * feed is turned on.
 */

export const DEFAULT_SIGNALK_URL = 'ws://localhost:3000/signalk/v1/stream?subscribe=self'

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:3080'
