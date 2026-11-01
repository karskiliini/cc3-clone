# 055 — Individual infantry entrenchment

A healthy or capable wounded infantryman with no path, fire/aim/reload job, pickup,
medical/carry/crew task or recent personal threat can begin digging immediately.
Idle and quiet Defend permit it; Ambush/Hide preserve concealment and do not start
shovel work. A new order clears digging immediately. Own incoming fire, a recent
credible nearby belief, fear, suppression, exhaustion or incapacity pre-empt work.
No side-wide spotted set, enemy truth or player visibility is consulted to decide
whether the man feels safe enough to dig. Actual pioneer tool work also takes priority.
The treated casualty cannot dig while the other man bandages him.

Each site has a stable id, position, facing and canonical accumulated/applied work
and construction depth. A man returning to the same site resumes it. Every site
survives departure/death. At nominal healthy capacity, 180 effective work seconds
produce a 1.2 m target pit. Winter/frozen ground takes four times as long, rubble five
times as long, and wounds/fatigue slow work. Paved surfaces, interiors, water, standing
structures and rock decor do not permit hand excavation. These are explicit gameplay
tunings. A crew already assigned a served weapon keeps its crew job rather than
starting an unrelated personal pit.

The dig layer, rather than a cover-only timer, gains a shaped pit and forward spoil.
Physical updates occur once per effective work second after the immediate first
stroke. Construction targets never replace actual physical depth: accepted vehicle
loads can collapse the same samples. Cover drops accordingly, and a returning man
repairs the physical depression gradually with more work. Existing good positions
are preferred; cover seeking considers personal sites at their actual fractional
positions. Both directional cover and ordinary/cached/blast cover read the physical
site, including the prior stage's compressed authored trenches/craters.

The existing four-frame entrenching motion is reused with individual timing, a
visible animated shovel and crouched simulation stance. HUD rows and group status
show Digging in. Hole relief/soil grows over time. A bounded per-site transparent
patch cache updates the local art without invalidating complete static terrain
chunks on every shovel stroke; local dig samples invalidate a patch after collapse.
The render cache and spatial cover index are derived, never authoritative state.
Sites, active digging, pioneer-work timing and sparse physical edits are hashed.

Verification: ten dedicated tests; 64 initial related tests; 77 integration checks
including viewer independence, restored continuation and separate-process replay;
final 41 digging/morale/HUD checks. Types and final production build pass. A 240 s
construction/interruption/resumption/collapse/repair trace is bit-identical on M5
Node, M2 Node and Chromium, SHA-256
`88b31f0a2d26198b58615a6886d955f6400a08c532a989f671206b15c1d0c885`.
Real Chromium battle: ten soldiers dig independently, growing intermediate cover;
all finish by about 190 s, with 0.717–0.8 physical cover at their individual positions.
No page errors, the background stays resolved, own browser/server stopped. Browser
record: `docs/superpowers/reports/workflow-055-20261101/browser.json`.
Full-suite and Firefox/Safari parity were not rerun for this stage.
