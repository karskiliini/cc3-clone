# Air support and illuminated night combat

Requested 2026-11-01. Status: queued requirements, not implemented. Backlog 058–059;
050 P2 stays active under the existing FIFO rule. These requirements add no approval gate.

## 058 — Air support, following later Close Combat games

Reference mechanics: assigned support; delayed availability with an audio/text cue;
click the support icon then a map position; one aircraft, one attack pass, then departure;
usually one use per battle; daylight and clear-weather availability. Aircraft and ordnance
are named in the support tooltip. Gateway to Caen uses a random aircraft and approach
heading. Its Normandy availability delays (Allies 5–12 minutes, Germans 8–12) are reference
values, not Eastern Front defaults. Scenario date, conditions and allocated missions govern
our availability. Campaign missions come from a daily pool; unused assignments remain
available later that day.

User additions: German Ju 87 bombing support and later Ju 87G anti-armour support;
Soviet IL-2 bombing or anti-armour bomblet support. A Ju 87B documented mixed load is
one 250 kg bomb plus four 50 kg bombs. Ju 87G uses two 37 mm cannon. IL-2 conventional
bomb loads and PTAB submunitions require dated aircraft/ordnance data, with PTAB and
Ju 87G restricted to their actual service period. Do not treat an airframe's maximum
possible load as its routine tactical load.

Target-dependent load selection is our extension to the reference games: choose the
mission/load from the reported target class, year and available assets during preparation.
The pilot's actual attack uses their own observations and delivered reports, following 056.
No scan of hidden live armour counts or positions to choose weapons or steer the attack.
Area attacks, dispersion, explosions, terrain/structure damage and friendly casualties must
be real simulation consequences, with animated approach, release/firing and departure.
All state, commands and randomness must replay deterministically.

Primary game references (accessed 2026-11-01):
- [Gateway to Caen manual, 12.1 and 18.10](https://store.steampowered.com/manual/297750).
- [The Bloody First manual, 12.1](https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/811880/manuals/Close_Combat_Bloody_First_Manual_EBOOK.pdf?t=1647349820).
Historical starting points:
- [Ju 87B load, David C. Eyre aircraft encyclopedia](https://aeropedia.com.au/content/junkers-ju-87/).
- [Ju 87G-2, RAF Museum object history](https://www.rafstories.org/ciim-media/pf/D63A5943_D295_9C52_1BE8_D4238A690CC6/121/994/78_A_657_Junkers_Ju_87G_2_494083_CO.pdf).
- [IL-2, Smithsonian collection](https://airandspace.si.edu/collection-objects/ilyushin-il-2-shturmovik/nasm_A19950142000).

## 059 — Night fog of war and mortar illumination

User request: clear night fog of war; mortar-fired illumination rounds that hang in the
sky and illuminate a localized area for a long time; a striking, nearly ray-traced-looking
effect as the descending flare lengthens the shadows.

Required player experience:
- Night is selectable/authored in a scenario and legible in briefing and deployment.
  Darkness, currently observable ground and stale/unobserved areas are visually distinct.
  Hidden enemies stay hidden; last-known markers never follow their hidden live position.
- A suitable mortar can fire an illumination mission at a map area, using a distinct,
  finite illumination-ammunition stock and normal crew/readiness/range/flight constraints.
  Area illumination need not require an already visible enemy. Show ammunition and mission
  state clearly in the command UI. Repeated rounds can sustain light while stock lasts.
- An aerial burst deploys a burning parachute flare. It descends over many tens of seconds,
  with a readable canopy, warm glare, gentle movement/smoke, smooth ground falloff and
  a gradual burnout. Duration, altitude, descent, wind and stock are explicit, tunable
  gameplay values until the specific historical mortar ammunition is sourced.
- Buildings, terrain relief, trees and vehicles occlude the light. Shadows move and lengthen
  continuously as the source descends; penumbra/soft edges, warm light and cool ambient
  night colour make the transition readable. Multiple flares combine without whiteout.
  Bound shadow work to the useful light radius and handle burnout/low altitude cleanly.

Lighting is physical evidence, not knowledge:
- Both sides benefit from, and can be exposed by, the same flare regardless of its owner.
- Darkness reduces each observer's acquisition ability; light improves the visibility of
  the illuminated target. Normal observer-to-target LOS, eye height, facing, concealment,
  condition and communication rules still apply. Light behind a wall does not reveal a man
  through it. Seeing into a lit area and out of it into darkness are asymmetric.
- Compute gameplay illumination from canonical flare position, height, intensity and
  occluders. The renderer reads that state; camera, selection, frame rate, quality settings
  and graphics fallback must never change sensing, RNG, AI decisions or hashes.

Implementation dependency and acceptance:
- Current terrain is Canvas 2D; vehicles have a separate three.js layer. Prototype a common
  height-aware point-light/shadow pass over terrain/occluder proxies and 3D vehicles before
  polishing isolated effects. A radial bright disk alone does not satisfy this request.
  Height-field ray marching or equivalent shadow geometry is a candidate, not a claim of
  hardware ray tracing or measured performance. Both layers must agree on light position.
- Compare identical building/tree/vehicle fixtures at high, middle and low flare altitude:
  shadows must have the correct direction and grow with descent. Include sloping terrain,
  overlapping lights, burnout and an occluded target at the edge of the illuminated area.
- Verify finite stock, crew constraints, localized/occluded light, both-side spotting,
  save/replay/hash coverage and camera/viewer independence. Cross-engine checks cover
  flare evolution and sensing. A renderer with no WebGL retains correct gameplay and a
  readable fallback; measure frame time on representative scenes before setting budgets.
- Visual acceptance requires an in-game recording of an actual mortar illumination mission
  over buildings and trees, through descent and extinction, showing changing shadows and
  correct hidden-unit behavior. Heavy tests and rendering runs go to the capacity-checked
  Mac mini under the user's standing transfer permission.
