# The bridge

A browser can't open a UDP or TCP socket, so instruments on the boat's network never
reach a web page on their own. That covers multiplexers, NMEA 2000 gateways, and
chartplotters sending NMEA over Wi-Fi. The bridge is a small Node program that runs
on the nav-station computer. It listens to those devices and passes every line to
the app over a WebSocket on this machine.

It needs Node 22.6 or later, which runs TypeScript as is, and nothing else: no
`npm install`.

```
node bridge/bridge.ts --udp 10110
node bridge/bridge.ts --tcp 192.168.1.10:10110 --tcp-server 10111
node bridge/bridge.ts --n2k --tcp 192.168.1.20:1457          # a Yacht Devices or Actisense gateway in RAW mode
node bridge/bridge.ts --config bridge/bridge.config.json
```

In the app: **Setup → Instruments → Bridge**, `ws://127.0.0.1:3080`, then **CONNECT BRIDGE**.
Setup lists each input with its state and how many lines it has sent.

| Input | What it is |
|---|---|
| `--udp PORT` | Listens for UDP datagrams: broadcast, or a multicast group as `PORT@GROUP`. Most Wi-Fi multiplexers send on 10110. |
| `--tcp HOST:PORT` | Connects to a TCP server, such as a multiplexer, a gateway or OpenCPN's output, and reconnects if it drops. |
| `--tcp-server PORT` | Accepts TCP connections that send NMEA. |
| `--n2k` | The next input sends NMEA 2000 frames as text, not NMEA 0183. |

A config file is the same thing as JSON:

```json
{ "port": 3080, "inputs": [{ "kind": "udp", "port": 10110 }, { "kind": "tcp-client", "host": "192.168.1.10", "port": 10110 }] }
```

## Sharing between copies of the app

The bridge also passes what one copy of the app shares to the others: the course, the start
line and the instruments (**Setup → Sharing**). Copies on the same computer share straight
away. For copies on two computers, run the bridge on both and link them with the same key:

```
node bridge/bridge.ts --udp 10110 --host 0.0.0.0 --key SECRET                     # the nav station
node bridge/bridge.ts --peer ws://NAV-STATION:3080 --key SECRET                   # the deck laptop
```

A connection from another machine gets nothing until it gives the key. Each message is passed
on once, even round a circle of links. A copy that takes in instruments uses them as its own:
a repeater, for the deck or a coach boat.

## Watched folders

A file that lands in a watched folder goes to the app, which opens it as if it had been picked:
a GRIB from a satellite download, a raster chart or ENC cell, a tracker's position report.
The bridge waits until the file stops changing, so it never sends one half written, and sends
it again only if it changes. Turn it on in the app under **Setup → Sharing → Watched folders**.

```
node bridge/bridge.ts --watch C:\Downloads\grib=grib --watch C:\Race\reports=tracking
node bridge/bridge.ts --watch C:\Charts\RNC=chart --scan        # and the charts already there, to each app that connects
```

Without `=KIND`, each file is known by its name. `--scan` also sends a folder's existing
files, the newest 20, to each copy of the app as it connects. That works like a chart
library, or a GRIB folder opened in one go. Files over 25 MB are not sent.

## Safety

- **It only listens.** Nothing goes to the boat. Transmitting is worklist M19, behind a
  switch that stays off until a test boat turns it on.
- **Only this machine's pages can connect.** It listens on `127.0.0.1`, and it refuses a
  WebSocket from any web page whose origin is not localhost (`--allow ORIGIN` adds
  one, such as where the app is hosted). Otherwise any site open in a browser here
  could read the boat's data.

## Without a boat

`bridge/replay.ts` sends a recording over UDP the way a multiplexer would:

```
node bridge/bridge.ts --udp 10110
node bridge/replay.ts bridge/fixtures/casco-bay-synthetic.nmea --to 127.0.0.1:10110 --rate 7 --loop
```

`fixtures/casco-bay-synthetic.nmea` is **made up**, not recorded. It holds five minutes
of a boat beating off Portland, plus a ferry on AIS, written by
`fixtures/make-recording.ts`. A real recording from a race boat is still a need
([needs.md](../docs/08-parity/needs.md) §5).

## The protocol

JSON messages, one object each.

- **To the app:** `hello` (the bridge, its version and its inputs), `lines` (an input's id,
  its format and a batch of lines, sent every 50 ms), and `status` (the inputs, when one
  changes).
- **From the app:** `ping`, answered with `pong`.

`http://127.0.0.1:3080/` shows the same status as a page.
