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
