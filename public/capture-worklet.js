class SoundMeshCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.length=Math.round(sampleRate/10);
    this.samples=new Float32Array(this.length*2);
    this.at=0; this.frame=0;
  }
  process(inputs) {
    const input=inputs[0];
    if (!input?.length) return true;
    const left=input[0],right=input[1] || left;
    for(let i=0;i<left.length;i++) {
      this.samples[this.at*2]=left[i];this.samples[this.at*2+1]=right[i];this.at++;
      if(this.at===this.length) {
        this.port.postMessage({frame:this.frame,samples:this.samples.buffer},[this.samples.buffer]);
        this.frame+=this.length;this.at=0;this.samples=new Float32Array(this.length*2);
      }
    }
    return true;
  }
}
registerProcessor('soundmesh-capture',SoundMeshCapture);
