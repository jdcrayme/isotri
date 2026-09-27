/**
 * Road networks (phase 4): A* over the weight field, stamped back as an
 * overlay channel — the infrastructure sibling of the hydrology core.
 *
 * The solve runs on a FIXED lattice level (level 2) so the road network is
 * independent of the current mesh: every edge is one L2 lattice step
 * (0.25 world units), and the vertex values come straight from the field
 * (seed terrain + hydrology stamps + painted overrides). Like the drainage
 * trunks, the resulting path is stored as fixed-point SEGMENTS and stamped
 * into the vertex field as a distance field — roads stay crisp at every
 * LOD, they do not dilute with interpolation, and refine-invariance holds.
 *
 * Cost model (per edge, admissible A* heuristic = euclidean distance):
 *   base        edge length (constant on the equilateral lattice)
 *   slope       × (1 + K_slope · (dz/edge)²)      — grades, not cliffs
 *   materials   rock / snow add engineering cost, forest light clearing
 *   wetlands    dragged by lake strength
 *   lakes       bridged at a flat per-edge penalty (counted as bridges)
 *   rivers      forded, cost rising with channel strength (counted as fords)
 *   open sea    IMPASSABLE — roads never bridge the ocean
 *
 * Determinism: identical field state + endpoints => the identical path.
 * The path is authored infrastructure (the user chose the endpoints), so it
 * is stored in the document and does NOT re-route when the terrain is later
 * sculpted — unlike rivers, which are derived.
 */

import {
  FIX,
  parseVk,
  vk,
  worldToLattice,
  worldXY,
  type VertexKey,
} from "./lattice";
import { VertexField, type RoadSeg } from "./field";
import { MinHeap } from "./hydro";

/** Solve level: roads are planned on level-2 vertices (FIX/4 stride). */
export const ROAD_SOLVE_LEVEL = 2;
const STRIDE = FIX >> ROAD_SOLVE_LEVEL; // fixed-point units per solve edge
const EDGE = 1 / (1 << ROAD_SOLVE_LEVEL); // world units per edge (0.25)

// ---- cost model ----
const SLOPE_K = 5.0; // (dz/edge)² penalty — avoids cliffs, accepts grades
const FOREST_K = 0.35; // clearing cost
const ROCK_K = 1.6; // engineering cost
const SNOW_K = 2.6; // alpine engineering cost
const SWAMP_K = 0.9; // wetland drag (scales with lake strength)
const LAKE_BRIDGE = 3.2; // flat per-edge penalty for bridging open water
const FORD_K = 1.4; // river crossing, scaling with channel strength
const MAX_EXPLORE = 120000; // A* node budget (huge maps solve well under this)

/** Lattice edge-neighbor offsets (all equilateral — same as the root grid). */
const NB: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [1, -1],
  [-1, 1],
];

export interface RoadStats {
  ms: number;
  edges: number;
  length: number; // world units
  bridges: number; // lake-water crossings
  fords: number; // river crossings
  explored: number; // A* nodes expanded
}

export interface RoadResult {
  segs: RoadSeg[];
  stats: RoadStats;
}

/**
 * Snap a world point to the nearest road-solve vertex, clamped to the
 * world rectangle. Returns the canonical fixed-point vertex key.
 */
export function snapToRoadGrid(
  field: VertexField,
  wx: number,
  wy: number
): VertexKey {
  const [aF, bF] = worldToLattice(wx, wy);
  const n = 1 << ROAD_SOLVE_LEVEL; // solve vertices per root cell
  const i = Math.round(aF * n);
  const j = Math.round(bF * n);
  const ci = Math.max(0, Math.min(field.geo.w * n, i));
  const cj = Math.max(0, Math.min(field.geo.h * n, j));
  return vk(ci * STRIDE, cj * STRIDE);
}

/**
 * Route a road from `fromKey` to `toKey` over the current field state.
 * Returns null when the endpoints coincide or no land route exists.
 */
export function computeRoad(
  field: VertexField,
  fromKey: VertexKey,
  toKey: VertexKey
): RoadResult | null {
  if (fromKey === toKey) return null;
  const t0 = performance.now();

  const n = 1 << ROAD_SOLVE_LEVEL;
  const GW = field.geo.w * n + 1;
  const GH = field.geo.h * n + 1;
  const N = GW * GH;
  const idxOf = (key: VertexKey): number => {
    const [a, b] = parseVk(key);
    return (b / STRIDE) * GW + a / STRIDE;
  };
  const keyOf = (idx: number): VertexKey =>
    vk((idx % GW) * STRIDE, ((idx / GW) | 0) * STRIDE);

  const start = idxOf(fromKey);
  const goal = idxOf(toKey);
  if (start === goal) return null;
  if (start < 0 || goal < 0 || start >= N || goal >= N) return null;

  // ---- lazily-loaded vertex data (field values are cached by the field) ----
  const zv = new Float64Array(N).fill(NaN);
  const water = new Float32Array(N);
  const lake = new Float32Array(N);
  const rock = new Float32Array(N);
  const snow = new Float32Array(N);
  const forest = new Float32Array(N);
  const riv = new Float32Array(N);
  const known = new Uint8Array(N);

  const load = (idx: number): void => {
    if (known[idx]) return;
    known[idx] = 1;
    const v = field.value(keyOf(idx));
    zv[idx] = v.z;
    water[idx] = v.w[0];
    lake[idx] = v.lake;
    rock[idx] = v.w[4];
    snow[idx] = v.w[5];
    forest[idx] = v.w[3];
    riv[idx] = v.river;
  };

  // heuristic: cost per world unit is >= 1 (base edge cost / edge length),
  // so straight-line distance is admissible
  const wxOf = (idx: number): [number, number] =>
    worldXY((idx % GW) * STRIDE, ((idx / GW) | 0) * STRIDE);
  const [gx, gy] = wxOf(goal);
  const hOf = (idx: number): number => {
    const [x, y] = wxOf(idx);
    return Math.hypot(x - gx, y - gy);
  };

  // terrain-aware edge cost, or -1 when impassable (open sea)
  const edgeCost = (u: number, v: number): number => {
    load(v);
    const wv = water[v];
    const lv = lake[v];
    if (wv > 0.62 && lv <= 0.2) return -1; // open sea: impassable
    load(u);
    const dz = Math.abs(zv[v] - zv[u]);
    let c = EDGE * (1 + SLOPE_K * (dz / EDGE) * (dz / EDGE));
    if (wv > 0.62) {
      c = EDGE + LAKE_BRIDGE; // bridging a lake: flat engineering cost
    } else {
      c *= 1 + FOREST_K * forest[v] + ROCK_K * rock[v] + SNOW_K * snow[v];
      if (lv > 0.2) c += SWAMP_K * (lv - 0.2); // wetlands drag
      if (riv[v] > 0.12) c += FORD_K * Math.min(1, riv[v] * 1.3); // ford
    }
    return c;
  };

  // ---- A* ----
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap(1024);
  g[start] = 0;
  heap.push(hOf(start), start);
  let explored = 0;
  let found = false;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    explored++;
    if (explored > MAX_EXPLORE) return null;
    if (cur === goal) {
      found = true;
      break;
    }
    const ci = cur % GW;
    const cj = (cur / GW) | 0;
    // 6 lattice neighbors: (±1,0), (0,±1), (+1,−1), (−1,+1)
    for (let s = 0; s < NB.length; s++) {
      const ni = ci + NB[s][0];
      const nj = cj + NB[s][1];
      if (ni < 0 || ni >= GW || nj < 0 || nj >= GH) continue;
      const nb = nj * GW + ni;
      if (closed[nb]) continue;
      const c = edgeCost(cur, nb);
      if (c < 0) continue;
      const ng = g[cur] + c;
      if (ng < g[nb]) {
        g[nb] = ng;
        came[nb] = cur;
        heap.push(ng + hOf(nb), nb);
      }
    }
  }
  if (!found) return null;

  // ---- reconstruct + convert to segments ----
  const path: number[] = [];
  for (let cur = goal; cur !== start; cur = came[cur]) path.push(cur);
  path.push(start);
  path.reverse();

  const segs: RoadSeg[] = [];
  let bridges = 0;
  let fords = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i];
    const v = path[i + 1];
    load(u);
    load(v);
    const [ua, ub] = parseVk(keyOf(u));
    const [va, vb] = parseVk(keyOf(v));
    segs.push({ a1: ua, b1: ub, a2: va, b2: vb });
    if (water[v] > 0.62) bridges++;
    else if (riv[v] > 0.12) fords++;
  }

  return {
    segs,
    stats: {
      ms: performance.now() - t0,
      edges: segs.length,
      length: segs.length * EDGE,
      bridges,
      fords,
      explored,
    },
  };
}
