# Battalion command, synchronization and radio intelligence

Requested 2026-11-02, 12:26–12:27. **Queued, not implemented**: 069 and 070.
Connects operational forces (053), individual perception/condition (056), night
signals (059), active campaign missions (067) and allocated artillery (068).

## 069 — Command companies through their own commanders

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
Current voice/intercom/radio contact and indirect-message routing are foundations,
not an implemented battalion hierarchy, physical courier system or command flares.

Completion: company mission execution with legitimate knowledge; real support
handover; H-hour, visible signals and moving couriers; lost/late/stale orders and
acknowledgments; damaged HQ communications; saved/replayed/recovered orders,
assignments and queues. Whole-battalion performance remains unmeasured: validate
actual command AI, individual combat, movement and rendering before promising capacity.

## 070 — Passive radio intelligence for either side

Either side can intercept actual enemy radio transmissions when the scenario's
date-appropriate receivers, operators and conditions permit it. The mechanism
is symmetric; equipment, training and availability need not be identical.
Do not make all Soviet or German messages automatically readable.

Keep three separate results:

1. Detect a transmission/traffic through a compatible, in-range receiver and
   capable operator. No actual emission means no radio intercept.
2. Interpret content: clear speech/text can be understood promptly by a capable
   listener; language, noise and analysis may yield delayed fragments. Coded or
   encrypted traffic may remain unreadable indefinitely. Waiting alone does not
   guarantee decryption.
3. Estimate direction/location only with the required capability and observations.
   Deliver a bearing or uncertain area, not exact coordinates, identity or a
   continuously updated enemy marker.

The user's proposed delay belongs to scanning, recognition, translation,
analysis and reporting through the listener's own command network, not slow
radio propagation. Store observation and report-arrival times, uncertainty,
confidence and partial interpretation. A report can arrive too late to act on.

Intercept only actual emitted message payload/traffic. Never inspect the full
command log, unsent player plans, courier contents or another person's entire
memory. An enemy can receive an emission even when its intended recipient does
not. Keep passive reception separate from friendly communication delivery;
do not make the existing same-side communication link leak personal reports
directly to the opposing side.

Radio trades fast command delivery for possible exposure. Radio silence and
couriers reduce emissions while slowing information. No automatic warning that
the enemy heard a message without evidence; the UI may explain general exposure
risk. Interception does not instantly reveal HQ or create a precise artillery
solution. Action on a report follows ordinary targeting, communication, range
and ammunition rules. A relocated transmitter leaves an aged report behind.

Completion: both factions use the same capability-based mechanism; clear traffic
can produce useful delayed reports; cipher traffic can remain unreadable;
courier-only/unsent plans never leak; uncertain location stays stale after movement;
broken own reporting links delay delivery. Emissions, private knowledge, queues
and timers survive save/replay/recovery and remain camera-independent.

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

Exact scenario establishments, language/cipher capabilities and processing
delays still need dated evidence before implementation. Do not infer guaranteed
instant plaintext access or a nationality-wide advantage from these sources.
