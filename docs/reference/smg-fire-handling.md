# SMG fire handling

The simulation separates acquisition, a trigger hold, and recovery. MP40 rounds are spaced at
0.12 seconds and PPSh rounds at 0.06 seconds; these approximate cyclic rates are separate from
the existing controlled-burst rate. Rounds consume ammunition and generate sound individually.
Every round traces its actual bearing through vegetation, solid cover and vehicle hulls.

Shoulder fire is the default. Close, hurried engagements and stress can prompt hip fire, with
quicker presentation and substantially wider dispersion. Prone soldiers always use shoulder fire.
At 75 m or more, controlled MP40 trigger pulls use two rounds and the selective-fire PPSh uses one.
Short area bursts traverse a small angle; loss of discipline can produce a full-magazine sweep.
High stress and low experience increase that probability, while fully panicked or cowering soldiers
stop firing. These thresholds and probabilities are gameplay tuning, not measured psychological laws.

The visual and physical shot share a bearing. The supplementary sprite atlases provide five torso
twists with planted legs and three recoil stages for standing, crouching, kneeling and prone fire.
Hip poses exist only for the upright postures. Prone torso travel and recoil are smaller. The barrel
flash and first tracer segment account for weapon height; the normal game camera still projects
ground positions from above. Sprite angular steps are discrete (16 body directions plus five twists).

The contemporary US Navy *Aircraft Armament* discussion describes short submachine-gun bursts and
a trigger hold continuing until release or an empty magazine. See the
[archived Navy text](https://www.ibiblio.org/hyperwar/USN/ref/AircraftArmament/).
The US Army's Korean War staff-ride reading gives the PPSh a maximum rate around 1,000 rounds/minute
and identifies both box and drum magazines; the game retains its existing 71-round drum definition.
See [Army University Press, Wonju and Chipyong-ni readings](https://www.armyupress.army.mil/Portals/7/educational-services/staff-rides/2_The_2d_Infantry_Division_at_the_Battles_of_Wonju_and_Chipyong-ni_Readings_Exportable.pdf).
The model deliberately treats handling, recoil dispersion and firing discipline as approximations.

`tools/smgPreview.html` runs the real combat, sprite and effects code with fixed demonstration modes.
Its optional `?time=2.7` parameter pauses at a repeatable moment. The faint path overlay is a preview
aid; the battle renders only its usual moving bullet streaks and impact effects.
