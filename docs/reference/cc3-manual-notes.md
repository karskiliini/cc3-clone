# Close Combat III: The Russian Front - User Manual Summary

## Combat Screen Layout and Interface

The combat screen is the main battlefield display where players control units and issue orders. Key screen elements include:

- **Combat Screen**: Main map area showing the battlefield, unit positions, and terrain
- **Team Data**: Displays the status of every team in the fighting force (toggleable)
- **Soldier Monitor**: Shows the status of individual soldiers within a team (toggleable, can be repositioned)
- **Inset Map**: Small thumbnail map in lower-left corner (toggleable) showing the entire map; clicking on it repositions the main view
- **Message Monitor**: Lower-right portion of the screen displays communication from teams with real-time status updates
- **Team Information Bars**: Appear above each team in normal view (hidden when zoomed in/out); show quick status information such as experience level
- **Zoom Controls**: Toolbar buttons to zoom in (magnifying glass with plus) or zoom out (magnifying glass with minus)
- **Scroll Controls**: Move mouse to screen edges or use arrow keys to scroll the map
- **Map Button**: Toggles the inset map on/off
- **Options Button**: Accessed via toolbar or pressing F8 from any screen

## Orders and Command Menu

### Order Types

Orders are issued by right-clicking any soldier in a team. The menu presents three categories:

**Movement Orders:**
- **Sneak**: Slowest, safest movement. Soldiers crawl, stick to cover, watch for enemies, try to avoid detection. Ambush order takes effect upon destination. Order dot color: Yellow
- **Move**: Normal movement rate. Units watch for attack while moving, defend if engaged. Defend order takes effect upon destination. Order dot color: Blue
- **Move Fast**: Maximum speed. Soldiers prioritize reaching destination over defense. Run or sprint if under fire. Will assault enemy-occupied locations and attempt hand-to-hand combat. Order dot color: Purple

**Targeting Orders:**
- **Fire**: Issue fire on a target location. Two types: direct fire (requires line of sight) and suppression fire (general area spray). Order dot color: Orange (suppression) or Red (direct)
- **Smoke**: Lay smoke screen at designated location. Infantry can throw smoke grenades up to 30 meters (15 meters if prone). Order dot color: Gray

**Dig-In Orders:**
- **Defend**: Units take cover and stand ground. Default order for armor at battle start. Blue arc appears showing defend zone. Teams watch for approaching enemies and return fire; may take offensive action independently.
- **Ambush**: Units keep heads down and launch ambush when enemy comes within 30 meters or closer. Green arc appears. Valuable when out of ammunition or too injured. Default order for infantry and support teams at battle start.

### Waypoints

Move, Move Fast, or Sneak orders support multiple waypoints to control unit routes:
1. Select team and issue movement order
2. Drag pointer to first waypoint location
3. Hold SHIFT, click, and continue holding SHIFT
4. Repeat until placing final order dot
5. Release SHIFT for final position
The final path segment determines defend/ambush arc facing.

### Order Dot Colors Reference
- Blue: Move
- Purple: Move Fast
- Yellow: Sneak
- Orange: Fire (suppression)
- Red: Fire (direct)
- Gray: Smoke
- Green arc: Ambush
- Blue arc: Defend

### Group Orders

Drag rectangle around multiple teams to issue same command to all. Move/Move Fast/Sneak orders position dots relative to team positions. Defend/Ambush maintain relative positions (with adequate cover). Fire/Smoke center all teams on selected target.

### Line of Sight (LOS) Tool

During deployment or with Fire orders, press ALT and swing target dot across desired coverage area. Line color indicates LOS:
- Bright green: Clear, effective field of fire
- Dark green: Obscured but not blocked; reduced hit chance possible
- Red: Blocked, no chance of hitting target

## Soldier and Team Status

### Soldier Health States
- **Healthy**: Full combat effectiveness
- **Slightly injured**: Reduced effectiveness
- **Incapacitated**: Cannot fight
- **Panicked**: Frightened state; may ignore orders
- **Dead**: Killed in action
- **Surrendered**: Captured by enemy; moves toward enemy side of map

### Team Morale and Psychological States
- **Good morale**: Teams perform well, follow orders, maintain cohesion
- **Bad morale**: Teams may ignore orders, panic, and eventually run
- **Pinned**: Suppressed by enemy fire
- **Cowering**: Hiding due to suppression
- **Panicked**: Fleeing in fear; reduced effectiveness
- **Berserk**: In frenzied attack state
- **Broken**: Unit cohesion shattered; troops reluctant to fight
- **Routed**: Complete collapse; unit flees map
- **Fled**: Unit has left the battlefield

### Team Activity States (shown via naming indicators)
- **Sneaking**: Moving cautiously to destination
- **Seeking Cover**: Moving toward cover position
- **Ambushing**: Waiting in ambush position
- **Assisting**: Supporting nearby unit
- **Can't See**: No line of sight to target
- **Engaged**: In active combat with enemy

### Colored Name Bars
Teams display colored name bars indicating morale/status:
- Different colors represent unit state and morale level
- Bar color changes reflect real-time unit conditions

## Weapon Systems and Fire

### Fire Types
- **Direct Fire**: Requires clear line of sight (LOS). Used by rifles, machine guns, tank guns, artillery.
- **Indirect Fire**: Does not require LOS (though LOS improves accuracy). Only mortars and rockets use indirect fire.

### Range Indicators
When issuing Fire order, range indicator (in meters) appears at line end with color coding:
- **Green**: Good range
- **Yellow**: Adequate range
- **Red**: Poor range
- **Black**: Very poor range

### Suppression Fire
Firing at enemy position without necessarily hitting soldiers. Keeps enemy pinned, reduces morale and effectiveness, prevents return fire. Machine guns and mortars especially suited for suppression. Sustained suppression can cause teams to panic and run.

### Weapon-Specific Notes
- Rifles, machine guns, tank guns, artillery: All require clear LOS
- Mortars, rockets: Can fire over obstacles via indirect fire
- Hand grenades, explosives, Molotov cocktails: Used automatically by teams when in close proximity to enemy
- Infantry smoke grenades: Maximum 30m range (15m if prone)

## Deployment and Map Elements

### Deployment Zones
- **Unshaded areas**: Portion of map under player control at battle start; deploy anywhere here
- **Dark gray areas**: Enemy-controlled territory
- **Light gray areas**: Neutral territory
- Shading disappears after clicking Begin button

### Buildings and Terrain
- **Multistory buildings**: Labeled with numerals (2, 3, 4) indicating floors
- **Building mechanics**: Non-AT teams automatically move to highest floor; roofs disappear when friendly troops occupy
- **Terrain features**: Hills, ditches, foliage, streets, forests
- **Right-click detail view**: Hold right-click on terrain element to see information in lower-left corner

### Victory Locations
- Buildings or terrain elements of strategic/tactical importance
- **Zoomed in**: Designated by flags of controlling side
- **Zoomed out/inset map**: Crosses = German victory locations; Stars = Russian victory locations
- **Mixed control**: Half of each flag shown if both sides engage in battle for location
- **Strategic**: Capture enemy locations and replace flags with your side's color; protect your own

### Minefields
- **Red spheres**: Visible when fully zoomed out; indicate minefield locations
- **Cleared sections**: Turn green after clearing path through minefield
- **Clearing methods**:
  - Mine-roller tanks (move forward, use extreme caution when backing)
  - Engineer teams (use Sneak command)
  - Infantry (Sneak command reduces detonation chance)
  - Mortar or artillery barrage (detonate mines from distance)
  - Conscript units (expendable units to clear paths)

## Requisition and Force Pool

### Requisition Screen Elements
- **Force Pool**: List box showing available teams for selection
- **Active Roster**: List box showing selected teams for current battle
- **Asterisk marking**: Denotes teams equipped for winter conditions
- **Requisition Points**: Currency used to "buy" teams; displayed lower-right corner
- **Team Slots**: Number available depends on primary commander rank (up to 15 teams maximum)
- **Details Button**: View detailed information and current unit status
- **Retire Button**: Remove team from Active Roster back to Force Pool
- **Revert Button**: Cancel all selections; return Force Pool and Active Roster to original state

### Team Types
- **Command teams**: Provide command and control on battlefield; improve performance of teams within command radius
- **Infantry teams**: Foot soldiers armed with rifles, submachine guns, hand grenades; may carry machine guns, flamethrowers, antitank (AT) weapons
- **Armor teams**: Tanks, tank destroyers, self-propelled guns, armored cars
- **Support teams**: Halftracks, field guns, mortars, machine guns, flamethrowers, AT weapons

### Unit Quality Levels
- **Conscript**: Poor training, adequate weapons
- **Regular**: Standard training and equipment
- **Elite**: Best training, finest weapons
- Individual unit capability varies within each quality tier

### Scenario Modes
- **Battles**: Single map, one-time engagement
- **Operations**: Series of consecutive battles with results carrying forward (destroyed teams unavailable in subsequent battles, survivor experience/cohesion improve)
- **Campaigns**: Series of operations played consecutively
- **Grand Campaign**: All operations covering four-year war duration

## German Units (Wehrmacht)

### Infantry Teams
- **Rifle Teams (Schützen)**: Backbone of German army; armed with bolt-action Mauser Kar 98 rifles, effective at short-to-medium range; early AT: cluster bombs; later AT: Panzerfäuste
- **Scout Teams (Aufklärungs-Assault)**: Served as "eyes" for Wehrmacht; submachine guns (MP-40); effective in close-quarters fighting (house-to-house, forests); early no AT weapons; later had Panzerfäuste
- **Heavy Assault Teams (Kampfstaffel)**: Carried heavy weapons—MG-42 assault versions, FG-42, cluster bombs (early), Panzerfäuste (later); heavy firepower at medium-to-long range; slower due to weapon weight

### Support Weapons
- **Flamethrower Teams**: Flammenwerfer units; used against strongpoints, infantry, vehicles; effective in ambush with infantry support; dangerous to operators; heavy, limiting mobility
- **Mortar Teams**: Granatenwerfer (5cm, 8cm, 12cm); close support artillery; support attacks, break up assaults, lay smoke screens, shell enemy mortars/artillery; 5cm and 8cm mobile; 12cm hard to move; ammunition scarce on Russian Front
- **Machine Gun Teams (MG-42)**: Perhaps best machine gun of WWII; high rate of fire, interchangeable barrels; devastating vs. infantry and light vehicles; 25 lbs—more mobile than Russian counterparts
- **Antitank Teams (Panzerschreck)**: Hand-held rocket launchers; electrically fired; effective vs. tanks, vehicles, other targets; ~20 lbs, ~65 inches long; effective to 125 meters (design based on captured American bazookas)
- **Antitank Guns (5.0cm PaK 40, PaK 37-43, FlaK 43)**: Higher rate of fire than tank-mounted equivalent caliber; critical early war when T-34 and KV-1 superior; positioned with protection, camouflage, infantry/MG/mortar support

### Armor and Vehicles
- **Light Tanks (Panzer Mark II, 35(t), 38(t))**: Used similar to armored cars and halftracks; especially employed after recognizing T-34 superiority
- **Medium Tanks (Panzer Mark III, IV)**: Mainstays of panzer units; constant improvement throughout war (thickened armor, upgraded guns); never matched T-34; required dangerously close range for penetration; narrow treads bogged in mud/snow
- **Medium Tank (Panzer V Panther)**: Designed after T-34 experience; better armor and firepower than III/IV; faster and more maneuverable than Tiger; perhaps best all-around tank of war; initially had reliability issues; tough one-on-one vs. heaviest Russian tanks; never produced in sufficient numbers
- **Heavy Tanks (Tiger I)**: Introduced 1943 as answer to Russian KV-1, KV-2, and T-34; nearly impenetrable armor; high-velocity 8.8cm gun deadly vs. all mid-war opponents; slow, poor maneuverability
- **Heavy Tanks (Tiger II/Panzer VI Ausf A King Tiger)**: Heaviest tank of war; late 1944 arrival (Russian Front and Ardennes); heavy Panther variant; low speed, cumbersome width; formidable in cover or formation; too slow for open fighting
- **Tank Destroyers (Jagdpanzer IV, JagdPanther, JagdTiger, Hetzer)**: Heavily armored fixed-gun versions of Panzer IV/Panther/King Tiger; some of war's most effective; JagdPanther and JagdTiger had armor and firepower to engage any Russian tank; vulnerable without traversing guns vs. flank attacks
- **Heavy Tank Destroyers (Ferdinand/Elefant)**: Based on Tiger I chassis; heavy armor, 8.8cm main guns; match for any Russian tank; lacked speed and maneuverability; forward-only machine guns vulnerable to infantry with explosives/flamethrowers; devastating when properly supported
- **Halftracks (SdKfz 250/251 variants)**: Armed with machine guns (devastating vs. infantry), mortars, Wurfrahmen rockets (mobile artillery); thin armor makes susceptible to small arms/machine guns at short range
- **Armored Cars (SdKfz 232)**: Even faster than halftracks; normally machine gun-armed; no match for tanks; used for reconnaissance or vs. infantry
- **Mine-Roller Variant Tanks**: Front-mounted rollers detonate mines; clear paths through minefields moving forward; must use extreme caution when backing (risk of destroying unexploded mines)

### Panzerfaust
- **Panzerfaust 30M, 60M, 100M**: Simple hand-held percussion-fired weapon; available from 1943; takes out most Russian tanks under 150 meters; single-shot, single-use; distributed one or two per German infantry unit; required good aim at side or rear of medium/heavy tanks

## Soviet/Russian Units

### Infantry Teams
- Various conscript, regular, and elite formations
- Armed with rifles, submachine guns, hand grenades
- AT weapons: AT rifles, Panzerfaust equivalents, Molotov cocktails, antitank grenades, grenade bundles

### Support Weapons
- **Heavy Machine Guns (Maxim M1910, Goryunov)**: Maxim based on WWI design; slow rate of fire; heavy slug with good muzzle velocity; Goryunov more modern design; improved rate of fire without reducing power; cumbersome to move and time-consuming to setup
- **Rocket Launcher Teams (Bazooka/Lend-Lease)**: American-supplied bazookas (thousands shipped via Lend-Lease); proved so effective Russians produced their own replacements for AT rifles; most effective at short range (side of tank) or medium range (rear); equivalent to German Panzerschreck

### Antitank Weapons
- **Antitank Rifles (Simonov PTRS-41, Mosin-Nagant AT Rifle M1891/30)**: Heavy, high-velocity rifles; preferred infantry AT weapon pre-WWII; 14.5mm caliber, effective to 1,000 meters early war; required nerve and skill; poor vs. heavier tanks; many used early war; holdover from WWI

### Light Tanks
- **Light Tank Series (BT-7m, BT-5, T-26C, T-60, T-70)**: Fast and maneuverable; hopelessly undergunned and underarmored vs. German tanks heavier than Panzer III; one earned nickname "coffin for seven brothers"; effective when used like halftracks or armored cars; helpless vs. most tanks and AT guns

### Medium Tanks
- **T-34/76**: Workhorse of WWII; more produced than any other tank in any army; rugged chassis, wide tracks, excellent all-around mobility; powerful reliable engine; easy to operate and maintain; sloped armor maximized protection while reducing weight; 76.2mm gun destroyed any early-war German tank; refined throughout war; inspired Panther design

### Heavy Tanks
- **KV Series (KV-1, KV-2)**: Along with T-34, surprised Germans who were told Russians only had antiquated few tanks; packed more punch than any German tank until Tiger (1943); slower and less well-armored than T-34; still formidable
- **Josef Stalin III (IS-3)**: Historians debate actual WWII combat; first seen at May Day parade Moscow 1945; best heavy tank at war's end; faster and more maneuverable than any other heavy tank; armor stopped all but heaviest German guns; high-velocity 122mm gun superior to any German tank gun; longer reload time than many competitors

### Specialized Units
- **Snipers**: Russian soldiers with excellent marksmanship; served as forward observers and officer hunters; targeting officers reduced unit cohesion and morale; received special training in hand-to-hand and close-quarter fighting
- **Ski Troops**: Mobile winter forces; Red Army adapted tactics after embarrassing losses to Finnish ski troops (Winter War 1940)
- **Female Combat Personnel**: Women served in virtually all military capacities—pilots (flew biplanes in precision night bombing), transport units, combat units alongside men; gynecologist added to medical staff of units with women

## Game Modes and Battle Mechanics

### Starting a Battle
After requisitioning troops, players deploy units on the combat screen:
1. Units can be repositioned via click-and-drag
2. Group select allows moving multiple units together maintaining relative positions
3. Initial orders (one per team) can be issued before clicking Begin
4. Redeploying unit or issuing second order cancels first order
5. Enemy units invisible initially; become visible when player's teams see them

### Battle End Conditions
**Selectable end conditions:**
- **Fight to the finish**: Battle ends when one side wiped out (default)
- **When time expires**: Battle ends when timer runs out (set 1-99 minutes)
- **After taking all victory locations**: Battle ends after capturing enemy victory locations
  - Optional: Hold for two minutes—battle only ends if victory locations held for 2 minutes; continues if enemy recaptures location before time expires

**Other end conditions:**
- **Truce**: Both sides must click Truce button; if accepted while one side holds all victory locations, that side wins
- **Retreat**: Issue orders for units to move off map (no surrender of teams)
- **Flee**: Immediate battle end; enemy takes control of entire map

### Prisoners and Rallying
- **Captured soldiers**: Become prisoners, move toward own side of map, don't participate
- **Taking prisoners**: Bracket or surround enemy with suppression fire, then assault at close range
- **Prisoner value**: Worth three times normal requisition value at scenario conclusion
- **Rally separated soldiers**: Move team closer to separated soldier to encourage rejoin; commander proximity helps prevent desertion and encourages return

### Scoring and Victory Determination

**Debriefing screen shows:**
- **Victory level**: Total, decisive, major, minor victory; or equivalent defeat
- **Performance rating**: Single or double arrows and point equivalents indicate performance vs. expected
  - **Force strength**: Surviving teams' requisition value + remaining points minus starting value
  - **Casualties**: Enemy damage inflicted; prisoners worth three times normal value
  - **Land gained**: Victory locations captured vs. expected

**Victory location expectations**: Displayed on map briefing; deviations from expected create arrow ratings (down arrows = underperformance; up arrows = outperformance)

### Difficulty Levels
- **Recruit**: Own side given every advantage in strength, morale, supplies
- **Veteran**: Sides balanced as historically accurate
- **Hero**: Own side initially at disadvantage; campaign mode features far fewer resources
Affects: Daily requisition points (fewer at harder levels), score handicapping, promotion point difficulty

### Realism Options (affect tournament scoring)
- **Always see enemy**: Enemy units always visible (normally realistic limited view)
- **Never act on initiative**: Units only act on direct orders (normally some independent action)
- **Always have full enemy info**: Receive summary team information (normally limited)
- **Always obey orders**: Units do exactly as commanded (normally show some initiative)
Higher realism = lower tournament score adjustment

## Terrain, Cover, and Line of Sight

### Terrain Features
- **Open terrain**: Long, wide sight lines; short-range weapons (submachine guns, flamethrowers) less effective; high-rate-of-fire weapons valuable; minimal natural cover
- **Urban/City fighting**: Streets offer ambush opportunities; heavy weapons require effective fields of fire; positioning at street intersections/corners critical; multistory stone buildings with good fields of fire defensible; single-story wood buildings surrounded by trees less defensible
- **Forests**: Dense trees reduce sight lines and fields of fire; restrict mobility; ambush opportunities similar to urban fighting; tanks can knock down trees; trenches and earthworks important
- **High ground**: Advantage for defense; better fields of fire; harder for attackers to assault from below
- **Multistory buildings**: Indicated by numerals (2, 3, 4); non-AT teams automatically occupy highest floor; roofs visible until friendly troops control building

### Cover Types
Different terrain provides varying concealment and protection:
- **Linear cover** (walls, trenches, gullies): Good protection vs. perpendicular fire; poor concealment and protection vs. parallel fire
- **Wooden buildings**: Protect from submachine gun fire; vulnerable to machine guns and AT rounds
- **Stone buildings**: Withstand all weapons except large guns (75mm or greater)
- **Pillboxes**: Withstand all but 100mm or greater guns
- **High grass**: Effective concealment; minimal protection from enemy fire
- **Deep ditch/stone wall**: Provides both cover and protection

### Fields of Fire
- Equates to team's line of sight
- Tree or building blocking LOS also blocks field of fire
- Check field of fire by issuing then canceling Fire order
- Line color indicates effectiveness:
  - **Bright green**: Clear, effective field of fire
  - **Dark green**: Obscured; reduced hit chance but possible
  - **Red**: No chance of hitting target
- Weapon type determines field of fire depth:
  - Submachine guns, personal AT (Panzerfaust), flamethrowers: Shortest range
  - Rifles, machine guns: Medium range
  - Heavy guns: Longest range

### Line of Sight Mechanics
- Obstructions between weapon and target affect LOS
- When issuing Fire order, line color describes LOS quality
- Clear visibility required for direct fire weapons
- Mortars and rockets use indirect fire (LOS not required, though helpful)

## Game Scale and Navigation

### Zoom Levels
- Zoom in (magnifying glass +): Detailed view of small area
- Zoom out (magnifying glass -): See larger battlefield portions
- Team information bars only visible at normal zoom level (hidden when zoomed in/out)
- Soldier outlines visible only in normal and zoomed-in views

### Overview Map (Inset Map)
- Thumbnail map appears lower-left corner by default
- Shows entire battlefield
- Click location on inset map to reposition main combat view
- Can be toggled on/off with Map button
- Can be repositioned by right-clicking and dragging
- Red spheres on inset show minefield locations (turn green when cleared)
- Crosses on inset = German victory locations
- Stars on inset = Russian victory locations

### Map Scrolling
- Move mouse to screen edges (right, left, top, bottom) to scroll
- Use arrow keys for scroll control
- Scroll speed adjustable in Options (General tab)

## Additional Notes

### Game Saves and Persistence
- Single battles don't save progress
- Operations and campaigns auto-save after each battle
- Game automatically saved under chosen scenario name
- Custom games saved in \games\battles folder
- Can be copied to other computers and pasted in \games\battles folder
- Appear in Command screen with other custom scenarios

### Multiplayer Connection Methods
- Internet TCP/IP
- IPX
- Modem
- Serial
- MSN Gaming Zone

---

**Manual Coverage**: This summary captures approximately 90-95% of the original user manual, covering all major gameplay mechanics, unit descriptions, battle interface, command systems, and strategic/tactical information. Some historical context paragraphs and advanced customization features may not be fully detailed, but all core gameplay elements are documented.

## Manual deep dive (2026-09-22, artifact://1059 full text vs the notes above)

Load-bearing rules the sections above did not capture:

### Input card (back cover)
- Z=Move, X=Move Fast, C=Sneak, V=Fire, B=Smoke, N=Defend, M=Ambush. SPACEBAR shows command
  radii; arrows scroll; ESC quits without saving; F3/PAUSE pause; F5 team monitor, F6 inset map,
  F7 soldier monitor, F8 options; right-click during aiming cancels the order line before the dot.
- CTRL+number saves a group to that number; CTRL+K killed/incapacitated, CTRL+T trees,
  CTRL+S sound, CTRL+M music, CTRL+V video toggles.
- Web-build deliverability: every bound key preventDefaults against its browser default
  (arrows/space/tab, F-keys, Ctrl+S/T/K/M/V, Ctrl+number) — F3/F5/F6/F7/F8 and the Ctrl chords
  are cancelled and reach the game. **Exception: CTRL+T is reserved by Chrome/Firefox at the
  browser level (new tab) — the keydown never reaches the page, so tree display has no live
  binding in a web build** (the handler exists and fires under any shell that captures keys
  first, e.g. a native/fullscreen wrapper). Everything else on the input card is deliverable.

### Fire model constants
- Targeting-dot kill bands: green 100–60 %, yellow 59–30 %, red 29–10 %, black 9–0 %.
- Indirect lines: brown = no LOS (low accuracy), orange = clear LOS (high accuracy). Mortar/rocket
  teams draw orange/brown, never red/green; out of rounds they fall back to the direct palette.
- LOS is per-soldier (each man individually); partial-team fire is expected ("if only one soldier
  begins shooting, he is probably the only one with a clear line of sight").
- Small-arms fire suppresses crews into buttoned-up hatches → worse spotting; open-topped vehicles
  (Marder) are extra vulnerable to close infantry. Ambush stops ongoing firing and holds until
  the enemy is within 30 m.

### Movement / tanks
- Move = reverse when retreating (front armour to the enemy); Move Fast turns the hull (rear
  exposed). A moving tank is harder to hit but fires less accurately.
- Fatigue: Move Fast tires much faster; heavy-weapon teams (mortars, MG, flamethrower) fatigue on
  movement and lose effectiveness; break long moves into waypoint segments.
- Orders can be REFUSED (low morale / under fire); right-click any soldier issues to the whole
  team; arrival defaults: Sneak→Ambush, Move→Defend.
- Deployment: only one initial order per team (Move may carry waypoints); a second order or
  redeploy cancels the first; illegal drops snap back; group-drag keeps relative positions, and
  teams that would land off-map do not move.

### Command / morale / scoring
- Rank adds a team slot (e.g. lieutenant→captain: 13→14 teams; cap 15) AND raises scoring
  expectations. Battle score = base (highest at lowest rank) + force strength + casualties + land
  gained; tournament score = battle score × realism factor. Expected-VL arrows: took = expected ±N
  (N = deviation, 3 expected/2 took → one down arrow).
- Campaign win = more total promotion points at the end; promotion points are awarded per
  operation; the Debriefing shows the running total and the points to the next rank.
- SPACEBAR command radii; troops outside any radius degrade. Morale improves from successful
  ambushes and tank kills; panic spreads between neighbouring teams; keep away from corpse fields.

### Battle end / prisoners
- Truce needs BOTH sides; if one side then holds every VL on the map, it wins. Flee = immediate
  end, enemy takes the whole map; you can also flee by moving every team off the left/right edge.
- Own surrendered men can be recovered by reaching them before they exit; a soldier may rejoin
  his group without encouragement given time; commander proximity helps.

### Operations / editor (thin sections, now noted)
- Operation structure: ≤5 maps per operation, game length ≤15 days; day requisition points accrue
  every day regardless of advance; map requisition points only when advancing to the next map;
  deployment zones are editable only on the FIRST map — later maps inherit the previous battle's
  outcome territory.
- End-of-map victory: German/Russian Offensive needs the winner to hold ≥80 % of victory
  locations; Meeting Engagement 50 % each. Editor bounds: 1–8 victory locations per map.
- Artillery barrage: German 150 mm fire is accurate; Russian Katyushas cluster but are much less
  accurate; up to four target coordinates; more targets = more dispersed; barrages can destroy
  buildings and tanks.
- Requisition: year/season filters the force pool (Summer 1942 excludes Tiger and IS-3);
  "Restrict Players to Historical Rarity" toggle; ammo levels Full/80/60 % with heavier loads
  slowing movement; realism options are set per side (rating = checkbox count).

### Unit tactics
- Snipers: cannot capture or hold victory locations; prefer shooting leaders; may refuse a shot
  that would reveal their position.
- Flamethrower: <50 m range; one rifle bullet can destroy the unit; its death explodes and can
  kill nearby troops. AT teams: engage tanks from <100 m, ideally side/rear; effective vs enemy AT
  guns too (gun shields stop small arms only).
- Mortars: useless at close range; rounds can burst in treetops; space multiple mortar teams far
  apart to frustrate counterfire; out-of-ammo teams become infantry.
- Cover taxonomy: light (tall grass/bushes: concealment, no protection), medium (trees/crests/
  embankments: frontal protection only), heavy (buildings/foxholes: multi-angle protection).
- Assault doctrine: suppress 30–60 s before the assault; one mortar smokes while the other keeps
  suppressing. Tanks cannot flatten buildings (track/gun barrel/cellar risk) but may fell trees.
- Between battles: refit, add units, or rest teams for later refit; requisition points can be
  saved across battles. Surviving units keep experience; wiped-out non-command teams are gone
  for the operation.

Scope nuance: the notes say AT teams move to the highest floor; the manual says teams "other than
AT guns" — an equipment-class exclusion, not a team-type one.
