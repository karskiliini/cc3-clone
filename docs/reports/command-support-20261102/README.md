# Battle plans, radio traffic and indirect-fire timing

2026-11-02. Implements the 13:15 request's tactical scope from 068–070.

## Player behavior

During deployment, open **BATTLE PLAN**, choose NOW, Signal 1/2/3 or H-hour,
select teams and issue ordinary map orders. A team can have several advance
orders with different triggers. The review shows only the player's plan;
**All** removes that team's scheduled entries. H-hour is battle seconds after
Begin, not wall-clock time. Timing is bounded by the battle duration.

In battle, the three Signal buttons use an operational HQ radio. Friendly
activation needs actual reception; a missed signal does not arrive later after
reconnection. Activation executes the previously briefed order without
retransmitting its secret meaning. Each signal/action executes once. H-hour
orders do not need a fresh radio message. Temporarily unconscious leaders wait
until capable of executing their received timed plan.

**ARTY / Shift+B** selects an area; SMALL/LARGE chooses mission size. Plain B
retains Smoke. Battery stock, queue, status and Cancel fire are visible. Four
guns and 48 shells per side are standalone defaults; authored config can limit
or disable support. Small missions use one round per gun; large missions reserve
at least 12 and normally six rounds per gun. Reservations are not spent shells.

The **Radio** panel shows actual opposing emissions immediately, equally for both
sides. Signals expose their identifier only; ordinary radio payloads and fire
calls expose transmitted text/target coordinates. They do not expose private
plans, caller positions or guaranteed impact times. Voice/intercom/couriers do
not fabricate radio emissions. Troops retain individual knowledge constraints.
Enemy fire-call coordinates also produce an amber map marker, aged for at most
60 seconds and removed by an intercepted cancellation. Clicking a radio target
row centers the camera without revealing unseen terrain or troops.

## Timing and conservation

Explicit gameplay calibration, not claimed exact national historical timings:

| System | First preparation | Valid repeat preparation | Additional constraints |
|---|---:|---:|---|
| Mortar | 30 s | 10 s | Existing setup, laying, loading and flight |
| Rocket | 60 s | 20 s | Existing setup, loading and flight |
| Off-map battery | 60 s | 20 s | 2 s message, queue, 6 s loading, 22 s flight |

Off-map small/large missions impose 15/180 s battery service after firing.
Cancellation also needs 2 s transmission/delivery and returns only unfired
reservations. Airborne shells still hit, with actual terrain/building/infantry/
vehicle effects and friendly damage. Received queued instructions survive later
HQ loss; a request lost before receipt does not become accepted.

Keep up to 16 fired target solutions per team/battery. Validity is 600 s,
within 10 m of the registered aim, with matching weapon and conditions. On-map
weapons must also remain within 2 m of their firing origin. A→B→A retains A's
benefit. Data are recorded only on actual launch. Repeats never bypass queues,
crew service, ammunition or projectile travel.

Existing sequential campaigns initialize a finite 96-shell pool per side and
assign at most 48 per battle without spending them at assignment. Debrief
deducts actual launches exactly once using a saved battle key. Unfired/cancelled
reservations remain available; no daily refill is invented.

Historical structural reference: the original US War Department
[FM 6-20, Tactical Employment, 1944](https://www.ibiblio.org/hyperwar/USA/ref/FM/PDFs/FM6-20.PDF)
distinguishes prearranged fires/signals and registration. It does not establish
the numerical game defaults above. Universal instant enemy reception is the
user's selected gameplay rule.

## Verification

- Focused Mac mini snapshot: 43 tests passed across six files; TypeScript passed.
- Real Chromium canvas clicks exercised deployment planning/review, Signal 1
  movement, H+60 activation, opposing signal/fire intercepts, artillery targeting,
  actual airborne shells, eight field-artillery impacts and cancellation.
  `result.json` passed with no page errors; screenshots are alongside this report.
- Node, Chromium and WebKit: all 1,600 per-tick hashes, public traffic, missions,
  plans and replay results match byte-for-byte; eight actual impacts. Final and
  replay hash: `905962572`. SHA-256 of each trace JSON:
  `0e425a114b69d21fb9b212cf4b3abc3b6b49bacd58ceb37ec3dd9ccb7b21b919`.
  A short local M5 Node run has the identical JSON digest as the Mini M2 run.
- File-by-file union of isolated broad, remaining and final focused snapshots:
  **1,976 passed, zero failed, seven skipped across 218 test files**. See
  `verification.json` for each file's actual supplying log. This is not a claim
  that one uninterrupted full-suite invocation completed. Initial rocket tests
  still expected launches before the new preparation interval; corrected full
  `hullArmor`/`rockets` files passed (20/6), retaining real launch/trajectory,
  salvo, reload and rocking assertions. Final affected suite: **55 passed**.
- Seven skips comprise two pre-existing skips plus three full-force viewer-chain
  and two full-force corrupt-packet soaks. The separate old 32-case full-size
  `lockstep.test.ts` soak was excluded. Long attempts were stopped, not reported
  passing. New actual two-peer command-support desync/rebuild, live relay command
  validation, production viewer-side parity, 1,600-tick cross-engine/replay traces
  and the legacy math/CRC/transport unit cases pass.
- Final TypeScript/production build passed. Vite's existing large-chunk warning
  remains. Simulation fingerprint matches local M5 and Mini source snapshots:
  `79cde46070ba6161dddbb2eb012c158d96ee53e3fc0d4536dca1fd54e94d057f`.

Browser/parity scripts close their own Vite servers (ports 5202/5203). All heavy
runs use isolated source snapshots on the user's Mac mini. Source, tests and
tools only are transferred; credentials and environment secrets are excluded.
The final test snapshot reuses unchanged CC3 assets and installed dependencies.

## Scope remaining

The larger 053 operational grand map and its geographic battery allocations,
full company-command hierarchy/attachments, moving physical couriers and
recognized command flares are not implemented by this tactical change. They
remain separate queued work rather than being reported complete. New 071
tracks physical field telephones, cuttable surface wire and protected urban
underground connections; no telephone implementation is included here.

Reproduce: `node tools/battlePlanBrowserCheck.mjs` and
`node tools/runCommandSupportChecks.mjs`, with `CC3_PLAYWRIGHT_MODULE` pointing
to an installed Playwright module when it is not in the project dependencies.
