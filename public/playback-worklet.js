// Continuous resampling across packet boundaries: do not restart a separate
// browser resampler for every 100 ms of audio.
class SoundMeshPlayback extends AudioWorkletProcessor {
  constructor() {
    super();this.chunks=[];this.position=null;this.startFrame=Infinity;
    this.inputRate=sampleRate;this.rate=1;this.level=0;this.last=[0,0];
    this.port.onmessage=event=>{
      const p=event.data;
      if(p.type!=='packet') return;
      if(this.position===null) {
        this.position=p.frame;this.startFrame=Math.round(p.when*sampleRate);this.inputRate=p.sampleRate;
      }
      this.rate=p.rate;
      this.chunks.push({start:p.frame,end:p.frame+p.frames,data:new Float32Array(p.samples)});
      if(this.chunks.length>64) this.chunks.shift();
    };
  }
  sample(frame,channel) {
    for(let i=0;i<Math.min(2,this.chunks.length);i++) {
      const c=this.chunks[i];
      if(frame>=c.start && frame<c.end) return c.data[(frame-c.start)*2+channel];
    }
    return undefined;
  }
  process(inputs,outputs) {
    const output=outputs[0];if(!output?.length) return true;
    for(let i=0;i<output[0].length;i++) {
      if(this.position===null || currentFrame+i<this.startFrame) continue;
      const frame=Math.floor(this.position),fraction=this.position-frame;
      while(this.chunks.length && this.chunks[0].end<=frame) this.chunks.shift();
      const available=this.sample(frame,0)!==undefined;
      this.level+=Math.max(-.002,Math.min(.002,(available?1:0)-this.level));
      for(let channel=0;channel<output.length;channel++) {
        const a=this.sample(frame,channel);
        if(a!==undefined) {
          const b=this.sample(frame+1,channel) ?? a;
          this.last[channel]=a+(b-a)*fraction;
        }
        output[channel][i]=this.last[channel]*this.level;
      }
      this.position+=this.inputRate/sampleRate*this.rate;
    }
    return true;
  }
}
registerProcessor('soundmesh-playback',SoundMeshPlayback);
