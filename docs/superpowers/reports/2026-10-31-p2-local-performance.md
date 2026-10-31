# P2 local hull profiling and optimization — 2026-10-31

This local verification pass is complete; P2 acceptance remains open. Baseline source: `64d4f06` on `codex/vehicles-3d-p2`.

The user explicitly requested this pass on the current Mac. All CPU work ran locally, with one heavy worker at a time: Apple M5 Pro, 15 cores, arm64, Node 24.22.1. These timings are not compared against the previous Mac mini/Node 26.7.0 measurements.

## Changes and profile evidence

The warmed baseline CPU profile identified solver work, five-point terrain sampling, contact-interest interpolation and swept footprint work. Named self-sample shares included `stepHullBody` 22.14%, `heightAt` 9.50%, `sampleBilinear` 8.18%, footprint generation/testing 8.07%, and garbage collection 2.30%. Sampling percentages guide investigation; unprofiled benchmarks below measure performance.

- A completion-scoped terrain probe caches exact uniform-tile proofs. The eight-by-eight-sample region covers the tile and the entire halo influencing height and finite-difference normals. Only uniform finite native-resolution regions take the fast path; mixed/nonfinite regions use the existing arithmetic. The cache expires with the completion, before accepted terrain effects; default live probes remain live. Signed zero is preserved.
- Contact-interest filtering computes only the four original positive sample weights. It no longer reads/interpolates base heights that its caller discards. It retains the same source eligibility, fallback fence tiles and refresh/rebuild invalidation.
- Suspension force accumulation uses scalar intermediates instead of temporary vectors. Velocity, cross/dot operations, normal force before traction, zero products, friction limits and accumulation order remain the same. Quaternion normalization, substeps, contact order, forces, gains and definitions are unchanged.
- `tools/hullPhysicsProfile.ts` records a warmed CPU profile of the actual production completion path. Profile writing and state hashing occur outside the measured region; profiled timing is labelled separately.

Independent Astra review found no actionable correctness issue in the terrain proof, observer filtering or scalar algebra.

## Same-machine benchmark

Each input uses 40 bodies, 1,000 warm-up ticks, ten batches of 1,000 timed ticks and native esbuild bundles. Scene construction, warm-up and final hashing are outside timing. Both versions use the same fixtures and Node runtime.

| Scene | Before median / max ms | After median / max ms |
| --- | ---: | ---: |
| Flat moving, 40 awake | 3.7668 / 5.1331 | 2.2407 / 2.5715 |
| Flat sleepers, 40 T-34/76 | 0.1194 / 0.1611 | 0.1001 / 0.1095 |
| Mixed rest, 10 awake / 30 asleep | 0.8600 / 1.3486 | 0.4565 / 0.4777 |
| Feature/boundary contact workload, 40 awake | 4.1567 / 5.7515 | 2.4568 / 2.6845 |
| Constant-normal solver, diagnostic only | 1.4193 / 1.6506 | 0.7705 / 0.7801 |

The moving production median improves **40.5%**. All 40 bodies finish moving north with no border touch. The long feature fixture eventually contains stationary crater/boundary contacts, as before; that row is not sustained-driving acceptance. The pure solver excludes production terrain/blockers and is not substituted for production cost. The **0.5 ms target remains unmet** (current production median 2.2407 ms).

Raw ten-batch samples and counters are retained in `p2-local-20261031/benchmark-{before,after}.json`. All four production scenarios have identical final hashes, awake/sleep/movement counts, displacement, border flags and feature-contact counts after 11,000 ticks.

## Exactness and checks

- Frozen-before/current production traces: **24,000 body records**, three scenes × 2,000 ticks × four bodies. Entire files, including every numeric f64 hex value, flags, suspension entries and per-tick state hashes, are byte-identical. SHA-256: `cb0dab1cbc4b187ba0ad719496405038a7807f2c365c5a909981073820de101d`.
- Independent frozen old-kernel differential: all **36 vehicle definitions**, four surfaces, steering/reverse/braking and traction changes: **18,432 body frames** and **1,370,915 contact observations** exactly equal. See `p2-local-20261031/kernel-differential.json`.
- Terrain differential tests compare native tick probes against the live five-point path over more than 15,000 positions, signed zeros, edges, mixed surfaces, nonfinite samples and changed terrain. Focused terrain/contact suite: **38 passed**; physics-tool type check passed.
- Full suite: **1,774 passed, 0 failed, 2 existing skipped tests across 189 files**. Both TypeScript checks and production build passed.
- Full ten-minute Node suite: **20 cases, 111,979 actual ticks, 1,119 state checkpoints and 600 physical surface checkpoints** match the retained previous cross-engine golden results exactly. This is a current Node validation, not a claim of new live browser runs.
- The new profile tool completed its 1,000-tick warm-up plus 5,000 profiled production ticks with all 40 bodies awake. Its final hash `3618722263` matches the pre-change profile. Raw profiled timing is not used as benchmark acceptance.
- Machine-readable evidence: `p2-local-20261031/verification-summary.json` and `determinism.json`.

## Reproduction and retained local files

Job directory: `/private/tmp/cc3-p2-perf-20261031/`. Before/after profiles and immutable bundled baseline executables remain there. The old kernel was loaded from `git show 64d4f06:src/sim/hullPhysics.ts`, without rewriting its arithmetic. No source state/hash fields are excluded from comparisons.

```sh
node_modules/esbuild/bin/esbuild tools/hullPhysicsBench.ts --bundle --platform=node --format=esm --target=es2022 --tsconfig=tsconfig.json --outfile=/tmp/hull-bench.mjs
node /tmp/hull-bench.mjs --json /tmp/hull-bench.json
node_modules/esbuild/bin/esbuild tools/hullPhysicsProfile.ts --bundle --platform=node --format=esm --target=es2022 --tsconfig=tsconfig.json --outfile=/tmp/hull-profile.mjs
node /tmp/hull-profile.mjs --scene flat-awake --out /tmp/hull.cpuprofile
npx tsc -p tsconfig.physics-tools.json
npm test
npm run build
```

The remaining accepted-pose footprint/collision work and residual solver allocations are further profiling candidates. The pure solver diagnostic still exceeds 0.5 ms, so the full production target needs more work.

P2 is not complete: the production performance target, attacker balance target and separately pending Safari acceptance remain open. This pass does not change balance or claim a new live browser-engine run.
