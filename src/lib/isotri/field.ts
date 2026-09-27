/**
 * Vertex field: elevation + material weight vector per lattice vertex.
 *
 * Pure-function core (LOD contract rule 1):
 *   value(v) = override(v)                        if user painted v (partial)
 *            = seedValue(v) + hydroStamp(v)       if v is level 0
 *            = blend(value(p1), value(p2), noise) otherwise (midpoint vertex)
 *
 * The blend is midpoint displacement with deterministic hash noise whose
 * amplitude shrinks with level, so coarse views stay the low-pass of fine
 * views and computation order never matters.
 *
 * Channels per vertex:
 *   elev   — authoritative terrain elevation (what hydrology and brushes edit)
 *   z      — rendered surface elevation; equals elev on land, but lakes render
 *            flat at their spill (filled) level. Inherited with noise masked
 *            by lake strength so water stays flat while land gets relief.
 *   moist  — 0..1, drives classify() at level 0; boosted near rivers/wetlands
 *   w      — the K-material weight vector (the tile factory's real input)
 *   river  — 0..1 stamped river-channel strength (an overlay channel, NOT a
 *            palette entry: rivers stay crisp because it inherits by pure
 *            interpolation with no noise)
 *   lake   — 0..1 standing-water strength (lakes / wetlands)
 *
 * User overrides are PARTIAL: painting weights keeps seed elevation fluid,
 * painting elevation re-derives weights from classify(). Hydrology stamps are
 * a separate derived layer — recomputed wholesale, never painted.
 */

import { clamp, fbm, hashNoise, smoothstep, hash3 } from "./hash";
import {
  FIX,
  vertexLevel,
  vertexParents,
  parseVk,
  vk,
  worldXY,
  type VertexKey,
} from "./lattice";

export const K = 6; // palette size
export const MATERIALS = [
  "Water",
  "Sand",
  "Grass",
  "Forest",
  "Rock",
  "Snow",
] as const;

export interface VV {
  elev: number;
  z: number;
  moist: number;
  w: Float32Array; // length K, sums to ~1
  river: number;
  lake: number;
}

/** Partial user override — only the fields the user actually touched. */
export interface Override {
  elev?: number;
  moist?: number;
  w?: Float32Array;
}

export interface HydroStamp {
  lake: number; // 0..1 standing water
  river: number; // 0..1 channel strength
  fill: number; // filled (spill) elevation for flat lake surfaces
  boost: number; // moisture boost from discharge / wetlands
}

export interface MapGeometry {
  w: number; // cells
  h: number;
  cx: number; // world center
  cy: number;
  r: number; // island radius (world units)
}

export const GEO: MapGeometry = {
  w: 30,
  h: 22,
  cx: 0,
  cy: 0,
  r: 8.6,
};
// world x range: [0, w + h/2], y range: [0, h*sqrt(3)/2]
GEO.cx = (GEO.w + GEO.h * 0.5) / 2;
GEO.cy = (GEO.h * Math.sqrt(3)) / 4;

/** Classify (elevation, moisture) into the base palette weight vector. */
export function classify(elev: number, moist: number): Float32Array {
  const w = new Float32Array(K);
  const tWater = 1 - smoothstep(-0.05, 0.03, elev); // 1 offshore -> 0 inland
  w[0] = tWater;

  const land = 1 - tWater;
  // sand: beach band just above sea level
  const sand =
    smoothstep(-0.035, 0.035, elev) * (1 - smoothstep(0.07, 0.17, elev));
  // forest where wet (fades out high and on the immediate shore)
  const forest =
    smoothstep(0.52, 0.8, moist) *
    smoothstep(0.015, 0.09, elev) *
    (1 - smoothstep(0.5, 0.78, elev));
  // rock at altitude
  const rock = smoothstep(0.42, 0.72, elev);
  const snow = smoothstep(0.8, 1.1, elev);
  const grass = Math.max(
    0,
    (1 - sand - forest - rock - snow) * smoothstep(0.0, 0.05, elev)
  );

  w[1] = sand * land;
  w[2] = grass * land;
  w[3] = forest * land;
  w[4] = rock * land;
  w[5] = snow * land;

  let sum = w[0] + w[1] + w[2] + w[3] + w[4] + w[5];
  if (sum <= 0) {
    w[0] = 1;
    sum = 1;
  }
  for (let i = 0; i < K; i++) w[i] /= sum;
  return w;
}

/** Deterministic level-0 seed terrain: island distance field + fBm. */
export function seedTerrain(
  a: number,
  b: number,
  seed: number
): { elev: number; moist: number } {
  const [wx, wy] = worldXY(a, b);
  const dx = wx - GEO.cx;
  const dy = wy - GEO.cy;
  const d = Math.sqrt(dx * dx + dy * dy) / GEO.r;

  // base: rises from the coast, falls toward the interior; exponent shapes
  // the coastal shelf.
  let e = 1.15 * (1 - Math.pow(clamp(d, 0, 1.6), 1.7)) - 0.22;

  // large-scale landform noise
  const land = fbm(wx * 0.42 + 31.7, wy * 0.42 + 11.3, seed, 4);
  e += (land - 0.5) * 0.75;

  // ridged mountains, weighted toward the interior
  const ridge = fbm(wx * 0.85 + 7.7, wy * 0.85 + 91.2, seed ^ 0x51f3, 4);
  const mt = Math.max(0, ridge - 0.58);
  e += mt * mt * 4.4 * smoothstep(0.18, 0.62, d);

  if (e < 0) e *= 0.55; // sea floor slopes down more gently

  const moist = clamp(
    fbm(wx * 0.6 + 55.5, wy * 0.6 + 77.7, seed ^ 0x2b7e, 3) * 1.3 - 0.12,
    0,
    1
  );

  return { elev: e, moist };
}

// Back-compat alias (used by preview scripts).
export const seedValue = seedTerrain;

/** Noise amplitudes per creation level (band-limited fBm bookkeeping). */
function ampElev(L: number): number {
  return 0.34 * Math.pow(0.52, L - 1);
}
function ampWeight(L: number): number {
  return 0.3 * Math.pow(0.55, L - 1);
}

export class VertexField {
  seed: number;
  /** User-painted vertices (partial) — the only authoritative mutable state. */
  overrides = new Map<VertexKey, Override>();
  /**
   * Derived hydrology stamps (root vertices only). Replaced wholesale on
   * recompute; never painted. Not serialized (pure function of terrain).
   */
  hydro = new Map<VertexKey, HydroStamp>();
  /** Derived-value cache (invalidated wholesale on any edit — cheap). */
  private cache = new Map<VertexKey, VV>();
  /** Vertices that exist (level-0 grid + every created midpoint). */
  materialized = new Set<VertexKey>();

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  ensure(a: number, b: number): VertexKey {
    const key = vk(a, b);
    this.materialized.add(key);
    return key;
  }

  materializeRoots(w: number, h: number): void {
    for (let j = 0; j <= h; j++)
      for (let i = 0; i <= w; i++) this.materialized.add(vk(i * FIX, j * FIX));
  }

  has(key: VertexKey): boolean {
    return this.materialized.has(key);
  }

  value(key: VertexKey): VV {
    const c = this.cache.get(key);
    if (c) return c;
    const v = this.compute(key);
    this.cache.set(key, v);
    return v;
  }

  private compute(key: VertexKey): VV {
    const [a, b] = parseVk(key);
    const L = vertexLevel(a, b);
    const ov = this.overrides.get(key);

    let elev: number;
    let moist: number;
    let z: number;
    let lake: number;
    let river: number;
    let w: Float32Array | null = null;

    if (L === 0) {
      const sv = seedTerrain(a, b, this.seed);
      elev = sv.elev;
      moist = sv.moist;
      z = elev;
      lake = 0;
      river = 0;
    } else {
      const parents = vertexParents(a, b)!;
      const p1 = this.value(parents[0]);
      const p2 = this.value(parents[1]);
      const ne = hashNoise(a, b, this.seed ^ 0x7f4a) * ampElev(L);
      elev = (p1.elev + p2.elev) * 0.5 + ne;
      moist = clamp(
        (p1.moist + p2.moist) * 0.5 + hashNoise(a, b, this.seed ^ 0x3a9f) * 0.09,
        0,
        1
      );
      lake = (p1.lake + p2.lake) * 0.5;
      river = (p1.river + p2.river) * 0.5; // rivers stay crisp: no noise
      // land gets the relief noise; lakes stay flat at their surface level
      z = (p1.z + p2.z) * 0.5 + ne * (1 - clamp(lake, 0, 1));
      const aw = ampWeight(L);
      w = new Float32Array(K);
      for (let i = 0; i < K; i++) {
        const base = (p1.w[i] + p2.w[i]) * 0.5;
        const n = (hash3(a, b, this.seed ^ (0x1111 * (i + 1))) * 2 - 1) * aw;
        w[i] = Math.max(0, base + n);
      }
    }

    // ---- user overrides (partial) ----
    if (ov) {
      if (ov.elev !== undefined) elev = ov.elev;
      if (ov.moist !== undefined) moist = clamp(ov.moist, 0, 1);
    }

    // ---- hydrology stamps (root vertices only) ----
    const hs = L === 0 ? this.hydro.get(key) : undefined;
    if (hs) {
      if (hs.river > river) river = hs.river;
      if (hs.lake > lake) lake = hs.lake;
      if (hs.boost > 0) moist = clamp(moist + hs.boost, 0, 1);
    }

    // ---- finalize weights ----
    if (ov?.w) {
      w = ov.w;
    } else if (L === 0) {
      // re-derive from the (possibly edited) elevation + moisture
      w = classify(elev, moist);
    }
    const wf = w as Float32Array;

    // lakes flatten the surface and flood the weight vector
    const lakeS = smoothstep(0.2, 0.62, lake);
    let zFinal = z;
    if (hs && lakeS > 0) {
      zFinal = elev + (hs.fill - elev) * lakeS;
    }

    let out: Float32Array;
    if (lakeS > 0) {
      out = new Float32Array(K);
      for (let i = 0; i < K; i++) out[i] = wf[i] * (1 - lakeS);
      out[0] += lakeS;
      let sum = 0;
      for (let i = 0; i < K; i++) sum += out[i];
      if (sum > 1e-6) for (let i = 0; i < K; i++) out[i] /= sum;
    } else {
      out = wf;
    }

    return { elev, z: zFinal, moist, w: out, river, lake };
  }

  /** All roots exist regardless of materialization (needed by inheritance). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Replace the hydrology layer wholesale and invalidate derivations. */
  setHydro(stamps: Map<VertexKey, HydroStamp>): void {
    this.hydro = stamps;
    this.clearCache();
  }

  isRoot(key: VertexKey): boolean {
    const [a, b] = parseVk(key);
    return a % FIX === 0 && b % FIX === 0;
  }

  /**
   * Paint a material onto a vertex. `delta` is a blend factor in [-1, 1]:
   * positive blends the material toward 1 (paint), negative erases toward 0.
   * Keeps any existing elevation override intact (partial overrides).
   * Returns the previous override (for undo).
   */
  paint(key: VertexKey, matIndex: number, delta: number): Override | null {
    const prev = this.overrides.get(key) ?? null;
    const cur = this.value(key);
    const w = new Float32Array(K);
    for (let i = 0; i < K; i++) w[i] = Math.max(0, cur.w[i]);
    const d = clamp(delta, -1, 1);
    if (d >= 0) w[matIndex] = w[matIndex] + (1 - w[matIndex]) * d;
    else w[matIndex] = w[matIndex] * (1 + d);
    let sum = 0;
    for (let i = 0; i < K; i++) sum += w[i];
    if (sum <= 1e-6) {
      w[2] = 1;
      sum = 1;
    }
    for (let i = 0; i < K; i++) w[i] /= sum;
    const next: Override = { ...(prev ?? {}), w };
    this.overrides.set(key, next);
    this.clearCache();
    return prev;
  }

  /**
   * Paint an absolute elevation (terrain brushes). Weight overrides are kept;
   * otherwise the palette re-derives from classify(newElev, moist).
   * Returns the previous override (for undo).
   */
  paintElev(key: VertexKey, elev: number): Override | null {
    const prev = this.overrides.get(key) ?? null;
    const next: Override = { ...(prev ?? {}), elev };
    if (next.moist === undefined) delete next.moist;
    this.overrides.set(key, next);
    this.clearCache();
    return prev;
  }

  setOverride(key: VertexKey, ov: Override | null): void {
    if (ov && Object.keys(ov).length === 0) ov = null;
    if (ov) this.overrides.set(key, ov);
    else this.overrides.delete(key);
    this.clearCache();
  }

  getOverride(key: VertexKey): Override | null {
    return this.overrides.get(key) ?? null;
  }

  /** Dominant material index (for colored vertex dots). */
  dominant(w: Float32Array): number {
    let best = 0;
    for (let i = 1; i < K; i++) if (w[i] > w[best]) best = i;
    return best;
  }
}
