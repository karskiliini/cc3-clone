# 054 — Loaded vehicles compress earthworks

Accepted suspension observations carry positive normal loads. After the physical
tick and any tow rollback, their ten 10 ms load impulses relax nearby loose dig-layer
samples toward the local ground. Airborne points and rejected candidate positions
cannot deform remote soil. A stationary supported hull can continue settling soil;
there is no speed-only or camera-dependent trigger. Ordinary unexcavated ground and
standing structures remain unchanged. Wheel/tread contact loads supply vehicle weight,
so the same crossing by a KV-1 collapses more soil than a T-70; repeated passes continue.

The explicit gameplay soil model uses a 1 m influence radius, quadratic radial
falloff, a 120 kNs/sample resistance and at most 25% relaxation per tick. Negative
pit samples fill at 65% of the spoil-collapse rate. This approximates rim collapse
and local backfill; it does not conserve or simulate individual grains of soil.
The actual authoritative 0.5 m dig/composite height arrays change, invalidating ground
versions and sleeping hulls. Terrain structures are not lowered through this mechanism.

Sparse canonical edits retain each changed sample's original and current dig height.
They are hashed in sample order, survive restored field contexts and explicit field
rebuilds, and are refreshed if a later crater deepens the changed soil. Subsequent
vehicles and physical LOS read the new surface. Trench/crater cover falls with the
remaining pit-depth fraction toward ordinary-ground cover. Derived render dirty tiles
are excluded from the hash and cannot alter outcomes.

Crater/foxhole/trench art interpolates each sample's remaining relief fraction before
its existing slope lighting and cast-shadow pass, preserving its authored round
sub-sample outline. Dirt/scorch remains after the relief flattens. Terrain chunks are
invalidated around changes; depth overlay and vehicles use the actual new height.
This shared canonical earthwork mechanism is also the foundation for stage 055.

Verification: 39 height/cover/contact/crossing tests passed, then 43 crater/terrain/hull
regressions, and nine dedicated compression tests after the final art adjustment.
Tests include real KV-1/T-70 crossings, repeated loads, spoil/cover, restore/hash,
later blast, airborne/rejected contacts and read-only physical art deformation.
Typecheck and final production build passed. A 160-tick production KV-1 crossing has
identical M5/M2 floating-point and soil/hash traces, SHA-256
`3ec8df680c5767736367fa8a105d6dd977ae62183e4c44b3c3ba582ed22546e8`.
A real Chromium battle crosses five small shell holes, changes 25 physical samples,
and shows shallower shaded relief afterwards. No page errors; own browser/server
stopped. Raw browser evidence is in `docs/superpowers/reports/workflow-054-20261101/`.
Full-suite and cross-browser parity were not rerun for this stage.
