# P2 navigation and individual shelter — 2026-10-30

This finalization covers the retained physical steering, bank/trench routing and individual building shelter changes on `codex/vehicles-3d-p2`. The user authorized committing and pushing this work on 2026-10-30. It does not mark the entire P2 plan complete.

## Result

- Vehicle paths stage the whole hull before water-bank turns and align trench entry/exit across overlapping banks. Shortcut and connector checks retain the original terrain/avoidance budget and inspect every crossed cell.
- Loaded driven tracks balance tangential gravity within the existing friction limit. A nominal stopping-yaw reserve prevents carried angular velocity from exceeding the original moving slip limit on flat support; uneven support retains the existing admission rule.
- Finite local recovery preserves attempts, elapsed budgets, ownership and interruption state. Idle tracked hull assistance now uses accepted heading and angular rate, preserving previous steering owners and the existing turn envelope. Shared route, cover, creep and wheeled turning policies are unchanged by that final idle correction.
- Every ordered infantry member considers the whole live building. Each compares physically spaced indoor crowding against reachable protected exterior positions using personal threat information and caution. Current bodies and committed endpoints reserve space; incapacitated bodies still occupy space. Separation cannot push a soldier from markedly better shelter into exposure.
- The JEV controller feasibility request is recorded as backlog 057; it is not implemented by this change.

## Regression repairs

The model test now recognizes the exported gun and wheel assemblies without increasing geometry budgets. Wreck tests supply map metadata required by the physical surface. The elevated small-arms fixture rebuilds its modified surface and uses a genuinely descending ray into the open compartment, rather than a front-plate interception. The integrity test measures corrupted payloads reaching the raw receiver: redundant delivery and validation may recover those packets without a desync.

The hull-down fixture keeps the 30-second bound and production 10-second creep timer. Its 5% approach and farther target permit the T-34's actual 5-degree depression limit. It explicitly checks initial eye visibility, a bearable but blocked physical muzzle ray, forward movement, and a clear bearable ray when firing. The default steep/cliff scenarios remain, and the enemy heading uses radians.

## Validation

Final immutable Mac mini run: **1,681 passed, 0 failed, 2 existing skipped tests across 187 files**. TypeScript, production build and job exit statuses are all zero. This includes all 10 original real-map arrivals, all six original tracked-slip cases, all five cover cases, all 15 building shelter cases, original tank-facing and gun-timing regressions, and the corrected hull-down test. The comparable pre-finalization snapshot had 1,635 passed and 46 failed; all 46 are resolved. Build output retains the existing large-chunk warning.

All 439 source/test/tool/config files and 424 public asset files matched their manifests, and both hosts used Node 26.7.0 with all 64 installed dependency versions matching the lockfile.

The final 216-frame Node 26.7.0 physics sample is byte-identical on the MacBook and Mac mini, SHA-256 `3da4dde3e4bbf551f41e92fdb129407d420e73e13153df16c601be8e0b818f1c`. It includes actual bank and trench crossing frames. Independent final review found no actionable issue in the idle correction or revised physical fixture.

## Remaining P2 scope

The broader navigation WeakMap/state-hash completeness work remains in Task 11, along with its full replay/cross-engine acceptance. This short cross-host sample does not prove that wider contract. Task 12's performance/balance/visual acceptance is also separate. Private diagnostic archives under `.superpowers/` remain local and are excluded from Git.
