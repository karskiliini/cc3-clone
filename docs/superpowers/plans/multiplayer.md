# Multiplayer plan: peer lockstep vs authoritative server

Status: planning only (backlog items 011–013). Written 2026-09-25 against `origin/main` at 3843bb5.
No game code has been changed for this document.

The request: plan multiplayer for two architectures.

1. Two local games connect to each other over the internet.
2. The game runs on a server; each player connects to it.

This document evaluates both against the actual code, lists what breaks and what already works,
compares them, recommends one, and lays out phased milestones. Each milestone has a completion
criterion and a rough size. The **Decisions for the user** section lists the choices only the user can make.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks, **XL** > 2 weeks. The estimates assume the
agent-assisted pace of recent backlog items and are rough.

---

## 1. What the codebase gives us today

**The sim is headless and single-threaded.** Every file in `src/sim/*` imports only `@/shared/*`,
`@/data/*` and other sim modules. There is no DOM, `window`, `localStorage` or canvas. Vitest runs
with `environment: 'node'` (`vite.config.ts:6`), and 88 test files drive `Battle` directly. The full
sim already runs under Node, so a server or replay runner needs no extraction work.

**Fixed-step and seeded.** `SIM_DT = 0.1` s (10 Hz, `src/shared/types.ts:19`). `Battle.step(dt)`
accumulates frame time and runs whole `subStep(SIM_DT)` ticks (`src/sim/battle.ts:140-147`). All sim
randomness flows through one `Rng` (mulberry32, `src/shared/rng.ts`) owned by `Battle`
(`battle.ts:43,50`). The only `Math.random` calls are in audio (`src/audio/synth.ts:23`,
`src/audio/sfx.ts:129,130,375,399,400,420`). The only wall-clock reads are in UI, render and audio
code (`src/ui/screens/battle.ts:413,538,559,615,725`, `src/render/unitRender.ts:802`,
`src/render/visibilityOverlay.ts`, `src/render/terrainRender.ts:3179,3581`, `src/engine/loop.ts:2`).
Wall-clock seeds are chosen in the UI (`src/ui/screens/operation.ts:183`,
`src/ui/screens/battleSetup.ts:163`), which is fine because the host can choose and share the seed.

**Determinism is tested, but only in one process.** `test/harness.test.ts:469-500` runs the same
seed twice in one process and compares results. It does not prove cross-process, cross-browser or
snapshot-restore determinism.

**Orders are few and already data.** The UI mutates the battle through a small surface:

| Call site | What it does |
|---|---|
| `Battle.issueOrder(teamId, Order)` (`battle.ts:218`), from `ui/screens/battle.ts:222` and `ui/screens/deploy.ts:82` | Applies immediately via `applyOrder(..., this.rng)` (`sim/orders.ts:468`). This consumes RNG (`orders.ts:51-52,298`), so the tick at which an order lands changes the random stream. |
| `Battle.deployTeam` (`battle.ts:236`) | Places a team during deployment. |
| `Battle.offerTruce(side)` (`battle.ts:259`) | Offers or withdraws a truce. |
| `flee(state, side)`, called directly from `ui/screens/battle.ts:562` | Mutates the state without going through `Battle`. |
| `battle.pause/resume/start`, plus `game.settings.speed` (`ui/screens/battle.ts:241,591-596`) | Pause and speed are UI-local. |

`Order` (`types.ts:773`) is plain JSON: a type, `Vec2` values, ids and a time. That makes it a
natural wire format.

**Fog of war is a render-time filter over full truth.** `BattleState.spotted` and `spottedVehicles`
(`types.ts:1084-1085`) are computed for both sides. Eight render and UI modules consult them
(`unitRender`, `effects`, `grassFx`, `orderMarkers`, `visibilityOverlay`, `minimap`, `targetHover`,
`overview`), and the full state always sits in client memory.

**The sim assumes one human side.** `config.playerSide` / `aiBothSides` (`types.ts:1060-1071`)
control:

- which side the AI plays (`battle.ts:88,180-184`)
- truce acceptance (`battle.ts:275-287`)
- victory and result perspective (`sim/victory.ts:63,112,148`)
- about 30 message-gating sites (for example `morale.ts:137,201,351`, `combat.ts:441`,
  `vehicleDamage.ts:168,525,533,553,568,645`, `structures.ts:390,431,498,511`, `pickup.ts:277`,
  `crewWeapon.ts:566,583,675,812,900`, `mind.ts:134`, `coverSeek.ts:93`, `medic.ts:140,147,167`)

All of these gate messages or perspective, not physics. I checked every hit, and none changes
gameplay.

### Measured size and cost (seed 3, AI vs AI, 600 sim-seconds per map, this dev machine)

| Map | Size (tiles) | Soldiers | Vehicles | Teams | Sim cost (ms per sim-second) | JSON state without static map |
|---|---|---|---|---|---|---|
| border_1941 | 200×150 | 109 | 6 | 21 | 27 | 226 KB |
| village_1942 | 220×160 | 130 | 7 | 25 | 49 | 264 KB |
| steppe_1943 | 240×170 | 135 | 8 | 26 | 54 | 356 KB |
| forest_1944 | 200×160 | 103 | 5 | 21 | 45 | 279 KB |
| berlin_1945 | 220×160 | 109 | 4 | 21 | 23 | 180 KB |
| moscow_1941 | 200×150 | 109 | 6 | 21 | 74 (battle ended at 251 s) | 251 KB |

- A soldier serializes to about 1.4–1.7 KB of JSON, a vehicle to 0.9–1.2 KB, and a team to about 0.55 KB.
- Peak transient lists on steppe: 46 tracers, 14 flashes, 31 explosions, 161 sparks, 150 ground
  items, 177 debris and 214 blood decals.
- Events average 0.2–0.7 per tick, with a peak of 26.
- The map also carries per-tile typed arrays (`buildingId`, `windows`, `smoke`, `ground`,
  `groundSteep`, each w×h) plus mutable `craters`, `craterMarks` and `dirtyTiles`.

Measurement script: `measure.ts` in the session scratchpad, run with `npx vite-node --root .`.
It is not committed.

---

## 2. Determinism blockers and hazards (found by grep and reading)

Lockstep (option 1) requires that every client computes bit-identical state from the same seed and
command stream. Option 2 does not require this, except for replays. The items below are ordered by severity.

| # | Where | Problem | Fix | Size |
|---|---|---|---|---|
| D1 | `src/sim/vehicleExplosion.ts:198` (`leaveCrater` without the `applyBlastDamage` that follows it at `combat.ts:592-594`). The render and UI also call `syncCraterMarks` at `src/render/depthOverlay.ts:187` and `src/ui/elevationReadout.ts:22`. | A vehicle-explosion crater mark stays unapplied to the height field until the sim's next HE blast (`structures.ts:176`). If one player has the depth map or elevation readout open, the renderer applies it early. LOS and cover then read a different height field on that client, which is a **real desync**. | Call `syncCraterMarks` inside `leaveCrater` (sim-side, always). Make the render callers read-only. | S |
| D2 | `src/render/unitRender.ts:735-741` | While drawing crew weapons, the renderer rewrites `state.flashes[].pos/facing`, `state.tracers[].from` and `state.projectiles[].from` to snap them to the muzzle. How often this runs depends on frame rate. The sim reads `tracer.from` for `t === 0` tracers (`structures.ts:163-167`), which render never sees today, so it is harmless now but fragile. It would also break any state hash that includes effects. | Keep the muzzle snap as a render-local offset, or move it into the sim where the flash, tracer or projectile is created. Rule: render never writes to `BattleState`. | S |
| D3 | `src/ui/screens/battle.ts:432,434,448,565,603`, `ui/screens/deploy.ts:223,229` call `addMessage(state, …)`. `sim/combat.ts:452-466` reads `state.messages.includes(prev.msg)`, and `battle.ts:189` trims the list to 200. | UI-only messages (speed, overlay toggles, control groups, "Flee?") go into sim state and change when sim-side kill reports stop coalescing. The effect is limited to message text, but it diverges between clients. | Move messages to a per-viewer log (`messages` tagged by side), keep UI notices in a HUD-local list, and exclude messages from the hash. | S (part of 011) |
| D4 | `battle.ts:218-222` (`issueOrder` applies immediately, consuming RNG) and `battle.ts:140-147` (frame-driven accumulator, `loop.ts:4` clamps dt to 0.1 s) | Orders land at whatever frame the click happens, so the RNG stream depends on local frame timing. | Queue commands per tick and apply them at the start of `subStep` in a canonical order (tick, side, sequence). Add `advanceTick()` for lockstep. Single-player uses the same queue with zero delay. | M (part of 012) |
| D5 | Transcendental math in the sim: 149 calls to `Math.sin/cos/atan2/exp/pow/log/hypot/…` across 30 files (heaviest: `mapdsl.ts` 29, `ai.ts` 20, `spawn.ts` 12, `combat.ts` 11, `vehicle.ts` 10), plus `Rng.gauss` (`rng.ts:17`) | ECMAScript leaves these implementation-approximated. V8 (Chrome, Edge, Node) and SpiderMonkey both use fdlibm ports. JavaScriptCore (Safari) uses the system libm, so results can differ in the last bit, and chaotic sim feedback amplifies that into a desync. `+ − × ÷ sqrt` and `Math.fround` are exact IEEE and safe. **Unknown until measured.** | Measure first (P5). If engines disagree, add `src/shared/dmath.ts` (a pure-TS fdlibm port of about 400 lines), route the sim through it, and add a lint/grep test that bans `Math.<transcendental>` under `src/sim`. | S to measure; L if a port is needed |
| D6 | About 45 module-level `WeakMap`/`Map` side-state stores in the sim, for example `ai.ts:284,285,315,832`, `mind.ts:105`, `morale.ts:32`, `combat.ts:75,194,452,1334,1745`, `orders.ts:94,97,126,179,449`, `vehicle.ts:46,119,217,480,514,586,844-851`, `medic.ts:41-44`, `items.ts:128`, `pickup.ts:51`, `trees.ts:59,75`, `structures.ts:96`, `growth.ts:34`, `infantryAim.ts:11`, `hastyFire.ts:22`, `heightField.ts:68`, `coverSeek.ts:91`, `aimPoint.ts:63`. `path.ts:95-100` also has module scratch buffers. | These are deterministic, because they are keyed per battle or object and filled in sim order, so **they do not break lockstep**. They do make `BattleState` non-serializable. Snapshots, save games, mid-battle join and "resync from the host" cannot capture them, and a state hash over `BattleState` alone misses divergence hiding in them. `orders.ts:94,97,126` key by object identity (`Order`, `Vec2[]`), so a deserialized order silently loses its side-state. | For lockstep, do nothing now: resync by replaying from tick 0 (see M5). Migrating them into serializable state is XL and only needed for true snapshot save/load. | XL (deferred) |
| D7 | `Rng.s` is private (`rng.ts:3`) | A state hash cannot include the RNG position, which is the cheapest and strongest desync detector. | Add `Rng.state()` and `Rng.setState()`. | S |
| D8 | `Battle` constructor always runs `aiDeploy` for the non-player side (`battle.ts:88-89`), consuming RNG | With two human sides, both clients must agree that neither side is AI-deployed. | This comes for free once `controllers` replaces `playerSide` (011). | — |

**Checked and safe:**

- Map and Set iteration follows insertion order by specification, and both clients insert in the same order.
- `Array.prototype.sort` is stable by specification. The 26 sorts in the sim have tie-breaks or
  stable inputs. The comparators at `combat.ts:363` and `vehicle.ts:250` have no tie-break but sort
  identical input arrays.
- `hash2` (`rng.ts:21`) is pure integer math.
- `state.time` is rounded to milliseconds (`battle.ts:152`).
- JS engines do not fuse multiply-add.
- `trees.ts:226 fireWeapon` is a constant cache, and `orders.ts:450 releasingDelayed` is a re-entrancy flag.
- Render-only randomness and time (`unitRender.ts:802` shimmer, `sfx.ts`) are harmless.

---

## 3. Option 1: two browsers in deterministic lockstep

**Model.** Both clients run the whole sim. They exchange **commands** (orders, deploy moves, truce,
flee, pause and speed requests, ready flags), not state. A command issued at local tick T is scheduled
for tick T + D (input delay), and tick T + D runs only when both peers' command bundles for it have
arrived. An empty bundle is the heartbeat. The per-tick upload is a few bytes (plus about 60–200 bytes
per order), so the traffic is effectively zero.

**Why lockstep and not state sync between browsers.** State sync would need a serializable state
(blocked by D6), would ship 180–356 KB of JSON state at 10 Hz, and would still leak fog of war. It
combines the costs of option 2 with none of its benefits.

**Input delay and feel.** At 10 Hz, D = 3 ticks gives 300 ms of scheduling delay, which covers about
200 ms RTT plus jitter. The game already hides that much latency on purpose: a leader's shouted
confirmation takes `ORDER_SHOUT_CONFIRM_S = 0.8` s (`battle.ts:39`), and `canObey` adds 1–3 s of
hesitation for shaken men (`orders.ts:34-52`). The local UI shows the order marker immediately in its
existing "ghosted until the shout lands" state, so the player never sees the lockstep delay. D can
adapt to measured RTT, but only changes through a scheduled command.

**Transport for a static site.** A static host cannot accept connections, so something must
rendezvous the two browsers.

- **1a. WebSocket relay.** A tiny server holds rooms keyed by a code and forwards bundles. It has no
  NAT problems at all. It needs about 150–250 lines of Node, or a Cloudflare Worker with a Durable
  Object per room. Latency is one extra hop, which the input delay absorbs. The server never runs the
  sim.
- **1b. WebRTC data channel.** Use an unordered-but-reliable or ordered-reliable channel. The relay
  above doubles as the signaling server, with public STUN. Direct P2P works for most home
  connections. Symmetric or carrier-grade NATs (commonly cited at about 10–20% of pairs) need a TURN
  server, and TURN is paid (Cloudflare, Twilio or metered.ca TURN, billed per GB). With traffic this
  small, cost is negligible, but it adds another service and credentials to manage. Hosted signaling
  such as the PeerJS cloud is free but unreliable.

Recommendation: ship 1a first. Add 1b only if the relay's extra hop is ever noticeable, which is
unlikely at a 300 ms input delay.

**Desync detection.** Every 10 ticks, each peer sends `hash(rng.state, time, nextId, per-soldier
quantized pos/health/activity/ammo, per-vehicle pos/hull/damage, VL owners, side scores)`. This is
FNV/xxhash over integers and costs about 0.1 ms. On a mismatch, freeze, show "Desync at tick N", and
save both peers' command logs plus hash chains for offline reproduction in Node (P4 replay runner).
Because D6 state is outside the hash, the RNG position is the key signal: nearly any divergent branch
changes how many draws are consumed.

**Disconnects and host migration.** Lockstep has no host during the battle, since both peers are
equal and the relay only forwards. On a missing bundle, the waiting peer stalls and shows "Waiting
for opponent (Ns)". After a timeout it can:

- end the battle as a forfeit, or
- issue a scheduled **controller change** command, `{side, controller: 'ai'}`.

AI takeover is deterministic because `stepAI` already runs inside the sim on both machines, so the
remaining player can finish against the AI. **Rejoin** uses the relay's retained seed, config and
full command log. The returning client fast-forwards from tick 0 (see M5).

**Pause and speed.**

- Speed becomes a scheduled command. Proposed policy: either player may lower it, and raising it
  needs both players.
- A slower CPU stalls both players: a 4× speed costs up to about 300 ms of CPU per wall-second on the
  measured maps.
- Pause is a scheduled command, with a per-player budget (for example 3 pauses of up to 60 s) so it
  cannot be used as a stall weapon.
- Orders while paused: CC3 forbids them. Keep that rule, because it simplifies lockstep.

**Cheating.** Both clients hold the entire truth, so a map hack is trivial: open devtools and read
`game.battle.state.soldiers`. It cannot be prevented, only obscured. The other cheats are prevented
cheaply:

- Forged orders for enemy teams: every client rejects a command whose team side does not match the
  sender's side. The rejection is deterministic, so both clients agree.
- Speed hacks: impossible in lockstep.
- Result tampering: a lie shows up as a desync.

For friends-only play this is the standard RTS trade-off (Age of Empires, StarCraft 1 and the original
CC3 are all lockstep with full client state).

**Replays and spectating come almost free.** A replay is `{buildVersion, config, seed, commands[]}`,
a few KB per battle. A spectator is a receive-only peer that is not in the tick-gating set, lagging a
few seconds behind, with an unfiltered or chosen-side view.

**Pre-battle sync.** Both clients must build an identical `Battle`:

- same build (exchange a version hash at join)
- same `BattleConfig`: map, year, seed, difficulty, `forces` per side, `controllers`
- no local AI deploy for human sides

Force selection runs in each player's own `forcePicker` and is exchanged before the battle is
constructed. The host picks the seed. Commit-reveal between the two peers is optional and only
matters for ranked play.

The deploy phase becomes lockstep too: `deployTeam` and default orders become commands, and the
battle starts on the tick after both "ready" commands. Each player's deploy screen shows only their
own zone, but the opponent's client knows the placements (the same accepted leak as above).

**Operations and campaigns** (`OperationState`) are out of scope for v1. Offer single battles only.

---

## 4. Option 2: authoritative server

**Model.** A Node process owns `Battle` and ticks it at 10 Hz on a wall-clock scheduler. Clients send
the same commands as in option 1. Each tick (or every second tick), the server sends each client a
**per-side view**: own units in full detail, enemy units only where `spotted[side]` holds, and
events filtered by what that side can see or hear. This gives true fog-of-war protection, and a
cheater can only automate their own clicks.

**What already works.** The sim runs headless under Node today; 88 vitest files run it there. The
server needs no determinism (the sim just runs), so D5 is irrelevant for play. D1–D4 are still worth
fixing for replays. A server can keep a replay as the command log, since it is also deterministic
against itself.

**What must change: the client stops owning a `Battle`.** This is the expensive part:

- **View protocol.** Define `SideView`: soldiers (id, quantized pos, heading, posture, activity,
  health, weapon/aim/fire state, carried kit, and for own men morale, ammo, stress and similar), vehicles
  (pos, hull and turret heading, damage view, crew hatches), teams, VLs, side scores, visible map
  changes (craters, rubble and breaches, `dirtyTiles`, smoke density, tree fires), and events.
  Render and UI read about **76 distinct soldier fields and about 50 vehicle fields** across about
  16k lines. Each needed field must be put on the wire or re-derived. Size: L.
- **Render-side helpers that read hidden sim state.** The renderer calls sim helpers backed by D6
  side-state or the full map: `getGrowth` (`sim/growth.ts:34` WeakMap), `treeFires` (`trees.ts:59`),
  `crewWeaponView`, `vehicleDamageView`, `getHeightField` plus `syncCraterMarks`, `losTrace` and
  `hasLineOfFire` (LOS tool, vision overlay, target hover), `penRating` and `teamPenetrationChance`,
  and `spottedEnemyTeamAt`. Each needs a client-side substitute fed by the view, or a server query.
  The vision overlay and LOS tool can keep running locally on the static map plus replicated craters
  and rubble. Size: L.
- **Client "remote battle" facade.** Build a `BattleState`-shaped object from views so the existing
  renderer keeps working, rather than rewriting 16k lines, plus snapshot interpolation (render about
  100–150 ms in the past between two received ticks). Visual-only transients (tracers, flashes,
  sparks, debris, blood) should be sent as events and simulated client-side, not replicated as state.
  Size: L–XL.
- **Server.** Room and lobby, tick scheduler, per-side projection, a WebSocket per client, reconnect
  (send a fresh full view, which is trivial here), and a process supervisor. Size: M–L.

**Bandwidth estimate.** Naively shipping full state is 180–356 KB × 10 Hz, about 2–3.5 MB/s per
client, which is unusable. A binary view with quantized positions costs about 40 B per visible soldier
and about 60 B per vehicle. That is about 135 × 40 + 8 × 60 ≈ 6 KB raw per tick at full visibility.
Delta-coding against the last acknowledged tick (most men are stationary) reduces it to about 1.5–3 KB.
Adding events and own-team detail at 2 Hz gives **about 20–40 KB/s down per client (160–320 kbit/s)**
and under 1 KB/s up. A 20-minute battle is about 25–50 MB per player. Hosting egress is negligible.

**Server cost.** The sim measured 23–74 ms of CPU per sim-second on this machine, which is 2–7% of a
core per battle at 1×. Allow about 2× for a slower VPS core, plus projection and serialization. A €5–10
per month 2-vCPU VPS (Hetzner, Fly.io or similar) would then host roughly 10–30 concurrent battles.
AI replans (every 5 s, `AI_INTERVAL`) and spotting (every 0.5 s) create tick spikes, so the scheduler
must tolerate a late tick. The ops burden is the real cost:

- a long-running process to deploy, monitor and restart
- a TLS certificate
- region choice (one EU box gives US and Asia players 100–250 ms RTT)
- version skew between server and cached clients

**Latency feel.** From click to seeing the first movement: RTT/2 upstream, up to 100 ms waiting for
the tick, RTT/2 downstream, plus a 100–150 ms interpolation buffer. That totals about 250–400 ms at
100 ms RTT, which is about the same as lockstep at D = 3. As with lockstep, the 0.8 s shout masks it,
and the local marker can appear ghosted immediately.

**Single-player.** It keeps the local `Battle` exactly as now. The facade is used only for remote
play, which creates two client code paths (local truth and remote view) that must render the same.
This is a long-term maintenance tax: every future sim feature that the renderer reads must also be
added to the view protocol.

---

## 5. Comparison

| | Option 1: lockstep (relay, optionally WebRTC) | Option 2: authoritative server |
|---|---|---|
| Total effort | About 5–7 weeks including prerequisites | About 9–14 weeks including prerequisites |
| Determinism work | Required: D1–D5 and a hash, plus cross-browser verification (D5 is the one unknown) | Only for replays; play does not need it |
| Fog of war and cheat resistance | Map hack possible (full state in memory); forged orders, speed hacks and result tampering prevented | Strong: clients only see their side's view |
| Hosting and ops | A stateless relay (Worker/Durable Object free tier or a €5 VPS); no sim on the server | A stateful sim server; €5–10 per month per 10–30 battles; deploys, monitoring and regions |
| Latency | 300 ms input delay, masked by the 0.8 s shout; a slow or laggy peer stalls both | About 250–400 ms, masked the same way; a slow client affects only itself |
| NAT problems | None with the relay; with WebRTC, TURN is needed for about 10–20% of pairs | None (clients connect out to the server) |
| Replay and spectate | Free (command log); spectators see everything | Needs the command log on the server, or recorded views; spectators easy and fog-correct |
| Reconnect | Fast-forward from tick 0 (about 30–90 s on a 20-minute battle) | Instant (fresh view) |
| Code changes | The sim plus a thin net layer; the renderer is untouched | New view protocol, client facade, and substitutes for sim helpers; renderer coupling grows |
| Single-player impact | Same code path (commands with zero delay), gains replays | Two render paths to keep in sync forever |
| Co-op against the AI | Free (the AI runs deterministically on both clients) | Free (the AI runs on the server) |
| Ranked or public matchmaking | Weak (map hack) | Suitable |

---

## 6. Recommendation

**Build option 1: deterministic lockstep over a WebSocket relay**, and structure the prerequisites so
that option 2 stays possible later.

Reasons:

- The sim is already 90% of the way there: one seeded RNG, fixed ticks, a headless design, plain-data
  orders, and a same-process determinism test.
- The latency cost is hidden by the game's own order-shout delay.
- The renderer (16k lines reading full `BattleState`) stays untouched, whereas option 2 needs a
  permanent second, view-based render path.
- The relay is stateless and nearly free to host, which fits a static site.
- Replays fall out of it and benefit single-player too.

The price is that fog of war is not cheat-proof, which is acceptable for playing with friends and is
how CC3 itself worked. If ranked or public matchmaking becomes a goal, option 2 reuses the command
layer (P1) and the side-controller refactor (P2), and a server can run the same deterministic sim as
a third lockstep referee. That hybrid validates results but still does not hide fog.

---

## 7. Phased plan

### Phase P: prerequisites that help both options (backlog 011 = P1–P2, 012 = P3–P5)

- **P1. Command layer and tick queue (011, size M).** Add `type Command = order | deployTeam |
  offerTruce | flee | setSpeed | pause | resume | ready | setController`, and
  `Battle.submit(cmd, side, applyAtTick?)`. Commands are applied at the start of `subStep` in the
  order (tick, side, sequence). The UI never calls `issueOrder`, `flee` or `deployTeam` directly.
  Single-player uses delay 0.
  *Done when:* a grep shows no UI or render call into sim mutators other than `submit`
  (`flee(state…)` and `issueOrder` are gone from `src/ui`), the full test suite passes, and
  single-player plays the same.
- **P2. Side controllers and per-side perspective (011, size M).** Replace `playerSide` and
  `aiBothSides` in the sim with `controllers: Record<Side, 'human' | 'ai'>`. The local viewer's side
  becomes UI state. Messages carry a `side` tag, UI notices move to a HUD list, results are computed
  per side, and a truce with two humans needs both offers. All call sites are in §1.
  *Done when:* a test battle with two human sides runs with no AI orders issued; the German and Soviet
  message logs each contain only their own side's reports; the debrief grades each side from its own
  perspective; and the harness still passes with both sides on AI.
- **P3. Determinism fixes (012, size S).** Fix D1 (sync craters in the sim), D2 (render never writes
  state), D3 (via P2) and D7 (`Rng.state()`). Add a regression test that runs the depth-overlay and
  elevation-readout sync mid-battle and asserts an unchanged hash chain.
- **P4. State hash, command log and replay runner (012, size M).** Add
  `hashState(battle): number` (§3) and `ReplayLog`. Add a Node runner that replays a log and prints
  the hash chain. Single-player records every battle, and the debrief offers "Save replay (.json)" and
  "Watch replay".
  *Done when:* a scripted single-player battle, re-run from its log in a separate Node process (a
  fresh module graph, not the same process), produces an identical hash chain at every tick; and the
  harness determinism test also compares hash chains.
- **P5. Cross-engine check (012, size S; a follow-up L if it fails).** Add `tools/determinism.html`,
  which runs every map for 10 sim-minutes AI vs AI and prints the hash chain. Run it in Chrome,
  Firefox, Safari and Node.
  *Done when:* all four engines produce identical chains for 5 maps × 2 seeds, or a divergence is
  found. In that case, `src/shared/dmath.ts` replaces all 149 transcendental call sites in `src/sim`,
  a test bans `Math.(sin|cos|tan|atan2|asin|acos|exp|log|pow|hypot|cbrt)` under `src/sim`, and the
  check is re-run until it passes.

### Phase M: lockstep multiplayer (013; each milestone is a separate commit and verification)

- **M1. Lockstep session over an abstract transport (M).** Add `LockstepSession` with input delay D,
  bundle and ack handling, stall and resume, a hash exchange every 10 ticks, and desync capture.
  *Done when:* a vitest runs two sessions over an in-memory transport with random 20–300 ms delay,
  jitter and reordering, driven by scripted commands for 10 minutes, and gets identical hash chains
  with no stall longer than the delay budget.
- **M2. Relay server and browser transport (M).** Add `server/relay.ts` (Node `ws`, dev dependency
  only), or a Worker/Durable Object, with rooms by six-character code, version check and
  command-log retention.
  *Done when:* two browsers on different networks complete a 10-minute battle through the deployed
  relay with no desync, and a desync report can be reproduced offline with the P4 runner.
- **M3. Lobby and pre-battle (L).** Create or join by code; choose side, map, year and speed policy;
  pick forces per side; exchange the version and config; run the lockstep deploy phase with ready
  handshake.
  *Done when:* two players each choose their own forces, deploy only in their own zone, and start on
  the same tick with matching hashes; and a mismatched build is refused with a clear message.
- **M4. Multiplayer battle rules and user experience (L).** Add speed and pause commands with
  budgets, two-human truce, flee as a command, and a "Waiting for opponent" overlay. After a timeout,
  offer AI takeover or forfeit. Add the desync overlay with a log download.
  *Done when:* each rule has a test at the session level, and a browser check covers pause, speed
  change, truce and a pulled-cable disconnect followed by AI takeover.
- **M5. Rejoin and spectate (M).** A reconnecting client downloads the relay's command log and
  fast-forwards with a progress bar (measured 23–74 ms per sim-second, so 30–90 s for a 20-minute
  battle on this machine). A spectator joins read-only.
  *Done when:* a client that reloads its tab at minute 10 re-enters the same battle with a matching
  hash; and a spectator follows a live battle.
- **M6 (optional). WebRTC P2P (M).** Use a data channel with the relay as signaling and fallback.
  *Done when:* two peers connect directly and the relay carries only signaling, and the game falls
  back to the relay when ICE fails.

**Total:** P ≈ 1.5–2.5 weeks (plus L if D5 fails), and M1–M5 ≈ 4–5 weeks.

---

## 8. Decisions for the user

1. **Mode:** 1v1 only, or also co-op (two humans against the AI, or 2v2)? Lockstep handles co-op
   naturally, but 2v2 needs per-player team ownership within one side.
2. **Should the AI side stay available in multiplayer** (co-op against the AI, AI takeover on
   disconnect)? Recommended: yes.
3. **Lobby:** room codes shared out of band (recommended for v1), or a public lobby, matchmaking or
   ranking? Ranked play argues for option 2.
4. **Hosting:** where the relay lives and who pays and operates it (Cloudflare free tier or a €5 VPS),
   and where the static site is hosted (none is configured in the repository today).
5. **Map-hack tolerance:** is visible-to-devtools fog acceptable for friends play? If not, option 2
   is the only answer.
6. **Speed and pause policy** in multiplayer: fixed 1×, or agreed speed-ups? Pause budget?
7. **Browser support:** is Safari required? This decides whether a failure in P5 forces the dmath port.
8. **Scope:** single battles only in v1; operations and campaigns later or never?

## 9. Known unknowns

- Whether the transcendental math in V8, SpiderMonkey and JavaScriptCore agrees bit for bit on our
  call mix (P5 answers this).
- Whether 4× speed stays smooth on low-end laptops. Lockstep runs at the pace of the slower machine.
- Whether a hash over `BattleState` fields catches divergence early enough, given that the D6
  side-state is unhashed. The RNG position should compensate; P4 and M1 tests will show.
- Whether the WebRTC TURN share is as small as commonly quoted for our players; this is moot with the relay.
