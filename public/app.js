import qrcode from '/qr.js';
import { LiveTimeline } from '/live-timeline.js';

const $ = id => document.getElementById(id);
// Storage may be blocked in private browsing or embedded iPhone browsers.
// Joining and audio must work even when nothing can be persisted.
const memoryStores = { sessionStorage: new Map(), localStorage: new Map() };
function readStore(kind, name) {
  try { return window[kind].getItem(name) ?? memoryStores[kind].get(name) ?? null; }
  catch { return memoryStores[kind].get(name) ?? null; }
}
function writeStore(kind, name, value) {
  memoryStores[kind].set(name, value);
  try { window[kind].setItem(name, value); return true; } catch { return false; }
}
const params = new URLSearchParams(location.search);
let hostToken = params.get('host') || readStore('sessionStorage', 'sm-host') || '';
let key = params.get('room') || readStore('sessionStorage', 'sm-room') || '';
let isHost = false, me = null, room = null, ctx = null, buffer = null, bufferId = null;
let source = null, output = null, splitter = null, merger = null;
let offset = 0, clockReady = false, loadedRevision = -1, loadSequence = 0, audioStart = null;
let events, heartbeatTimer, clockTimer, waking = null, joinUrls = [], ownDelay = null, connected = false;
let failedTrack = null;
let liveGain = null, liveNodes = new Set(), liveReadySent = null;
let capture = null, startingCapture = false;
let selectedSource='live',selectedJoinUrl='';
const liveTimeline=new LiveTimeline();
let safeOutput=null,liveLevel=null;
let livePlayer=null,continuousReady=false,continuousSetup=null;
let eqFilters=null,eqSignature='';
let eqDraft={enabled:true,bass:0,mid:0,treble:0},eqSaveTimer=null,eqSaving=0,eqPending=null;
const eqPresets={flat:[0,0,0],warm:[2,0,-1],bass:[4,-1,0],voice:[-2,3,1],bright:[-1,0,3],night:[-3,1,-2]};
const clientNow = () => performance.timeOrigin + performance.now();
const serverNow = () => clientNow() + offset;
const escapeHtml = str => String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = sec => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.floor(Math.max(0, sec) % 60)).padStart(2, '0')}`;
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function connectionControls(enabled) {
  $('enable').disabled = !enabled;
  $('rename').disabled = !enabled;
  $('broadcast').disabled = !enabled || !isHost;
  $('source-live').disabled = !enabled || !isHost;
  $('source-file').disabled = !enabled || !isHost;
}
function renderJoinInvitation() {
  selectedJoinUrl=joinUrls.includes(selectedJoinUrl)?selectedJoinUrl:joinUrls.find(url=>url.startsWith(`${location.origin}/`)) || joinUrls[0] || '';
  $('qr-invite').hidden=!selectedJoinUrl;
  $('copy').disabled=!selectedJoinUrl;
  $('join-network-label').hidden=joinUrls.length<2;
  $('join-network').innerHTML=joinUrls.map(url=>`<option value="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//,'').split('/')[0])}</option>`).join('');
  $('join-network').value=selectedJoinUrl;
  if(!selectedJoinUrl) {
    $('join-qr').innerHTML='';
    $('join-links').innerHTML='<p class="muted">Connect the host to Wi-Fi and restart to create a join link.</p>';
    return;
  }
  const qr=qrcode(0,'M');qr.addData(selectedJoinUrl,'Byte');qr.make();
  $('join-qr').innerHTML=qr.createSvgTag({cellSize:4,margin:16,scalable:true});
  $('qr-join-link').href=selectedJoinUrl;
  $('join-links').innerHTML=`<a class="join-link" href="${escapeHtml(selectedJoinUrl)}">${escapeHtml(selectedJoinUrl)}</a>`;
}
function renderSourceMode() {
  $('source-mode').hidden=!isHost;
  $('source-live').setAttribute('aria-pressed',String(selectedSource==='live'));
  $('source-file').setAttribute('aria-pressed',String(selectedSource==='file'));
  $('broadcast-controls').hidden=!isHost || selectedSource!=='live';
  $('file-options').hidden=!isHost || selectedSource!=='file';
}
async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (e) { if (e.name === 'AbortError') throw new Error('The laptop did not respond. Check that both devices are on the same Wi-Fi.'); throw e; }
  finally { clearTimeout(timer); }
}
async function api(path, data, extra = {}) {
  const response = await timedFetch(`/api/${path}?key=${encodeURIComponent(key)}`, {
    method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'x-host-token': isHost ? hostToken : '', ...extra.headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...extra
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
async function updateMe(settings = {}) {
  if (!me) throw new Error('This device has not joined the room. Open the full join link from the host laptop first.');
  return api('device', { id: me.id, secret: me.secret, ...settings });
}
async function syncClock() {
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const start = clientNow(); const reply = await api('clock'); const end = clientNow();
    samples.push({ rtt: end - start, offset: reply.time - (start + end) / 2 });
  }
  samples.sort((a,b) => a.rtt - b.rtt);
  offset = samples.slice(0, 3).reduce((sum, s) => sum + s.offset, 0) / 3;
  clockReady = true;
  return samples[0].rtt;
}
function stopAudio() {
  if (source) { try { source.stop(); } catch {} source.disconnect(); source = null; }
  splitter?.disconnect(); merger?.disconnect(); output?.disconnect();
  splitter = merger = output = null; audioStart = null;
}
function myDevice() { return room?.devices.find(d => d.id === me?.id); }
function audibleContextTime() {
  const timestamp = ctx.getOutputTimestamp?.();
  if (timestamp?.contextTime > 0 && timestamp.performanceTime > 0) return timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000;
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
function applyAudioSettings() {
  const d = myDevice(); if (!d || !output) return;
  output.gain.setTargetAtTime(d.muted ? 0 : d.volume, ctx.currentTime, .02);
}
function ensureSafeOutput() {
  if(safeOutput) return safeOutput;
  const headroom=ctx.createGain();headroom.gain.value=.6;
  const compressor=ctx.createDynamicsCompressor();
  compressor.threshold.value=-6;compressor.knee.value=6;compressor.ratio.value=20;
  compressor.attack.value=.003;compressor.release.value=.12;
  const bass=ctx.createBiquadFilter();bass.type='lowshelf';bass.frequency.value=200;
  const mid=ctx.createBiquadFilter();mid.type='peaking';mid.frequency.value=1000;mid.Q.value=.8;
  const treble=ctx.createBiquadFilter();treble.type='highshelf';treble.frequency.value=4000;
  headroom.connect(bass);bass.connect(mid);mid.connect(treble);treble.connect(compressor);compressor.connect(ctx.destination);
  eqFilters={bass,mid,treble};safeOutput=headroom;eqSignature='';applyEqualizer();return safeOutput;
}
function applyEqualizer() {
  if(!safeOutput || !eqFilters) return;
  const eq=myDevice()?.eq || {enabled:true,bass:0,mid:0,treble:0};
  const signature=JSON.stringify(eq);if(signature===eqSignature) return;
  eqSignature=signature;
  let boost=0;
  for(const band of ['bass','mid','treble']) {
    const gain=eq.enabled?eq[band]:0;
    eqFilters[band].gain.setTargetAtTime(gain,ctx.currentTime,.04);
    boost+=Math.max(0,gain);
  }
  // Reserve gain before the filters, including combined positive boosts.
  safeOutput.gain.setTargetAtTime(.6*Math.pow(10,-boost/20),ctx.currentTime,.04);
}
function targetEq() {
  const target=$('eq-target').value || 'this';
  return target==='all'?room?.roomEq:target==='this'?myDevice()?.eq:room?.devices.find(d=>d.id===target)?.eq;
}
function renderEq(force=false) {
  const target=$('eq-target').value || 'this';
  if(document.activeElement!==$('eq-target')) {
    $('eq-target').innerHTML='<option value="this">This speaker</option>'+(isHost?'<option value="all">All speakers + new joins</option>'+room.devices.filter(d=>d.id!==me?.id).map(d=>`<option value="${d.id}">${escapeHtml(d.name)}</option>`).join(''):'');
    $('eq-target').value=target==='this' || (isHost && (target==='all' || room.devices.some(d=>d.id===target)))?target:'this';
  }
  const editing=!force && ['eq-bass','eq-mid','eq-treble','eq-preset','eq-enabled'].some(id=>document.activeElement===$(id));
  if(!editing && !eqSaveTimer && !eqSaving) eqDraft={enabled:true,bass:0,mid:0,treble:0,...targetEq()};
  for(const band of ['bass','mid','treble']) {
    if(!editing) $(`eq-${band}`).value=eqDraft[band];
    $(`eq-${band}-value`).textContent=`${eqDraft[band]>0?'+':''}${eqDraft[band]} dB`;
    $(`eq-${band}`).disabled=!me;
  }
  $('eq-enabled').checked=eqDraft.enabled;
  $('eq-preset').value=Object.keys(eqPresets).find(name=>eqPresets[name].every((value,i)=>value===eqDraft[['bass','mid','treble'][i]])) || 'custom';
  for(const id of ['eq-enabled','eq-preset','eq-target','eq-reset']) $(id).disabled=!me;
}
async function saveEq() {
  eqSaveTimer=null;
  const {target,eq}=eqPending || {target:$('eq-target').value || 'this',eq:{...eqDraft}};
  eqPending=null;
  eqSaving++;
  try {
    if(target==='all') await api('eq-all',{eq});
    else {const id=target==='this'?me.id:target;await api('device',{id,secret:id===me.id?me.secret:'',eq});}
    $('eq-status').textContent=eq.enabled?'Equalizer applied. Boosts reserve headroom; overall volume may decrease.':'Equalizer bypassed. Your band settings are kept.';
  } catch(error) {notice(error.message);$('eq-status').textContent=error.message;}
  finally {eqSaving--;}
}
function queueEq() {
  if(eqSaveTimer) clearTimeout(eqSaveTimer);
  eqPending={target:$('eq-target').value || 'this',eq:{...eqDraft}};
  eqSaveTimer=setTimeout(saveEq,120);
}
function updateLiveVolume(value) {
  if(!liveGain || value===liveLevel) return;
  liveGain.gain.cancelScheduledValues(ctx.currentTime);
  liveGain.gain.setTargetAtTime(value,ctx.currentTime,.015);liveLevel=value;
}
function stopLiveAudio(resetTimeline=true) {
  const oldGain=liveGain;
  const oldPlayer=livePlayer;livePlayer=null;
  if(oldGain && ctx) {
    oldGain.gain.cancelScheduledValues(ctx.currentTime);
    oldGain.gain.setTargetAtTime(0,ctx.currentTime,.003);
  }
  for (const node of liveNodes) { try { node.stop(ctx.currentTime+.02); } catch {} }
  liveNodes.clear();liveGain=null;liveLevel=null;
  if(oldGain) setTimeout(()=>oldGain.disconnect(),50);
  if(oldPlayer) setTimeout(()=>{oldPlayer.disconnect();oldPlayer.port.close();},50);
  if(resetTimeline) liveTimeline.reset();
}
async function prepareContinuousPlayback() {
  if(!ctx.audioWorklet || typeof AudioWorkletNode==='undefined') return;
  if(!continuousSetup) continuousSetup=ctx.audioWorklet.addModule('/playback-worklet.js?v=1').then(()=>{
    stopLiveAudio();continuousReady=true;
  }).catch(error=>{
    continuousSetup=null;stopLiveAudio();
    notice(`Continuous playback could not load: ${error.message}. Live playback is paused on this laptop. Refresh before trying again.`);
    throw error;
  });
  await continuousSetup;
}
function markLiveReady() {
  if (!room?.live || !ctx || ctx.state !== 'running') return;
  const id=`live:${room.live.id}`;
  if (liveReadySent === id) return;
  liveReadySent=id;
  updateMe({armed:true,readyTrack:id}).catch(()=>{liveReadySent=null;});
}
function receiveLive(packet) {
  if (!connected || !ctx || ctx.state !== 'running' || !room?.live || room.live.paused || room.live.id !== packet.id) return;
  if(ctx.audioWorklet && typeof AudioWorkletNode!=='undefined' && !continuousReady) return;
  const d=myDevice(); if(!d) return;
  const raw=atob(packet.pcm),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  const view=new DataView(bytes.buffer);
  const samples=new Float32Array(packet.frames*2);
  for(let channel=0;channel<2;channel++) {
    const from=d.role==='left'?0:d.role==='right'?1:channel;
    for(let i=0;i<packet.frames;i++) {
      const value=view.getFloat32(i*8+from*4,true);
      samples[i*2+channel]=Number.isFinite(value)?Math.max(-1,Math.min(1,value)):0;
    }
  }
  const desiredWhen=audibleContextTime()+(packet.startsAt+d.delay-serverNow())/1000;
  const plan=liveTimeline.plan(packet,desiredWhen,ctx.currentTime,`${packet.id}/${packet.sampleRate}/${d.delay}/${d.role}`);
  if(plan?.ignore) return;
  if(!plan) {
    stopLiveAudio();
    $('local-status').textContent='Rebuffering. If this repeats, stop sharing and choose Stable Wi-Fi.';
    return;
  }
  if(plan.restart) stopLiveAudio(false);
  if(!liveGain) {
    liveGain=ctx.createGain();liveGain.connect(ensureSafeOutput());
    liveGain.gain.setValueAtTime(0,ctx.currentTime);
    liveLevel=d.muted?0:d.volume;
    liveGain.gain.setTargetAtTime(liveLevel,plan.when,.006);
  } else updateLiveVolume(d.muted?0:d.volume);
  if(continuousReady) {
    if(!livePlayer) {
      livePlayer=new AudioWorkletNode(ctx,'soundmesh-playback',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
      livePlayer.connect(liveGain);
    }
    livePlayer.port.postMessage({type:'packet',frame:packet.frame,frames:packet.frames,sampleRate:packet.sampleRate,when:plan.when,rate:plan.rate,samples:samples.buffer},[samples.buffer]);
  } else {
    const audio=ctx.createBuffer(2,packet.frames,packet.sampleRate);
    for(let c=0;c<2;c++) {const data=audio.getChannelData(c);for(let i=0;i<packet.frames;i++) data[i]=samples[i*2+c];}
    const node=ctx.createBufferSource();node.buffer=audio;node.connect(liveGain);
    node.playbackRate.value=plan.rate;
    liveNodes.add(node);node.onended=()=>{liveNodes.delete(node);node.disconnect();};
    node.start(plan.when);
  }
  $('local-status').textContent=d.muted?'Live speaker muted.':`Receiving live audio · ${continuousReady?'continuous engine':'compatible engine'} · ${(room.live.bufferMs ?? 700)/1000}s buffer`;
}
function schedule(force = false) {
  if (!room || !ctx || !buffer || bufferId !== room.track?.id || !clockReady || !connected) return;
  const d = myDevice(); if (!d) return;
  const t = room.transport;
  if (!force && loadedRevision === t.revision && ownDelay === `${d.delay}/${d.role}`) { applyAudioSettings(); return; }
  stopAudio(); loadedRevision = t.revision; ownDelay = `${d.delay}/${d.role}`;
  if (!t.playing || ctx.state !== 'running') return;
  // Positive delay holds this speaker back. Output timestamps map the shared
  // wall clock to the browser's audio clock, including estimated output latency.
  const desired = t.startsAt + d.delay;
  const ahead = (desired - serverNow()) / 1000;
  let when = audibleContextTime() + ahead;
  const earliest = ctx.currentTime + .04;
  const late = Math.max(0, earliest - when);
  when = Math.max(earliest, when);
  const position = t.position + late;
  if (position >= buffer.duration) return;
  source = ctx.createBufferSource(); source.buffer = buffer;
  output = ctx.createGain(); output.gain.value = d.muted ? 0 : d.volume;
  if (d.role === 'stereo') source.connect(output);
  else {
    // Route the selected source channel to BOTH hardware channels. A phone's
    // single physical speaker can then reproduce its assigned side reliably.
    splitter = ctx.createChannelSplitter(2); merger = ctx.createChannelMerger(2);
    source.connect(splitter);
    const channel = d.role === 'right' && buffer.numberOfChannels > 1 ? 1 : 0;
    splitter.connect(merger, channel, 0); splitter.connect(merger, channel, 1); merger.connect(output);
  }
  output.connect(ensureSafeOutput()); source.start(when, position);
  audioStart = { when, position, delay: d.delay };
}
async function loadTrack() {
  if (!ctx || !room?.track || bufferId === room.track.id) return;
  const id = room.track.id, sequence = ++loadSequence;
  bufferId = id; buffer = null; stopAudio();
  $('local-status').textContent = 'Loading and preparing the track…';
  try {
    await updateMe({ readyTrack: null });
    const response = await fetch(`/api/audio?key=${key}&track=${id}`);
    if (!response.ok) throw new Error('Could not download the track');
    const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
    if (sequence !== loadSequence || room.track?.id !== id) return;
    buffer = decoded;
    if (isHost) await api('transport', { action: 'duration', duration: decoded.duration });
    await updateMe({ readyTrack: id });
    $('local-status').textContent = 'Ready to play. Keep this screen open.';
    schedule(true);
  } catch (e) {
    if (sequence !== loadSequence) return;
    bufferId = null; failedTrack = id; notice(`This device could not load the audio: ${e.message}. Try an MP3 or WAV file, then tap Enable speaker to retry.`);
    $('local-status').textContent = 'Audio could not load. Try another file.';
  }
}
function renderDevices() {
  const ds = room.devices;
  $('count').textContent = `${ds.length} device${ds.length === 1 ? '' : 's'}`;
  $('empty-devices').hidden = ds.length > 0;
  const readyId=room.live?`live:${room.live.id}`:room.track?.id;
  $('stage-caption').textContent = `${ds.filter(d => d.armed && readyId && d.readyTrack === readyId && !d.muted).length} ready · ${ds.length} connected`;
  // Preserve controls while the user edits, rather than resetting focus every heartbeat.
  if (!$('devices').contains(document.activeElement)) {
    $('devices').innerHTML = ds.map(d => {
      const canEdit = isHost || d.id === me?.id;
      const disabled = canEdit ? '' : 'disabled';
      const status = d.muted ? 'Muted' : !d.armed ? 'Tap Enable on device' : room.live ? d.readyTrack===readyId?'Live speaker':'Enable / refresh page' : !room.track ? 'Speaker enabled' : d.readyTrack === room.track.id ? 'Ready' : 'Loading track…';
      return `<article class="device" data-id="${d.id}"><div class="device-title"><div><strong>${escapeHtml(d.name)}</strong>${d.id === me?.id ? '<small>THIS DEVICE</small>' : ''}</div><span class="device-status">${status}</span></div><div class="device-controls"><label>Channel<select data-setting="role" ${disabled}>${[['stereo','Full stereo'],['left','Left channel'],['right','Right channel']].map(([v,n])=>`<option value="${v}" ${d.role===v?'selected':''}>${n}</option>`).join('')}</select></label><label>Timing adjustment<div class="delay-control"><input type="number" min="-500" max="500" step="5" value="${d.delay}" data-setting="delay" aria-label="Delay for ${escapeHtml(d.name)}" ${disabled}><span>ms</span></div></label><button class="secondary mute" data-mute="${!d.muted}" ${disabled}>${d.muted?'Unmute':'Mute'}</button></div><div class="volume-control"><label>Volume</label><input type="range" min="0" max="1" step="0.01" value="${d.volume}" data-setting="volume" aria-label="Volume for ${escapeHtml(d.name)}" ${disabled}><output>${Math.round(d.volume*100)}%</output></div></article>`;
    }).join('');
  }
  $('stage-devices').innerHTML = ds.map((d, i) => {
    const angle = (i / Math.max(ds.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const x = d.role === 'left' ? 18 : d.role === 'right' ? 82 : 50 + Math.cos(angle) * 32;
    const y = 50 + Math.sin(angle) * 31;
    return `<div class="stage-node" style="left:${x}%;top:${y}%;opacity:${d.muted?.45:1}"><div class="node-icon">${d.role==='left'?'L':d.role==='right'?'R':'≋'}</div><small>${escapeHtml(d.name)}</small></div>`;
  }).join('');
}
function render() {
  renderDevices();
  renderEq();
  const t = room.track;
  $('track-name').textContent = room.live?.name || t?.name || (selectedSource==='file'?'Your music. Across the room.':"Share what you're listening to.");
  $('track-detail').textContent = room.live ? `Live from the broadcaster · ${room.live.paused?'room paused':`${(room.live.bufferMs ?? 700)/1000}s sync buffer`}` : t ? `${(t.bytes / 1048576).toFixed(1)} MB · shared over your Wi-Fi` : selectedSource==='file'?'Choose a downloaded song and play it on every speaker.':'Stream from a browser tab. No music download needed.';
  $('live-latency').disabled=Boolean(room.live);
  $('source-badge').textContent=room.live?'LIVE BROADCAST':t?'LOCAL FILE':selectedSource==='file'?'MUSIC FILE':'LIVE AUDIO';
  $('play').hidden=!room.live && !t;
  $('play').disabled = !isHost || !connected || (!room.live && !t?.duration);
  const playing=room.live?!room.live.paused:room.transport.playing;
  $('play').innerHTML = playing ? 'Ⅱ <span>Pause together</span>' : '▶ <span>Play together</span>';
  renderSourceMode();
  $('broadcast').hidden=Boolean(room.live);
  $('stop-broadcast').hidden=!room.live;
  $('seek').hidden=Boolean(room.live) || !t;
  $('elapsed').parentElement.hidden=Boolean(room.live) || !t;
  $('seek').disabled = !isHost || !t?.duration;
  $('seek').max = t?.duration || 100;
  $('duration').textContent = time(t?.duration || 0);
  $('playback-hint').textContent = room.live ? 'Room pause silences the speakers. The original stream keeps playing.' : isHost ? selectedSource==='file'?'Every unmuted speaker must be ready before you press Play together.':'Share a music tab, or choose Music file for downloaded songs.' : 'The host broadcasts music. Tap Enable this speaker to listen.';
}
function receive(next) {
  const previousTrack = room?.track?.id;
  const previousLive=room?.live?.id;
  room = next;
  applyEqualizer();
  if(previousLive!==room.live?.id && room.live) selectedSource='live';
  if(previousTrack!==room.track?.id && room.track) selectedSource='file';
  if(previousLive!==room.live?.id) {stopLiveAudio();liveReadySent=null;}
  if(room.live?.paused) stopLiveAudio();
  if(capture && capture.id!==room.live?.id) cleanupCapture();
  if (previousTrack !== next.track?.id) { stopAudio(); buffer = null; bufferId = null; failedTrack = null; loadedRevision = -1; loadSequence++; }
  render();
  if(room.live) {
    stopAudio();markLiveReady();
    const d=myDevice();if(d) updateLiveVolume(d.muted?0:d.volume);
    return;
  }
  if (ctx && room.track && !bufferId && failedTrack !== room.track.id) loadTrack().catch(e => notice(e.message));
  schedule();
}
async function wake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') waking = await navigator.wakeLock.request('screen'); } catch {}
}
async function enable() {
  try {
    failedTrack = null;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    await ctx.resume();
    await prepareContinuousPlayback();
    await syncClock();
    await updateMe({ armed: ctx.state === 'running' });
    $('enable').textContent = 'Speaker enabled · tap to refresh';
    $('local-status').textContent = buffer && bufferId === room?.track?.id ? 'Ready to play. Keep this screen open.' : continuousReady ? 'Continuous engine ready. Start sharing at low volume.' : 'Speaker enabled. Choose music on the host.';
    ctx.onstatechange = () => {
      updateMe({ armed: ctx.state === 'running' }).catch(() => {});
      if (ctx.state !== 'running') { stopAudio(); stopLiveAudio();liveReadySent=null; $('enable').textContent = 'Resume this speaker ↗'; $('local-status').textContent = 'Audio was interrupted. Tap Resume this speaker.'; }
      else {schedule(true);markLiveReady();}
    };
    await wake(); await loadTrack(); schedule(true);markLiveReady();
  } catch (e) { notice(e.message); }
}
async function boot() {
  connectionControls(false);
  $('local-status').textContent = 'Joining the room…';
  try {
    if (!key && !hostToken) throw new Error('This address is missing the room invitation. Open the full join link from the host laptop, including everything after ?room=.');
    const response = await timedFetch('/api/bootstrap', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key,host:hostToken}) });
    const boot = await response.json(); if (!response.ok) throw new Error(boot.error);
    key = boot.key; isHost = boot.isHost; joinUrls = boot.joinUrls;
    const roomSaved = writeStore('sessionStorage', 'sm-room', key);
    const hostSaved = !isHost || writeStore('sessionStorage', 'sm-host', hostToken);
    $('upload-label').hidden = !isHost;
    $('demo').hidden = !isHost;
    renderSourceMode();
    const name = readStore('localStorage', 'sm-name') || (/Mobi|Android/i.test(navigator.userAgent) ? 'Phone speaker' : 'Laptop speaker');
    $('device-name').value = name;
    try {
      const saved=JSON.parse(readStore('sessionStorage','sm-device') || 'null');
      if (!saved || saved.room !== key) throw new Error('New room');
      me={id:saved.id,secret:saved.secret};
      await updateMe({name,armed:false,readyTrack:null});
    } catch { me=await api('join',{name}); }
    writeStore('sessionStorage','sm-device',JSON.stringify({...me,room:key}));
    await syncClock();
    // Only remove the invitation after a successful join and storage write.
    // If storage is unavailable, retain it so refreshing still works.
    if (roomSaved && hostSaved) { try { history.replaceState({}, '', '/'); } catch {} }
    connectionControls(true);
    $('local-status').textContent = 'Joined. Tap Enable this speaker to allow sound.';
    renderJoinInvitation();
    events = new EventSource(`/api/events?key=${key}`);
    events.onopen = () => { connected = true; $('connection').textContent = isHost ? '● Connected · Host laptop' : '● Connected · Speaker'; if (room) schedule(true); };
    events.onmessage = e => receive(JSON.parse(e.data));
    events.addEventListener('audio',e=>{try {receiveLive(JSON.parse(e.data));} catch(error) {notice(`Live playback failed: ${error.message}`);}});
    events.onerror = () => { connected = false; stopAudio();stopLiveAudio(); $('connection').textContent = 'Connection lost · reconnecting…'; if (room) render(); };
    heartbeatTimer = setInterval(async () => {
      try { await updateMe({ armed: ctx?.state === 'running' }); }
      catch (e) { if (e.message === 'Device access denied') { try { me = await api('join', {name:$('device-name').value}); writeStore('sessionStorage','sm-device',JSON.stringify({...me,room:key}));liveReadySent=null; await updateMe({armed:ctx?.state==='running',readyTrack:room?.live?`live:${room.live.id}`:bufferId}); } catch {} } }
    }, 5000);
    clockTimer = setInterval(() => syncClock().catch(() => {}), 15000);
  } catch (e) {
    $('connection').textContent = 'Room not connected';
    const message = `${e.message} Use the full join link shown on the laptop. The laptop and iPhone must be on the same Wi-Fi.`;
    notice(message);
    $('local-status').textContent = message;
    $('enable').textContent = 'Join the room first';
    $('upload-label').hidden = true; $('demo').hidden = true;
  }
}
$('enable').addEventListener('click', enable);
for(const band of ['bass','mid','treble']) $(`eq-${band}`).addEventListener('input',()=>{
  eqDraft[band]=Number($(`eq-${band}`).value);
  $(`eq-${band}-value`).textContent=`${eqDraft[band]>0?'+':''}${eqDraft[band]} dB`;
  $('eq-preset').value='custom';queueEq();
});
$('eq-enabled').addEventListener('change',()=>{eqDraft.enabled=$('eq-enabled').checked;queueEq();});
$('eq-preset').addEventListener('change',()=>{
  const values=eqPresets[$('eq-preset').value];if(!values) return;
  eqDraft={enabled:true,bass:values[0],mid:values[1],treble:values[2]};queueEq();renderEq(true);
});
$('eq-reset').addEventListener('click',()=>{eqDraft={enabled:true,bass:0,mid:0,treble:0};queueEq();renderEq(true);});
$('eq-target').addEventListener('change',async()=>{
  if(eqSaveTimer) {clearTimeout(eqSaveTimer);eqSaveTimer=null;saveEq();}
  eqDraft={enabled:true,bass:0,mid:0,treble:0,...targetEq()};renderEq(true);
});
$('source-live').addEventListener('click',()=>{selectedSource='live';if(room) render();else renderSourceMode();});
$('source-file').addEventListener('click',()=>{selectedSource='file';if(room) render();else renderSourceMode();});
$('join-network').addEventListener('change',()=>{selectedJoinUrl=$('join-network').value;renderJoinInvitation();});
function cleanupCapture() {
  if(!capture) return;
  const old=capture;capture=null;
  old.input?.disconnect();old.worklet?.disconnect();old.silence?.disconnect();
  old.stream.getTracks().forEach(track=>track.stop());
  old.context?.close().catch(()=>{});
  $('broadcast').disabled=false;
}
async function stopBroadcast() {
  const id=capture?.id || room?.live?.id;
  cleanupCapture();
  if(id) {try {await api('live-control',{id,action:'stop'});} catch(e) {notice(e.message);}}
}
async function sendLiveChunks(owner) {
  if(owner.sending) return;
  owner.sending=true;
  try {
    while(capture===owner && owner.queue.length) {
      const {frame,samples}=owner.queue.shift();
      const bytes=new ArrayBuffer(8+samples.byteLength),view=new DataView(bytes);
      view.setFloat64(0,frame,true);
      const pcm=new Float32Array(samples);
      for(let i=0;i<pcm.length;i++) view.setFloat32(8+i*4,pcm[i],true);
      const response=await timedFetch(`/api/live-chunk?key=${key}&id=${owner.id}`,{method:'POST',headers:{'x-host-token':hostToken},body:bytes});
      if(!response.ok) throw new Error((await response.json()).error || 'Broadcast upload failed');
    }
  } catch(e) {
    if(capture===owner) {notice(e.message); await stopBroadcast();}
  } finally {owner.sending=false;}
}
$('broadcast').addEventListener('click',async()=>{
  if(startingCapture || capture) return;
  if(!isHost) return notice('Open the host link on the laptop to broadcast.');
  if(!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) return notice('To broadcast, open the host link at http://localhost:3210 in desktop Chrome or Edge. Phones can join as speakers using the Wi-Fi link.');
  startingCapture=true;$('broadcast').disabled=true;notice('');
  let stream,context,id;
  try {
    // The capture picker and audio resume both start within the user's click.
    const selection=navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser'},audio:{suppressLocalAudioPlayback:true,echoCancellation:false,noiseSuppression:false,autoGainControl:false},systemAudio:'exclude',monitorTypeSurfaces:'exclude',selfBrowserSurface:'exclude',surfaceSwitching:'exclude'});
    if(!ctx) ctx=new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback'});
    const resumed=ctx.resume();
    stream=await selection;await resumed;
    if(!stream.getAudioTracks().length) throw new Error('No audio was shared. Select the music browser tab and switch on Share tab audio.');
    const surface=stream.getVideoTracks()[0]?.getSettings().displaySurface;
    if(surface && surface!=='browser') throw new Error('Choose a browser tab for this version. Screen/system audio can feed the room audio back into itself.');
    context=new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback',sampleRate:ctx.sampleRate});
    await context.resume();
    if(!context.audioWorklet) throw new Error('This browser cannot capture live audio. Use current desktop Chrome or Edge.');
    await context.audioWorklet.addModule('/capture-worklet.js');
    const session=await api('live-start',{sampleRate:context.sampleRate,bufferMs:Number($('live-latency').value)||700,name:'Live browser audio'});id=session.id;
    const owner={id,stream,context,queue:[],sending:false};capture=owner;
    owner.worklet=new AudioWorkletNode(context,'soundmesh-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'});
    owner.silence=context.createGain();owner.silence.gain.value=0;
    owner.input=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    owner.worklet.port.onmessage=e=>{
      if(capture!==owner) return;
      if(owner.queue.length>=15) {notice('The Wi-Fi upload is falling behind. Restart sharing on a faster connection.');stopBroadcast();return;}
      owner.queue.push(e.data);sendLiveChunks(owner);
    };
    owner.input.connect(owner.worklet);owner.worklet.connect(owner.silence);owner.silence.connect(context.destination);
    stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(capture===owner) stopBroadcast();},{once:true}));
    await enable();
    notice('Broadcasting audio only. Keep the music tab and this page open. If you also hear an immediate copy from the original tab, try current desktop Chrome or Edge. Do not mute the music player itself: that can silence the captured audio too.');
  } catch(e) {
    cleanupCapture();stream?.getTracks().forEach(track=>track.stop());
    if(context && context.state!=='closed') context.close().catch(()=>{});
    if(id) api('live-control',{id,action:'stop'}).catch(()=>{});
    notice(e.name==='NotAllowedError'?'Sharing was cancelled or blocked. Click Share live audio again when ready.':e.message);
  } finally {startingCapture=false;$('broadcast').disabled=false;}
});
$('stop-broadcast').addEventListener('click',stopBroadcast);
$('rename').addEventListener('click', async () => {
  try { const name = $('device-name').value.trim() || 'Speaker'; await updateMe({name}); writeStore('localStorage','sm-name',name); $('local-status').textContent = `Name saved: ${name}`; } catch(e) { notice(e.message); $('local-status').textContent = e.message; }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(selectedJoinUrl); $('copy').textContent = 'Link copied ✓'; setTimeout(()=>$('copy').textContent='Copy join link',2000); }
  catch { notice('Select and copy the join link above. This browser needs a secure connection for automatic copying.'); }
});
async function upload(file) {
  if (!file) return;
  if (file.size > 80*1024*1024) return notice('Choose an audio file smaller than 80 MB.');
  $('file').disabled = true; $('demo').disabled = true; notice('Uploading music to your local room…');
  try {
    // Resume audio directly from this user gesture, before any network request.
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback'});
    await ctx.resume(); await updateMe({armed:ctx.state==='running'});
    const response = await fetch(`/api/upload?key=${key}`, {method:'POST',headers:{'x-host-token':hostToken,'x-file-name':encodeURIComponent(file.name)},body:file});
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    notice(''); await enable();
  } catch(e) { notice(e.message); } finally { $('file').disabled=false; $('demo').disabled=false; $('file').value=''; }
}
$('file').addEventListener('change', () => upload($('file').files[0]));
$('demo').addEventListener('click', async () => {
  // A short, modest-level stereo WAV. Both channels click on each second;
  // alternating pitched chimes identify left and right between the clicks.
  const rate=22050, seconds=16, frames=rate*seconds;
  const bytes=new ArrayBuffer(44+frames*4), view=new DataView(bytes);
  const word=(at,text)=>[...text].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
  word(0,'RIFF'); view.setUint32(4,36+frames*4,true); word(8,'WAVE'); word(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);
  word(36,'data');view.setUint32(40,frames*4,true);
  for(let i=0;i<frames;i++) {
    const t=i/rate, beat=Math.floor(t), phase=t-beat;
    for(let c=0;c<2;c++) {
      let sample=phase<.025 ? .17*Math.sin(2*Math.PI*1200*phase)*Math.exp(-phase*180) : 0;
      const chime=phase-.25;
      if(beat%2===c && chime>=0 && chime<.3) sample+=.16*Math.sin(2*Math.PI*(c===0?440:660)*chime)*Math.exp(-chime*15)*Math.min(1,chime*300);
      view.setInt16(44+i*4+c*2,Math.round(sample*32767),true);
    }
  }
  await upload(new File([bytes],'Stereo test · left then right.wav',{type:'audio/wav'}));
});
$('play').addEventListener('click', async () => {
  try { notice(''); if (ctx?.state !== 'running') await enable(); if(room.live) await api('live-control',{id:room.live.id,action:room.live.paused?'resume':'pause'});else await api('transport',{action:room.transport.playing?'pause':'play'}); } catch(e) { notice(e.message); }
});
$('seek').addEventListener('change', async () => { try { await api('transport',{action:'seek',position:Number($('seek').value)}); } catch(e) { notice(e.message); } });
$('devices').addEventListener('input', e => { if (e.target.dataset.setting==='volume') e.target.nextElementSibling.textContent=`${Math.round(e.target.value*100)}%`; });
$('devices').addEventListener('change', async e => {
  const setting = e.target.dataset.setting; if (!setting) return;
  const id = e.target.closest('[data-id]').dataset.id;
  const value = ['volume','delay'].includes(setting) ? Number(e.target.value) : e.target.value;
  try { await api('device',{id,secret:id===me.id?me.secret:'',[setting]:value}); } catch(e) { notice(e.message); }
});
$('devices').addEventListener('click', async e => {
  if (!e.target.hasAttribute('data-mute')) return;
  const id=e.target.closest('[data-id]').dataset.id;
  try { await api('device',{id,secret:id===me.id?me.secret:'',muted:e.target.dataset.mute==='true'}); } catch(e) { notice(e.message); }
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') { await wake(); try { await syncClock(); if (ctx?.state==='running') schedule(true); } catch {} }
});
setInterval(() => {
  if (!room?.track) return;
  const t=room.transport;
  const position=Math.min(room.track.duration||Infinity,t.position+(t.playing?Math.max(0,serverNow()-t.startsAt)/1000:0));
  $('elapsed').textContent=time(position);
  if (document.activeElement!==$('seek')) $('seek').value=position;
  if (isHost && connected && t.playing && room.track.duration && position>=room.track.duration) api('transport',{action:'pause'}).catch(()=>{});
},250);
// Re-anchor long-running playback if a browser clock drifts from room time.
setInterval(() => {
  if (!source || !audioStart || !room?.transport.playing || ctx.state!=='running') return;
  const expected=room.transport.position+(serverNow()-room.transport.startsAt-audioStart.delay)/1000;
  const actual=audioStart.position+audibleContextTime()-audioStart.when;
  if (expected>0 && Math.abs(expected-actual)>.05) schedule(true);
},5000);
boot();
