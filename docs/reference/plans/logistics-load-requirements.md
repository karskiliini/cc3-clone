# Logistics & Load requirements (WW2-adjusted Maslow + weight model)

Status: requested 2026-09-19. Sources: user requirements in-session; existing systems
`src/sim/items.ts`, `src/sim/pickup.ts`, `src/sim/medic.ts`, `src/sim/coverSeek.ts`,
`src/sim/movement.ts`, `src/sim/crewWeapon.ts`.

## R1. Decision ladder (Maslow, adjusted for WW2 combat)

When a soldier's situation changes, priorities resolve in this fixed order. A higher
rung always preempts lower ones (implemented gates: `ableToLoot`, `underFire`,
`NO_LOOT_STATES/ACTIVITIES` in `pickup.ts`; cover-seek preempts pickups because
`stepCoverSeeking` runs before `stepPickups` in `battle.ts`'s pipeline).

1. **Survive** — get out of / into cover against enemy fire (`coverSeek.ts`; burning-vehicle
2. **Self-aid** — bandaging a wound before any looting. *Gap to close:* bandaging is not
   modelled as an `Activity` (types.ts `Activity` union has no such member; medic.ts drives
   it through its own `MedicTask` phase machine), so `ableToLoot` cannot see it. Add an
   `ableToLoot` guard that reads the soldier's active medic task (`medic.ts`'s treatment
   state, or a `s.medicTaskAt` marker), refusing looting while treating or being treated.
3. **Armament** — find a weapon if unarmed, ensure ammo, upgrade if better is available
   (`pickupPriority` ladder 1-4: ammo < half load → squad MG when its gunner is down →
   AT kit / grenades → strictly better weapon for the terrain).
4. **Obey orders** — any order (or cover-seek) path preempts an in-progress pickup
   (`endPickup` when the path diverges, pickup.ts active-track loop).

## R2. Knockdown weapon loss

- A man knocked down (blast / vehicle impact, `stunnedUntil` in the future) **often**
  loses his weapon: it lies on the ground beside him (`dropKit(weaponOnly)`).
- The drop is rolled **once on entering the stun**, not per step (transition-gate on
  `prevStunned` in `DropTrack`), probability `panicDropChance(experience) * 0.8`.
- When he rearms (`takeItem` weapon path), `kitDropped` resets, so a *second* knockdown
  can drop again.
- Dropped weapon must be visible on the ground (existing item sprites) and pickable once
  the stun ends (existing `ableToLoot` stun gate).
- Tests: enter-stun drop with seeded rng; no per-step re-roll; item at his position and
  pickable after stun; rearm clears `kitDropped`. Mutation check: chance → 0 fails test 1.

## R3. Weight / load speed model

- Every unit type has a **base weight** and therefore a **base speed**
  (`SPEEDS[activity]` in movement.ts is the base; extend with a per-weapon carry weight).
- **Extra carried weight slows the man down**: `moveAlongPath` multiplies by a load
  factor derived from what he carries (weapon class + spare ammo + grenades).
- **Trained carriers are faster**: the unit type that is issued the weapon by its
  order of battle (AT man with the Panzerfaust, MG gunner with the MG42) carries it at
  a reduced weight penalty vs an infantryman improvising with the same weapon. The
  unit types must matter — the same weapon is a different load for different men.
- Speed penalty applies while moving (`SPEEDS` consumer), not while stationary.
- Suggested shape: `loadFactor(s) = 1 - k * max(0, carriedWeight(s) - typeAllowance(s))`
  clamped to a floor (e.g. 0.6); `carriedWeight` = weapon weight + ammo crates; the
  `typeAllowance` is higher for the weapon's trained carrier (units.ts role flags).

## R4. AT pickup willingness (user rule)

- A soldier who sees an AT weapon on the ground should **usually** pick it up and be
  ready to use it, even though it slows him (R3).
- Current gate is too strict: pickup.ts:201 requires `!teamHasAt(...) &&
  enemyArmourKnown(...)`. Relax: pick an AT kit when the team has no dedicated AT man
  (role check, not "no AT anywhere"), and drop the armour-known requirement when the
  item has rounds — the armour-known shortcut may remain for satchels only.
- The willingness must survive the R3 slowdown, i.e. priority rung 3 stays above
  rung 4 regardless of the weight penalty.

## R5. Leader requisition of men (crew replacement)

- A ranking soldier may **order an individual nearby soldier to work for him**:
  the canonical case is a PaK that has lost a crew member; its leader forcefully
  recruits a nearby idle/rifle man to re-man the gun.
- Inter-leader arbitration: when two leaders want the same man, the **equipment
  priority** decides — higher-priority equipment wins the man:
  1. tank  2. AT guns (PaK/field guns)  3. infantry guns (HMG/mortar)  4. AT rifles /
     bazookas  5. machine guns (squad LMG)  6. snipers  7. plain infantry.
- Only men who are candidates in the loser's own priority class may be taken
  (a tank leader may not strip a PaK crew while the PaK still rates higher).
- Recruitment is refused for men who are pinned/broken/panicked, stunned, dazed, or
  under fire; the recruiting leader walks the man over (existing crewTask walking).
- Implementation sketch: new sim module `requisition.ts` (throttled like coverSeek),
  called from the pipeline after `stepCrewWeapons`; `equipmentPriority(team)` from
  `team.crewWeapon`/vehicle class/WEAPONS cls; nearest eligible soldier outside
  higher-priority teams; reassign `s.teamId` + formation slot, add message.
