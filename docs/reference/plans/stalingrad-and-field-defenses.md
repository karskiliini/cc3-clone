# Stalingrad, persistent destruction and defensive construction

Requested 2026-11-02. **Queued requirements, not implemented**: backlog 062–066.
The existing queue order and deferred 050 P2 work remain unchanged. This document
records the requested outcome and completion criteria without an approval gate.

## Existing foundations

- `src/data/maps/stalingrad_1942.ts` supplies one Red Barricades factory district:
  halls, workers' housing, rails, bluff and a narrow authored river edge. It is
  not yet the requested set of different Stalingrad scenarios.
- Campaign data repeats that map; `CampaignState` preserves personnel/teams and
  daily air allocations, with no persistent battlefield-damage record.
- Buildings, terrain, craters and earthworks already change within a battle.
  058 supplies physical air ordnance; 059 supplies night conditions, individual
  light-dependent sight and mortar illumination.
- `GameMap.wire` / `sim/wire.ts` are separate from fence terrain, with intact/cut
  states, slowing/cutting and vehicle interaction. `GameMap.mines` / `sim/mines.ts`
  distinguish AP/AT mines and clearing. These are foundations, not a completed
  player construction interface. Trigger coordinates, AP/AT consumption rules,
  ownership/knowledge and vehicle-type behavior need auditing before expansion.

## 062 — Stalingrad scenario family

Provide distinct selectable levels and campaign entries:

1. The approach into a largely intact urban district: houses, streets, courtyards
   and civilian/industrial structures that can be destroyed during fighting.
2. A historically grounded Red Barricades factory battle, with recognizable hall
   layout, yards, rails, workers' housing and relevant surrounding terrain.
3. A Volga-bank/crossing scenario, including a night version, connected to 063.
4. A heavily devastated starting state, either authored as a preset or produced
   by the same destruction system used in the linked campaign.

Keep **geographic district**, **historical date**, **time of day** and **damage
phase** separate. A different district is not a random re-layout of the same
city. Verify dates, plant identity, layout, river geometry and scale against
period maps/photographs and traceable historical sources before map production;
factory names must not be conflated. Preserve metre/tile scale and document
necessary tactical-map cropping. The intact starting state needs an explicitly
authored scenario date/context.

Done when each phase is selectable and legible in briefing, visually distinct,
playable from both sides where applicable, and verified in the actual game.
Buildings must remain destructible; no texture-only ruined-city substitute.

## 063 — Visible Soviet reinforcement traffic across the Volga

The river must support an observable crossing/landing sequence bringing new
Red Army soldiers into the battle repeatedly. Night missions emphasize this
traffic through authored schedules and availability; daytime traffic remains
scenario-dependent. Define actual reserve strength, transport capacity, cadence
and interruption rules rather than unbounded spawning.

Show transport, passengers, approach to the bank, landing and unloading into
ordinary controllable teams. Any abstracted off-map leg must lead into a visible
physical river approach and disembarkation; soldiers must not simply materialize
behind the front. Resolve historical river width/map extent before polishing
shore details. Transport loss/delay, blocked landings and interdiction must affect
arrivals consistently, with legible player feedback.

Use individual perception and delivered orders for arriving people; darkness and
illumination affect acquisition normally. A hidden arrival must not announce its
identity/location to the opposing player. Campaign reserves are spent once and
the surviving/new force is recorded. Done when a real night battle demonstrates
multiple crossings and disembarkations, interruption changes actual arrivals,
and replay/save/recovery reproduce the schedule and resulting people exactly.

## 064 — Persistent battlefield and between-battle bombardment

Use a stable base city/district plus persistent damage. A fresh campaign starts
from its scenario's intact/damaged preset. Fighting and optional between-battle
artillery/air bombardment accumulate damage; the next battle on that district
continues from the resulting city. A devastated preset also supports standalone
play without requiring a long campaign first.

Persist damaged/destroyed buildings, breaches, rubble, craters and height changes,
relevant vegetation/wrecks/earthworks and the state of placed/cut/detonated defenses.
Key records by battlefield identity and geometry version, not only a reused map
label; do not stamp one district's damage onto another district's coordinates.

The between-battle option applies **several dozen strikes**, as requested. Specify
whether the authored count means missions, salvos or individual impacts. Use
seeded variation between fresh campaigns and reproducible continuation of a saved
campaign. Impact clusters/targets should produce plausible damaged blocks and
streets, with a controllable severity distribution. Preserve a playable mission
or provide the forces/tools needed to open blocked routes. Use the physical
structure/crater/height pipeline and rebuild applicable collision/navigation data.

These background events have their own scenario budget; they must not silently
spend the player's finite tactical support pool. Default between-battle scope is
the battlefield state, without inventing casualties in a roster already settled
by the debrief. Record each transition once so reload/rejoin never repeats it.

Done when an intact district progressively becomes ruined across linked battles,
damage never resets on reload, the same seed/save reproduces it, different fresh
seeds produce distinct damage, and rendering, cover, LOS and movement agree.

## 065 — Player-placed wire and physical field obstacles

On eligible later scenarios, **either faction when defending** can strengthen
positions with barbed wire, Spanish horses and authored additional obstacle types.
Scenario defense roles, stocks and preparation allowance govern access, rather
than hardcoding one nationality as the builder. Enemy AI uses the same allowance
and placement rules, based on known terrain/front/orders rather than hidden enemy
deployment or the player's camera.

Provide setup tools for wire lines and oriented obstacle footprints, with stock/
cost, legal preview, rotation and cancellation. Validate the entire footprint
inside the permitted defensive area near the positions, including map/deployment
edges. Show availability clearly. Any construction permitted during combat must
require an actual capable worker, material and work time at the site, following
individual order acceptance; no instantaneous remote placement.

Barbed wire remains its **own element**, not a fence repaint. Obstacle material,
geometry and resistance must distinguish infantry delay from a genuine vehicle
barrier. Verify the intended historical Spanish-horse construction and represent
it physically. Infantry, wheeled vehicles and tracked hulls need appropriate
crossing/cutting/pushing/crushing behavior; engineers can open real gaps. Apply
the resulting geometry to routing, local physical movement and visuals, without
granting unobserved defenses to an individual's navigation knowledge.

Done when player and AI can prepare legal defenses, illegal/over-budget placement
is rejected, routes and physical bodies encounter those defenses, gaps remain
open, and the persistent/replayed field matches the displayed objects.

## 066 — Scenario-limited defensive AP/AT mine placement

Some missions grant the defender AP mines; a smaller authored subset also grants
AT mines. Stocks default to unavailable unless explicitly allocated. Setup allows
legal placement in the defensive area with separate inventories/clear symbols;
combat laying, if enabled, requires engineers, carried mines and real work.

Audit the existing trigger pipeline first, including fractional soldier/world
coordinates and vehicle footprints. AP and AT pressure/activation/consumption
rules must remain distinct: a passing foot soldier must not erase an AT mine as
a harmless generic explosion. Hazards affect friendlies physically too. Avoidance
uses a person's own known/briefed field locations; enemy fields remain hidden
until legitimately observed, probed, triggered or reported. Display known own
fields without exposing the enemy's hidden layout.

Use the same full-footprint defensive-area and supply validation as 065. Reject
unsuitable terrain unless the scenario explicitly supports a special emplacement.
Clearing, destruction and detonation consume/update the real mine object and
persist across linked battles; preparation must not refill old minefields.

Done when both factions can lay only their allocated types/counts on eligible
missions, restrictions hold on zone edges and hostile commands, real AP/AT tests
cover appropriate targets/friendlies/clearing, and hidden knowledge, saves,
replays and two-player recovery retain the same field.

## Delivery dependencies and verification

Queue order stays 062 → 063 → 064 → 065 → 066. Establish the battlefield identity/
damage-phase contract while making 062 so 064 can reuse its geometry. Validate
river scale and the reinforcement transport path before polishing 063. Wire and
mine foundations are reused, with targeted correctness fixes where needed.

For each implementation, test its important physical/knowledge/budget risks and
show the complete player flow in-game. Add new canonical state/commands to hashes,
save migration, replay and network validation. Measure representative new-feature
cost; offload substantial builds, tests and rendering to the user's Mac mini when
it has capacity. This does not resume the deferred general P2 optimization project.
