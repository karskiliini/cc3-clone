# Online multiplayer 044/047b — implementation evidence

- Final production build and TypeScript check pass. Nine focused relay/policy tests
  pass, including damaged N / valid N+1 / repaired N; failed history replay after
  real progress; unchanged previous battle and reproducible AI continuation; no
  progress timeout. Original 43 network tests pass (32 lockstep, four integrity, four policy,
  three relay), including 10 sim-minutes,
  packet loss/reordering, repeated resync, hostile messages and speed handling.
- `browser.json`: two independent Chromium contexts at 1024×768 and 1280×720,
  real lobby/force picker/deploy drag/Begin, owner-only pause, shared speed votes,
  page reload/rejoin, visible resync/rebuilt battle, recovered report download,
  three failed corrections/report/actions, local AI and forfeit. No page errors.
  Final downloaded replay matches its recorded final hash (73 ticks, 13 commands).
- `mac.json` and `mini.json`: separate M5 and M2 hosts over real LAN WebSockets,
  120 ticks each, all 12 common checkpoints identical; deliberate 1 mm corruption
  recovered on both. Build `6e36286645b035fca07ca7e7cff287d2070ec703acc14bee8ca4bb6f491add4c`.
- Screenshots inspected after shortening overflowing action labels. Primary browser
  check uses default graphics without video: forced SwiftShader plus recording
  stalled frame delivery in headless Chromium 1228/1248. This is recorded as test
  environment evidence, not a proven game scheduling bug or a performance fix.
- Both owned relay servers and all owned browser contexts stopped after testing.
  No unrelated Mac mini services stopped. Tests/build ran nice 19, one worker.

## Boundaries

Public deployment is left to the user under the existing backlog default; this is
LAN evidence, not a claim of different-network Internet or hosted full-battle proof.
Firefox/Safari online verification and public-host soak remain external checks.
True nondeterminism after three replays ends with recovery actions; arbitrary host
snapshot transfer remains explicitly conditional future scope under 047b.

## Dependency evidence

Pinned runtime `ws@8.22.1`, dev `@types/ws@8.18.2`, explicit existing esbuild version
0.25.12. `npm audit --omit=dev` reported zero runtime known vulnerabilities at this
stage. The Endor dependency-reviewer exact package lookup was attempted once but
this installed endorctl rejects its documented `agent` command. Endor package-risk
posture is UNKNOWN; no Endor safety approval is claimed. The full existing dev
lockfile audit has seven findings (three moderate, two high, two critical); no
unrelated forced dependency upgrades were made.
