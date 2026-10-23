import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import qrcode from '../public/vendor/qrcode.mjs';
import jsQR from 'jsqr';
import { LiveTimeline } from '../public/live-timeline.js';

const source = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace("import qrcode from '/qr.js';",'').replace("import { LiveTimeline } from '/live-timeline.js';",'').replace(/boot\(\);\s*$/, 'globalThis.bootResult = boot();');
function browser({search='?room=test-room',rejectInvitation=false,joinUrls=['http://192.168.1.2:3210/?room=test-room']}={}) {
  const elements=new Map(), requests=[];
  const element=id=>{
    if(!elements.has(id)) elements.set(id,{textContent:'',value:'',hidden:false,disabled:false,parentElement:{hidden:false},handlers:{},setAttribute(){},addEventListener(type,fn){this.handlers[type]=fn;},contains(){return false;}});
    return elements.get(id);
  };
  let replaced=false;
  const context=vm.createContext({
    qrcode,LiveTimeline,atob,URLSearchParams,AbortController,setTimeout,clearTimeout,setInterval:()=>0,performance,console,
    location:{search},
    document:{getElementById:element,addEventListener(){},visibilityState:'visible'},
    history:{replaceState(){replaced=true;}},
    navigator:{userAgent:'iPhone Mobi'},
    window:{get sessionStorage(){throw new Error('Storage is blocked');},get localStorage(){throw new Error('Storage is blocked');}},
    EventSource:class {constructor(url){this.url=url;}addEventListener(){}},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url==='/api/bootstrap') return {ok:!rejectInvitation,json:async()=>rejectInvitation?{error:'Use the join link shown on the host laptop.'}:{key:'test-room',isHost:false,joinUrls}};
      if(url.startsWith('/api/join')) return {ok:true,json:async()=>({id:'phone-id',secret:'phone-secret'})};
      if(url.startsWith('/api/clock')) return {ok:true,json:async()=>({time:performance.timeOrigin+performance.now()})};
      if(url.startsWith('/api/device')) return {ok:true,json:async()=>({ok:true})};
      throw new Error(`Unexpected test request: ${url}`);
    }
  });
  vm.runInContext(source,context);
  return {context,element,requests,replaced:()=>replaced};
}
test('iPhone can join and save its name when browser storage is blocked',async()=>{
  const b=browser(); await b.context.bootResult;
  assert.equal(b.element('enable').disabled,false);
  assert.equal(b.element('rename').disabled,false);
  assert.match(b.element('local-status').textContent,/Joined/);
  assert.equal(b.replaced(),false,'retain the invitation when storage cannot survive a reload');
  b.element('device-name').value='My iPhone';
  await b.element('rename').handlers.click();
  assert.equal(b.element('local-status').textContent,'Name saved: My iPhone');
  const save=b.requests.find(r=>r.url.startsWith('/api/device'));
  assert.equal(JSON.parse(save.options.body).name,'My iPhone');
});
test('a bare address explains the missing invitation and disables unusable controls',async()=>{
  const b=browser({search:''}); await b.context.bootResult;
  assert.equal(b.element('connection').textContent,'Room not connected');
  assert.equal(b.element('enable').disabled,true);
  assert.equal(b.element('rename').disabled,true);
  assert.match(b.element('local-status').textContent,/missing the room invitation/);
  assert.equal(b.requests.length,0);
});
test('expired invitations show the connection error beside the speaker controls',async()=>{
  const b=browser({rejectInvitation:true}); await b.context.bootResult;
  assert.equal(b.element('enable').disabled,true);
  assert.match(b.element('local-status').textContent,/Use the join link/);
  assert.equal(b.replaced(),false);
});
test('rendered QR codes scan to the complete invitation and follow the selected network',async()=>{
  const urls=['http://192.168.1.2:3210/?room=0123456789abcdef01234567','http://10.0.0.42:3210/?room=0123456789abcdef01234567'];
  const b=browser({joinUrls:urls});await b.context.bootResult;
  function scanRenderedSvg() {
    const svg=b.element('join-qr').innerHTML;
    const size=Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
    const pixels=new Uint8ClampedArray(size*size*4).fill(255);
    for(const match of svg.matchAll(/M(\d+),(\d+)l4,0 0,4 -4,0 0,-4z/g)) {
      const x=Number(match[1]),y=Number(match[2]);
      for(let j=y;j<y+4;j++) for(let i=x;i<x+4;i++) {
        const at=(j*size+i)*4;pixels[at]=pixels[at+1]=pixels[at+2]=0;
      }
    }
    return jsQR(pixels,size,size)?.data;
  }
  assert.equal(b.element('qr-invite').hidden,false);
  assert.equal(scanRenderedSvg(),urls[0]);
  assert.equal(b.element('qr-join-link').href,urls[0]);
  b.element('join-network').value=urls[1];b.element('join-network').handlers.change();
  assert.equal(scanRenderedSvg(),urls[1]);
  assert.equal(b.element('qr-join-link').href,urls[1]);
  assert.ok(b.element('join-links').innerHTML.includes(urls[1]));
});
test('live receiver schedules adjacent blocks through reduced gain and a compressor',async()=>{
  const b=browser();await b.context.bootResult;
  const sources=[],gains=[],compressors=[],buffers=[],filters=[];
  const param=()=>({value:1,cancelScheduledValues(){},setTargetAtTime(value){this.target=value;},setValueAtTime(){}});
  const node=()=>({connections:[],connect(to){this.connections.push(to);},disconnect(){}});
  const ctx={currentTime:0,state:'running',outputLatency:.02,destination:{},
    createGain(){const n={...node(),gain:param()};gains.push(n);return n;},
    createDynamicsCompressor(){const n={...node(),threshold:param(),knee:param(),ratio:param(),attack:param(),release:param()};compressors.push(n);return n;},
    createBiquadFilter(){const n={...node(),frequency:param(),Q:param(),gain:param()};filters.push(n);return n;},
    createBuffer(channels,frames,rate){const data=Array.from({length:channels},()=>new Float32Array(frames));const n={duration:frames/rate,getChannelData:i=>data[i]};buffers.push(n);return n;},
    createBufferSource(){const n={...node(),playbackRate:param(),start(when){this.when=when;},stop(){}};sources.push(n);return n;}
  };
  b.context.testContext=ctx;
  vm.runInContext(`ctx=testContext;connected=true;receive({track:null,live:{id:'live',bufferMs:700},transport:{playing:false,position:0,startsAt:0,revision:0},devices:[{id:'phone-id',name:'Phone',volume:1,delay:0,role:'stereo',muted:false,armed:true,readyTrack:'live:live'}]});`,b.context);
  const pcm=Buffer.alloc(4800*8);pcm.writeFloatLE(1.5,0);pcm.writeFloatLE(-2,4);
  const start=performance.timeOrigin+performance.now()+700;
  b.context.packet={id:'live',frame:0,frames:4800,sampleRate:48000,startsAt:start,pcm:pcm.toString('base64')};
  vm.runInContext('receiveLive(packet)',b.context);
  b.context.packet={...b.context.packet,frame:4800,startsAt:start+100};
  vm.runInContext('receiveLive(packet)',b.context);
  assert.equal(sources.length,2);
  assert.equal(sources[1].when,sources[0].when+.1);
  assert.equal(buffers[0].getChannelData(0)[0],1);
  assert.equal(buffers[0].getChannelData(1)[0],-1);
  assert.equal(compressors.length,1);assert.equal(compressors[0].ratio.value,20);
  const headroom=gains.find(g=>g.connections.includes(filters[0]));
  assert.equal(headroom.gain.value,.6);
  assert.deepEqual(filters.map(f=>f.type),['lowshelf','peaking','highshelf']);
  assert.ok(filters[2].connections.includes(compressors[0]));
  vm.runInContext(`room.devices[0].eq={enabled:true,bass:4,mid:0,treble:2};applyEqualizer();`,b.context);
  assert.deepEqual(filters.map(f=>f.gain.target),[4,0,2]);
  assert.ok(headroom.gain.target<.31,'positive EQ boosts reserve headroom before the filters');
  vm.runInContext('room.devices[0].eq.enabled=false;applyEqualizer();',b.context);
  assert.deepEqual(filters.map(f=>f.gain.target),[0,0,0]);
  assert.equal(headroom.gain.target,.6);
  assert.ok(!sources.some(s=>s.connections.includes(ctx.destination)));
});
