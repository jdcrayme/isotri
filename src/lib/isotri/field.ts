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
 *   fill   — local water level (the spill elevation). Carried at roots from
 *            hydrology stamps, inherited at finer layers with NO noise, so
 *            refined water surfaces can be clamped flat to it (lake-level
 *            clamping).
 *
 * Fine-layer hydrology inheritance (phase 3):
 *   The coarse solve also emits its drainage network as TRUNK SEGMENTS
 *   (root vertex -> receiver, with channel strength). Refined vertices
 *   re-stamp the trunk locally: river = max(interpolated, distance-field
 *   of nearby segments with a smooth deterministic meander wobble). This
 *   keeps channels crisp at width ∝ √Q instead of smearing with
 *   interpolation, and adds band-limited meander detail that only exists
 *   at fine LODs (coarse views are untouched — refine-invariance holds).
 *
 * User overrides are PARTIAL: painting weights keeps seed elevation fluid,
 * painting elevation re-derives weights from classify(). Hydrology stamps are
 * a separate derived layer — recomputed wholesale, never painted.
 */

import { clamp, fbm, hash3, hashNoise, smoothstep, valueNoise } from "./hash";
import {
  FIX,
  SQRT3_2,
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
  fill: number; // local water level (spill elevation near water)
}

/**
 * One drainage-network edge on the root lattice, emitted by the hydrology
 * core for fine-layer trunk seeding. Coordinates are FIXED-POINT lattice
 * coords of the two root endpoints; `q` is the channel strength (0..1) at
 * the source — the fine distance field reproduces width ∝ √Q from it.
 */
export interface TrunkSeg {
  a1: number;
  b1: number;
  a2: number;
  b2: number;
  q: number;
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

/**
 * Build a consistent geometry for a w×h root lattice.
 *
 * World extents of a w×h grid: x ∈ [0, w + h/2], y ∈ [0, h·√3/2]. The island
 * radius scales with the smaller extent so the landmass fills the rectangle
 * the same way at every size (at the default 30×22 this is exactly the
 * original hand-tuned r = 8.6, so seed-7 worlds are unchanged).
 */
export function makeGeometry(w: number, h: number): MapGeometry {
  const cx = (w + h * 0.5) / 2;
  const cy = (h * Math.sqrt(3)) / 4;
  const r =
    (8.6 * Math.min(w + h * 0.5, h * SQRT3_2)) / (22 * SQRT3_2);
  return { w, h, cx, cy, r };
}

/** Default world (kept as a literal so existing saved worlds stay exact). */
export const GEO: MapGeometry = {
  w: 30,
  h: 22,
  cx: 0,
  cy: 0,
  r: 8.6,
};
GEO.cx = (GEO.w + GEO.h * 0.5) / 2;
GEO.cy = (GEO.h * Math.sqrt(3)) / 4;

/** Named world sizes offered by the editor. Medium is the classic default. */
export interface MapSizePreset {
  key: string;
  label: string;
  w: number;
  h: number;
}

export const MAP_SIZES: MapSizePreset[] = [
  { key: "small", label: "Small", w: 22, h: 16 },
  { key: "medium", label: "Medium", w: 30, h: 22 },
  { key: "large", label: "Large", w: 44, h: 32 },
  { key: "huge", label: "Huge", w: 64, h: 46 },
];

/** Which preset (if any) a saved w×h corresponds to. */
export function sizeKeyFor(w: number, h: number): string | null {
  for (const s of MAP_SIZES) if (s.w === w && s.h === h) return s.key;
  return null;
}

/** Sanity bounds for a geometry coming off disk. */
export const MAP_SIZE_MIN = 8;
export const MAP_SIZE_MAX = 128;

export function clampMapSize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.round(Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, w))),
    h: Math.round(Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, h))),
  };
}

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
  seed: number,
  geo: MapGeometry = GEO
): { elev: number; moist: number } {
  const [wx, wy] = worldXY(a, b);
  const dx = wx - geo.cx;
  const dy = wy - geo.cy;
  const d = Math.sqrt(dx * dx + dy * dy) / geo.r;

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

// ---- fine-layer trunk seeding constants ----

/** Peak amplitude (world units) of the deterministic meander wobble. */
const TRUNK_MEANDER = 0.36;

/**
 * Channel half-width (world units) for a trunk of strength q — matched to
 * the coarse view, where a vertex with stamp q falls to the shader's
 * channel-core threshold (~0.22·q) about 0.75–0.8 cells from the center.
 */
function trunkHalfWidth(q: number): number {
  return 0.55 + 0.45 * q;
}

/** Squared-distance-free point/segment distance in world units. */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-12) t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

export class VertexField {
  seed: number;
  /** World geometry (size/center/island radius) — part of the document. */
  geo: MapGeometry;
  /** User-painted vertices (partial) — the only authoritative mutable state. */
  overrides = new Map<VertexKey, Override>();
  /**
   * Derived hydrology stamps (root vertices only). Replaced wholesale on
   * recompute; never painted. Not serialized (pure function of terrain).
   */
  hydro = new Map<VertexKey, HydroStamp>();
  /**
   * Fine-layer hydrology detail: trunk seeding + lake-level clamping on
   * refined tiles. Purely a derivation toggle — coarse (level-0) values are
   * identical either way.
   */
  fineHydro = true;
  /** Spatial hash of drainage trunk segments (cell -> segments). */
  private trunkGrid = new Map<number, TrunkSeg[]>();
  /** Derived-value cache (invalidated wholesale on any edit — cheap). */
  private cache = new Map<VertexKey, VV>();
  /** Vertices that exist (level-0 grid + every created midpoint). */
  materialized = new Set<VertexKey>();

  constructor(seed: number, geo: MapGeometry = GEO) {
    this.seed = seed | 0;
    this.geo = geo;
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
    let fill: number;
    let w: Float32Array | null = null;

    if (L === 0) {
      const sv = seedTerrain(a, b, this.seed, this.geo);
      elev = sv.elev;
      moist = sv.moist;
      z = elev;
      lake = 0;
      river = 0;
      fill = elev;
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
      fill = (p1.fill + p2.fill) * 0.5; // water level inherits smoothly
      // land gets the relief noise; lakes stay flat at their surface level
      z = (p1.z + p2.z) * 0.5 + ne * (1 - clamp(lake, 0, 1));

      // ---- fine-layer trunk seeding (phase 3) ----
      // The coarse drainage network is re-stamped onto refined vertices as a
      // smooth 2D distance field with a deterministic low-frequency meander,
      // so channels stay crisp at width ∝ √Q and gain fine-scale bends
      // instead of diluting into the interpolation. Skipped over open water
      // (rivers never draw across lakes — same rule as the coarse stamps).
      if (this.fineHydro && this.trunkGrid.size > 0 && lake < 0.5) {
        const [wx, wy] = worldXY(a, b);
        const sx = wx + (valueNoise(wx * 1.9 + 41.3, wy * 1.9 + 17.9, this.seed ^ 0x51ab) - 0.5) * TRUNK_MEANDER;
        const sy = wy + (valueNoise(wx * 1.7 + 91.2, wy * 1.7 + 33.7, this.seed ^ 0x9e21) - 0.5) * TRUNK_MEANDER;
        const s = this.trunkRiverAt(sx, sy);
        if (s > river) river = s;
      }

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
      fill = hs.fill;
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
      // roots: flatten to the stamped spill level
      zFinal = elev + (hs.fill - elev) * lakeS;
    } else if (L > 0 && lakeS > 0) {
      // refined vertices: lake-level clamping — the water surface is pulled
      // to the inherited water level so lakes render flat at every LOD and
      // shorelines stay crisp instead of soaking half the relief noise.
      zFinal = z + (fill - z) * lakeS;
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

    return { elev, z: zFinal, moist, w: out, river, lake, fill };
  }

  /** All roots exist regardless of materialization (needed by inheritance). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Replace the hydrology layer wholesale and invalidate derivations. */
  setHydro(stamps: Map<VertexKey, HydroStamp>, trunks: TrunkSeg[] = []): void {
    this.hydro = stamps;
    this.rebuildTrunkIndex(trunks);
    this.clearCache();
  }

  /** Toggle fine-layer detail (trunk seeding + lake clamping). */
  setFineHydro(on: boolean): void {
    if (this.fineHydro === on) return;
    this.fineHydro = on;
    this.clearCache();
  }

  // ---------------- fine-layer trunk index ----------------

  /** Spatial-hash cell size (world units) for the trunk index. */
  private static readonly TRUNK_CELL = 1.25;

  private static trunkCellKey(cx: number, cy: number): number {
    // world coords are small (|c| < 200); offset-encode two int16 halves
    return ((cx + 2048) << 12) | (cy + 2048);
  }

  private rebuildTrunkIndex(trunks: TrunkSeg[]): void {
    this.trunkGrid.clear();
    const C = VertexField.TRUNK_CELL;
    for (const t of trunks) {
      const [ax, ay] = worldXY(t.a1, t.b1);
      const [bx, by] = worldXY(t.a2, t.b2);
      const hw = trunkHalfWidth(t.q);
      const pad = hw + TRUNK_MEANDER + 0.05;
      const x0 = Math.floor((Math.min(ax, bx) - pad) / C);
      const x1 = Math.floor((Math.max(ax, bx) + pad) / C);
      const y0 = Math.floor((Math.min(ay, by) - pad) / C);
      const y1 = Math.floor((Math.max(ay, by) + pad) / C);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = VertexField.trunkCellKey(cx, cy);
          const bucket = this.trunkGrid.get(k);
          if (bucket) bucket.push(t);
          else this.trunkGrid.set(k, [t]);
        }
      }
    }
  }

  /**
   * Distance-field stamp of the drainage network at a (wobbled) world
   * point: the strongest channel contribution from nearby trunk segments.
   */
  private trunkRiverAt(sx: number, sy: number): number {
    const C = VertexField.TRUNK_CELL;
    const cx = Math.floor(sx / C);
    const cy = Math.floor(sy / C);
    let best = 0;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const bucket = this.trunkGrid.get(VertexField.trunkCellKey(ix, iy));
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const t = bucket[n];
          const [ax, ay] = worldXY(t.a1, t.b1);
          const [bx, by] = worldXY(t.a2, t.b2);
          const d = distToSegment(sx, sy, ax, ay, bx, by);
          const hw = trunkHalfWidth(t.q);
          if (d >= hw) continue;
          // flat core out to 0.3·hw (so the centerline keeps the coarse
          // strength exactly), then a smooth bank falloff to the edge
          const s = t.q * (1 - smoothstep(hw * 0.3, hw, d));
          if (s > best) best = s;
        }
      }
    }
    return best;
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
