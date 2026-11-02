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

### Historical starting references

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
