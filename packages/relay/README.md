# @patch/relay

The end-to-end encrypted relay (`spec/10-auth.md` § Relay): a rendezvous that
forwards bytes it cannot read, and the pieces both ends of a relayed connection
are made of.

| Entry                 | What                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `@patch/relay`        | the handshake and session crypto, the tunnel protocol, the device client  |
| `@patch/relay/server` | the relay itself (`createRelayServer`)                                    |
| `@patch/relay/host`   | the server's half: ends devices' sessions on the server's loopback        |
| `@patch/relay/bridge` | a loopback listener that carries a page and its sockets through a session |

## Running a relay

```sh
PORT=8787 node dist/cli.js        # or the `patch-relay` bin
```

It keeps no state. Put TLS in front and give people the `wss://` address; with
Caddy:

```
relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

and a unit to keep it up:

```
[Service]
ExecStart=/usr/bin/node /opt/patch/relay/dist/cli.js
Environment=PORT=8787 HOST=127.0.0.1
Restart=on-failure
```

A server uses it with `PATCH_RELAY_URL=wss://relay.example.com`.

Production runs one at `wss://patch.tomchambers.me/relay` — a path on the
server's own host, so it needs no DNS record of its own. `scripts/install-relay.mjs`
installs it (`~/.patch-relay`, the `patch-relay` user service on 127.0.0.1:8787);
Caddy's `handle_path /relay/*` strips the prefix. This is the address the desktop
app hands its own server by default.
