import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const code=await readFile(new URL('../public/playback-worklet.js',import.meta.url),'utf8');
function processor(outputRate) {
  let Processor;
  const scope=vm.createContext({sampleRate:outputRate,currentFrame:0,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={onmessage:null};}},registerProcessor(name,type){Processor=type;}});
  vm.runInContext(code,scope);
  return {scope,player:new Processor()};
}
for(const outputRate of [44100,48000]) test(`continuous engine preserves stereo waveforms across packets at ${outputRate} Hz`,()=>{
  const {scope,player}=processor(outputRate),inputRate=48000,frames=19200;
  const pcm=new Float32Array(frames*2);
  for(let i=0;i<frames;i++) {pcm[i*2]=.5*Math.sin(2*Math.PI*440*i/inputRate);pcm[i*2+1]=.4*Math.sin(2*Math.PI*660*i/inputRate);}
  for(let frame=0;frame<frames;frame+=4800) {
    const data=pcm.slice(frame*2,(frame+4800)*2);
    player.port.onmessage({data:{type:'packet',frame,frames:4800,sampleRate:inputRate,when:0,rate:1,samples:data.buffer}});
  }
  const rendered=[[],[]],total=Math.floor(frames/inputRate*outputRate);
  for(let block=0;block<Math.ceil((total+700)/128);block++) {
    scope.currentFrame=block*128;
    const output=[new Float32Array(128),new Float32Array(128)];
    assert.equal(player.process([],[output]),true);
    for(let c=0;c<2;c++) rendered[c].push(...output[c]);
  }
  // Ignore the intentional opening fade; compare actual rendered samples,
  // including the boundary between every pair of network packets.
  for(let i=1000;i<total-2;i++) {
    const position=i*inputRate/outputRate,at=Math.floor(position),fraction=position-at;
    for(let c=0;c<2;c++) {
      const expected=pcm[at*2+c]+(pcm[(at+1)*2+c]-pcm[at*2+c])*fraction;
      assert.ok(Math.abs(rendered[c][i]-expected)<.000002,`waveform changed near output sample ${i}`);
    }
  }
  assert.ok(rendered.every(channel=>channel.slice(total+550).every(value=>value===0)),'underrun fades to silence');
});
test('continuous engine waits until the shared start time and bounds queued audio',()=>{
  const {scope,player}=processor(48000);
  for(let i=0;i<70;i++) player.port.onmessage({data:{type:'packet',frame:i*4800,frames:4800,sampleRate:48000,when:2,rate:1,samples:new Float32Array(9600).fill(.5).buffer}});
  assert.ok(player.chunks.length<=64);
  scope.currentFrame=0;
  const output=[new Float32Array(128),new Float32Array(128)];player.process([],[output]);
  assert.ok(output.every(channel=>channel.every(value=>value===0)));
});
