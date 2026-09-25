# CC3 Clone — Visual Evidence Pass (contact-sheet study of all 41 episodes)

Date: 2026-09-18. Method: every episode downloaded (360p proxy), 6×6 contact sheet
(1 frame/min), vision-analyzed by subagents. Evidence chain: `/tmp/cc3frames/`
(`ids.json`, `eNN.mp4`, `sheet_eNN.jpg`). Each tile ≈ 60 s. Claims below are
pixel-grounded; caption-only knowledge is NOT repeated here.

## A. Per-episode screen-type map (what actually appears on screen)

| Ep | Menu | Briefing | Requisition | COA plan | Battle | Debrief | Roster | Campaign map |
|----|------|----------|-------------|----------|--------|---------|--------|--------------|
| E01–E05 (boot camp) | – | in-battle popups only | – | – | ✔ | – | – | – |
| E06 Barbarossa | ✔ | ✔ (+intro video) | – | ✔ | ✔ | ✔ | – | – |
| E07 Lemberg | – | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – |
| E08 Next Stop Lemberg | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ ("KLUSTER" grids) | – |
| E09–E13 Roads to Moscow | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (E12 none) | ✔ (E12 none) | – |
| E14 Campaign Debrief | – | strategic cmd screen | – | – | – | campaign debrief ✔ | – | ✔ |
| E15–E18 Izyum | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (E15/E17 none) | ✔ | ✔ (E15) |
| E19–E22 Stalingrad | – | ✔ | ✔ | ✔ | ✔ | ✔ (E22 none) | ✔ | – |
| E23–E26 Star/Back Hand | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (E23 "Campaign Debriefing" + "HOSTORY" [sic] screen) |
| E27–E31 Kursk/Prokhorovka | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (E31 "CAMPAIGN REPORT") |
| E32–E35 Korsun | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (E32 "CAMPAIGN SUMMARY" with Victory Level gauge) |
| E36 Vistula | – | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – |
| E37–E39 Hermann Göring | – | ✔ | ✔ | ✔ | ✔ | ✔ (E37/E38 none) | ✔ | – |
| E40 Berlin | – | ✔ | ✔ | ✔ | ✔ | – | – | ✔ |
| E41 Cold War | – | ✔ | ✔ | ✔ | ✔ (to end) | – | – | – |

## B. Confirmed visual facts the captions did not (or barely) give

1. **The pre-battle planning chain is a distinct, consistent screen set** — seen in
   nearly every campaign episode: (a) strategy/objective map with **white numbered
   circles ①–⑤/⑥ over the battle map** plus white label boxes naming places/hills
   ("Ford", "Hill 133", "Road to Lemberg", "Spree River"); (b) **"EN COA n" screens**
   — red dashed enemy arrows + red rectangle unit boxes, grey side panel listing
   the enemy plan stages ("River Crossing Stages", "Secure", "Obscure", "Assault",
   "Defend/Delay"); (c) **"FR COA n" screens** — same layout in blue for friendly
   plans. This whole COA-planning phase is a real game screen family (multiple
   COA variants offered per side), not video-editor overlays.
2. **Requisition screen**: dense red/black tabbed tables, two-column unit lists with
   colored strength rows (green/orange/red), tab headers, numbered buttons along the
   bottom. Appears between briefing and COA phase in most campaign battles.
3. **Debrief family**: separate **"BATTLE DEBRIEF"** (stat table + small map
   thumbnail bottom-left), **roster screen** (red header "ROSTER", multi-column
   per-soldier rows with green/red status cells), and **campaign-level debrief**
   ("Campaign Debriefing", "CAMPAIGN SUMMARY" with a green **"Cumulative Victory
   Level" gauge bar**, "CAMPAIGN REPORT"). E23 shows a campaign **history** screen
   (title renders as "HOSTORY" in the original UI) listing prior battle results.
4. **Campaign map screen**: "CAMPAIGN MAP" header, painterly green terrain with red
   battle markers, large bordered debrief/briefing text panels overlaid; strategic
   command screen (E14) shows **"Day 8 of 30" counters, Victory/Prestige stats,
   three map thumbnails + Requisitions button**.
5. **Battle HUD**: consistently a **full-width dark maroon bottom band** with green
   team/soldier status rows (left cluster = friendly, right = enemy entries), a thin
   top status strip, and in several maps a **right-edge vertical roster/minimap
   strip** (E04, E05, E11, E29: left-edge vertical green unit panel). Boot camp
   episodes show **tutorial dialog boxes** (black, white text, red header) pinned
   over the map — scripted lesson popups, matching the caption evidence.
6. **Map art**: hand-painted 2D top-down/oblique pre-rendered terrain; palettes per
   season — summer green/tan fields with hedgerows, snow maps (white ground, brown
   forest stipple, blue-grey frozen rivers), urban (Stalingrad ochre rubble + grey
   factory halls; Berlin grey stone + rust/orange rubble + Reichstag-scale blocks).
   Trees render as dotted stipple clusters; buildings as isometric sprite blocks
   with drop shadows; burning vehicles show yellow fire blobs; white smoke plumes
   rise from burning buildings; numbered multi-story buildings visible.
7. **Units**: tiny multi-pixel sprites; friendly blue/green markers, enemy red;
   green waypoint/path lines and tracer streaks on the map; red target flashes.
8. **UI chrome**: menus/briefing/requisition/debrief share one palette — black or
   dark maroon background, blood-red panels, yellow/gold serif headers, green and
   red body text; red-glow buttons. Battle screen chrome is the maroon HUD only.

## C. Video-production inserts (NOT game UI — do not clone)

- "Extracts from von McDoll's Diary" photo interstitials (B/W photo + script title)
  — one per campaign episode, the narrator's own AAR slide.
- Full-screen doctrine quote slides citing US War Dept TM-E 30-451 / TM 30-430,
  Schneidler's *Panzer Tactics* — narrator's educational inserts.
- Microsoft logo splash, archival intro footage (E06), browser-style pages (E09,
  E21 — narrator showing websites), "Thanks for watching!" outro cards.

## D. Corrections / confirmations vs. the roadmap (grand-campaign-roadmap.md)

- **Confirmed**: 16-operation structure, requisition→briefing→COA→battle→debrief→roster
  flow, campaign map + History screen (E23/E31/E32 evidence), Victory Level gauge,
  day counters, boot-camp popup style. §1 list stands.
- **New gap — G21 (P1, UI/shell): COA planning phase.** Before each battle the game
  presents an objective map (numbered VL circles + labels) and EN/FR course-of-action
  overlays (red/blue arrows + side panel listing plan stages). Clone has none of this.
  Scope: per-operation data (objective names, 2–3 enemy COA variants, friendly COA
  choices), a static briefing-map screen with toggled overlay layers. Low sim risk,
  high "reads like CC3" value — slot after G4.
- **New gap — G22 (P2): KLUSTER/roster grid screens** (E08) — post-battle per-soldier
  stat grids. Subsumed under G13 debrief polish; note the original renders TWO roster
  layouts (per-team and per-soldier).
- **New detail for G4**: the campaign History screen exists as its own screen
  (E23 "HOSTORY" listing), separate from the campaign map — two artifacts, not one.
- **New detail for G13**: debrief stat tables include a small battle-map thumbnail
  bottom-left; campaign summary shows a green Victory Level gauge bar.
- **Boot camp (G5)**: lessons appear as in-battle black tutorial dialogs (not
  separate screens) — build the task-checker modal as a map overlay, matching E01–E05.
- **Requisition (G3)**: screen is tabbed with numbered bottom buttons — keep that
  navigation shape in the requisition 2.0 UI.

## E. Caveats

- 1 frame/min sampling: brief transitions (loading screens, deployment drag phase)
  may be missed; no episode showed an explicit deployment-phase screen, though the
  manual documents it — treat deployment as manual-confirmed, video-unverified.
- Contact-sheet resolution (~320 px/tile) limits text legibility; exact strings and
  button labels are approximate. Full-res frames on demand at any timestamp
  (`ffmpeg -ss <t> -i eNN.mp4 -frames:v 1`).

---

## F. Second pass (2026-09-20, denser grids + full 41-episode coverage)

Method: every episode re-gridded at 5×4 frames per episode (≈ every 1/20 of the
video, 384×216/tile) — `/tmp/cc3grids/grid_eNN.jpg` — one vision pass each,
notes in `/tmp/cc3notes/eNN.md`. This pass confirms the §A table, then diffs
features against the current clone.

### F.1 Feature coverage vs. the clone (what exists, what does not)

| Feature family | Video evidence | Clone status |
|---|---|---|
| Briefing screens | all campaign eps | ✔ `battleSetup.ts` |
| Requisition/force selection | 25 eps | ✔ `operation.ts`/`battleSetup.ts` (shape differs: original is tabbed two-column tables) |
| COA planning (objective map + EN/FR COA overlays) | 26/26 eps — **universal** | partial: `coa.ts` is a stylized front-line summary, NOT the original's objective-map-with-numbered-circles + red/blue COA overlay family → G21 still open |
| Roster screens | 26/26 eps | ✔ `roster.ts` (per-soldier grid; original also has per-team layout) |
| Debrief stat tables + map thumbnail | 22 eps | ✔ `debrief.ts` (thumbnail per §D) |
| Campaign map screen | several eps | ✔ `history.ts`/`operation.ts` |
| In-battle HUD (bottom maroon strip, team bars) | every battle frame | ✔ |
| Inset map | ~all battle frames | ✔ |
| Truce/flee buttons | 23 eps | ✔ bottom strip |
| Smoke plumes | 26/26 eps | ✔ |
| Blast/explosion flashes | many eps | ✔ |
| Right-click order menu | 17 eps | ✔ |
| Zoom (multiple levels, pan) | 26/26 eps | ✔ |
| Victory-location flags | 25 eps | ✔ |
| Debri­ef/debrief screens | 22 eps | ✔ |

### F.2 Confirmed remaining gaps (new, from this pass)

1. **G33 (P2) — Fire-support options in the COA/briefing chain.** E06/E08/E16 show the
   pre-battle fire-support menu: "Mortar … 1", "Artillery (Bty 960, 150mm)",
   "Air Support (Fragmentation)". The clone has no off-map indirect support
   purchase/usage. Scope: per-battle support points (mortar fire missions,
   artillery batteries, air strikes) issued on the COA/deploy screen, resolved by
   the existing indirect-fire splash path; no on-map unit.
2. **G34 (P3) — Time-of-day tint.** E20 shows a clearly darker battle view
   (dawn/dusk) among daylight ones. Scope: per-battle light-level field
   (day/dawn/dusk/night), renderer multiplies scene tint, sim: night cuts spotting
   range (already parameterizable via a light factor hook in spotting).
3. **G35 (P3) — Campaign counters.** E14 strategic command screen: "Day 8 of 30"
   counters, Victory/Prestige stats, three map thumbnails, Requisitions button.
   The clone's campaign screen lacks day counters and prestige; add fields +
   display (sim-logic light).
4. **G36 (P3) — Minefield belts on COA overlays.** E10/E37/E38 show red hatched
   minefield belts drawn on the objective map (the sim already has per-tile mines;
   this is the overlay/artefact view only).
5. **Combined-arms doctrine graphic** (E08/E16: "Guns (Firepower) / Tanks (Armour) /
   Infantry (Mobility)" triangle) — boot-camp flavour asset, G5 material.
6. **COA legend/plan-stage panels** ("River Crossing Stages: Overwatch, Obstacles,
   Cut Fence, Reduce, Assault", legend entries "Defenses, Tanks, Tactical
   Advancement, Fire Support, Armor, Air Support, Assault") — data + layout detail
   to fold into G21 when built.

### F.3 Confirmation notes

- The objective-map + COA overlay family appears in **every one of the 26 campaign
  episodes** — the single most consistent pre-battle screen in the original. G21
  (already P1) is justified by this pass as the top remaining fidelity gap.
- Night/fog-of-war tinted planning maps (dark-shaded map states before battle)
  appear in several episodes — also G21 scope.
