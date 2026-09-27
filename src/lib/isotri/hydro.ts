/**
 * Continental hydrology over the level-0 lattice (LOD contract rule 4:
 * the drainage network is derived at the coarse layer and STAMPED into the
 * vertex field; finer layers only ever inherit the stamp by interpolation,
 * so they never need to re-run the global solve).
 *
 * Pipeline (all O(V log V), V = (w+1)*(h+1) root vertices):
 *
 *  1. Rain field — deterministic fBm + orographic boost over high ground.
 *  2. Priority-flood depression filling (Barnes et al. 2014): start from the
 *     ocean (sea level 0) and flood inward with a min-heap; every depression
 *     is raised to its spill level. The vertex that discovered you is your
 *     flat-area drainage parent — this routes flow across filled flats and
 *     through lakes without starburst artifacts.
 *  3. Receivers: each land vertex drains to its steepest descending neighbor
 *     in FILLED elevation; if none (flat / lake bottom), to the discovery
 *     parent. Result: a single drainage tree rooted at the ocean.
 *  4. Discharge accumulation, one pass over vertices in descending filled
 *     elevation:  acc(u) = rain(u) + Σ acc(child)·(1 − loss(edge)).
 *     Tree accumulation is order-independent — determinism holds by design.
 *  5. Classification: discharge (NOT raw accumulation) above a quantile
 *     threshold becomes a river (width ∝ √Q); fill depth > LAKE_MIN becomes
 *     a lake; shallow fills become wetlands; discharge also boosts moisture,
 *     which grows riparian forest corridors for free through classify().
 */

import { clamp, fbm, smoothstep } from "./hash";
import { FIX, vk, worldXY, type VertexKey } from "./lattice";
import { GEO, VertexField, type HydroStamp } from "./field";

export interface HydroParams {
  /** River threshold multiplier — higher => fewer, bigger rivers. */
  thrMult: number;
}

export interface HydroStats {
  rivers: number;
  lakes: number;
  swamps: number;
  ms: number;
  thr: number;
  vertices: number;
}

export interface HydroDebug {
  recv: Int32Array;
  acc: Float64Array;
  filled: Float64Array;
  rain: Float64Array;
  isOcean: Uint8Array;
}

export interface HydroResult {
  stamps: Map<VertexKey, HydroStamp>;
  stats: HydroStats;
  debug?: HydroDebug;
}

const LAKE_MIN = 0.035; // fill depth above which a depression is a lake
const SWAMP_MIN = 0.012; // fill depth above which it is a wetland
const LOSS = 0.004; // per-edge transmission loss (evaporation / infiltration)
const EPS = 3e-4; // flat-area gradient injected by the fill
const RIVER_QUANTILE = 0.08; // fraction of land vertices that are channels

/** Binary min-heap on float priorities with int payloads. */
class MinHeap {
  private pri: Float64Array;
  private val: Int32Array;
  private n = 0;

  constructor(capacity: number) {
    this.pri = new Float64Array(capacity);
    this.val = new Int32Array(capacity);
  }

  private grow(): void {
    const p = new Float64Array(this.pri.length * 2);
    const v = new Int32Array(this.val.length * 2);
    p.set(this.pri);
    v.set(this.val);
    this.pri = p;
    this.val = v;
  }

  push(priority: number, value: number): void {
    if (this.n === this.pri.length) this.grow();
    let i = this.n++;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.pri[par] <= priority) break;
      this.pri[i] = this.pri[par];
      this.val[i] = this.val[par];
      i = par;
    }
    this.pri[i] = priority;
    this.val[i] = value;
  }

  pop(): number {
    const top = this.val[0];
    const n = --this.n;
    if (n <= 0) return top;
    const p = this.pri[n];
    const v = this.val[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      let mp = p;
      if (l < n && this.pri[l] < mp) {
        m = l;
        mp = this.pri[l];
      }
      if (r < n && this.pri[r] < mp) {
        m = r;
        mp = this.pri[r];
      }
      if (m === i) break;
      this.pri[i] = this.pri[m];
      this.val[i] = this.val[m];
      i = m;
    }
    this.pri[i] = p;
    this.val[i] = v;
    return top;
  }

  get size(): number {
    return this.n;
  }
}

/**
 * Neighbor table for the triangular lattice: the 6 edge-neighbors are
 * (±1,0), (0,±1), (+1,−1), (−1,+1) in root (i,j) coords — all at identical
 * world distance (the lattice is equilateral).
 */
function buildNeighbors(w: number, h: number): Int32Array {
  const W1 = w + 1;
  const nb = new Int32Array((w + 1) * (h + 1) * 6).fill(-1);
  const idx = (i: number, j: number) => j * W1 + i;
  for (let j = 0; j <= h; j++) {
    for (let i = 0; i <= w; i++) {
      const k = idx(i, j);
      const o = k * 6;
      const put = (ii: number, jj: number, slot: number) => {
        if (ii >= 0 && ii <= w && jj >= 0 && jj <= h) nb[o + slot] = idx(ii, jj);
      };
      put(i - 1, j, 0);
      put(i + 1, j, 1);
      put(i, j - 1, 2);
      put(i, j + 1, 3);
      put(i + 1, j - 1, 4);
      put(i - 1, j + 1, 5);
    }
  }
  return nb;
}

export function computeHydro(
  field: VertexField,
  seed: number,
  params: HydroParams,
  withDebug = false
): HydroResult {
  const t0 = performance.now();
  const w = GEO.w;
  const h = GEO.h;
  const W1 = w + 1;
  const N = W1 * (h + 1);
  const nb = buildNeighbors(w, h);

  const elev = new Float64Array(N);
  const keyOf: VertexKey[] = new Array(N);
  for (let j = 0; j <= h; j++) {
    for (let i = 0; i <= w; i++) {
      const k = j * W1 + i;
      keyOf[k] = vk(i * FIX, j * FIX);
      // base elevation WITHOUT hydro stamps (stamps never touch elev)
      elev[k] = field.value(keyOf[k]).elev;
    }
  }

  // ---- 1. rain field (deterministic, orographic) ----
  const rain = new Float64Array(N);
  for (let j = 0; j <= h; j++) {
    for (let i = 0; i <= w; i++) {
      const k = j * W1 + i;
      const [wx, wy] = worldXY(i * FIX, j * FIX);
      const r =
        0.62 +
        0.85 * (fbm(wx * 0.55 + 101.3, wy * 0.55 + 37.7, seed ^ 0x9e37, 3) - 0.5) +
        0.38 * smoothstep(0.12, 0.75, elev[k]);
      rain[k] = clamp(r, 0.08, 1.7);
    }
  }

  // ---- 2. priority-flood depression filling ----
  const filled = new Float64Array(N);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const isOcean = new Uint8Array(N);
  const heap = new MinHeap(N * 2);
  const order = new Int32Array(N);
  let orderN = 0;

  for (let k = 0; k < N; k++) {
    const i = k % W1;
    const j = (k / W1) | 0;
    const boundary = i === 0 || i === w || j === 0 || j === h;
    if (boundary || elev[k] <= 0) {
      isOcean[k] = 1;
      filled[k] = Math.max(elev[k], 0);
      heap.push(filled[k], k);
    }
  }
  while (heap.size > 0) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    order[orderN++] = k;
    const f = filled[k];
    const o = k * 6;
    for (let s = 0; s < 6; s++) {
      const n = nb[o + s];
      if (n < 0 || closed[n]) continue;
      const fn = Math.max(elev[n], f + EPS);
      filled[n] = fn;
      parent[n] = k;
      heap.push(fn, n);
    }
  }

  // ---- 3. receivers: steepest filled descent, flats route via discovery ----
  const recv = new Int32Array(N).fill(-1);
  for (let k = 0; k < N; k++) {
    if (isOcean[k]) continue;
    const f = filled[k];
    let best = -1;
    let bestSlope = 0;
    const o = k * 6;
    for (let s = 0; s < 6; s++) {
      const n = nb[o + s];
      if (n < 0) continue;
      const d = f - filled[n];
      if (d > 1e-9 && d > bestSlope) {
        bestSlope = d;
        best = n;
      }
    }
    // flat or lake bottom: follow the priority-flood discovery edge toward
    // the outlet (this is the flat-routing trick)
    recv[k] = best >= 0 ? best : parent[k];
  }

  // ---- 4. discharge accumulation: one pass, descending filled elevation ----
  const acc = new Float64Array(N);
  for (let x = orderN - 1; x >= 0; x--) {
    const k = order[x];
    if (isOcean[k]) continue;
    acc[k] += rain[k];
    const r = recv[k];
    if (r >= 0) acc[r] += acc[k] * (1 - LOSS);
  }

  // ---- 5. classify: rivers, lakes, wetlands ----
  const landAcc: number[] = [];
  for (let k = 0; k < N; k++) if (!isOcean[k]) landAcc.push(acc[k]);
  landAcc.sort((a, b) => b - a);
  // thrMult scales the quantile FRACTION DOWN: 3x => only the biggest trunks
  const qIdx = clamp(
    Math.floor(
      (landAcc.length * RIVER_QUANTILE) / Math.max(0.05, params.thrMult)
    ),
    0,
    Math.max(0, landAcc.length - 1)
  );
  const thr = Math.max(1e-6, landAcc[qIdx] ?? 1e-6);

  const stamps = new Map<VertexKey, HydroStamp>();
  let rivers = 0;
  let lakes = 0;
  let swamps = 0;

  for (let k = 0; k < N; k++) {
    if (isOcean[k]) continue;
    const depth = filled[k] - elev[k];
    let lake = 0;
    if (depth > LAKE_MIN) lake = 1;
    else if (depth > SWAMP_MIN)
      lake = 0.25 + 0.55 * smoothstep(SWAMP_MIN, LAKE_MIN, depth);
    const river =
      lake < 0.5
        ? clamp((Math.sqrt(acc[k] / thr) - 0.85) / 0.85, 0, 1)
        : 0;
    const boost =
      0.5 * smoothstep(thr * 0.12, thr * 1.1, acc[k]) +
      0.3 * smoothstep(0.2, 0.5, lake);
    stamps.set(keyOf[k], { lake, river, fill: filled[k], boost });
    if (river > 0.12) rivers++;
    if (lake >= 0.9) lakes++;
    else if (lake > 0.1) swamps++;
  }

  // river mouths: bleed channel strength one step into the ocean so rivers
  // visibly connect to the sea instead of stopping at the coastline
  for (let k = 0; k < N; k++) {
    if (isOcean[k]) continue;
    const st = stamps.get(keyOf[k]);
    if (!st || st.river < 0.12) continue;
    const r = recv[k];
    if (r >= 0 && isOcean[r]) {
      const ok = keyOf[r];
      const prev = stamps.get(ok);
      if (prev) {
        if (st.river * 0.8 > prev.river) prev.river = st.river * 0.8;
      } else {
        stamps.set(ok, {
          lake: 0,
          river: st.river * 0.8,
          fill: Math.max(elev[r], 0),
          boost: 0,
        });
      }
    }
  }

  const stats: HydroStats = {
    rivers,
    lakes,
    swamps,
    ms: performance.now() - t0,
    thr,
    vertices: N,
  };

  return {
    stamps,
    stats,
    debug: withDebug ? { recv, acc, filled, rain, isOcean } : undefined,
  };
}
