/**
 * Deterministic integer hashing + value noise.
 *
 * RULE (the LOD contract): all authoritative randomness must be a pure
 * function of integer inputs (world position, channel, seed). No Math.random,
 * no per-tile RNG state, no GPU sin-hashes for data.
 */

export function hash3(a: number, b: number, c: number): number {
  // splitmix-style integer avalanche -> [0, 1)
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1) ^ Math.imul(c | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Centered hash noise in [-1, 1). */
export function hashNoise(a: number, b: number, c: number): number {
  return hash3(a, b, c) * 2 - 1;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth 2D value noise on the integer lattice, [0,1). */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = hash3(xi, yi, seed);
  const n10 = hash3(xi + 1, yi, seed);
  const n01 = hash3(xi, yi + 1, seed);
  const n11 = hash3(xi + 1, yi + 1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/** Fractal Brownian motion (sum of value-noise octaves), roughly [0,1). */
export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 0x9e37) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
