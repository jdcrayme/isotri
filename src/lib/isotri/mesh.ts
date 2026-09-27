/**
 * TriMesh: adaptive triangular mesh with a restricted (balanced) hierarchy.
 *
 * Invariants maintained after every operation:
 *  - Adjacent leaf triangles differ by at most 1 level (no cracks by design).
 *  - Every leaf edge either:
 *      (a) exactly matches another leaf's edge   -> 'same'
 *      (b) is covered by two finer leaves' edges -> 'finer' (midpoint exists)
 *      (c) is half of a coarser leaf's edge      -> 'coarser'
 *      (d) borders nothing                       -> 'boundary'
 *
 * Neighbor resolution is exact (edge hash map), no geometric probes.
 */

import {
  descendChild,
  edgeKey,
  MAX_LEVEL,
  parseTriKey,
  parseVk,
  rootTriangleAt,
  triChildren,
  triCorners,
  triKey,
  vk,
  type TriKey,
  type VertexKey,
} from "./lattice";

export interface Tri {
  L: number;
  o: number;
  i: number;
  j: number;
  parent?: TriKey;
  children?: TriKey[];
}

export type EdgeRel = "same" | "finer" | "coarser" | "boundary";

export interface EdgeNeighbor {
  rel: EdgeRel;
  tri?: TriKey;
  /** For 'finer': the midpoint vertex key where the edge must be split. */
  mid?: VertexKey;
}

export class TriMesh {
  tris = new Map<TriKey, Tri>();
  leaves = new Set<TriKey>();
  /** leaf edge -> registrants (one or two leaf keys) */
  private edges = new Map<string, { a: TriKey; b?: TriKey }>();
  leafCount = 0;
  maxLevelSeen = 0;

  constructor() {}

  addRootCell(i: number, j: number): void {
    for (const o of [1, 0]) {
      const key = triKey(0, o, i, j);
      this.tris.set(key, { L: 0, o, i, j });
      this.leaves.add(key);
      this.registerTriEdges(key);
      this.leafCount++;
    }
  }

  get(key: TriKey): Tri | undefined {
    return this.tris.get(key);
  }

  private registerEdge(ek: string, tri: TriKey): void {
    const e = this.edges.get(ek);
    if (!e) this.edges.set(ek, { a: tri });
    else if (e.a !== tri && e.b !== tri) e.b = tri;
  }

  private unregisterEdge(ek: string, tri: TriKey): void {
    const e = this.edges.get(ek);
    if (!e) return;
    if (e.a === tri) {
      e.a = e.b as TriKey;
      e.b = undefined;
    } else if (e.b === tri) {
      e.b = undefined;
    }
    if (!e.a) this.edges.delete(ek);
  }

  private triEdgeKeys(key: TriKey): string[] {
    const t = this.tris.get(key)!;
    const cs = triCorners(t.L, t.o, t.i, t.j);
    const vs = cs.map((c) => vk(c[0], c[1]));
    return [
      edgeKey(vs[0], vs[1]),
      edgeKey(vs[1], vs[2]),
      edgeKey(vs[2], vs[0]),
    ];
  }

  private registerTriEdges(key: TriKey): void {
    for (const ek of this.triEdgeKeys(key)) this.registerEdge(ek, key);
  }

  private unregisterTriEdges(key: TriKey): void {
    for (const ek of this.triEdgeKeys(key)) this.unregisterEdge(ek, key);
  }

  private addChildren(parentKey: TriKey): TriKey[] {
    const t = this.tris.get(parentKey)!;
    if (t.children) return t.children;
    const childKeys = triChildren(t.L, t.o, t.i, t.j);
    t.children = childKeys;
    this.leaves.delete(parentKey);
    this.unregisterTriEdges(parentKey);
    this.leafCount--;
    for (const ck of childKeys) {
      const p = parseTriKey(ck);
      this.tris.set(ck, { L: p.L, o: p.o, i: p.i, j: p.j, parent: parentKey });
      this.leaves.add(ck);
      this.registerTriEdges(ck);
      this.leafCount++;
      if (p.L > this.maxLevelSeen) this.maxLevelSeen = p.L;
    }
    return childKeys;
  }

  /**
   * Resolve what lies across an edge of leaf `triKey`.
   * Edge endpoints are the fixed-point vertex keys of that edge.
   */
  resolveEdge(triKey_: TriKey, v1: VertexKey, v2: VertexKey): EdgeNeighbor {
    const ek = edgeKey(v1, v2);
    const reg = this.edges.get(ek);
    if (reg && reg.b && (reg.a === triKey_ || reg.b === triKey_)) {
      const other = reg.a === triKey_ ? reg.b : reg.a;
      return { rel: "same", tri: other };
    }
    // finer? edges (v1,mid) and (mid,v2) registered by other leaves
    const [a1, b1] = parseVk(v1);
    const [a2, b2] = parseVk(v2);
    const mid = vk((a1 + a2) / 2, (b1 + b2) / 2);
    const e1 = this.edges.get(edgeKey(v1, mid));
    if (e1 && e1.a !== triKey_) return { rel: "finer", mid };
    const e2 = this.edges.get(edgeKey(mid, v2));
    if (e2 && e2.a !== triKey_) return { rel: "finer", mid };
    // coarser? parent edges (v1-d, v2) and (v1, v2+d)
    const d = [a2 - a1, b2 - b1];
    const f1 = this.edges.get(edgeKey(vk(a1 - d[0], b1 - d[1]), v2));
    if (f1 && f1.a !== triKey_) return { rel: "coarser", tri: f1.b ?? f1.a };
    const f2 = this.edges.get(edgeKey(v1, vk(a2 + d[0], b2 + d[1])));
    if (f2 && f2.a !== triKey_) return { rel: "coarser", tri: f2.b ?? f2.a };
    return { rel: "boundary" };
  }

  private triVertexKeys(key: TriKey): VertexKey[] {
    const t = this.tris.get(key)!;
    return triCorners(t.L, t.o, t.i, t.j).map((c) => vk(c[0], c[1]));
  }

  /**
   * Subdivide a leaf into 4, cascading into coarser neighbors to restore
   * the balance invariant. Returns every parent key that was subdivided
   * (for undo), in order.
   */
  subdivide(triKey_: TriKey, cascade = true): TriKey[] {
    const t = this.tris.get(triKey_);
    if (!t || t.children) return [];
    if (t.L >= MAX_LEVEL) return [];
    const done: TriKey[] = [triKey_];
    this.addChildren(triKey_);
    if (cascade) {
      const vs = this.triVertexKeys(triKey_);
      const egs: [VertexKey, VertexKey][] = [
        [vs[0], vs[1]],
        [vs[1], vs[2]],
        [vs[2], vs[0]],
      ];
      for (const [v1, v2] of egs) {
        const nb = this.resolveEdge(triKey_, v1, v2);
        if (nb.rel === "coarser" && nb.tri) {
          done.push(...this.subdivide(nb.tri, true));
        }
      }
    }
    return done;
  }

  /**
   * Merge the 4 leaf children of `parentKey` back into it.
   * Rejects if any external neighbor is finer than the children (would
   * create a level gap of 2), or if children are not all leaves.
   */
  coalesce(parentKey: TriKey, force = false): boolean {
    const p = this.tris.get(parentKey);
    if (!p || !p.children) return false;
    const childKeys = p.children;
    for (const ck of childKeys) {
      const c = this.tris.get(ck);
      if (!c || c.children) return false; // need all four as leaves
    }
    if (!force) {
      for (const ck of childKeys) {
        const vs = this.triVertexKeys(ck);
        const egs: [VertexKey, VertexKey][] = [
          [vs[0], vs[1]],
          [vs[1], vs[2]],
          [vs[2], vs[0]],
        ];
        for (const [v1, v2] of egs) {
          const nb = this.resolveEdge(ck, v1, v2);
          if (nb.rel === "same" && nb.tri) {
            const other = this.tris.get(nb.tri);
            if (other && other.parent === parentKey) continue; // sibling
            // exact-edge match => same level as the child => diff 1 after
            // merge: always fine.
          } else if (nb.rel === "finer") {
            return false; // finer external neighbor would end up 2 levels off
          }
        }
      }
    }
    for (const ck of childKeys) {
      this.unregisterTriEdges(ck);
      this.tris.delete(ck);
      this.leaves.delete(ck);
      this.leafCount--;
    }
    p.children = undefined;
    this.leaves.add(parentKey);
    this.registerTriEdges(parentKey);
    this.leafCount++;
    return true;
  }

  /** Global sanity check of the balance invariant (used by tests). */
  checkBalance(): string | null {
    for (const key of this.leaves) {
      const t = this.tris.get(key)!;
      const vs = this.triVertexKeys(key);
      const egs: [VertexKey, VertexKey][] = [
        [vs[0], vs[1]],
        [vs[1], vs[2]],
        [vs[2], vs[0]],
      ];
      for (const [v1, v2] of egs) {
        const nb = this.resolveEdge(key, v1, v2);
        if (nb.rel === "coarser" && nb.tri) {
          const other = this.tris.get(nb.tri)!;
          if (t.L - other.L >= 2)
            return `gap ${t.L} vs ${other.L} at ${key}`;
        }
      }
    }
    return null;
  }

  /** Point location by tree descent. Returns leaf key or null if outside. */
  locate(aF: number, bF: number): TriKey | null {
    const root = rootTriangleAt(aF, bF);
    if (!root) return null;
    let cur = root;
    for (;;) {
      const t = this.tris.get(cur.key);
      if (!t) return null;
      if (!t.children) return cur.key;
      const child = descendChild(cur, aF, bF);
      if (!child) return null;
      cur = child;
    }
  }

  /** Convenience: locate from world coords. */
  locateWorld(x: number, y: number): TriKey | null {
    const bF = (y * 2) / Math.sqrt(3);
    const aF = x - bF * 0.5;
    return this.locate(aF, bF);
  }
}
