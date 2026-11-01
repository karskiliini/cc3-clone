# CC3 room relay protocol v1

Implemented contract for workflow 044/047b. Shared runtime types/validation
live in `src/net/relayProtocol.ts`; existing simulation traffic remains `NetMessage`
inside `IntegrityTransport` envelopes. This document describes the lifecycle and
failure guarantees; typed fixtures and real WebSocket tests exercise the same contract.
There is no database, account service or public room listing.

## Connection and membership

HTTP `GET /healthz` returns readiness, protocol/build fingerprint and active room count.
WebSocket `/relay` uses JSON text frames. Browser clients use native WebSocket; the
Node relay uses [ws](https://github.com/websockets/ws/blob/master/README.md).
The first request is `create`, `join` or `rejoin`, carrying protocol and simulation
build fingerprint. A mismatch fails before a battle starts. Every failure is a typed
`error` with a readable reason; an occupied room never silently changes occupants.

Create assigns the host a side and a cryptographic resume token. It returns a random
six-character room code. Join claims the other side. Rejoin requires that side's
resume token; the code alone cannot replace a player. Tokens are kept in browser
storage, never in share links, command histories, health responses or error reports.
A replacement socket closes only that member's previous connection. Both members
are informed about presence. Empty rooms expire after a bounded reconnect interval;
relay restart loses in-memory rooms, which the client reports explicitly.

## Lobby

The host configures map/year/duration/seed and force points. Settings changes clear
both ready flags. Each side submits only its own roster, bounded by year, side,
points and team-count rules. Invalid changes leave the last valid room unchanged.
When both sides accept their rosters, the server freezes a common config with two
human controllers and begins a deterministic deployment phase. Each player then
places and readies their own teams through the existing lockstep commands.

## Battle traffic and retained history

`wire` frames carry the current room generation and an integrity envelope. The relay
checks that a simulation message speaks for the authenticated side, bounds payloads,
and records the first sealed bundle for each side/turn before forwarding it. A later
attempt to rewrite that sealed bundle is rejected. Valid bundles ahead of a damaged
packet are retained within the bounded turn window; the sealed bound advances only
when its missing predecessors have been repaired. CRC-bad bodies never enter history. Empty turns need no history entry;
sealed bounds and progress are retained. All ordinary orders, ready flags, pause,
speed and truce/flee commands remain in the deterministic battle command log.

A returning player triggers a freeze handshake. Connected clients stop advancing
and acknowledge their completed turn after their prior outbound messages. Only then
does the relay choose a common completed turn, retain all already sealed future
commands, increment the room generation and send both clients a history snapshot.
Both rebuild in bounded slices from tick zero, report progress and their rebuilt
hash, and resume only after matching hashes. Old-generation packets cannot enter
the new session. Unsealed local input is retained by the surviving client. A failed
rebuild is visible and bounded; true nondeterminism ends with recovery actions and
a downloadable report rather than a permanent frozen view. A replay exception
closes recovery on both peers; local AI continuation preserves the survivor’s prior
battle. Recovery with no advancing rebuild progress for 60 seconds times out.

## Shared policy and leaving

Either side may lower speed; raising requires both players' current votes. Each has
three pauses, at most 60 real seconds each; the pause owner can resume early. Lockstep
control turns continue at 1x while paused, so the deadline replays deterministically.
Orders are disabled during a multiplayer pause. Single-player rules stay unchanged.

On a lost connection, play waits and offers reconnect, continue locally against AI,
and forfeit. Choosing local AI ends that online room; the same battle continues with
a logged controller-change command, so its replay remains reproducible. Rejoin is
available while the room remains in its reconnect grace period. A closed/expired
room gives a concrete error and does not pretend to recover a missing history.

## Resource and deployment boundaries

Rooms, peers, frame sizes, send queues, request rates and retained history are bounded;
invalid JSON and unknown operations never crash the relay. Only the owning host can
change settings, and only the owning side can submit its roster or battle messages.
Room tokens are not a defence against a friend reading their own full simulation
state; map hacks remain the explicitly accepted trust model.

Serve the built frontend and `/relay` on one origin, or proxy `/relay` from the frontend.
Production TLS terminates at the user's chosen host/proxy. Deployment remains with
the user under the standing backlog default; implementation verification uses the
user's Mac mini and this Mac as separate clients. Actual public Internet availability
must be reported separately from local/LAN test evidence.

## Run and connect

Requires Node 24+ and the installed npm dependencies. For a single-origin build:

```sh
npm ci
npm run build
CC3_STATIC_DIR=dist CC3_RELAY_HOST=0.0.0.0 PORT=8787 npm run relay
```

Open the host’s reachable HTTP address in both browsers, choose **Multiplayer**,
then create a room and share its six-character code. The guest joins that code;
each chooses their forces and readies, then deploys and presses Begin. Both must
Begin before battle starts. For local development, run `npm run relay` and
`npm run dev`; Vite proxies `/relay` to port 8787. A separately hosted frontend
can use `VITE_RELAY_URL` at build time or the lobby's relay-address field.

For public hosting, supply HTTPS/WSS through a reverse proxy, preserve WebSocket
upgrade headers and allow the selected public origin with `CC3_ALLOWED_ORIGINS`
(comma-separated) when it differs from the relay's Host. Serve the same built
simulation sources on relay and clients: `tools/simulationFingerprint.ts` hashes
the source contract, not the Git worktree path or UI-only edits. Restarting the
relay deliberately discards rooms; keep it running for reconnects. Resume tokens
belong to the browser's saved game and must not be shared with the room code.

`tools/onlineBrowserCheck.mjs` exercises two real browser contexts against an
already running server. It closes only its own browsers. Video capture is optional
(`CC3_RECORD_VIDEO=1`); software GPU emulation plus video capture stalled headless
Chromium in this environment, so primary verification uses default graphics and
screenshots. `tools/onlineHostProbe.ts` exercises real sockets on separate machines.
The 2026-11-01 evidence covers this Mac (M5) and the user's Mac mini (M2) over LAN,
not a publicly deployed Internet service. Hosting remains the user's responsibility.
