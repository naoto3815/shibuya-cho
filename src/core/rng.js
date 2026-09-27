// [foundation] Seeded RNG (mulberry32). engine.rng = createRng(seed)
//   rng()            -> [0,1)
//   rng.range(a,b)   -> float in [a,b)
//   rng.int(a,b)     -> integer in [a,b] inclusive
//   rng.pick(arr)    -> element
//   rng.seed(n)      -> reseed (returns rng)
//   rng.gaussian(mean=0, sd=1)
//   rng.chance(p)    -> bool
//   rng.fork(n)      -> independent rng derived from current state + n
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  const rng = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = (n) => { s = (Number(n) >>> 0) || 1; return rng; };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.min(b, Math.floor(a + (b - a + 1) * rng()));
  rng.pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  rng.chance = (p) => rng() < p;
  rng.gaussian = (mean = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.fork = (n = 0) => createRng((s ^ Math.imul((n | 0) + 1, 0x9E3779B1)) >>> 0);
  rng.state = () => s;
  return rng;
}

export default createRng;
