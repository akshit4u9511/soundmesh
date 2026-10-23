import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { now, positionAt, validSettings, flatEq, validEq } from './lib/room.mjs';
import { makeLivePacket } from './lib/live.mjs';

const port = Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7) || process.env.PORT || 3210);
const managed=process.argv.includes('--managed');
const instanceId=randomUUID();
const projectRoot=fileURLToPath(new URL('.',import.meta.url));
const runtimeFile=new URL('./.soundmesh/runtime.json',import.meta.url);
const roomKey = /^[a-f0-9]{24}$/.test(process.env.SOUNDMESH_ROOM_KEY || '') ? process.env.SOUNDMESH_ROOM_KEY : randomBytes(12).toString('hex');
const hostKey = /^[a-f0-9]{48}$/.test(process.env.SOUNDMESH_HOST_KEY || '') ? process.env.SOUNDMESH_HOST_KEY : randomBytes(24).toString('hex');
const devices = new Map();
const streams = new Set();
const addresses = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
let track = null, audio = null;
let live = null;
let roomEq=flatEq();
let transport = { playing: false, position: 0, startsAt: 0, revision: 0 };
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isHost = req => equal(req.headers['x-host-token'], hostKey);
const active = () => [...devices.values()].filter(d => now() - d.seen < 20000);
function state() {
  return { track, roomEq, live: live ? {id:live.id,name:live.name,sampleRate:live.sampleRate,bufferMs:live.bufferMs,startedAt:live.startedAt,paused:live.paused} : null, transport, devices: active().map(({ secret, seen, ...d }) => d), serverTime: now() };
}
function broadcast() {
  const message = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of streams) res.write(message);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) { const e = new Error('File too large (maximum 80 MB)'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/qr.js', ['vendor/qrcode.mjs', 'text/javascript; charset=utf-8']],
  ['/live-timeline.js', ['live-timeline.js', 'text/javascript; charset=utf-8']],
  ['/capture-worklet.js', ['capture-worklet.js', 'text/javascript; charset=utf-8']],
  ['/playback-worklet.js', ['playback-worklet.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && files.has(url.pathname)) {
      const [name, type] = files.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(await readFile(new URL(`./public/${name}`, import.meta.url)));
    }
    if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
      const input = JSON.parse((await body(req, 4096)).toString());
      if (!equal(input.key, roomKey) && !equal(input.host, hostKey)) return json(res, 403, { error: 'Use the join link shown on the host laptop.' });
      return json(res, 200, { key: roomKey, isHost: equal(input.host, hostKey), joinUrls: addresses.map(ip => `http://${ip}:${port}/?room=${roomKey}`) });
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (!equal(url.searchParams.get('key'), roomKey)) return json(res, 403, { error: 'Room link required' });
    if(url.pathname==='/api/instance' && req.method==='GET') {
      if(!isHost(req)) return json(res,403,{error:'Host access required'});
      return json(res,200,{app:'soundmesh',pid:process.pid,instanceId,managed});
    }
    if (url.pathname === '/api/clock' && req.method === 'GET') return json(res, 200, { time: now() });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state());
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      streams.add(res); res.write(`data: ${JSON.stringify(state())}\n\n`);
      req.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname === '/api/audio' && req.method === 'GET') {
      if (!audio || url.searchParams.get('track') !== track.id) return json(res, 404, { error: 'Track has changed' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.end(audio);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/api/live-chunk') {
      if (!isHost(req)) return json(res, 403, {error:'Only the broadcaster can send audio'});
      if (!live || url.searchParams.get('id') !== live.id) return json(res, 409, {error:'This broadcast has ended'});
      const session = live;
      const bytes = await body(req, 200000);
      if (live !== session) return json(res, 409, {error:'This broadcast has changed'});
      try {
        const first = live.startedAt === null;
        const packet = makeLivePacket(live, bytes, now());
        if (first) broadcast();
        if (!live.paused) {
          const message = `event: audio\ndata: ${JSON.stringify(packet)}\n\n`;
          for (const stream of streams) {
            if (stream.writableLength > 2 * 1024 * 1024) { stream.destroy(); streams.delete(stream); }
            else stream.write(message);
          }
        }
        return json(res,200,{ok:true});
      } catch(e) { live=null; broadcast(); return json(res,409,{error:e.message}); }
    }
    if (url.pathname === '/api/upload') {
      if (!isHost(req)) return json(res, 403, { error: 'Only the host can upload music' });
      const uploaded = await body(req, 80 * 1024 * 1024);
      if (!uploaded.length) return json(res, 400, { error: 'Choose a non-empty audio file' });
      live = null;
      audio = uploaded;
      track = { id: randomUUID(), name: decodeURIComponent(req.headers['x-file-name'] || 'Music').slice(0, 180), bytes: audio.length, duration: null };
      transport = { playing: false, position: 0, startsAt: 0, revision: transport.revision + 1 };
      for (const d of devices.values()) d.readyTrack = null;
      broadcast(); return json(res, 200, { ok: true });
    }
    const input = JSON.parse((await body(req, 16384)).toString());
    if(url.pathname==='/api/shutdown') {
      const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if(!managed || !local || !isHost(req)) return json(res,403,{error:'Only the local launcher can stop this server'});
      json(res,200,{ok:true});setImmediate(close);return;
    }
    if(url.pathname==='/api/eq-all') {
      if(!isHost(req)) return json(res,403,{error:'Only the host can adjust the whole room'});
      roomEq=validEq(input.eq);
      for(const d of devices.values()) d.eq={...roomEq};
      broadcast();return json(res,200,{ok:true});
    }
    if (url.pathname === '/api/live-start') {
      if (!isHost(req)) return json(res,403,{error:'Start broadcasting from the host laptop'});
      if (![22050,24000,32000,44100,48000,88200,96000].includes(input.sampleRate)) throw new Error('Unsupported capture sample rate');
      if(input.bufferMs!==undefined && ![350,700,1400].includes(input.bufferMs)) throw new Error('Invalid live buffer setting');
      if (live) return json(res,409,{error:'Stop the current broadcast before starting another'});
      live={id:randomUUID(),name:String(input.name || 'Live browser audio').slice(0,100),sampleRate:input.sampleRate,bufferMs:input.bufferMs ?? 700,startedAt:null,frames:0,lastChunk:now(),paused:false};
      track=null; audio=null;
      transport={playing:false,position:0,startsAt:0,revision:transport.revision+1};
      for(const d of devices.values()) d.readyTrack=null;
      broadcast(); return json(res,200,{id:live.id});
    }
    if (url.pathname === '/api/live-control') {
      if (!isHost(req)) return json(res,403,{error:'Only the host controls the broadcast'});
      if (!live || input.id !== live.id) return json(res,409,{error:'This broadcast has ended'});
      if (input.action==='stop') live=null;
      else if(input.action==='pause') live.paused=true;
      else if(input.action==='resume') live.paused=false;
      else throw new Error('Unknown broadcast action');
      broadcast(); return json(res,200,{ok:true});
    }
    if (url.pathname === '/api/join') {
      if (active().length >= 20) return json(res, 409, { error: 'This room already has 20 devices' });
      const d = { id: randomUUID(), secret: randomBytes(20).toString('hex'), name: String(input.name || 'Speaker').slice(0, 40), volume: 0.45, delay: 0, role: 'stereo', muted: false, armed: false, readyTrack: null, eq:{...roomEq},seen: now() };
      devices.set(d.id, d); broadcast(); return json(res, 200, { id: d.id, secret: d.secret });
    }
    if (url.pathname === '/api/device') {
      const d = devices.get(input.id);
      if (!d || (!isHost(req) && !equal(input.secret, d.secret))) return json(res, 403, { error: 'Device access denied' });
      Object.assign(d, validSettings(input)); d.seen = now();
      if (equal(input.secret, d.secret)) {
        if ('armed' in input) d.armed = Boolean(input.armed);
        if ('readyTrack' in input) d.readyTrack = input.readyTrack === track?.id || (live && input.readyTrack === `live:${live.id}`) ? input.readyTrack : null;
      }
      broadcast(); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/transport') {
      if (!isHost(req)) return json(res, 403, { error: 'Playback is controlled from the host laptop' });
      if (!track) return json(res, 409, { error: 'Add a music file first' });
      if (input.action === 'duration') {
        if (!Number.isFinite(input.duration) || input.duration <= 0) throw new Error('Invalid audio duration');
        track.duration = input.duration; broadcast(); return json(res, 200, { ok: true });
      }
      const at = now();
      let position = positionAt(transport, at, track.duration || Infinity);
      if (input.action === 'play') {
        if (!track.duration) return json(res, 409, { error: 'Wait for the host to decode this audio file' });
        const listeners = active().filter(d => !d.muted);
        if (!listeners.length || listeners.some(d => !d.armed || d.readyTrack !== track.id)) return json(res, 409, { error: 'Every unmuted device must tap Enable speaker and finish loading. Mute devices you do not need.' });
        if (position >= track.duration - 0.05) position = 0;
        transport = { playing: true, position, startsAt: at + 1800, revision: transport.revision + 1 };
      } else if (input.action === 'pause') {
        transport = { playing: false, position, startsAt: at, revision: transport.revision + 1 };
      } else if (input.action === 'seek') {
        if (!Number.isFinite(input.position)) throw new Error('Invalid seek position');
        transport = { playing: transport.playing, position: Math.max(0, Math.min(track.duration || 0, input.position)), startsAt: at + 1800, revision: transport.revision + 1 };
      } else throw new Error('Unknown playback action');
      broadcast(); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) { if (!res.headersSent) json(res, e.status || 400, { error: e.message || 'Request failed' }); else res.end(); }
});
const timer = setInterval(() => {
  if (live && now() - live.lastChunk > 8000) live=null;
  for (const [id, d] of devices) if (now() - d.seen > 60000) devices.delete(id);
  for (const res of streams) res.write(': keepalive\n\n');
  broadcast();
}, 10000);
server.listen(port, '0.0.0.0', async () => {
  if(managed) {
    try {
      await mkdir(new URL('./.soundmesh/',import.meta.url),{recursive:true});
      await writeFile(runtimeFile,JSON.stringify({pid:process.pid,instanceId,root:projectRoot,node:process.execPath,serverPath:fileURLToPath(import.meta.url),port,hostUrl:`http://localhost:${port}/?host=${hostKey}`,roomKey,hostKey}));
    } catch(error) {console.error(`Cannot save launcher state: ${error.message}`);server.close(()=>process.exit(1));return;}
  }
  console.log(`\nSoundMesh is ready.\n\nOpen this HOST link on this laptop:\nhttp://localhost:${port}/?host=${hostKey}\n\nJoin links for your other devices (same Wi-Fi):`);
  for (const ip of addresses) console.log(`http://${ip}:${port}/?room=${roomKey}`);
  if (!addresses.length) console.log('No Wi-Fi/LAN address found. Connect to Wi-Fi and restart.');
  console.log('\nKeep this window open. Press Ctrl+C to stop.\n');
});
server.on('error', e => { console.error(`Cannot start SoundMesh: ${e.message}`); clearInterval(timer); process.exitCode = 1; });
let closing=false;
async function close() {
  if(closing) return;closing=true;
  clearInterval(timer);for(const res of streams) res.end();
  if(managed) {
    try {const record=JSON.parse(await readFile(runtimeFile,'utf8'));if(record.instanceId===instanceId) await unlink(runtimeFile);} catch {}
  }
  server.close(()=>process.exit());
  const timeout=setTimeout(()=>{server.closeAllConnections();process.exit();},2000);timeout.unref();
}
process.on('SIGINT', close); process.on('SIGTERM', close);
