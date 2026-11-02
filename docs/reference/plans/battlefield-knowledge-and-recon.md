# Battlefield map knowledge and pre-battle aerial photographs

Requested 2026-11-02, 14:15. **Queued, not implemented**: 074 and 075.
Extends individual sensing (056), night visibility (059), changing terrain (064),
campaign objectives (067) and the optional command perspective (073). The basic
knowledge model also applies to the ordinary view; 073 determines whose picture
is being shown, not whether hidden terrain changes are allowed to leak.

## 074 — Map baseline, remembered scene and current observation

Represent three different knowledge states instead of darkening the live world:

| State | Player presentation | Knowledge updates |
|---|---|---|
| Not observed | Drawn map baseline: known routes, terrain and authored mapped features | Scenario briefing or legitimately received newer intelligence |
| Previously observed | Last observed appearance, visibly distinguishable from current observation | A new actual observation or delivered report |
| Currently observed | What the relevant observers can actually perceive now | Individual sensing and real report delivery for the selected context |

The baseline is dated/scenario-authored map information, not a rendering of the
hidden current map. It can show a mapped building without confirming its present
condition. Initially destroyed buildings, new defenses or craters must not appear
on an old map merely because their live simulation objects exist.

Store remembered terrain/structure state and its observation time/source. If a
building was seen intact and is destroyed after it leaves view, show the intact
remembered building until someone observes/reports the changed state. Freeze the
relevant visible geometry/appearance and coverage, not just a tile's visited bit
over a live mesh. Support partial observations: seeing one wall or roof must not
refresh hidden interiors, other elevations or the whole neighborhood.

Use the same knowledge boundary for terrain textures/meshes, damage states,
craters, obstacles, minimap, labels, target previews and relevant rendering
caches. Hidden destruction must not leak through a refreshed silhouette, debris,
marker or a live shadow derived from unobserved geometry. A genuinely observed
effect can provide a bounded cue without automatically revealing the exact
hidden building/terrain state. Distant explosions/sounds can support uncertain
reports, not an automatic perfect geometry update.

Knowledge differs from physics: the real collapsed wall, crater or wire still
affects movement, collision and LOS. Route decisions use the unit's legitimate
map/observations; encountering an unknown obstruction can create a new local
observation and replan. Neither path previews nor subordinate AI may consult
hidden changes to grant knowledge in advance. Camera movement/zoom and merely
selecting a formation do not observe or refresh the terrain.

### Tall buildings and partial distant visibility

Use actual observer eye height/elevation and visible portions of a structure,
including upper walls, roofline and silhouette. A tall building can be detected
far away even when its base is hidden by lower obstacles. Consider range/angular
size, intervening terrain/buildings/vegetation, light, weather, illumination and
the observer's sensing capability rather than a blanket short ground-sight radius.

Detecting a roofline does not reveal the street behind it, occupants, lower-floor
damage or ground-level targets. Distinguish distant structure detection from
fine recognition/current-condition assessment. Update only information actually
resolvable by that observation, with its age/uncertainty. A visibly changed
skyline may legitimately update known upper-structure damage while the hidden
ground remains remembered or unmapped.

Acceptance: baseline never leaks live damage; intact memory survives an unseen
collapse and refreshes only after legitimate observation/report; two command
contexts can retain different dated states; a roof is visible over a lower
occluder without exposing its base/occupants; darkness/weather/height affect
detection consistently. Verify main rendering/minimap/targeting, real physical
obstructions versus known routes, save/replay/recovery and camera independence.
Audit existing personal navigation cells and night-ground memory before reusing
them: they do not by themselves prove a finished remembered-scene renderer.

## 075 — Pre-battle high-altitude aerial coverage of key areas

User proposal: before battle, photograph key locations from a high-flying
reconnaissance aircraft. Some areas then have more detailed/recent information
than the drawn map baseline. Make pre-battle reconnaissance coverage/briefing a
supported scenario/campaign preparation option, with authored key-area coverage
before each applicable battle. This is not a new live battlefield camera.

Each photograph/intelligence patch has a footprint, capture time, source,
resolution/quality and actual visible content. Show coverage and age in the
briefing/map so the player can distinguish an older map, a recent photographed
crossing and a currently observed position. Optional photograph-style presentation
can supplement the readable tactical map; an image alone must not secretly keep
updating the underlying knowledge.

Populate the covered area's initial 074 knowledge from the state **at capture**.
A destroyed bridge visible when photographed can be known before ground troops
arrive. Damage, movement or fieldwork occurring after capture stays unknown until
a later observation/report. Old campaign photographs retain their age; map load
or battle transition cannot silently replace them with today's physical state.
Snapshot generation must respect the actual pre-battle event sequence and 064
background destruction, rather than label a post-bombardment image as older data.

High-altitude coverage shows only what the authored image quality, angle,
occlusion and conditions permit: broad terrain, roofs, sufficiently clear damage
and visible surface activity. It does not reveal interiors, concealed troops,
buried mines, exact unit identities/health/ammunition or future positions. Any
visible force sightings are aged observations with uncertainty, not live markers
tracking those units after the photograph was taken. Coverage quality may vary;
do not assume every photographed area resolves every small obstacle or soldier.

Distribute the briefing/patch knowledge to the appropriate command context and
participants legitimately briefed before battle. Later delivery to isolated
elements still follows communication rules. In 073, selecting another formation
does not grant it photos that were never distributed to it. Radio transmission
of derived reports follows 070; a photograph's whole data set is not automatically
broadcast by sending one agreed signal.

Keep reconnaissance separate from 058's combat-aircraft sortie/ammunition pool
and 064's background bombardment budget. Author availability, coverage and any
resource cost explicitly; do not silently consume an attack sortie or invent
continuous unlimited reconnaissance. Picking additional areas/priorities is a
possible later interaction, not an already requested mandatory flight simulator.

Persist capture-time snapshots/semantic knowledge and coverage/quality metadata,
with deterministic generation where applicable. Reloading must not resample the
current hidden battlefield into an old photo. Verify newly photographed versus
map-only regions, post-capture destruction/movement, unresolved/concealed objects,
different command distributions, chronological campaign transitions and exact
replay/recovery. No historical aircraft/equipment availability is asserted here;
date-specific assets and numerical resolution limits need evidence when authored.
