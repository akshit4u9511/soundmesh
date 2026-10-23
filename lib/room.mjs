export const now = () => performance.timeOrigin + performance.now();
export const flatEq = () => ({enabled:true,bass:0,mid:0,treble:0});
export function validEq(eq) {
  if(!eq || typeof eq!=='object' || typeof eq.enabled!=='boolean') throw new Error('Invalid equalizer settings');
  const result={enabled:eq.enabled};
  for(const band of ['bass','mid','treble']) {
    if(!Number.isFinite(eq[band])) throw new Error('Invalid equalizer band');
    result[band]=Math.max(-6,Math.min(6,eq[band]));
  }
  return result;
}
export function positionAt(transport, time, duration = Infinity) {
  return Math.min(duration, Math.max(0, transport.position + (transport.playing ? Math.max(0, time - transport.startsAt) / 1000 : 0)));
}
export function validSettings(input) {
  const result = {};
  if ('name' in input) result.name = String(input.name).trim().slice(0, 40) || 'Unnamed device';
  if ('volume' in input) {
    if (!Number.isFinite(input.volume)) throw new Error('Invalid volume');
    result.volume = Math.max(0, Math.min(1, input.volume));
  }
  if ('delay' in input) {
    if (!Number.isFinite(input.delay)) throw new Error('Invalid delay');
    result.delay = Math.max(-500, Math.min(500, input.delay));
  }
  if ('role' in input) {
    if (!['stereo', 'left', 'right'].includes(input.role)) throw new Error('Invalid speaker role');
    result.role = input.role;
  }
  if ('muted' in input) result.muted = Boolean(input.muted);
  if ('eq' in input) result.eq = validEq(input.eq);
  return result;
}
