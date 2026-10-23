// Timestamp small PCM packets against the same clock used by file playback.
export function makeLivePacket(live, bytes, time) {
  if (bytes.length < 16 || (bytes.length - 8) % 8 !== 0) throw new Error('Invalid stereo PCM packet');
  const frame = bytes.readDoubleLE(0);
  const frames = (bytes.length - 8) / 8;
  if (!Number.isSafeInteger(frame) || frame !== live.frames || frames > live.sampleRate / 4) throw new Error('Audio packets arrived out of order');
  for (let i = 8; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) throw new Error('Invalid audio samples');
  if (live.startedAt === null) live.startedAt = time + (live.bufferMs ?? 700);
  // A suspended source must not drain a growing queue of stale audio.
  if (time > live.startedAt + frame / live.sampleRate * 1000 - 100) throw new Error('The broadcaster fell behind. Stop sharing and start again.');
  const packet = { id: live.id, frame, frames, sampleRate: live.sampleRate, startsAt: live.startedAt + frame / live.sampleRate * 1000, pcm: bytes.subarray(8).toString('base64') };
  live.frames += frames; live.lastChunk = time;
  return packet;
}
