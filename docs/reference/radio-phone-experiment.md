# Radio and telephone trial

Playable experimental checkpoint on `codex/radio-phone-experiment`; not a
completed production implementation of all 071/076/077 requirements. The main
`codex/vehicles-3d-p2` branch is unchanged by this trial.

Open the development server and choose **Signal experiment**, then **Begin**.
An unarmed T-34 training target is visible to I Platoon. The warehouse blocks
the receiving squad's view. A routed field telephone connects I/II Platoon;
actual personal reports then reach the receiving squad without direct sight.
Select **Receiving squad** to see its dated reported-contact marker.

**FIELD TELEPHONE** opens own-line controls. In deployment, select a leader,
Connect selected, add route points and click a friendly endpoint. Underground
is a trial control for comparing protected and exposed wires. Surface wire can
be severed by actual blasts or a moving vehicle; underground segments are safe.
Operators must remain within 4 m of the ends. Remove is setup-only; repair
requires a capable endpoint/engineer at the cut segment and 20 s of actual work.

**Radio** shows both radio nets and only the player's own phone transcript.
The headset uses 109 locally generated English speech tokens, no online speech
service. Signals retain their private meanings; speech reads only public wire
payloads. Player audio does not automatically grant every soldier knowledge.

## Voice flood fix from live trial feedback

2026-11-03 clarification: radio is a real command medium, not a narration of
every simulation update. Orders use local voice/intercom when possible, then
an intact telephone path (including leader relays), with radio only when no
non-radio command path exists. Only the media actually present on the chosen
path produce headset traffic. A nearby order is not a phone/radio call merely
because equipment is available. Automatic perception-memory updates no longer
produce radio speech; own telephone contact reports remain supported. Explicit
radio signals and genuine external-support calls still produce public radio
traffic. One fire mission/correction is not voiced once per observer/packet.
The existing ordinary order-execution timing is unchanged; this trial does not
yet implement full queued command delivery or the future company hierarchy.
The routing correction passed 80 targeted tests across nine files, including
actual queued player orders over telephone versus radio, local/voice relays,
phone-to-voice relays, severed-wire fallback, and the existing support/report
tests. TypeScript passed. This is targeted validation, not a full-suite claim.

- One utterance at a time instead of overlapping every incoming packet.
- Routine voice announcements: at most eight per real minute, at least six
  seconds between starts. Old background announcements are not replayed later.
- Signals and fire calls have priority and can interrupt a lower-priority report.
- Repeated stationary contact updates/relays coalesce; small position jitter
  does not trigger another call. A changed area can be announced after 12 s;
  an unchanged contact is not repeated within 60 s. Changed condition is distinct.
- Bulk navigation/belief synchronization is not synthesized as hundreds of
  separate “Enemy activity report target” utterances.
- Recipient knowledge and physical report delivery remain independent of this
  player voice filter. Text remains available for admitted logical calls.

This replaces the initial trial's unbounded simultaneous playback. Telephone
privacy is enforced again inside the audio consumer. The prototype still needs
broader playtesting, full message-airtime/queue design, speed/pause tuning and
cross-engine/network regression verification before being considered complete.
The flat test roster uses named platoon teams, not the full future hierarchy.
Optional 073 scoped command views and 074/075 terrain memory/photos are absent.

Validation: **20 tests passed across four files; TypeScript passed.** Focused offline-audio, physical-wire, actual non-seeing leader
delivery/cut, and spam-admission tests plus TypeScript. A 50-message burst
schedules one utterance; opposing phone speech is excluded. All 110 WAV assets
(109 vocabulary files and one sample) have nonempty PCM data. No broad suite or
production-ready status is claimed for this prototype.

Run locally: `npm ci`, then `npm run dev -- --port 5175`. Click inside the game
to unlock audio. Reload after audio-code changes to clear the old browser's
already scheduled speech.
