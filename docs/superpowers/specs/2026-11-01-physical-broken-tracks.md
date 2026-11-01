# 052 — Physical broken tracks

A destroyed tracked running gear now cuts an open chain rather than instantly
freezing the hull. A penetrating running-gear hit selects the closest link to its
physical impact; an AT mine chooses the struck side and link from the mine position.
Wheeled vehicles retain their wheel-failure behavior. Existing saved/fixture damage
without a chain retains its prior immobility semantics.

The simulation owns 20–80 world-space points per run, spaced about 25 cm apart.
Two free ends surround the cut link. Fixed 100 ms ticks use four substeps and seven
distance/contact passes, gravity, damping, terrain support and running-gear cylinder
collisions. Points inherit hull linear/angular velocity. A stretched joint exceeding
2.5 pitches can tear again. Rendering has no influence on construction or motion.
The geometry is an explicit gameplay approximation: width/length come from existing
hull/contact data, six support cylinders approximate the wheels, and existing layout
metadata chooses the front/rear drive sprocket. It is not a detailed multibody model
of every historical shoe, guide tooth and suspension arm.

While links bear on the drive sprocket, that side can still drive and drag the loose
run. Once contact is lost, engagement cannot regenerate; longitudinal traction,
braking and differential steering from that side disappear in the actual hull solver.
The other side remains driven and can slew the hull. Both disengaged sides immobilize.
No arbitrary post-break speed multiplier or heading teleport substitutes for traction.
Canonical points, velocities, tears and engagement participate in state hashing/replay.

3D shoes consume copied world points, preserve the two ends and omit torn joints.
The baked static thrown-chain decoration is replaced using intact/damage geometry
comparison, including both-side and wreck variants; armor and the unbroken side stay.
A detached run stays visible when its own vehicle leaves the camera view, subject to
existing side visibility. The no-WebGL fallback draws the same linked points.

Verification (Mac mini, Node 24.22.1): 40 damage/mine/passenger/chain tests passed;
30 hull/chain tests passed; final 50 chain/3D tests passed (eight dedicated chain tests).
Typecheck and production build passed. The production hull/chain test keeps initial
sprocket contact and subsequently loses it; a 180-tick M5/M2 float-bit trace is identical,
SHA-256 `2c7d39fdbb147e3baace920819ccae215d6d97d5ae73c9959c5a33f1472ff62e`.
One settled 47-link chain costs approximately 0.191 ms/tick over 1000 ticks on the
loaded M2 mini, not a general performance guarantee. Intact vehicles allocate no chain.
The real Chromium battle records driving, engagement loss, and the chain left behind;
no page errors, own browser/server stopped. The actual Pz III model retains 2172/2232
hull indices after one-side clipping. Full-suite and cross-browser parity were not rerun.
Evidence: `docs/superpowers/reports/workflow-052-20261101/browser.json`.
