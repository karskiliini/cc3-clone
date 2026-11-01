# 051 — Physical APC passengers

User-requested workflow stage, implemented 2026-11-01 on `codex/vehicles-3d-p2`.
This addendum extends the earlier vehicle spec's soldier-physics scope for APC riders.

- The SdKfz 251 has ten authored bench positions in model-origin metres (+x right,
  +y rear, +z up). Inner floor/side/rear surfaces and benches follow the procedural
  vehicle bay in `tools/blender/vehicles.py`, with conservative collision padding.
  Geometry and equal-mass body particles are simulation approximations.
- Seat indices and hatch endpoints are canonical simulation data. A casualty retains
  its capacity until physically ejected; rendering cannot allocate or reshuffle seats.
- Moving, suppressed or panicking riders crouch beneath the side plates. Calm riders
  can expose themselves to fire while halted. Firing immediately changes posture;
  the existing passenger accuracy penalty remains. Side plates protect crouched men
  from nonpenetrating side small-arms fire, while penetrations and overhead fire can
  still hurt them. Ordinary damage, morale and passenger queues remain authoritative.
- A casualty is initialized at the hit pose with hull linear/angular point velocity.
  Seven world-space particles linked by six distance constraints model head, torso,
  pelvis, arms and legs. Fixed 0.1 s ticks use four substeps and five constraint passes;
  9 cm contact radii resolve the floor, sloping walls and benches. Damping and support
  friction settle the body. An open top has no artificial lid: an overturned hull can
  release the body, which then falls onto the actual terrain.
- Living figures, guns and articulated casualties are drawn under the hull transform,
  sharing its pitch/roll. World-space body points are converted read-only for rendering.
  Entry and exit vault the rear rim via an explicit elevated waypoint. The sprite
  fallback draws the same seat and body anchors; detached bodies remain visible.
- Rider state is hashed and replayed; no viewer, camera, frame timing or render RNG
  participates. The existing normal boarding/unloading mechanism is reused.

Verification: 252 related regressions passed over 12 files; final changed-path checks
passed 53 tests including all ten dedicated passenger physics/render-transform cases.
Production build/typecheck passed. A 100-tick body trace was byte-identical on M5/M2
under Node 24.22.1, SHA-256 `9d7b54047567ef896b0bd1398324648fba05077ac2b6bcb7926b71846f489265`.
The real Chromium battle capture boarded ten men, retained two casualties while
moving over relief, showed five exposed shooters, and unloaded the eight survivors.
No page errors; the own browser/server were stopped. Raw browser evidence is in
`docs/superpowers/reports/workflow-051-20261101/browser.json`.
The full suite and a new cross-browser determinism suite were not rerun for this stage.
