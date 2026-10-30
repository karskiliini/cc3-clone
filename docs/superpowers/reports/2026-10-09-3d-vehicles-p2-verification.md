# P2 physical determinism and performance verification — 2026-10-30

Status: this verification pass is complete; P2 acceptance remains open for the explicit unmet gates below. Branch `codex/vehicles-3d-p2`, starting revision `345fe3038805a001f99bd3ff727f5f61c4fd7f6b`. Implementation commits: `c97788a` (canonical state/hash and numerical optimizations), `8d74ea4` (initial overlap and sweep robustness).

## Implementation

Physical driver observations, near-miss/cover hysteresis, reversing and turn memory now live on vehicles; soldier vehicle-wait/dodge timing lives on soldiers. Terrain restoration retains scalar overrides, temporary profiles, direct crater history and original building envelopes. Reattaching a copied height field preserves its actual samples and revision. Refreshing terrain still replaces temporary profiles, as before.

The hash includes exact body numbers, flags and suspension entries, driver memory, full path coordinates, relevant gun/order gates and terrain mutation inputs. Reading the hash does not initialize an absent body or surface or consume RNG. The hash schema changes, so peers must use the same build. It fingerprints mutation inputs rather than every terrain sample; physical cross-engine checkpoints additionally hash actual ground/base/dig/composite sample words.

Numerical optimizations retain quaternion normalization, contact order, all force/response constants and input-definition immutability. They reuse normalized definitions during one synchronous update, reuse identical contact-plane bases, avoid temporary vectors in solid impulses, specialize equivalent bilinear reads and synchronize terrain once per controlled body completion. Live external ground probes retain their previous semantics. A conservative distant-hull rejection retains the existing near-contact narrow phase.

## Verified checks

| Check | Evidence |
| --- | --- |
| Full corrected production suite | 1,772 passed, 0 failed, 2 existing skipped, 189 files; immutable run P |
| TypeScript and production build | Both exit 0 in P; physics tools type check also exit 0 |
| Latest tools/fixture delta | 112 passed, 0 failed, 1 existing opt-in skip, 3 files; immutable run O |
| Preoptimization/current exact body comparison | 4,800 body records, three scenarios × 400 ticks × four bodies; all numeric f64 bits, flags and suspension entries match |
| MacBook/Mac mini parity | 216 physics frames plus route/source data byte-identical; SHA-256 `e1d462c7f776881383e4a88350d61b68656d437e33089d3a5a63ba044f4c129a` |
| Visual captures | Eight 1024×768 images, zoom 1, actual VehicleScene and sprite fallback; before/after simulation hashes equal |

The exact-body comparison uses preoptimization run D production sources with the same corrected current fixtures, not the original misdirected fixture. Hashes themselves are excluded from this particular before/after comparison because the hash schema changed independently; full body records are compared exactly. The fixtures explicitly restore authored spawn positions and northward headings after deployment placement. Earlier timings from east/west-facing fixtures are invalid as acceptance evidence.

Visual inspection includes log crest, crater descent/ascent, halftrack side/roof, KV side slope, sideways turret and sprite fallback. Small decorative shellholes originally fell between the tracks; the corrected engineering fixture adds 4 m physical shell craters. Selected frames now show −5.02° descent and +8.98° ascent, and the KV side slope shows 20.54° roll. The yellow physical muzzle marker agrees with the rendered barrel; the southeast dark extension is its cast shadow. The game map viewport remains its native 1024×670 inside the requested 1024×768 canvas, with the bottom 98 pixels reserved for UI. No production map is modified for captures. Metrics for all eight frames, including selected tick and unchanged render hash, are retained in `p2-20261030/visual-captures.json`; image files are `task11-20261030-p/captures/{log-crest,crater-descent,crater-ascent,halftrack-side,halftrack-roof,kv-slope,sideways-turret,sprite-fallback}.png` under the Mini job root below.

## Long-run gates

The required ten-minute suite is five existing AI maps plus flat, sleep, feature, routing/near-miss and overturn physical scenarios, each at seeds 1 and 2. Every 100-tick checkpoint, final hash, chain digest, actual tick count and physical surface checkpoint is compared. Shorter ended AI battles retain their actual final tick rather than pretending to run 6,000 ticks.

The first monolithic Node job hit its 4 GB heap limit after nine completed cases. No strong-root cache leak has been established; the isolated repeat identifies a single vehicle-step runaway described below. The runner now creates a fresh process for each map/seed and persists completed results. The browser runner similarly uses a fresh owned process/session per case; incomplete or empty result sets fail comparison.

Full corrected cross-engine result: all 20 runs match between Node, Chromium, WebKit and installed Chrome. Each engine completed 111,979 actual ticks, with 1,119 state checkpoints and 600 actual-surface checkpoints matching exactly. Each physical scenario runs the full 6,000 ticks. Retained result JSON is in `p2-20261030/{node,chromium,webkit,chrome}.json` beside this report.

The earlier five-map AI suite was blocked in immutable run O at `berlin_1945/2`. The isolated child also fails, pinpointing tick 80 (8.0 sim-seconds) inside vehicle stepping; immediately before the runaway, heap use is about 109 MB. This rules out hashing/cross-battle accumulation as the direct cause. The root cause is now fixed: Tiger 46 originally intersected a nonplanar roof boundary at creation. The first 10 ms suspension update produced upward speed 31.03669 m/s and angular velocity −19.31699 rad/s. Initial geometric projection clears solid support and excessive suspension compression with zero kinetic energy; the same first update now yields −0.067964 m/s and −0.010566 rad/s. No force/gain/integration/contact-order change is required. Both current and original baseline had 2,366 identical captured body records through tick 79, establishing that the defect predates this optimization.

The movement sweep now rejects nonfinite/out-of-map endpoints before computing sample count, including outside starting points. This prevents a future invalid body from causing unbounded allocation. New regression tests cover the original deployment/terrain, a ten-minute passive fall bounded by gravitational plus spring energy, quaternion norm, original production stepping past tick 80, and invalid sweep endpoints. All 62 focused tests and TypeScript passed. The corrected original full Berlin battle also completed 6,000 ticks in the isolated diagnostic.

The full corrected suite and all three automated browser engines passed as immutable run P, including the original Berlin case. Earlier O results remain pre-fix diagnostic evidence on the Mini. No heap enlargement or omitted current case is used. Installed Safari remains a separate unmet gate. The user authorized enabling Remote Automation, but `safaridriver --enable` requested administrator authentication unavailable to the noninteractive session. The final owned Safari session probe on the corrected build still reports that Allow Remote Automation is disabled; retained evidence is `p2-20261030/safari.json`. The Mini user must enable it in Safari Settings → Developer, or run `/usr/bin/safaridriver --enable` interactively. WebKit is not substituted for Safari.

Source input proof: all 449 files match manifest SHA-256 `bafa52a4afca41f03503bebbed5a89254f5ddb95deef6fac23826b11e53714db`. Machine-readable validation summary: `p2-20261030/verification-summary.json`. The owned preview server is stopped after capture/engine completion.

Runtime: pinned Node 26.7.0 on both hosts; Playwright core 1.61.0, Chromium 149.0.7827.55, installed Chrome 156.0.8078.74, WebKit 26.5 (build 2311), installed Safari 27.0.1. Heavy jobs run on the user's `teros-mac-mini.local` (M2 Pro); source transfers exclude secrets and `.env*`.

## Performance and balance

Acceptance benchmark: 40 bodies, 1,000 warm-up ticks and ten measured batches of 1,000 ticks, including production parameter lookup, live terrain samples/normals, sleep/version checks, accepted movement blockers/effects and pose synchronization. Flat moving, all-T34 sleepers and log/crater contacts are separate. Mixed-resting fleet and constant-normal pure solver are additional diagnostics. Timing under concurrent suites is not acceptance evidence. The 0.5 ms/tick awake target is not yet met or claimed.

Controlled before/after benchmark completed in `task12-perf-20261030`, after our heavy jobs ended. Both versions use identical corrected fixtures, same Node 26.7.0 runtime and hardware. Native bundles use esbuild 0.25.12 `--bundle --platform=node --format=esm --target=es2022 --tsconfig=tsconfig.json`; the preoptimization source is retained immutable run D, with its input manifest. Initialization and the prescribed warm-up are excluded; the measured production update retains its allocations and callbacks. The requested full vite-node invocation also completed. All four production-scene final hashes and counters match the native bundle exactly.

| 40-body scene | Before median / max ms per tick | Current median / max ms per tick | Current awake / asleep |
| --- | ---: | ---: | ---: |
| Flat, moving | 9.3300 / 9.5712 | 5.0475 / 5.2099 | 40 / 0 |
| Flat, sleepers (40 T-34/76) | 0.1303 / 0.1322 | 0.1753 / 0.1792 | 0 / 40 |
| Mixed fleet at rest | 1.4920 / 1.5040 | 1.2200 / 1.3052 | 10 / 30 |
| Log/crater and boundary contacts | 7.8098 / 9.2837 | 5.2116 / 5.5997 | 40 / 0 |
| Constant-normal solver, diagnostic | 2.5437 / 2.5599 | 1.6561 / 1.6835 | — |

The flat moving case improves by 45.9%, but its 5.0475 ms median remains 10.1 times the 0.5 ms target. All 40 bodies finish moving north inside the map; the minimum northward travel is 1,099.57 tiles, with no border touch. The sleeper case regresses by 0.045 ms for all 40 bodies; that result is retained rather than hidden by the moving-case improvement. Mixed resting includes ten awake halftracks; it is not labelled 40 sleeping bodies. All 40 bodies encounter the raised strip during feature warm-up; by the end of that long fixed-drive feature run all are stationary while still awake, with a minimum 26.69 tiles of northward travel and `touchesBorder=true`. It therefore includes crater and boundary contacts and is a contact-workload diagnostic rather than a second sustained-driving case. The target result is the flat moving row. Retained complete samples: `p2-20261030/benchmark-{before,current}.json`.

The full vite-node run uses the same 1,000-tick warm-up and ten 1,000-tick batches: flat moving median/max 11.1450/12.0280 ms; sleepers 0.1643/0.1828 ms; mixed resting 2.6063/2.6700 ms; feature/boundary contacts 11.6891/22.6726 ms; pure solver diagnostic 2.6015/2.7647 ms. These loader timings are kept separate from the controlled native before/after comparison; neither reaches the 0.5 ms awake target. See `p2-20261030/benchmark-vite-node.json`.

The 20-minute battle harness compares all ten actual map IDs × seeds 1–9 (90 cases per version) against finalized `345fe30` production sources. Both versions use the same passive 1 Hz distance/speed/path-node instrumentation and original sanity assertions. Jobs are split with the existing HARNESS_MAPS option. The winter source filename exports `moscow_1941`; a zero-case `winter_1941` artifact is retained as invalid and excluded, with the actual Moscow batch completed. The harness now rejects unknown map IDs and empty selections. The incomplete pre-spawn-fix candidate M was stopped and retained as superseded evidence. All 90 current candidate cases completed with their original assertions under `task12-spawnfix-20261030`, compared with unchanged baseline production sources. The original baseline also OOMs in its Berlin seed 2 battle. That historical failure is retained explicitly; the eight other Berlin seeds passed independent runs with their original assertions. The baseline therefore has 89 valid outcomes and one recorded failure; it is not reported as 90 successful cases. Three representative changed cases have a separate initial-placement audit: RNG state, XY positions and orientations are identical, while invalid initial contact is corrected vertically (2.06 cm in border seed 5; 20.84 cm in Moscow seed 1; 14.96/6.16 cm for two vehicles in Berlin seed 1). This identifies a physical cause for subsequent shot/speed/path/outcome changes. See `p2-20261030/spawn-corrections.json`. The current version completed 90/90 cases; 41 of the 89 paired cases changed outside wall timing. Assertions and balance constants are not retuned. Retained summary: `p2-20261030/balance-comparison.json`.

| Metric | Baseline, 89 paired cases | Current, same 89 cases |
| --- | ---: | ---: |
| Attacker wins / decided battles | 20 / 77 (25.97%) | 19 / 74 (25.68%) |
| Draws | 12 | 15 |
| Attacker shots | 219,608 | 216,139 |
| Defender shots | 170,937 | 167,752 |
| Small-arms shots / hits | 202,974 / 3,859 | 194,798 / 3,791 |
| Mean sampled vehicle speed | 0.27309 m/s | 0.25644 m/s |
| Mean sampled total path nodes | 1,201.21 | 1,154.20 |
| Maximum total path nodes | 5,771 | 5,755 |

Over all 90 current cases the attacker wins 20 of 75 decided battles (26.67%), with 15 draws; the extra historical-crash case is an attacker win in the corrected version. The 40–47% target remains unmet and was already unmet in the baseline. The paired rate is nearly unchanged. The immediate cause of this patch's outcome differences is corrected physical initial contact and resulting vehicle motion/shot/RNG timing, illustrated by the audited initial poses above. The underlying low attacker win rate needs separate tactical/balance diagnosis; this work does not claim that diagnosis or change combat/AI gains. Harness wall timings ran under varying concurrent jobs and are diagnostic; controlled hull timings below are the performance comparison.

## Reproduction and retained evidence

Worktree: `/Users/marski/.codex/worktrees/vehicles-3d-p2/cc3_clone`.

Mini job root: `/Users/marski/work/cc3-clone-p2w.noindex/runs/`:

- `task11-20261030-l/`: full-suite JSON/log, type/build exit flags and immutable input manifest.
- `task11-20261030-o/`: pre-spawn-fix tool/input manifest, Node failure, successful physical matrix, delta tests, parity, Safari probe and captures.
- `task11-20261030-p/`: corrected production source manifest, complete-suite/current cross-engine jobs, parity and current captures.
- `task12-spawnfix-20261030/balance-groups/` and `task12-baseline-20261030/balance-groups/`: current/baseline identical-map/seed harness records and exit flags. Interrupted monolithic and superseded candidate M results are not acceptance evidence.
- `task12-perf-20261030/`: before/after source manifests, 400-tick exact body traces/comparison, completed benchmark samples and full battle comparison.
- `task12-spawn-audit-20261030/`: representative pre/post placement audits establishing unchanged RNG/XY/orientation and corrected initial contact.

```sh
npm run typecheck
npm test
npm run build
npx tsc -p tsconfig.physics-tools.json
npx vite-node tools/determinismNode.ts --minutes 10 --json node.json
# Start an owned preview only while browser checks/captures need it.
npx vite --host 127.0.0.1 --port 5199 --strictPort
node tools/runDeterminismEngines.mjs --base http://127.0.0.1:5199 --minutes 10 --engines chromium,webkit,chrome,safari --playwright-root /Users/marski/actions-runner/_work/supset-mes/supset-mes/node_modules/playwright-core --out engines
node tools/compareDeterminism.mjs node.json engines/chromium.json engines/webkit.json engines/chrome.json engines/safari.json
npx vite-node tools/hullPhysicsBench.ts --json bench.json
HARNESS=1 HARNESS_SEEDS=9 HARNESS_JSON=balance.json npx vitest run test/harness.test.ts
# Exact capture helper retained on the Mini:
node /Users/marski/work/cc3-clone-p2w.noindex/runs/task11-20261030-p/capture.mjs /Users/marski/work/cc3-clone-p2w.noindex/runs/task11-20261030-p/captures http://127.0.0.1:5199
```

## Remaining scope

Do not mark backlog 050 or all P2 complete while Safari, the measured performance target or other acceptance gates are unmet. The 0.5 ms/tick awake target, 40–47% attacker win target and installed Safari check remain unmet. Classic order-module WeakMaps (formation headings/claims, skipped legs and delayed radio orders) remain outside the copied physical-driver continuation test. Command-log reconstruction is tested, but this change does not establish arbitrary whole-battle snapshot restoration. Terrain deformation follow-up 054 and P3/P4/P5 remain separate.
