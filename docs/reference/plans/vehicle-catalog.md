# CC3 Clone — WW2 Vehicle & Fortification Catalog (user directive, refined)

Date: 2026-09-19. Source: user request ("comprehensive WW2 tank/vehicle catalog, most expensive
first, all with their own sprites, beautifully animated") + refinements below. Every entry here is
a requirement; additions I derive are marked **[NEW]**. Status: not yet implemented (this file is
the implementable spec; the roadmap G-numbers reference `grand-campaign-roadmap.md`).

## 1. vehicles requested vs. current state

Legend: ✔ exists in `VEHICLE_DEFS` (units.ts), ◐ variant missing, ✗ missing entirely.
Order: most expensive → cheapest (requisition points, first pass).

| # | Vehicle | Side/Kind | Cost | Main gun (new WEAPONS id) | Status | Notes |
|---|---------|-----------|------|---------------------------|--------|-------|
| 1 | **Tiger II (Königstiger)** — Henschel | ger tank | 130 | `kwk43_88` (185 mm Pen, L/71, 6.5 s) | ✗ | 70 t: hullTurnDegS 9, traverse 6, readyRack 5, ammo 50, weakSpots lowerHull/mantlet. Art: boxy hullFamily, wideTracks, tigerBox turret elongate 1.4, muzzleBrake |
| 2 | **IS-3** | sov tank | 125 | reuse `d25t_122` | ✗ | 1945 only (`Y45 = [1945]`). Sloped "piked" hull → new hullFamily `pike`, sovietRound turret elongate 1.3, muzzleBrake. slowPivot 8 deg/s |
| 3 | **IS-2 (1944)** | sov tank | 100 | `d25t_122` | ✔ is2 | keep; cost bump to ~100 in pass 2 |
| 4 | **SU-152** | sov spg | 95 | `ml20_152` (HE-heavy, Pen 110, 30 s load, heRadiusM 10) | ✗ | casemate, gunArcDeg 12, KV-1S chassis (slab hullFamily), crew 5 |
| 5 | **JS (IS-1)** | sov tank | 90 | `zis_s53_85` variant with 85mm → `d5t_85` (Pen 100) | ✗ | bridge between KV-1 and IS-2; sovietRound turret elongate 1.5 |
| 6 | **Ferdinand/Elephant [NEW, inventive add]** | ger tank dest. | 100 | `pak43_88` (Pen 200) | ✗ | optional; slot only if Tiger II lands well |
| 7 | **Panther D** | ger tank | 80 | `kwk42_75` | ◐ only G | new def `pantherD`: same stats, turretElongate 1.5, no mantlet px change; era 'late'; Y43 only |
| 8 | **Panther A** | ger tank | 78 | `kwk42_75` | ✗ | between D and G: cast cupola variant, traverse 15→18 |
| 9 | Panther G | ger tank | 75 | `kwk42_75` | ✔ panther | — |
| 10 | **Tiger I** | ger tank | 90 | `kwk36_88` | ✔ tiger | — |
| 11 | **StuG III G** | ger spg | 55 | `stuk40` | ✔ stug3g | — |
| 12 | **StuG IV** | ger spg | 58 | `stuk40` | ✗ | Pz IV chassis: boxy hullFamily + casemate, lengthM 5.9 |
| 13 | **SU-100** | sov spg | 70 | `d10_100` (Pen 160, loadS 8) | ✗ | casemateTaper steeper (0.28), SU-85 hull |
| 14 | **SU-122** | sov spg | 65 | `m30_122` (howitzer, heRadiusM 9, loadS 16) | ✗ | T-34 chassis casemate, sloped hullFamily |
| 15 | SU-85 | sov spg | 55 | `zis_s53_85` | ✔ su85 | — |
## 1b. Lend-Lease & mixed MGs (user addition, 2026-09-19)

- **Soviet .50-cal / Lend-Lease MGs**: Soviets get the **DShK 12.7 mm** (`dshk_hmg`: HMG,
  8 mm armour penetration at 300 m — kills halftracks/ACs, range 1200, suppression 0.5) as a
  new HMG team `sov_dshk` (Y42-45, cost 30, crew 3). Lend-Lease US/UK MGs in Soviet service:
  **Browning M2 .50** (`m2_hmg`, same stats, team `sov_m2`, `lendLease: true`),
  **Bren LMG** (`bren_lmg`: replaces DP-28 in some 1944-45 squads) and **Thompson M1A1**
  (SMG, `thompson`) mixed into Lend-Lease-equipped squads by an operation-level `lendLease`
  flag (1943+ operations: ~30% of DP-28 → Bren, ~20% of PPSh → Thompson, one DShK/M2 team).
- **Lend-Lease vehicles [NEW]**: **M3A1 Scout Car** (sov recon, cost 20), **M4A2 Sherman 76**
  (sov tank, cost 70, gun `m3_76_long` Pen 110, Y44-45, US olive-drab palette with red star —
  new palette `lendLeaseUS`), **Universal Carrier** (cost 12, MG carrier), optional Austin AC.
- **Jeep / Kübelwagen — ammunition tug [user addition]**: unarmed soft utility vehicles that
  resupply emplaced guns: **Willys MB Jeep** (sov/US, lend-lease), **Kübelwagen Type 82**
  (ger). New mechanic **ammo shuttle (G30)**: when an AT gun, mortar or tank team's ammo drops
  ≤ 20%, a tug (player-issued "Resupply" order, or AI automatic) drives within 8 m and
  transfers one crate per 5 s until the gun is full; each tug carries 3 crates. Not directly
  commandable in battle (Resupply/auto only); teams without a tug resupply at half rate from
  the kampfgruppe pool. Art: tiny 3.1 m open car, canvas roof variant; distinct silhouette.

| 16 | **PzKw IV variants** | ger tank | 45–55 | — | ◐ | keep F1/H; **add `pz4g`** (75mm L/43 `kwk40_l43`, Y42-43, cost 50) to bridge F1→H |
| 17 | **Hetzer** | ger TD | 45 | `stuk39_75` (short 75, Pen 90) | ✗ | small (lengthM 4.9), low silhhouette → new hullFamily `hetzer` (steep casemate), crew 4, gunArcDeg 10 |
| 18 | **T-34/85** | sov tank | 70 | `zis_s53_85` | ✔ t34_85 | — |
| 19 | T-34/76 | sov tank | 60 | `f34_76` | ✔ t34_76 | — |
| 20 | **T-28** | sov tank | 40 | `kt28_76` (short 76, Pen 45) | ✗ | 3 turrets (main + 2 MG) → art: `sovietRound` + 2 small forward turrets (`multiTurret: true` flag); Y41 only, slow (road 8) |
| 21 | PzKw III J | ger tank | 50 | `kwk39_50` | ✔ pz3j | — |
| 22 | **T-26** | sov light | 35 | `45mm_20k` | ✔ t26 | — |
| 23 | **Flammpanzer III [NEW-req: "flamethrower tanks, some german tank"]** | ger tank | 45 | **none** — `flamewerfer` vehicle weapon | ✗ | Pz III chassis, `flame: true` vehicle flag (see §3.2); ammo 60 "charges", range 35 m |
| 24 | **OT-34 (T-34 flamethrower)** | sov tank | 62 | `f34_76` retained (ATR turret variant) **or** drop gun — pick: keep F-34, add auxiliary `flamewerfer` bow mount | ✗ | `flame: true` + bow flame; art: extra fuel trailer-look rear drum optional |
| 25 | **Bergeschlepper/Kettengrad** — user said "kettengrad": **Kettenkrad SdKfz 2** | ger halftrack-let | 8 | none | ✗ | tiny: lengthM 3, widthM 1.6, crew 3, open, unarmed; new kind `'utility'`; speed road 12; art: motorcycle-front halftrack |
| 26 | **Nebelwerfer 41 (towed)** | ger rocket | 30 | `nebel41` (6-barrel salvo: burst 6, heRadiusM 7, accuracy 0.25, minRange 700) | ✗ | treat as AT-gun-class team (`type: 'rocket'` team type), setupS 12, ammo 6 salvos |
| 27 | **SdKfz 251/1 "Stuka zu Fuß"** (rocket halftrack) | ger halftrack | 35 | `nebel41` side racks (fixed 45° elevation: indirect only) | ✗ | sdkfz251 variant `sdkfz251_rocket`: passengers 0, rocket racks art on both sides |
| 28 | **BM-13 Katyusha** | sov rocket truck | 40 | `bm13` (16-rail salvo, burst 8, heRadiusM 8, indirect, accuracy 0.2, minRange 1000, maxRange 8000→capped 2000) | ✗ | new kind `'truck'`; open cab art, rail rack; after salvo: relocate (shoot & scoot bonus: packS 2) |
| 29 | SdKfz 251 | ger HT | 25 | — | ✔ sdkfz251 | — |

## 7. Victory-location dominance capture (user addition, 2026-09-19) — G31

Today VLs flip only through the capture timer of a team standing on them. Requirement: a VL's
ownership must also follow **area dominance** — every second, each VL evaluates the teams within
its influence radius (CC3 uses ~150 m; use VL-radius × 3):

- Score per side = Σ over nearby combat teams of (infantry 1.0, AT gun/HMG 0.5, vehicle 1.5,
  dead/routed 0) × (1 − suppression) × proximity falloff (1 at the VL, 0 at the radius edge).
- A side that outscored the other by ≥ 2.0 (dominance) for a continuous 30 s starts the VL's
  capture timer as if a team stood on it (neutral VLs become that side's; enemy VLs flip only
  after the standard contested-capture delay, ×1.5).
- An enemy team ON the VL still overrides (contested = timer paused), matching CC3's
  "hold the ground" rule; dominance only claims ground nobody contests.
- Victory scoring at battle end uses the same ownership state as today — no change to the
  debrief math, only to how ownership is earned.

Sim placement: extend `sim/victory.ts` step (runs at 10 Hz — evaluate dominance at 1 Hz), keep
it deterministic and rng-free; unit-test with a synthetic map: two squads near a neutral VL,
one suppressed → ownership drifts to the dominant side after 30 s; contested case paused.

### 7.1 VL ownership gates deployment in multi-round battles — G31b

Operations (and any multi-round battle chain: the existing five/six-battle operation plus the
grand campaign) reuse the same map for consecutive rounds (Counterattack / Second Assault).
Rule: at round setup, **each side may only deploy into (or adjacent to, ≤ 1 tile outside) the
areas it owns** —

- VLs owned by a side at the end of the previous round define that side's legal deploy zones:
  the standard zone is intersected with (owned VL circles ∪ original side zone). If the
  intersection is empty (side lost everything), that side deploys in its original zone but the
  round starts with a ×0.8 reinforcement-point penalty (CC3's "fought over ground" feel).
- VLs owned by neither (fresh map / first round) behave as today (standard zones).
- The deploy screen shows owned VLs highlighted and greys out illegal deploy ground (drag is
  refused with a Report message, matching the out-of-zone refusal).

Data: `OperationBattleDef` gains `carriesOver?: boolean`; the operation state stores the final
VL ownership map per battle id and feeds it into `BattleConfig.initialVLOwnership` +
`BattleConfig.allowedDeployOwnership`. Sim/victory + spawn consume them; debrief writes the
ownership snapshot back. Unit-test: round-1 win holding VL A/B → round-2 deploy zone contains
only A/B ∪ side zone; drag outside refused.

## 2. Existing families kept (no action): PzKw IV F1/H, Marder III, KV-1, T-70, BT-7, SU-76.

## 3. New mechanics the catalog forces

### 3.1 Rocket artillery (Nebelwerfer, Stuka-zu-Fuß, Katyusha) — G24
- New weapon cls `'rocket'`: salvo fires `burst` rockets over ~4 s, each an indirect HE impact
  (uses the existing mortar `indirect` pipeline), huge suppression; long reload (60 s) then empty.
- Team type `'rocket'` behaves like an atgun team (setup/pack, gun-crew model), vehicles mount the
  launcher as `mainWeaponId` with `hasTurret: false`.
- Katyusha/Stuka-zu-Fuß: after firing, AI (and the player prompt) should displace; a `postSalvoMove`
  suggestion flag on the team.

### 3.2 Flamethrower tanks — G25
- `VehicleDef.flame?: { rangeM: number; charges: number }`; weapon cls `'flame'` —
  short range (30–40 m), kills/suppresses infantry in a cone (reuse smoke-cloud projection),
  ignites `vehicleExplosion` burn state on soft vehicles.
- **Flame animation**: additive orange/yellow particle jet from the muzzle, flicker noise
  (reuse `render/noise.ts`), lingering fire blobs on the target tile for 3–5 s (fireFx).
- Trigger: Fire order on a target within range uses the flame weapon first; otherwise the main gun.

### 3.3 Camouflage nets (deploy phase) — G26
- In the deploy screen each vehicle team gets a **Net** toggle (context menu + hotkey): adds
  `netted: true`; render: grey-green mottled overlay sprite over the hull + concealment bonus
  (spotting modifier ×0.6 while stationary).
- **Torn off on movement**: the first move order (or any vehicle displacement > 2 m) clears
  `netted` with a small cloth-tear audio cue (sfx: noise burst) — per user requirement.
- Nets cost nothing but the toggle is deploy-only (CC3-style realism option later: score modifier).

### 3.4 Close-combat knives/bayonets — G27
- Every soldier gains an implicit `melee` weapon: bayonet for rifle-armed (kar98k, mosin), knife
  ( butt/nahkampfmesser) for SMG/crew/pistol. Effective range 1.5 m, lethality 0.7 vs unsuppressed
  defender 0.35, resolves as an instant combat roll when an enemy soldier is within 1.5 m and the
  side's melee order (new context action "Charge") is issued; defenders suppressed ×2 kill chance.
- Animation: lunge frame on the attacker (soldierAnim), white slash flash fx.

### 3.5 Fortifications — G28
- **Concrete bunkers (both sides)**: map-decor object (`structures.ts`), 3 sizes; blocks LOS/AT
  except firing slit; garrisoned team (HMG/AT gun) gets cover 0.9, immune ≤ 100 mm HE.
  Requisition: bunker purchase in battle setup (points), placed in deploy zone like a team.
- **Wooden strussed trenches ("juoksuhaudat" — reveted trenches)**: trench segments with timber
  revetment art (brown plank hatching), cover 0.75 + all-weather speed 0.5 inside; dig-in not
  realtime — placed at deploy like bunkers; AT guns may deploy INTO a trench (gun shield + revetment).

### 3.6 Support weapons — G29
- **120mm mortar (PM-38)** soviet: range 1500, heRadiusM 9, loadS 14, crew 5, cost 35; new WEAPON
  `mortar120`, new team `sov_mortar120` (Y43-45, upgradesTo none).
- **PTRD-41**: exists (`ptrd`) — keep; add a second dedicated AT rifle team slot for Soviets
  (already `sov_ptrd` team). No change.
- **Lahti L-39 20mm AT rifle** (Finnish campaign prep): weapon `lahti_l39` — cls atrifle,
  Pen 25, rate 0.3, accuracy 0.4, magazine 10; team reserved for the future Finnish side
  (`side: 'finnish'` enum extension deferred to the Finland campaign epic — file the weapon now).

## 4. Sprite/art checklist (per new vehicle)
1. `VEHICLE_DEFS` entry (stats above).
2. `SPEC` entry in `render/vehicleArt.ts` (hullFamily, turret, barrel, palette).
3. `DIMENSIONS` fallback row in `render/sprites.ts` (real dims pushed by setVehicleDims anyway).
4. `HEIGHT_M` row in vehicleArt.ts.
5. Team def (`TEAM_DEFS`) + icon.
6. Visual check in `tools/*.html` sprite preview + a battle spawn.

Hull/turret families to ADD: `pike` (IS-3), `hetzer`, `multiTurret` support (T-28 side turrets),
`truck` (Katyusha), `kettenkrad` (motorcycle front), rocket-rack overlay (251/1, Katyusha rails).

## 5. Build order (each shippable)
1. Weapons batch: kwk43_88, ml20_152, d5t_85, d10_100, m30_122, kt28_76, stuk39_75, kwk40_l43,
   nebel41, bm13, flamewerfer, mortar120, lahti_l39.
2. Vehicle defs + team defs + art specs (most expensive first: Tiger II → IS-3 → SU-152 → IS-1 →
   Panther D/A → StuG IV → SU-100 → SU-122 → pz4g → Hetzer → T-28 → flamethrowers → Kettenkrad →
   rockets (Nebelwerfer team, 251/1, Katyusha) → 120mm mortar team.
3. Mechanics: rockets (3.1) → flame (3.2) → camo nets (3.3) → melee (3.4) → fortifications (3.5).
4. Operation/force-list integration + balance harness pass after each batch.

## 6. Verification
- Unit: new weapons reachable (`ALL_WEAPON_IDS`), every vehicle def has SPEC + HEIGHT_M +
  TEAM_DEFS entry (a new data-completeness test), rocket salvo resolves ≥ burst impacts, flame
  ignites burn, net tears on move (regression test), melee resolves within range.
- Visual: tools sprite preview page extended with all new defIds; deploy + battle screenshot pass.

## 8. Huge maps & scale-up of command (user addition, 2026-09-19) — G32

### 8.1 Map size
- New maps at **≥ 16 km × 16 km** (10×10 miles) — at TILE_M=2 that is 8000×8000 tiles; prefer
  widening the tile to 4–5 m for strategic maps (a TILE_M bump is a global constant change:
  verify LOS ranges, weapon ranges and speeds are all in metres already, so they scale cleanly).
- Aspect: support **wide-than-tall** fronts (attack east with a 2–3× wide map) AND huge squares;
  the attack axis becomes map metadata (`attackAxis: 'n'|'e'|'s'|'w'`) used to place the default
  deploy zones and the briefings ("enemy advancing from the west").
- **Off-axis support**: indirect-fire units may start far outside the combat zone (e.g. south of
  an east-attack map). Requires: (a) deploy zones defined per-team-role (`supportZones` in map
  def, one rect per role: 'line', 'indirect', 'recon'), (b) spotting/LOS unchanged — mortars and
  rockets already fire indirect beyond LOS, but their MIN range may need zone-aware defaults,
  (c) the inset map must scale to the full area with the combat viewport as a sub-rectangle.
- Renderer: terrain painting must stay chunk-tileable (paint per 64-tile chunk on demand);
  camera clamp, edge scroll and the pathfinder (A* with skip-tiling or hierarchical paths) need
  large-map profiles; path budget scales with distance (currently tuned for ~150-tile maps).

### 8.2 Command scale: company → battalion → brigade
- Higher maps imply bigger forces: the kampfgruppe evolves from a company (current ~10–15 teams)
  to a **battalion** (30–60 teams) and **brigade** (100+ teams). Requirements:
  - **Hierarchical command**: teams are grouped into platoons/companies under the player's
    overall command; orders can be issued at group level (select a company marker, issue one
    order that propagates with per-team delay/radio availability).
  - **Command UI**: the team grid must paginate/group by company; an order overlay per group;
    the battle AI assigns un-commanded groups to objectives itself (initiative, G18).
  - **Performance**: sim cost is dominated by soldier count — a brigade ≈ 3000 soldiers. Needs
    (a) soldier LOD (full sim only near camera / in combat; coarse morale-only tick far away),
    (b) spot checks against hierarchical LOS grid, (c) test harness profiles at 3k soldiers.
- Deployment: with 60+ teams the deploy screen needs a list-plus-filter view, not a grid; the
  drag-to-place flow stays per-team, plus "deploy group at marker" bulk placement.

## 9. Additions beyond the original list (my proposals, marked [NEW])
- **Ferdinand/Elephant** (see §1 note), **SU-57(B) Lend-Lease 57mm gun carrier**, **BA-64 scout
  car**, **SdKfz 234/2 Puma** armoured car (recon screen role), **ZiS-30 57mm SP** (early),
  **T-60/T-80 lights** for the 1942 ladder, **Brummbar** for 1944-45 city maps.
