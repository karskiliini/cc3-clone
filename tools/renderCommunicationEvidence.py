#!/usr/bin/env python3
"""Render a stereo evidence WAV from the shipped tokens (stdlib only)."""
import array,math,pathlib,wave,json
ROOT=pathlib.Path(__file__).resolve().parents[1];OUT=ROOT/'public/audio/communications'; RATE=22050
def phrase(words,start,pan):
 result=[];at=start
 for word in words.split():
  with wave.open(str(OUT/(word+'.wav'))) as w: samples=array.array('h',w.readframes(w.getnframes()))
  result.append((int(at*RATE),samples,pan));at+=len(samples)/RATE+0.045
 return result,at
tracks=[];end=0
for words,start,pan in [('german radio contact report enemy infantry target digit_1 digit_0',0,-0.6),('soviet radio fire request mission digit_2',2,0.6),('telephone move north over',5,0)]:
 chunks,at=phrase(words,start,pan);tracks+=chunks;end=max(end,at)
left=[0.]*(int(end*RATE)+1);right=left.copy()
for start,samples,pan in tracks:
 for i,value in enumerate(samples):
  left[start+i]+=value*math.sqrt((1-pan)/2)*0.55;right[start+i]+=value*math.sqrt((1+pan)/2)*0.55
pcm=array.array('h')
for l,r in zip(left,right):pcm.extend([max(-32768,min(32767,round(l))),max(-32768,min(32767,round(r)))])
with wave.open(str(OUT/'evidence-both-radios-own-telephone.wav'),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(RATE);w.writeframes(pcm.tobytes())
print(f'{end:.2f} seconds stereo evidence')
