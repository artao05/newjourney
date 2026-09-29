# Channels out: the JSON/WebSocket API

newjourney sends its live channels over a WebSocket to a server you name in
**Setup → Channels out**. It is a web app, so it cannot listen for
connections. It connects out to your server, and when the link drops it
reconnects after 1, 2, 4 … 30 seconds.

- **Address:** `ws://host:port/path` on the boat's network. A page served over
  https may only reach `wss://`, or `ws://localhost`, because browsers block
  mixed content.
- **Rate:** one frame a second (or one every 5 s), with the latest value of
  every channel.
- **Reference:** `src/lib/api/channelsOut.ts`. Version `v: 1`.

## newjourney JSON

Every message is one JSON object, as a text frame.

### From newjourney

**`hello`**, once on connecting, lists the channels this build produces:

```json
{
  "type": "hello",
  "v": 1,
  "app": "newjourney",
  "channels": [
    { "id": "tws", "name": "Tws", "unit": "kn", "group": "wind" },
    { "id": "latitude", "name": "Latitude", "unit": "latlon", "group": "position" }
  ]
}
```

**`channels`** then carries the values at the rate set. `t` is milliseconds
since 1970 (UTC). A channel with no value at that moment is left out.

```json
{ "type": "channels", "v": 1, "t": 1790712000000, "values": { "tws": 12.4, "twd": 205.1, "sog": 6.2 } }
```

Channel ids are stable, kebab-case, and never renamed; they are the ids in
`src/lib/channels/catalogue.ts`. Units follow the catalogue (the `unit` in
the hello):
- `kn` for speeds, `nm` and `m` for distances, `s` for times, `pct` for
  percentages;
- `deg` for angles, true unless the id says magnetic, and `deg/s` for rates;
- `latlon` for latitude and longitude, decimal degrees, signed north and east;
- `datetime` as milliseconds since 1970;
- `degC`, `hPa`, `kPa`, `kg/m3`, `V`, `A`, `rpm` and `load` as named.

Signed angles such as TWA, AWA and heel are −180…180, negative to port.

**`pong`** answers a `ping`: `{ "type": "pong", "t": 1790712000000 }`.

### To newjourney

**`subscribe`** narrows the frames to the channels listed, or `"*"` for all
of them again:

```json
{ "type": "subscribe", "channels": ["tws", "twd", "twa", "bsp", "target-bsp"] }
```

`{ "type": "ping" }` asks for a `pong`. Anything else is ignored.

## Signal K

In the Signal K form, newjourney sends
[delta](https://signalk.org/specification/latest/doc/data_model.html) messages
in Signal K's SI units, with no hello and no subscription. A Signal K server
takes these on a WebSocket stream connection that is allowed to write. The
channels sent, and their paths:

| Channel | Signal K path |
| --- | --- |
| latitude, longtitude | `navigation.position` |
| sog, cog | `navigation.speedOverGround`, `navigation.courseOverGroundTrue` |
| bsp, heading, heel-roll | `navigation.speedThroughWater`, `navigation.headingTrue`, `navigation.attitude.roll` |
| tws, twd, twa | `environment.wind.speedTrue`, `.directionTrue`, `.angleTrueWater` |
| aws, awa | `environment.wind.speedApparent`, `.angleApparent` |
| vmg, target-bsp, target-twa, polar-bsp | `performance.velocityMadeGood`, `.targetSpeed`, `.targetAngle`, `.polarSpeed` |
| current-set, current-drift | `environment.current.setTrue`, `.drift` |

## A server to try it with

Any WebSocket server will do. With Node and the `ws` package:

```js
import { WebSocketServer } from 'ws'
new WebSocketServer({ port: 8765 }).on('connection', (s) => {
  s.send(JSON.stringify({ type: 'subscribe', channels: ['tws', 'twd', 'bsp'] }))
  s.on('message', (m) => console.log(String(m)))
})
```
