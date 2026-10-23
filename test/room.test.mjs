import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, validSettings } from '../lib/room.mjs';

test('playhead waits for the scheduled start, advances, and clamps at track end', () => {
  const t = { playing: true, position: 8, startsAt: 10000 };
  assert.equal(positionAt(t, 9000, 30), 8);
  assert.equal(positionAt(t, 12500, 30), 10.5);
  assert.equal(positionAt(t, 50000, 30), 30);
  assert.equal(positionAt({ ...t, playing:false }, 50000, 30), 8);
});
test('speaker controls clamp levels and reject invalid timings and roles', () => {
  assert.deepEqual(validSettings({ volume: 4, delay: -900, role: 'left', name: '  Phone  ' }), { name:'Phone', volume:1, delay:-500, role:'left' });
  assert.throws(() => validSettings({ delay:NaN }));
  assert.throws(() => validSettings({ volume:'loud' }));
  assert.throws(() => validSettings({ role:'surround' }));
  assert.deepEqual(validSettings({ secret:'fake', readyTrack:'fake' }), {});
});
test('equalizer validation limits boosts and rejects malformed audio settings',()=>{
  assert.deepEqual(validSettings({eq:{enabled:true,bass:15,mid:-20,treble:2}}),{eq:{enabled:true,bass:6,mid:-6,treble:2}});
  assert.throws(()=>validSettings({eq:{enabled:true,bass:NaN,mid:0,treble:0}}));
  assert.throws(()=>validSettings({eq:{enabled:true,bass:0,mid:0}}));
});
