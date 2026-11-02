# Battalion command, synchronization and radio intelligence

Requested 2026-11-02, 12:26–12:27. Implementation requested at 13:15.
The pre-battle plan, H-hour/radio-signal activation and immediate radio traffic
features below are implemented; verification is recorded in
`docs/reports/command-support-20261102/README.md`. Broader battalion hierarchy,
physical couriers, support handover and command-flare recognition remain queued.
Connects operational forces (053), individual perception/condition (056), night
signals (059), active campaign missions (067) and allocated artillery (068).

## 069 — Command companies through their own commanders

### Pre-battle battle plan and advance orders

Clarification (2026-11-02, 13:03): before battle, create a battle plan and issue
advance orders. Configure a small set of agreed signals (typically two or three),
each mapped to defined actions for specified recipients: for example, begin the
prepared attack, shift support or execute a fallback. Show each participant's
orders and signal meaning before accepting the plan. Initial participating units
receive their assigned plan during setup; enemy units do not receive it.

During battle, a received agreed signal activates the recipient's already-known
orders. It does not carry the hidden plan to the enemy. A signal without a known
meaning cannot create an order; units absent from the briefing need a legitimate
delivery of the plan. Changes after battle starts follow ordinary communication
rules. Preserve H-hour, visible flares and couriers as alternative coordination
methods. Save the plan, signal definitions, recipients and execution state;
duplicate reception must not restart or duplicate a completed action.

At battalion scale the player gives companies a mission and destination/area:
Defend, Attack, Prepare to Attack or Support Attack. Include purpose, timing and
constraints where needed. Subordinate commanders arrange platoons/squads and
carry out the mission using their own observations and actually delivered
reports. Neither the player camera nor global enemy state supplies their knowledge.
Retain the smaller-force tactical mode and the individual simulation of 056.

Preparation requires real assembly, movement and support readiness; support
requires real weapon capability, ammunition and legitimate target knowledge.
Company commanders make bounded local adjustments to contact, blocked routes,
losses and readiness, reporting progress/problems or requesting revised orders.
The player need not position every rifleman. Optional direct orders still obey
command authority and communication delivery rules.

### Assign indirect-fire assets to companies

The battalion commander can subordinate indirect-fire units to companies,
setting control, priority and any retained battalion reserve. Assign existing
guns, crews and stocks once; do not duplicate support availability. A change of
control must reach the relevant people. Control transfer and physical relocation
are separate: moving crews, guns or carriers takes actual travel and resources
under 053. Fire missions retain 068's communication and ammunition constraints.

### Coordinate through received plans and physical signals

- **H-hour:** an actually received plan can schedule action against the shared
  simulation clock. The clock does not deliver an unknown order. Define late
  receipt, missed deadlines and fallback intent explicitly.
- **Flare signal:** recipients must previously know the agreed meaning, timing
  and sector and physically see/recognize the flare. LOS, weather, cover and
  individual condition matter. Illumination and command significance are separate;
  not every illuminating flare is an order. Signals consume finite ammunition
  and can also be seen by the enemy, without perfect hidden emitter identification.
- **Courier:** a real messenger travels from battalion to company on foot or in
  an available Kübelwagen/Kettenkrad. Routes, terrain, driver, capacity, fuel,
  fatigue and casualties affect arrival. A carrier cannot simultaneously carry
  a mortar team and perform an incompatible courier task. Acknowledgment needs
  a return journey or another working communication channel.

Store message version, payload, sender, recipient and issue/delivery times.
Orders carried by a departing messenger cannot be overwritten telepathically.
A recipient rejects an older instruction only when it already knows a newer
one. Missing acknowledgment means uncertain delivery, not instant knowledge of
a distant messenger's death. Show issued/in transit/received/acknowledged/
preparing/ready/executing states only from legitimate reports, with their age.

### Radio is a physical command dependency

HQ radios/operators are actual equipment/people. Injury, damage, incompatibility,
range and condition can interrupt links. Units retain received orders and
standing intent; new instructions need another channel or wait. Signals failure
can delay action, while 067 still requires a coherent active tactical mission.
Current voice/intercom/radio contact and indirect-message routing now support
pre-briefed orders and radio activation. A full battalion hierarchy, physical
courier system and command-flare recognition are separate remaining work.

Completion: company mission execution with legitimate knowledge; real support
handover; H-hour, visible signals and moving couriers; lost/late/stale orders and
acknowledgments; damaged HQ communications; saved/replayed/recovered orders,
assignments and queues. Whole-battalion performance remains unmeasured: validate
actual command AI, individual combat, movement and rendering before promising capacity.

## 070 — Passive radio intelligence for either side

**Superseding game rule (2026-11-02, 13:03): every actual radio transmission is
immediately heard by the opposing side.** This replaces the earlier proposal of
capability-gated reception and delayed translation/analysis. Apply it equally to
both factions, with no random interception chance or artificial intercept delay.
The friendly radio link still requires functioning equipment/operators; an order
that never transmits produces nothing to overhear. Enemy reception does not imply
successful delivery to the intended friendly recipient.

Ordinary transmitted content is exposed immediately. For a prearranged signal,
reveal that the identifiable signal was given, but never its private meaning,
linked orders, recipients' plans or intended maneuver. Do not automatically
decode its meaning after waiting or after repeated use. The opponent can draw
its own conclusions from observed action. Unsent plans, physical courier payloads,
voice/intercom-only conversations and other personal memories are not radio traffic.

An indirect-fire call exposes its transmitted target location/area immediately,
so the opponent knows where fire is being requested next. Corrections and radio
cancellations expose their transmitted updates too. Show a request/intercept,
not guaranteed future impacts: a battery may reject, queue or cancel the mission.
Do not reveal hidden shell trajectories, exact impact times, untransmitted stock
or the caller's/battery's exact location. The actual target remains the transmitted
coordinate/area even if empty; do not attach hidden live enemy tracking to it.

Keep enemy reception separate from ordinary same-side communication delivery.
Show intercepted traffic in the opposing commander's information/UI immediately;
individual enemy soldiers still act only on their own observations and delivered
orders/reports under 056. Hearing a signal does not automatically grant every
enemy individual the opponent's battle plan or a new maneuver order.

Radio trades fast command delivery for guaranteed disclosure of emitted content.
Prearranged signals conceal meaning; couriers conceal their carried message from
radio listening but take physical travel time. Interception alone does not locate
the transmitter. Any future direction-finding feature requires separate capability
and uncertain, aged estimates rather than exact continuous HQ markers.

Completion: each emitted radio message reaches the opponent at the same simulation
time; signals expose identity/existence without private meaning; fire requests
expose only their transmitted target and updates; no unsent/courier-only leaks or
automatic position reveal. Save/replay/recovery preserve private plans, emissions,
intercepts and execution state without duplicate triggers or camera dependence.

## 072 — Direct local control versus delivered HQ orders

Requested 2026-11-02, 13:51. **Queued, not implemented.** User requirements:
direct lower-unit control remains possible without radio/telephone contact, but
the available commands differ; external indirect-fire calls need connectivity;
the player's own on-map mortar team can always receive a fire command.

Proposed interpretation: the player can act as the selected local leader as well
as the battalion commander. Disconnected direct commands are decisions that
leader can make locally, rather than new HQ orders that arrived telepathically.
Retain ordinary move, fire, defend/hide and local withdrawal using the selected
unit's own observations, delivered reports, known map and received intent. Do not
invent an arbitrary movement radius or a radio delay for a local decision.
Condition, hesitation and practical capability still govern execution under 056.

| Action | Working HQ/support communication | Disconnected local control |
|---|---|---|
| Ordinary tactical movement/fire/cover | Delivered orders and local decisions | Local leader's decision using its legitimate knowledge |
| New distant coordination, revised shared plan or attachment | Actual message path and receipt | Needs a courier/voice relay or restored link; cannot synchronize other units telepathically |
| External battery / another unit's indirect fire | Connected caller-to-support path, including legitimate relays | Unavailable until a request can reach the supporting element |
| Selected own on-map mortar fire order | Available | Available: explicit organic-mortar exception |
| Correct fire using another observer's information | Delivered observation/correction | Only the mortar's own observations and previously delivered information |
| Previously received H-hour plan | Executes when due and capable | Still executes; loss of contact does not erase briefing |

A radio somewhere in the force is not by itself a valid support route. Require
working endpoints and the actual path to the support authority/battery. A nearby
leader can convey orders by voice, and a courier can carry a new instruction,
with their actual limits and travel time. Telephone routing must use 071's intact
wire and working endpoints. Only real radio hops produce 070 interceptions;
a telephone-only or face-to-face exchange does not emit radio traffic.

“Always command the own mortar” removes the HQ-connection prerequisite only.
The player may give an area-fire order even when no observer sees the impact
area, with normal blind-fire uncertainty. It does not supply hidden enemy
positions, magically correct the aim, restore ammunition, revive crews, skip
setup/loading/preparation/flight or remove minimum/maximum range. The exception
does not allow a disconnected rifle team to call a separate mortar as if it were
physically part of that team; select the actual organic mortar to give its order.

UI: show **Local control** versus **HQ connected**, and the actual path/status
when known. Explain disabled support actions with a concrete reason such as
“No connection to battery.” Switching selection must not copy the player's or
another unit's live enemy knowledge into the chosen soldier. Received orders,
local decisions and pending courier/remote orders remain distinct canonical data.
Do not apply the old blanket out-of-command refusal to legitimate local decisions.

Before implementation, settle the command/authority matrix without weakening
the explicit direct-control and organic-mortar requirements. Verify actual local
movement and mortar launches without HQ, rejected external calls on broken
paths, successful delivered requests after reconnection/relay, no inherited
spotting without a report, protected urban phones versus cuttable field wire,
individual refusal/condition constraints and exact replay/network recovery.

## 073 — Optional parent-command perspective on selection

Requested 2026-11-02, 13:57. **Queued design alternative, not implemented.**
Do not silently replace the ordinary view or 072's local-command proposal.
074/075 define the map baseline, remembered scene, height-aware observations and
pre-battle aerial coverage used by each context; see
`docs/reference/plans/battlefield-knowledge-and-recon.md`.
Selection in this mode identifies the immediate parent command context:

| Selected element | Displayed command picture | Command recipients |
|---|---|---|
| Individual squad | Its platoon | Proposed: that platoon's squad leaders |
| Platoon leader | Its company | That company's platoon leaders, explicitly requested |
| Company leader | Its battalion | Proposed extension: company leaders; not yet a user-selected requirement |

Display the active formation and role clearly, for example **Company command ·
2nd Company**, so selecting a platoon leader is not mistaken for directly
possessing that leader's personal field of view. Retain an explicit distinction
between this parent-command perspective and directly acting as a local leader
under 072. Exact interaction for entering/leaving either mode remains to settle.

“What the platoon/company sees” means the relevant commander's own observations
and actually received reports, including their age, uncertainty and incomplete
coverage. It is not a live union of every subordinate's current sight. Radio,
telephone, voice and courier paths determine when a sighting reaches that picture.
A broken connection leaves old reports; it does not continuously update hidden
contacts or delete information already received. Reconnection needs actual report
delivery. Scoped enemy radio intercepts also need to reach the applicable command
context rather than becoming every subordinate's personal knowledge automatically.

Apply the perspective to map contacts, terrain knowledge/visibility overlays,
minimap, tooltips, targeting previews and support markers consistently. Selecting
another formation cannot leave its live contact tracking/target lock behind in
the previous perspective. The player can remember previously seen information;
switching the UI must not copy it into a soldier's knowledge or turn it into a
newly delivered report. Orders still use the selected command authority's real
communication routes, and troops implement them through individual capability.

Preserve 072's direct control of an isolated local element and explicit own
on-map mortar order exception; lack of a parent report must not silently remove
that promised control. Preserve previously received battle plans/signals and
071's cuttable surface versus protected urban phone lines. Actual organization
and attachments must exist before exposing platoon/company/battalion contexts;
today's flat team roster is not an already implemented hierarchy.

Acceptance: two platoons with different reports show different scoped pictures;
company view gains a sighting only on real delivery; isolated formations retain
aged knowledge and local-control options; selection does not mutate canonical
knowledge, grant global enemy updates or route orders from the wrong leader.
Verify overlays/minimap/targeting alongside the main view and exact deterministic
save/replay/recovery. Keep this an optional alternative until its mode choice and
relationship to the ordinary view are settled.

## Historical starting references

- US Army Office of the Chief of Military History, Albert Praun,
  [German Radio Intelligence](https://www.nsa.gov/portals/75/documents/news-features/declassified-documents/friedman-documents/publications/FOLDER_240/41748549078781.pdf),
  postwar report hosted by NSA. Describes interception, direction finding,
  evaluation and cryptanalysis as distinct activities, including Eastern Front
  experience. It does not establish universal success or fixed game delays.
- David Glantz's Soviet-intelligence chapter in
  [The Intelligence Revolution](https://media.defense.gov/2010/Sep/27/2001329813/-1/-1/0/Intelligence_revolution.pdf),
  officially hosted historical research. Indexed passages describe limited Soviet
  radio interception in late 1942. The full PDF fetch returned HTTP 403; use this
  as a starting reference, not proof of a particular unit's equipment at a given date.

These sources supply historical context, not evidence for universal instant
interception. The 13:03 rule above is an explicit gameplay abstraction selected
by the user; do not describe it as historically universal radio access.
