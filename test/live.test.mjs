import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeLivePacket } from '../lib/live.mjs';
import { LiveTimeline } from '../public/live-timeline.js';

function bytes(frame,frames=4800) {
  const b=Buffer.alloc(8+frames*8);b.writeDoubleLE(frame,0);
  for(let i=8;i<b.length;i+=8) {b.writeFloatLE(.25,i);b.writeFloatLE(-.5,i+4);}
  return b;
}
test('live PCM timestamps use a stable shared timeline and preserve both channels',()=>{
  const live={id:'live',sampleRate:48000,startedAt:null,frames:0};
  const first=makeLivePacket(live,bytes(0),10000);
  const second=makeLivePacket(live,bytes(4800),10180);
  assert.equal(first.startsAt,10700);
  assert.equal(second.startsAt,10800,'upload jitter must not become playback jitter');
  assert.equal(second.frames,4800);
  const pcm=Buffer.from(first.pcm,'base64');
  assert.equal(pcm.readFloatLE(0),.25);assert.equal(pcm.readFloatLE(4),-.5);
  assert.equal(live.frames,9600);
});
test('live PCM rejects reordering, invalid samples, and stale upload queues',()=>{
  const live={id:'live',sampleRate:48000,startedAt:null,frames:0};
  assert.throws(()=>makeLivePacket(live,bytes(4800),10000),/out of order/);
  const bad=bytes(0);bad.writeFloatLE(NaN,8);
  assert.throws(()=>makeLivePacket(live,bad,10000),/Invalid audio samples/);
  makeLivePacket(live,bytes(0),10000);
  assert.throws(()=>makeLivePacket(live,bytes(4800),20000),/fell behind/);
});
test('live receiver joins audio blocks with no gaps or overlaps despite jittery clock estimates',()=>{
  const timeline=new LiveTimeline();let end=null;
  for(let i=0;i<1000;i++) {
    const packet={frame:i*4800,frames:4800,sampleRate:48000};
    const jitter=i%2===0?.018:-.023;
    const plan=timeline.plan(packet,10+i*.1+jitter,i*.1,'stream/48000/0/stereo');
    assert.ok(plan);
    if(end!==null) assert.equal(plan.when,end,'the next block starts at the exact end of the preceding block');
    assert.ok(plan.rate>=.999 && plan.rate<=1.001);
    end=plan.when+.1/plan.rate;
  }
});
test('receiver drops stale audio and reanchors after packet loss instead of cutting into a block',()=>{
  const timeline=new LiveTimeline();
  const first=timeline.plan({frame:0,frames:4800,sampleRate:48000},1,0,'a');
  assert.equal(first.restart,true);
  assert.deepEqual(timeline.plan({frame:0,frames:4800,sampleRate:48000},1,0,'a'),{ignore:true});
  const gap=timeline.plan({frame:9600,frames:4800,sampleRate:48000},1.2,.2,'a');
  assert.equal(gap.restart,true);assert.equal(gap.when,1.2);
  assert.equal(timeline.plan({frame:14400,frames:4800,sampleRate:48000},1.3,2,'a'),null);
  assert.equal(timeline.nextFrame,null);
});
test('live latency profiles change the initial buffer without changing PCM spacing',()=>{
  for(const bufferMs of [350,700,1400]) {
    const session={id:'profile',sampleRate:48000,bufferMs,startedAt:null,frames:0};
    const a=makeLivePacket(session,bytes(0),10000),b=makeLivePacket(session,bytes(4800),10100);
    assert.equal(a.startsAt,10000+bufferMs);assert.equal(b.startsAt-a.startsAt,100);
  }
});
test('capture worklet packs consecutive blocks across render boundaries without losing samples',async()=>{
  let Processor;const packets=[];
  const context=vm.createContext({sampleRate:48000,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage(packet){packets.push(packet);}};}},registerProcessor(name,cls){Processor=cls;}});
  vm.runInContext(await readFile(new URL('../public/capture-worklet.js',import.meta.url),'utf8'),context);
  const capture=new Processor();let sample=0;
  for(let block=0;block<80;block++) {
    const left=new Float32Array(128),right=new Float32Array(128);
    for(let i=0;i<128;i++) {left[i]=sample;right[i]=-sample;sample++;}
    assert.equal(capture.process([[left,right]]),true);
  }
  assert.equal(packets.length,2);assert.equal(packets[0].frame,0);assert.equal(packets[1].frame,4800);
  for(let p=0;p<2;p++) {
    const pcm=new Float32Array(packets[p].samples);
    for(let i=0;i<4800;i++) {assert.equal(pcm[i*2],p*4800+i);assert.equal(pcm[i*2+1],-(p*4800+i));}
  }
});
