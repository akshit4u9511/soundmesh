// Keep each PCM block exactly adjacent to the preceding block. Network-clock
// estimates may adjust playback speed slightly, but never move a block boundary.
export class LiveTimeline {
  reset() { this.signature=null;this.nextFrame=null;this.nextWhen=null; }
  constructor() { this.reset(); }
  plan(packet, desiredWhen, now, signature) {
    if(this.signature===signature && packet.frame<this.nextFrame) return {ignore:true};
    const restart=this.signature!==signature || packet.frame!==this.nextFrame;
    const when=restart?desiredWhen:this.nextWhen;
    if(!Number.isFinite(when) || when<now+.025) {this.reset();return null;}
    // At most 0.1% rate correction. This avoids clock-driven jumps/clicks.
    const error=when-desiredWhen;
    const rate=restart?1:Math.max(.999,Math.min(1.001,1+error*.02));
    this.signature=signature;this.nextFrame=packet.frame+packet.frames;
    this.nextWhen=when+packet.frames/packet.sampleRate/rate;
    return {when,rate,restart};
  }
}
