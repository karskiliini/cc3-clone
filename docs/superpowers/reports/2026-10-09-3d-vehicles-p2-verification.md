# P2 physical determinism and performance verification — 2026-10-30

Status: verification in progress; P2 acceptance remains open. Branch `codex/vehicles-3d-p2`, starting revision `345fe3038805a001f99bd3ff727f5f61c4fd7f6b`.

## Implementation

Physical driver observations, near-miss/cover hysteresis, reversing and turn memory now live on vehicles; soldier vehicle-wait/dodge timing lives on soldiers. Terrain restoration retains scalar overrides, temporary profiles, direct crater history and original building envelopes. Reattaching a copied height field preserves its actual samples and revision. Refreshing terrain still replaces temporary profiles, as before.

The hash includes exact body numbers, flags and suspension entries, driver memory, full path coordinates, relevant gun/order gates and terrain mutation inputs. Reading the hash does not initialize an absent body or surface or consume RNG. The hash schema changes, so peers must use the same build. It fingerprints mutation inputs rather than every terrain sample; physical cross-engine checkpoints additionally hash actual ground/base/dig/composite sample words.

Numerical optimizations retain quaternion normalization, contact order, all force/response constants and input-definition immutability. They reuse normalized definitions during one synchronous update, reuse identical contact-plane bases, avoid temporary vectors in solid impulses, specialize equivalent bilinear reads and synchronize terrain once per controlled body completion. Live external ground probes retain their previous semantics. A conservative distant-hull rejection retains the existing near-contact narrow phase.

## Verified checks

| Check | Evidence |
| --- | --- |
| Full suite, production implementation | 1,770 passed, 0 failed, 2 existing skipped, 188 files; immutable run L |
| TypeScript and production build | Both exit 0 in L; physics tools type check also exit 0 |
| Latest tools/fixture delta | 112 passed, 0 failed, 1 existing opt-in skip, 3 files; immutable run O |
| Preoptimization/current exact body comparison | 4,800 body records, three scenarios × 400 ticks × four bodies; all numeric f64 bits, flags and suspension entries match |
| MacBook/Mac mini parity | 216 physics frames plus route/source data byte-identical; SHA-256 `e1d462c7f776881383e4a88350d61b68656d437e33089d3a5a63ba044f4c129a` |
| Visual captures | Eight 1024×768 images, zoom 1, actual VehicleScene and sprite fallback; before/after simulation hashes equal |

The exact-body comparison uses preoptimization run D production sources with the same corrected current fixtures, not the original misdirected fixture. Hashes themselves are excluded from this particular before/after comparison because the hash schema changed independently; full body records are compared exactly. The fixtures explicitly restore authored spawn positions and northward headings after deployment placement. Earlier timings from east/west-facing fixtures are invalid as acceptance evidence.

Visual inspection includes log crest, crater descent/ascent, halftrack side/roof, KV side slope, sideways turret and sprite fallback. Small decorative shellholes originally fell between the tracks; the corrected engineering fixture adds 4 m physical shell craters. Selected frames now show −5.02° descent and +8.98° ascent, and the KV side slope shows 20.54° roll. The yellow physical muzzle marker agrees with the rendered barrel; the southeast dark extension is its cast shadow. The game map viewport remains its native 1024×670 inside the requested 1024×768 canvas, including the bottom UI strip. No production map is modified for captures.

## Long-run gates

The required ten-minute suite is five existing AI maps plus flat, sleep, feature, routing/near-miss and overturn physical scenarios, each at seeds 1 and 2. Every 100-tick checkpoint, final hash, chain digest, actual tick count and physical surface checkpoint is compared. Shorter ended AI battles retain their actual final tick rather than pretending to run 6,000 ticks.

The first monolithic Node job hit its 4 GB heap limit after nine completed cases. No strong-root leak has been established. The runner now creates a fresh process for each map/seed and persists completed results. The browser runner similarly uses a fresh owned process/session per case; incomplete or empty result sets fail comparison.

Full Node/Chromium/WebKit/installed Chrome results: pending immutable run O. Installed Safari remains a separate unmet gate. The user authorized enabling Remote Automation, but `safaridriver --enable` requested administrator authentication unavailable to the noninteractive session. A subsequent owned Safari session probe still reports that Allow Remote Automation is disabled. The Mini user must enable it in Safari Settings → Developer, or run `/usr/bin/safaridriver --enable` interactively. WebKit is not substituted for Safari.

Runtime: pinned Node 26.7.0 on both hosts; Playwright core 1.61.0, Chromium 149.0.7827.55, installed Chrome 156.0.8078.74, WebKit 26.5 (build 2311), installed Safari 27.0.1. Heavy jobs run on the user's `teros-mac-mini.local` (M2 Pro); source transfers exclude secrets and `.env*`.

## Performance and balance

Acceptance benchmark: 40 bodies, 1,000 warm-up ticks and ten measured batches of 1,000 ticks, including production parameter lookup, live terrain samples/normals, sleep/version checks, accepted movement blockers/effects and pose synchronization. Flat moving, all-T34 sleepers and log/crater contacts are separate. Mixed-resting fleet and constant-normal pure solver are additional diagnostics. Timing under concurrent suites is not acceptance evidence. The 0.5 ms/tick awake target is not yet met or claimed.

Quiescent before/after benchmark: queued in `task12-perf-20261030`; results pending. Both versions use identical corrected fixtures, same runtime and hardware. Bundled native Node and the requested vite-node invocation are reported separately.

The 20-minute battle harness compares all ten actual map IDs × seeds 1–9 (90 cases per version) against finalized `345fe30` production sources. Both versions use the same passive 1 Hz distance/speed/path-node instrumentation and original sanity assertions. Jobs are split with the existing HARNESS_MAPS option. The winter source filename exports `moscow_1941`; a zero-case `winter_1941` artifact is retained as invalid and excluded, with the actual Moscow batch queued. The harness now rejects unknown map IDs and empty selections. Full coverage, attacker wins, shot/speed/path differences and wall timings are pending; assertions and balance constants are not retuned.

## Reproduction and retained evidence

Worktree: `/Users/marski/.codex/worktrees/vehicles-3d-p2/cc3_clone`.

Mini job root: `/Users/marski/work/cc3-clone-p2w.noindex/runs/`:

- `task11-20261030-l/`: full-suite JSON/log, type/build exit flags and immutable input manifest.
- `task11-20261030-o/`: current tool/input manifest, per-case long Node/browser results, delta tests, parity, Safari probe and `captures/`.
- `task11-20261030-m/balance-groups/` and `task12-baseline-20261030/balance-groups/`: identical-map/seed harness records and exit flags. Original interrupted monolithic results are not acceptance evidence.
- `task12-perf-20261030/`: before/after source manifests, 400-tick exact body traces/comparison and benchmark queue/results.

```sh
npm run typecheck
npm test
npm run build
npx tsc -p tsconfig.physics-tools.json
npx vite-node tools/determinismNode.ts --minutes 10 --json node.json
node tools/runDeterminismEngines.mjs --base http://127.0.0.1:5198 --minutes 10 --engines chromium,webkit,chrome,safari --out engines
node tools/compareDeterminism.mjs node.json engines/chromium.json engines/webkit.json engines/chrome.json engines/safari.json
npx vite-node tools/hullPhysicsBench.ts --json bench.json
HARNESS=1 HARNESS_SEEDS=9 HARNESS_JSON=balance.json npx vitest run test/harness.test.ts
```

## Remaining scope

Do not mark backlog 050 or all P2 complete while Safari, the measured performance target or other acceptance gates are unmet. Classic order-module WeakMaps (formation headings/claims, skipped legs and delayed radio orders) remain outside the copied physical-driver continuation test. Command-log reconstruction is tested, but this change does not establish arbitrary whole-battle snapshot restoration. Terrain deformation follow-up 054 and P3/P4/P5 remain separate.
