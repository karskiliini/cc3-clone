# Operational campaign and allocated artillery

Requested 2026-11-02 at 11:26. **Queued, not implemented**: existing umbrella 053
and new artillery requirement 068. This develops the Sixth Army campaign 067;
062–066 supply its terrain, river transport and defenses. Requirements do not
automatically reprioritize implementation or add an approval ceremony.

## 053 — Move forces across Sixth Army's operational area

The user now explicitly requests the previously proposed grand-campaign layer.
Players can move formations across the whole represented Sixth Army front, with
the opposing force controlled by AI or the operational opponent. Each move must
change the actual campaign situation and resulting tactical battles. Existing
`GRAND_CAMPAIGN` data is a linked battle list, not this operational force model.

Represent connected sectors, meaningful objective flags, force location/strength,
orders, travel/readiness, supply routes/depots, reserves and support allocation.
Sector versus hex presentation and turn timing remain implementation choices;
the required scale and causal effects are fixed. Preserve the earlier 053
company/battalion scale distinction: an operational formation can contain several
tactical detachments; moving an army formation does not place its whole strength
onto one tactical map. Split/merge/attachments retain individual/equipment IDs,
stocks and losses. One unit cannot participate in two simultaneous battles.

Operational choices determine where contact occurs, which map is used, attack/
deployment directions, the participating forces, reserves/arrival times, usable
exit/supply connections and available artillery. Multiple approach routes can
matter. Retreats and enemy counterattacks move the represented front too. A
calendar/index cannot advance Germany to Stalingrad without the needed ground.
The 067 rule requiring at least one capable, active side in each offered tactical
mission still applies; rest/refit intervals occur on the operational layer.

### Transfer smaller units between friendly formations

User clarification (11:31): formations can send smaller units to other friendly
formations on the grand map. Examples include an engineer squad, an antitank
detachment or a tank platoon. This reallocates existing people/equipment rather
than purchasing a duplicate or instantly changing the recipient's roster.

Create a transfer order with source, destination, actual unit/cargo, transport
mode, route and estimated arrival. Show travel time, required transport/fuel/
other resources and the source's reduced capability before the order is issued.
Respect unit integrity and declared attachments: guns need their crews, and
organic carriers/support must follow the chosen transfer package consistently.

Walking takes time, rations and physical effort; motorized movement also needs
available capacity, fuel and suitable routes. Transport remains committed for
its actual delivery/return journey. Costs depend on the chosen route/mode and
conditions, not a universal free transfer or fixed instantaneous fee. Use the
campaign clock consistently when determining tactical reinforcement arrival.

After departure the unit is unavailable to the source; before arrival it is
unavailable to the destination. It has a real in-transit state/location and
cannot join two simultaneous battles. If the destination fights before arrival,
it starts without that unit; arrival during a battle is possible only through
the actual reinforcement timing and a valid entry route.

A cut road, lost bridge, contested sector or exhausted transport supply can
delay/stop the transfer or require rerouting and applicable contact resolution.
Cancellation/rerouting preserves progress and spent resources rather than
teleporting the unit back or refunding consumed fuel. Completion changes the
command attachment once and preserves identities, experience, wounds, fatigue,
weapons, vehicles and remaining stores. Transfer itself does not heal/refill them.

Persist transfer identity, ownership/attachment, route/progress, transport
commitments and reserved/spent resources through save/load and recovery. Prove
source/destination strength changes at the correct times, arrival affects the
right tactical battle, blocked/under-resourced routes cannot complete for free,
and repeated completion/load never duplicates people, equipment or supplies.

### Supply and encirclement have real tactical consequences

Compute supply from controlled, usable connections to actual supply sources,
with route capacity, transport time and available stores. The 067 bridge/junction/
landing flags affect those connections through their physical state and control.
Cutting every ground connection isolates the formation from **new ground supply**.

Isolation preserves supplies already carried or stored locally. Ammunition,
fuel, food and medical stocks are then depleted by fighting/time and not refilled
between missions without a real delivery. Tactical initial loadouts, weapon fire,
vehicle movement, recovery and reinforcement availability must reflect that state.
Do not replace supplies with a cosmetic "unsupplied" icon or instantly erase all
ammunition when a route closes. Explain stock, incoming deliveries, shortages and
their effects in briefing/UI/debrief.

Limited river or air deliveries require an actual available route, transport and
allocation; they are not automatic unlimited exceptions to encirclement. Volga
transport 063 can sustain a river-connected force even when land routes are cut.
An air bridge is a distinct supply capability, not a use of the bombing button.

Finish a tactical battle by committing casualties, survivors, ammunition/fuel
expenditure, captured ground/supplies, damaged equipment and terrain exactly once.
Those results determine subsequent operational options. Save/load, quit/resume
and repeated debrief must not duplicate units, deliveries or recovered supplies.
Strategic intelligence may be uncertain; tactical people receive only legitimate
briefing/orders/reports and personal observations, not hidden live grand-map data.

Acceptance: compare identical forces/orders with an open supply route versus a
real encirclement; the isolated force uses its retained stores and receives no
free refill. Moving reserves changes the next battle's roster/timing/direction;
recapturing a usable connection restores deliveries after their actual delay.
Conservation, persistence, deterministic continuation and clear player feedback
must hold. Live online operational multiplayer is additional implementation work;
the existing single-battle relay does not already provide it.

## 068 — Allocated artillery with frequent small fire missions

Add callable field-artillery support alongside existing on-map mortars/rockets
and aircraft. The primary interaction supports **frequent small fire missions**;
large concentrated bombardments are less frequent because of actual ammunition,
available guns, preparation, service/crew readiness and support commitments.
Do not copy air support's usually single-use assignment into artillery.

Author battery/formation identity, gun type/count/serviceability, position/range,
ammunition, readiness and fire-control capacity for the period. Set numerical
cadence, mission sizes, travel/communication/flight times and recovery from sourced
weapon data plus documented gameplay calibration. No universal cooldown should
make an unlimited number of shells free.

On the operational map, allocate batteries/support priority to areas or forces.
Allocation changes availability in the area's tactical battles; moving/reassigning
support takes the authored time and respects range. The same battery cannot
promise its full guns/ammunition simultaneously to every battle. Show committed
support, queued requests, remaining shells and expected availability/arrival.

Within battle, request an area and small/large authored fire mission through an
eligible observer/command communication chain. Use personally observed targets
or delivered aged reports, and allow explicit blind area fire with appropriate
uncertainty. Corrections require observed impacts and delivered reports. The
fire-control system must not inspect hidden enemy concentrations for its aim.

Shell arrival is scheduled canonical simulation, with dispersion and physical
terrain/structure/infantry/vehicle effects, including friendly damage. Use existing
damage/crater foundations and persist the effects via 064. Canceling or losing
contact does not undo shells already fired; only unfired reservations can return
to stock. Give the player readable request/acceptance/preparation/firing/impact/
completion feedback and a way to cancel pending fire.

Artillery availability depends on the battery's own stores, range, commitment
and communications. A surrounded infantry formation can still receive reachable
outside fire support if those conditions hold; its lost ground supply is not a
magical ban on every external shell. Batteries inside the pocket consume their
own finite remaining stocks. Ground resupply of shells still requires a route.

Account actual expenditure/reservations once across campaign and tactical play.
Distinguish player-allocated fire from 064's separately budgeted background
bombardment; do not duplicate costs or manufacture extra free missions on reload.
Include allocation, queues, stocks, messages, flight and impacts in applicable
save/replay/hash/network state.

Acceptance: demonstrate several successive small missions and a larger scarce
concentration with visibly different real expenditure/readiness; allocation to
one area changes support elsewhere; simultaneous commitments cannot duplicate
guns or shells; interrupted supply eventually limits firing while already-fired
shells still land. Verify observer knowledge, friendly effects, persistence and
deterministic recovery in the actual game. This remains a queued feature.
