/**
 * Triangular lattice geometry.
 *
 * Vertices live on the infinite triangular lattice. Level-0 lattice steps are
 * (1,0) and (0,1) in lattice coords, mapping to world basis
 *   e1 = (1, 0), e2 = (1/2, sqrt(3)/2).
 *
 * All vertex identities are FIXED-POINT integers: a level-L vertex has
 * coords (a, b) = (i * 2^(G-L), j * 2^(G-L)). The "native level" of a vertex
 * is derivable from the 2-adic valuation of its coords, so a vertex identity
 * NEVER depends on which triangles exist (LOD contract rule 1).
 *
 * Triangles: U(i,j) has corners (i,j), (i+1,j), (i,j+1)  [apex up]
 *            D(i,j) has corners (i+1,j), (i,j+1), (i+1,j+1)  [apex down]
 * at level L with stride st = 2^(G-L) fixed-point units.
 */

export const MAX_DEPTH = 6; // G: deepest subdivision level
export const MAX_LEVEL = MAX_DEPTH;
export const FIX = 1 << MAX_DEPTH; // fixed-point units per level-0 step

export const SQRT3_2 = Math.sqrt(3) / 2;

export type VertexKey = string; // "a,b"
export type TriKey = string; // "L:o:i:j"   o: 1 = up, 0 = down

export function vk(a: number, b: number): VertexKey {
  return a + "," + b;
}

export function parseVk(key: VertexKey): [number, number] {
  const c = key.indexOf(",");
  return [parseInt(key.slice(0, c), 10), parseInt(key.slice(c + 1), 10)];
}

/** World position in level-0 units (z = elevation added by callers). */
export function worldXY(a: number, b: number): [number, number] {
  return [(a + b * 0.5) / FIX, (b * SQRT3_2) / FIX];
}

function v2(x: number): number {
  if (x === 0) return 99;
  const v = x < 0 ? -x : x;
  let n = 0;
  let r = v;
  while (r % 2 === 0) {
    r /= 2;
    n++;
    if (n > 40) break;
  }
  return n;
}

/** Native lattice level of a fixed-point vertex (0 = coarsest). */
export function vertexLevel(a: number, b: number): number {
  const m = Math.min(v2(a), v2(b));
  return MAX_DEPTH - Math.min(m, MAX_DEPTH);
}

/**
 * Parents (edge endpoints) of a subdivision vertex — the exact inverse of
 * midpoint creation. Returns null for level-0 (seed) vertices.
 *
 * In units of sL = 2^(G-L): p=a/sL, q=b/sL.
 *   p odd, q even -> horizontal edge midpoint
 *   p even, q odd -> e2-direction edge midpoint
 *   p odd, q odd  -> anti-diagonal edge midpoint
 */
export function vertexParents(
  a: number,
  b: number
): [VertexKey, VertexKey] | null {
  const L = vertexLevel(a, b);
  if (L === 0) return null;
  const sL = FIX >> L;
  const p = a / sL;
  const q = b / sL;
  const pOdd = (p & 1) === 1;
  const qOdd = (q & 1) === 1;
  if (pOdd && !qOdd) return [vk(a - sL, b), vk(a + sL, b)];
  if (!pOdd && qOdd) return [vk(a, b - sL), vk(a, b + sL)];
  return [vk(a - sL, b + sL), vk(a + sL, b - sL)];
}

export function triKey(L: number, o: number, i: number, j: number): TriKey {
  return L + ":" + o + ":" + i + ":" + j;
}

export function parseTriKey(key: TriKey): {
  L: number;
  o: number;
  i: number;
  j: number;
} {
  const parts = key.split(":");
  return {
    L: +parts[0],
    o: +parts[1],
    i: +parts[2],
    j: +parts[3],
  };
}

/** Fixed-point corner coords [A, B, C] of a triangle. */
export function triCorners(
  L: number,
  o: number,
  i: number,
  j: number
): [[number, number], [number, number], [number, number]] {
  const st = FIX >> L;
  if (o === 1) {
    return [
      [i * st, j * st],
      [(i + 1) * st, j * st],
      [i * st, (j + 1) * st],
    ];
  }
  return [
    [(i + 1) * st, j * st],
    [i * st, (j + 1) * st],
    [(i + 1) * st, (j + 1) * st],
  ];
}

export function edgeKey(v1: VertexKey, v2k: VertexKey): string {
  return v1 < v2k ? v1 + "|" + v2k : v2k + "|" + v1;
}

/**
 * The 4 children of a triangle under 1-to-4 midpoint subdivision.
 * Note the middle child flips chirality (up -> down and vice versa).
 * Formulas verified against corner arithmetic (see scripts/test-lattice.ts).
 */
export function triChildren(
  L: number,
  o: number,
  i: number,
  j: number
): TriKey[] {
  const c = L + 1;
  if (o === 1) {
    return [
      triKey(c, 1, 2 * i, 2 * j),
      triKey(c, 1, 2 * i + 1, 2 * j),
      triKey(c, 1, 2 * i, 2 * j + 1),
      triKey(c, 0, 2 * i, 2 * j),
    ];
  }
  return [
    triKey(c, 0, 2 * i + 1, 2 * j),
    triKey(c, 0, 2 * i, 2 * j + 1),
    triKey(c, 0, 2 * i + 1, 2 * j + 1),
    triKey(c, 1, 2 * i + 1, 2 * j + 1),
  ];
}

export interface Located {
  key: TriKey;
  L: number;
  o: number;
  i: number;
  j: number;
}

/**
 * Locate the root (level-0) triangle containing fractional lattice coords.
 * u+v < 1 -> up triangle, else down triangle of cell (i,j).
 */
export function rootTriangleAt(aF: number, bF: number): Located | null {
  const i = Math.floor(aF);
  const j = Math.floor(bF);
  if (i < 0 || j < 0) return null;
  const u = aF - i;
  const v = bF - j;
  const o = u + v < 1 ? 1 : 0;
  return { key: triKey(0, o, i, j), L: 0, o, i, j };
}

/**
 * Descend one subdivision step from a triangle to the child containing
 * (aF, bF) (fractional level-0 lattice coords). Returns null if the
 * point is not inside the given triangle (should not happen for a parent).
 */
export function descendChild(
  loc: Located,
  aF: number,
  bF: number
): Located | null {
  const s = Math.pow(2, loc.L); // level-0 units per parent-local unit
  if (loc.o === 1) {
    const u = aF * s - loc.i;
    const v = bF * s - loc.j;
    let c: [number, number, number];
    if (u + v < 0.5) c = [1, 2 * loc.i, 2 * loc.j];
    else if (u > 0.5) c = [1, 2 * loc.i + 1, 2 * loc.j];
    else if (v > 0.5) c = [1, 2 * loc.i, 2 * loc.j + 1];
    else c = [0, 2 * loc.i, 2 * loc.j];
    return { key: triKey(loc.L + 1, c[0], c[1], c[2]), L: loc.L + 1, o: c[0], i: c[1], j: c[2] };
  }
  // Down triangle: xi = (i+1) - a*s, eta = b*s - j, region xi <= eta.
  const xi = (loc.i + 1 - aF * s) * 2;
  const eta = (bF * s - loc.j) * 2;
  let c: [number, number, number];
  if (eta <= 1) c = [0, 2 * loc.i + 1, 2 * loc.j];
  else if (xi >= 1) c = [0, 2 * loc.i, 2 * loc.j + 1];
  else if (eta >= xi + 1) c = [0, 2 * loc.i + 1, 2 * loc.j + 1];
  else c = [1, 2 * loc.i + 1, 2 * loc.j + 1];
  return { key: triKey(loc.L + 1, c[0], c[1], c[2]), L: loc.L + 1, o: c[0], i: c[1], j: c[2] };
}

/** Inverse iso projection at z=0: iso coords -> world (x, y). */
export function isoToWorld(ix: number, iy: number): [number, number] {
  // ix = x - y ; iy = (x + y) / 2
  const x = ix * 0.5 + iy;
  const y = iy - ix * 0.5;
  return [x, y];
}

/** World (x, y) -> fractional lattice coords (aF, bF). */
export function worldToLattice(x: number, y: number): [number, number] {
  const bF = (y * 2) / Math.sqrt(3);
  const aF = x - bF * 0.5;
  return [aF, bF];
}
