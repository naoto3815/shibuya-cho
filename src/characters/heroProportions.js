// Canonical standing height; source scans stay at their authored size.
export const HERO_HEIGHT = 1.95;
export const HERO_ASSET_HEIGHT = 1.82;

// Keep face, collar, hands and shoes at their reference size; lift the trouser rise.
// Geometry and bind joints must use the same map. Hero clips are solved on that rig.
export function heroBodyY(y, x = 0) {
  const ankle = 0.10, hip = 0.94, collar = 1.52, lift = 0.115;
  if (y <= ankle || y >= collar) return y;
  // Hands and forearms lie outside the torso: don't shorten their reach as the waist rises.
  const t = Math.max(0, Math.min(1, (Math.abs(x) - 0.22) / 0.09));
  const body = 1 - t * t * (3 - 2 * t);
  return y + body * lift * (y <= hip ? (y - ankle) / (hip - ankle) : (collar - y) / (collar - hip));
}
export function heroJoints(joints) {
  return Object.fromEntries(Object.entries(joints).map(([name,p])=>[name,[p[0],heroBodyY(p[1],p[0]),p[2]]]));
}
