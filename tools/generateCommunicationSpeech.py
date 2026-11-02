#!/usr/bin/env python3
"""Generate offline macOS Alex voice bank; run from any working directory."""
import json,pathlib,string,subprocess,tempfile,wave
ROOT=pathlib.Path(__file__).resolve().parents[1]; OUT=ROOT/'public/audio/communications'; OUT.mkdir(parents=True,exist_ok=True)
WORDS='german soviet radio telephone message report signal fire request correction cancellation mission target contact enemy activity casualty terrain vehicle obstruction objective uncontrolled leadership succession infantry tank gun wounded killed healthy move fast sneak defend ambush stop smoke attack assault suppress retreat rally at to from north south east west position grid over out ready affirmative negative cancelled requested corrected zero one two three four five six seven eight nine minus point space unknown'.split()
TOKENS={w:w for w in WORDS}; TOKENS.update({'letter_'+c:c.upper() for c in string.ascii_lowercase}); TOKENS.update({'digit_'+str(i):w for i,w in enumerate('zero one two three four five six seven eight nine'.split())})
durations={}
for key,text in TOKENS.items():
 with tempfile.TemporaryDirectory() as d:
  raw=pathlib.Path(d)/'voice.aiff'
  subprocess.run(['/usr/bin/say','-v','Alex','-r','185','-o',str(raw),text],check=True)
  subprocess.run(['ffmpeg','-v','error','-y','-i',str(raw),'-af','silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB','-ar','22050','-ac','1',str(OUT/(key+'.wav'))],check=True)
 with wave.open(str(OUT/(key+'.wav'))) as w: durations[key]=round(w.getnframes()/w.getframerate(),6)
if any(duration <= 0 for duration in durations.values()):
 raise RuntimeError('System voice produced empty audio. Run outside the sandbox with speech-service access.')
(OUT/'manifest.json').write_text(json.dumps(durations,indent=2)+'\n')
(ROOT/'src/data/communicationSpeechDurations.ts').write_text('// Generated offline by tools/generateCommunicationSpeech.py; seconds.\nexport const SPEECH_DURATIONS: Readonly<Record<string, number>> = '+json.dumps(durations,indent=2)+';\n')
print(f'Generated {len(durations)} tokens')
