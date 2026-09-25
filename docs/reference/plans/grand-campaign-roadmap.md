# CC3 Clone — Grand Campaign Gap Analysis & Roadmap

Source of truth: the McDoll Strategy & Tactics playlist "Close Combat 3 The Russian Front"
(41 episodes, German Grand Campaign, 2023-03 → 2024-02, video ID `yWXAvs4ENcs` onward),
studied in two passes: auto-generated captions of E01–E38 and E40–E41 (E39 has no captions),
plus a full VISUAL pass (contact sheets of all 41 episodes, 1 frame/min — see
`visual-evidence-pass.md` in this folder). Cross-checked against
`docs/reference/cc3-manual-notes.md` and the current code
(`src/data/operation.ts`, `src/data/units.ts`, `docs/superpowers/specs/2026-09-12-cc3-clone-design.md`).

---

## 1. What the original actually is (as evidenced by the series)

The series plays the **German Grand Campaign: 16 operations × multi-day battle chains, 41 maps
played over ~46 battles, June 1941 → April 1945**. Operation sequence observed on screen:

| # | Operation | Dates in-game | Battles |
|---|-----------|---------------|---------|
| 1 | Blitzkrieg (Barbarossa, drive on Lemberg) | 26 Jun 1941, day 1–5 | 3 |
| 2 | Roads to Moscow (Operation Typhoon) | Nov–Dec 1941, day 1–4 of 10 | 4 (+"Moscow Retaliates" = op 3, day 1–8 of 8) |
| 3 | Moscow Retaliates (Soviet counter-offensive) | Dec 1941 | 1 op, debrief at E14 |
| 4 | Second Battle of Kharkov (Izyum, Fredericus) | May 1942, day 1–5 | 4 |
| 5 | Counter Stroke at Kharkov | May 1942, day 1–3 of 7 | 3 |
| 6–7 | Rattan Creek / Red Barricades (Stalingrad) | Oct–Nov 1942, day 1–8 | 4 |
| 8 | Operation Star (delaying the Dnepr drive) | 30 Jan 1943 | 1–2 |
| 9 | Back Hand Blow (Manstein's counterstroke) | 18 Feb 1943, day 1–3 of 7 | 3 |
| 10–11 | Dog Fight at Kursk / Counter Blow at Prokhorovka | 4–15 Jul 1943 | 5 |
| 12–13 | Korsun Pocket + Relief Attempt | Feb 1944, day 1–6 | 4 |
| 14 | Bridgehead on the Vistula (Magnuszew) | 27 Jul 1944, day 1–6 | 1–2 |
| 15 | Hermann Göring Attacks | Aug 1944, day 1–6 | 3 |
| 16 | Götterdämmerung (Berlin) | 30 Apr 1945, day 1–5 | 2 (+1 custom "Cold War Begins" map) |

Campaign-level mechanics the series exposes (all currently missing or reduced in the clone):

1. **One persistent fighting force for the whole war.** "Kampfgruppe McDoll" (player-renamed,
   e.g. "Kampfgruppe von Moltke") fights every operation, 1941–45. The point of the campaign is
   *preserving and growing* a named company: casualties matter because the same soldiers return.
2. **Per-soldier persistence.** Each soldier has a name, rank, health, morale, leadership,
   experience, medals and an operation history ("History" tab: who fought at Barbarossa vs
   who joined later — "15 members survived from Barbarossa to the last battle").
   Casualty outcomes: healthy / wounded (light, serious, evacuated) / killed; a wounded man
   may return several battles later.
3. **Medals & promotion chain.** Iron Cross 2nd/1st class, Knight's Cross (with bars),
   War Merit Badge (with bars), Assault Badge, Wound Badge, Winter Badge. Kills are *credited
   to soldiers/crews* ("Baumann's gun crew accounted for three tanks"). Promotions
   Gefreiter → Obergefreiter → Unteroffizier → Feldwebel → … officer ranks for the commander
   (platoon leader → Leutnant → Hauptmann → Major), gated by campaign points + performance.
   The commander starts as a literal one-man team ("platoon leader von McDoll, a one-man army")
   and buys a command staff, then command halftrack, then command tank.
4. **Requisition + refit economy.** Per battle: requisition points (difficulty-scaled), a
   **force pool by year** (OOB changes 1941→1945 with named equipment variants:
   Schützen 1941 → Sturm Grenadier 1942/1943/1944, MG34 → MG42 1942/1943, Pz 35(t) →
   Pz IV D/F2 → Panther D/G, Tiger I → King Tiger, Pz 251/10 → Puma, 5 cm PaK → 8.8 Flak,
   Ferdinand → Elefant…), **team slots** (limit), and a **Refit function**: repair damaged
   vehicles, replace casualties, *upgrade* a team to its next-year variant (costs points,
   keeps the men). Vehicles can be "retired" (crew kept, vehicle released). Elite force pools
   (Fallschirmjäger, Waffen-SS?) appear mid-campaign. Winter-ready teams marked with an
   asterisk; at Hero difficulty resources are scarcer.
5. **Operation structure**: briefing screen (operational + battle briefing text, historical
   narrative), day N of M within an operation, operation debrief, campaign debrief with
   running totals (kills/wounded/prisoners/tanks both sides), victory level per battle +
   operation + campaign.
6. **End conditions**: all-VL-taken (with optional 2-minute hold), 15-minute timer in the
   series, fight-to-the-finish; truce requests by the AI (declining a truce is a real choice —
   accepting while behind can end as a defeat); flee; retreat off-map.
7. **Boot camp** tutorial missions (5: moving, firing, commanders & tactics, monitors, armour)
   with scripted tasks that *enforce* completion ("Boot camp won't work if you don't obey your
   orders").
8. **Command screen**: scenario picker, **mission/scenario editor** (map, date, days, weather,
   experience level, briefing text, deployment zones, victory locations, opening artillery
   barrage — E41 builds a custom Reichstag last stand), **History button** with the campaign
   map and per-location historical narrative.
9. **Battlefield features shown repeatedly**: minefields (belts, gaps, lanes; red spheres on
   inset map), bunkers/pillboxes with barbed wire, tank turrets dug in as fixed guns,
   petroleum barrels that deflagrate, frozen rivers passable to vehicles, mud that bogs
   vehicles ("Marshall Mud"), snow/winter attrition, burning/ruined buildings, multi-story
   buildings with numerals, command radius visualised (spacebar; team info bar set to show
   command), suppression/team info bars switchable (ammo / morale / suppression / command).
10. **AI behaviour** (E15: "the enemy, or at least the AI, seem to be learning"): massed tank
    thrusts at a weak point, double envelopment attempts, truce requests when losing, refuse
    to cooperate (infantry attacking without tank support is a failure mode of the *Russian* AI
    in E22), conscript/militia routing under threat (E41 Volkssturm flee when the Reichstag
    falls).
11. **Aesthetics/UX**: 1920×1080 play at battle screen; requisition/briefing/debrief screens
    small in the original; soldier monitor shows per-soldier health; team info bars per option;
    supply truck columns, priests' churches as landmark VLs, named buildings (Borisov's house,
    St Sophia's church, the Larat workshop) used in briefings.

---

## 2. Current state of the clone vs. the original

Have (verified against code/tests): 7 orders incl. smoke/defend/ambush + waypoints + group
orders; LOS/spotting with concealment, tall grass, facing; directional cover + cover seeking;
soldier mind (stress/fear/motivation/traits); crew-served weapons with packing/abandoning;
indirect fire with spotting quality; vehicle armour by facing, penetration, immobilise/bailout;
structure damage + 0.5 m height field; morale cascade, panic/break/rout/surrender; truce/flee;
5-battle linear operation with requisition points and per-year OOB; deployment zones; victory
locations; debrief; procedural art/audio; big test suite.

Gaps, ranked by how load-bearing they are to the CC3 *campaign feel*:

### P0 — the campaign is the game
- **G1 Persistent kampfgruppe with per-soldier careers.** `src/data/operation.ts` has six
  battles with AI force lists only; no player persistence, no soldier roster, no experience
  carry-over, no wounds healing over time, no kill crediting.
- **G2 Medals, promotions, kill credits, commander rank.** No data model at all.
- **G3 Requisition + refit screen.** There is a requisition of fixed points, but no force pool
  browsing, team slots, refit (repair/replace/upgrade), retire, or year-variant upgrades.
- **G4 16-operation structure with day N of M, operational + battle briefings, operation and
  campaign debriefs, running totals, History screen.** Clone has one 5-battle operation with
  one-line titles.
- **G5 Boot camp (5 tutorial missions with enforced tasks).**

### P1 — battlefield content
- **G6 Minefields** (belts, gaps, lanes, red spheres on inset, clearing: engineers, mine-roller
  tanks, barrage detonation, sneak reduces detonation chance).
- **G7 Bunkers/pillboxes & barbed wire** (withstand ≤ 100 mm; wire slows infantry).
- **G8 Seasonal ground states with tactical teeth**: frozen river = vehicle-passable; mud bogs
  vehicles (chance per move attempt, immobilise); deep snow slows; winter-ready teams vs
  attrition for non-winter teams.
- **G9 Fixed turret emplacements** (dug-in tank turrets), **fuel barrels** (deflagration),
  named landmark buildings surfaced in briefings and message monitor.
- **G10 Multi-story buildings with floor numerals + auto-occupancy of top floor + roof hide**
  (height field exists; occupancy/roofs don't).

### P1 — UI / shell
- **G11 Team info bar modes** (ammo / morale / suppression / command) instead of fixed bar.
- **G12 Command radius visualisation** (toggle).
- **G13 Debrief**: per-team and per-soldier casualty list, medals awarded, kill credits,
  VL expectation arrows, prisoners ×3 value, difficulty/realism scoring.
- **G14 Truce as AI-initiated negotiation** (currently player-initiated only, per bottom strip).
- **G15 Scenario editor + custom scenarios**; campaign map/History screen.
- **G16 Options screen**: team/soldier monitor toggles (F5/F7 exist), scroll speed, realism
  options (always see enemy, never act on initiative, always full enemy info, always obey
  orders) affecting a tournament-style score modifier.
- **G21 COA planning phase (visual pass, P1).** Before most campaign battles the game
  shows an objective map (white numbered circles over the battle map + place labels)
  then "EN COA n" / "FR COA n" overlays — red/blue dashed arrows and unit boxes with a
  side panel listing plan stages ("Secure", "Obscure", "Assault", "Defend/Delay",
  "River Crossing Stages"). 2–3 COA variants per side. Per-operation data + one static
  briefing-map screen with toggleable overlay layers; slot after G4. See
  `visual-evidence-pass.md` §D.
- **G22 Roster screen family (visual pass, P2).** The post-battle roster is its own
  full-screen red/black table (red "ROSTER" header, per-team AND per-soldier layouts,
  green/red status cells); debrief tables carry a small battle-map thumbnail bottom-left,
  and the campaign summary shows a green "Cumulative Victory Level" gauge. Fold into G13.
  The campaign History screen is a separate artifact from the campaign map (E23).
- **G23 Deploy-phase facing follows the defend arc (user observation).** On the deploy
  screen, whenever a Defend order's arc is shown for a team (default armour Defend from
  `DeployScreen.onEnter`, or a player-issued Defend during deployment), the vehicle, gun
  and its infantry crew must visibly rotate to face the arc's bisector the moment the arc
  is drawn — not only when the battle begins. Currently `applyOrder` sets `s.facing` only
  via the sim's order-apply path (`src/sim/orders.ts`), which the deploy screen invokes
  eagerly, yet hulls/guns render at their spawn heading until Begin. Fix in
  `DeployScreen`'s order-issuing + default-order pass: after issuing any Defend (and the
  initial Ambush for infantry), set the team's vehicle/soldier facing from the order
  target (`facingFromAngle(angleTo(pos, order.target))`) so the deploy rendering matches
  the arc. Acceptance: on entering deploy, every tank/gun faces its Defend arc centre;
  re-issuing Defend during deployment re-turns the unit immediately.

### P2 — sim polish toward the original's behaviour
- **G17 Prisoners**: capture flow (surrounded + suppressed → surrender), prisoner value ×3,
  prisoners marched off map, E27-style "release prisoners" is flavour only — skip.
- **G18 Initiative for friendly teams**: AI-only subordinates occasionally act on their own
  (E13: Ulrich's squad assaulting on initiative, endorsed by the commander) — mind.ts has the
  machinery; expose a "subordinate initiative" event with a player confirm/overrule.
- **G19 Hand-to-hand combat** in building clearance (Klein-Schulz killed in hand-to-hand E08).
- **G20 Victory location expectation arrows** on debrief (performance vs briefing expectation).

---

## 3. Proposed architecture for the campaign layer

```
src/campaign/
  types.ts        SoldierRecord, TeamRecord, Medal, Promotion, OperationState,
                  RequisitionOffer, RefitOption
  roster.ts       persistent soldier/team store; wound recovery schedule; kill credits
  oob.ts          per-year force pool: team defs + upgrade chains (team A '40 → '42 → '43)
  requisition.ts  points, slots, force pool ↔ active roster, refit/retire/upgrade resolution
  medals.ts       award rules (kills, wound badges, winter badge, assault badge), promotions
  operations.ts   the 16 operations: maps, days, briefings, VL expectations, barrages
  state.ts        campaign save/load (localStorage JSON), campaign debrief aggregation
  history.ts      campaign map + per-location narrative text
```

Key decisions:
- **Soldier identity lives in the campaign, not the battle.** `battle.ts` emits per-soldier
  events (kia, wound severity, kill credit with weapon/vehicle, prisoner capture, medal-worthy
  action from mind.ts bravery tracking). `roster.ts` folds events into records between battles.
  Battle stays deterministic and seedable; campaign is pure reducer over battle reports.
- **Teams are (def, soldier ids, vehicle id, ammo/supply state).** Refit = swap def (upgrade
  chain), repair vehicle (points), replace KIA from replacements pool (new named soldiers,
  lower starting experience). Wounded soldiers unavailable for N days of operation time.
- **OOB variants are data**: extend `src/data/units.ts` with year-suffixed defs
  (`ger_rifle_41`, `ger_sturm_42`, `ger_sturm_43`, `ger_mg42_43`, `ger_pz4f2`, `ger_pz5g`,
  `ger_tiger`, `ger_kingtiger`, `ger_ferdinand`, `ger_elefant`, `ger_puma`, `ger_flak88`,
  `sov_lend_lease`, `sov_is2`, `sov_su152`, Volkssturm `ger_volkssturm_45`…) and an
  `upgradesTo` field forming the refit chains the videos show.
- **Determinism**: all campaign randomness (replacement names, recovery rolls) from a
  campaign seed stored in the save.

## 4. Build order (suggested increments, each shippable)

1. **Roster persistence (G1)** — battles report per-soldier outcomes; roster screen after
   debrief showing names, health, experience, kills; wounded recovery across battles.
2. **Requisition 2.0 (G3 partial)** — force pool list, team slots, points by difficulty,
   rename teams; refit (repair/replace) inside it.
3. **Upgrade chains + year variants (G3)** — data for German and Soviet lines 1941–45.
4. **Medals/promotions/kill credit (G2)** — award rules + debrief medals panel + commander
   rank affecting requisition points & slots.
5. **16 operations + briefings + debriefs + campaign totals (G4)** — maps can reuse the seven
   existing maps with different VL/season/sides initially; briefings carry the operational/
   battle text (paraphrase the originals' structure, own words — copyright).
6. **Minefields (G6)**, **bunkers/wire (G7)**, **ground states (G8)** — sim + map DSL + inset
   map rendering + tests (mine detonation chance, bog chance, frozen-river passability).
6b. **COA planning phase (G21)** — objective-map screen with numbered VL circles and
   EN/FR overlay layers; data-only, no sim change; goes between increments 6 and 7.
7. **Shell polish (G11–G16)** — info-bar modes, command radius, truce negotiation, options,
   History screen, scenario editor (last — only if still wanted; it's a big surface).
8. **Boot camp (G5)** — 5 scripted tutorial battles reusing the battle engine with a task
   checker (task = predicate over battle state; fail → modal, as in the original).

## 5. Verification plan

- Unit: roster reducer (kill/wound/recovery/medal), refit cost math, upgrade chains, mine
  detonation & bog probabilities, prisoner value.
- Integration: full-campaign headless run (AI both sides) completes 16 operations without
  exception; save/load round-trip equality; seed reproducibility.
- Playtest gates per increment against the checklist in §1 (does the battle read like E06/E15/
  E29/E40? smoke barrage → fire line → assault; guns winning the firefight; AI massing tanks).

## 6. Second visual-evidence pass gaps (2026-09-20, see visual-evidence-pass.md §F)

- **G33 Fire-support options (P2)**: pre-battle mortar/artillery/air-support menu
  (E06/E08/E16); off-map fire missions resolved via the indirect splash path.
- **G34 Time-of-day tint (P3)**: per-battle light level (day/dawn/dusk/night);
  renderer tint + spotting-range factor (E20 evidence).
- **G35 Campaign counters (P3)**: "Day N of 30", Victory/Prestige stats on the
  strategic command screen (E14).
- **G36 COA minefield overlay (P3)**: hatched minefield belts on the objective map
  (E10/E37/E38); sim mines exist, this is the planning view.
- **G21 reaffirmed P1**: the objective-map + EN/FR COA overlay family appears in all
  26 campaign episodes — the most consistent missing screen family.
