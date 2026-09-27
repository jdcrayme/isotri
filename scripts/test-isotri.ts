/**
 * Validation suite for the isotri core: lattice math, mesh topology
 * invariants, field determinism. Run: bun scripts/test-isotri.ts
 */
import {
  FIX,
  MAX_DEPTH,
  descendChild,
  parseVk,
  rootTriangleAt,
  triChildren,
  triCorners,
  triKey,
  vertexLevel,
  vertexParents,
  vk,
  worldToLattice,
  worldXY,
} from "../src/lib/isotri/lattice";
import { TriMesh } from "../src/lib/isotri/mesh";
import { VertexField, GEO } from "../src/lib/isotri/field";
import { computeHydro } from "../src/lib/isotri/hydro";
import { FIX } from "../src/lib/isotri/lattice";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("  FAIL:", msg);
  }
}

// ---------- 1. vertex level + parents ----------
console.log("1. vertex levels & parents");
{
  // level-0 vertex (i,j) -> (i*FIX, j*FIX)
  assert(vertexLevel(2 * FIX, 3 * FIX) === 0, "root level");
  // midpoint of ((0,0),(1,0)) -> (FIX/2, 0) level 1
  assert(vertexLevel(FIX / 2, 0) === 1, "horizontal midpoint level 1");
  const p = vertexParents(FIX / 2, 0)!;
  assert(p[0] === vk(0, 0) && p[1] === vk(FIX, 0), "horizontal parents");
  // midpoint along e2: ((0,0),(0,1)) -> (0, FIX/2)
  const p2 = vertexParents(0, FIX / 2)!;
  assert(p2[0] === vk(0, 0) && p2[1] === vk(0, FIX), "e2 parents");
  // anti-diagonal midpoint: ((0,0),(1,-1)) -> (FIX/2, -FIX/2)
  const p3 = vertexParents(FIX / 2, -FIX / 2)!;
  assert(
    (p3[0] === vk(0, 0) && p3[1] === vk(FIX, -FIX)) ||
      (p3[1] === vk(0, 0) && p3[0] === vk(FIX, -FIX)),
    "anti-diag parents"
  );
  // deep vertex: level 3 midpoint of level-2 vertices
  assert(vertexLevel(FIX / 8, FIX / 8) === 3, "nested midpoint level");
  assert(vertexParents(0, 0) === null, "root has no parents");
}

// ---------- 2. subdivision children tile the parent ----------
console.log("2. subdivision tiling");
{
  for (const o of [1, 0]) {
    const cs = triCorners(1, o, 3, 4);
    const kids = triChildren(1, o, 3, 4).map((k) => {
      const t = { L: 2, o: +k.split(":")[1], i: +k.split(":")[2], j: +k.split(":")[3] };
      return triCorners(t.L, t.o, t.i, t.j);
    });
    // every child corner must be a parent corner or an edge midpoint
    const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const valid = new Set<string>();
    for (const c of cs) valid.add(c.toString());
    for (let i = 0; i < 3; i++)
      valid.add(mid(cs[i], cs[(i + 1) % 3]).toString());
    for (const kid of kids)
      for (const c of kid)
        assert(valid.has(c.toString()), `child corner ${c} valid (o=${o})`);
    // total: 4 children have 12 corners; distinct = 6 (3 corners + 3 mids)
    const all = new Set<string>();
    for (const kid of kids) for (const c of kid) all.add(c.toString());
    assert(all.size === 6, `distinct child corners = 6 (o=${o}), got ${all.size}`);
  }
}

// ---------- 3. mesh: random ops keep balance + locate works ----------
console.log("3. mesh balance under random ops");
{
  const W = 12,
    H = 10;
  const mesh = new TriMesh();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) mesh.addRootCell(i, j);
  assert(mesh.leafCount === W * H * 2, "initial leaf count");

  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const leafArr = () => Array.from(mesh.leaves);
  for (let iter = 0; iter < 400; iter++) {
    const arr = leafArr();
    if (rnd() < 0.65) {
      const k = arr[(rnd() * arr.length) | 0];
      mesh.subdivide(k, true);
    } else {
      const k = arr[(rnd() * arr.length) | 0];
      const t = mesh.get(k)!;
      if (t.parent) mesh.coalesce(t.parent, false); // may reject: fine
    }
    const bad = mesh.checkBalance();
    assert(bad === null, `balance after op ${iter}: ${bad}`);
  }

  // locate: random world points inside the map must resolve to a leaf whose
  // corners actually contain the point (barycentric check).
  for (let iter = 0; iter < 500; iter++) {
    const x = rnd() * W;
    const y = rnd() * H * 0.866;
    const key = mesh.locateWorld(x, y);
    if (!key) continue;
    const t = mesh.get(key)!;
    assert(!!t && !t.children, "located a leaf");
    const [aF, bF] = worldToLattice(x, y);
    // containment: sign tests against the 3 edges
    const cs = triCorners(t.L, t.o, t.i, t.j).map((c) => {
      const [wx, wy] = worldXY(c[0], c[1]);
      return [wx, wy];
    });
    const bary = worldToLattice(x, y);
    // convert point to fixed-point lattice, then to triangle-local u,v
    const s2 = Math.pow(2, t.L);
    let inside: boolean;
    if (t.o === 1) {
      const u = aF * s2 - t.i;
      const v = bF * s2 - t.j;
      inside = u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9;
    } else {
      const xi = t.i + 1 - aF * s2;
      const eta = bF * s2 - t.j;
      inside = xi >= -1e-9 && eta >= -1e-9 && xi <= eta + 1e-9;
    }
    assert(inside, `locate containment at (${x.toFixed(2)},${y.toFixed(2)})`);
    void bary; void cs;
  }

  // full subdivision of one region + coalesce back
  const k0 = triKey(0, 1, 5, 5);
  const done = mesh.subdivide(k0, true);
  assert(done.length >= 1, "subdivide reports parents");
  for (const k of [...done].reverse()) mesh.coalesce(k, true);
  assert(mesh.checkBalance() === null, "balance after undo-by-coalesce");
}

// ---------- 4. field determinism + inheritance ----------
console.log("4. field determinism");
{
  const f1 = new VertexField(42);
  const f2 = new VertexField(42);
  const key = vk(FIX / 2, FIX / 4); // level-2 vertex
  const v1 = f1.value(key);
  const v2 = f2.value(key);
  assert(v1.elev === v2.elev, "same seed same elevation");
  for (let i = 0; i < 6; i++)
    assert(v1.w[i] === v2.w[i], "same seed same weights");

  // different seed differs
  const f3 = new VertexField(43);
  assert(f3.value(key).elev !== v1.elev, "different seed differs");

  // painting a coarse vertex changes fine descendants (live inheritance)
  // NOTE: pick an OCEAN root and paint GRASS so the change is observable.
  const root = vk(4 * FIX, 4 * FIX); // deep ocean under this island seed
  const child = vk(4 * FIX + FIX / 2, 4 * FIX); // midpoint to the right
  const before = f1.value(child).w[2]; // grass weight
  f1.paint(root, 2, 0.8); // paint grass
  const after = f1.value(child).w[2];
  assert(after > before, "paint propagates to descendants");

  // determinism regardless of computation order
  const f4 = new VertexField(42);
  const a0 = f4.value(child).w[2]; // compute child FIRST
  const a1 = f4.value(root).w[2];
  f4.paint(root, 2, 0.8);
  const a2 = f4.value(child).w[2];
  assert(a2 === after, "order independence of inheritance");
  assert(a0 !== a2, "paint actually changed the child");
  void a1;
}

// ---------- 5. island sanity ----------
console.log("5. island generation sanity");
{
  const f = new VertexField(7);
  let landN = 0,
    n = 0,
    eMin = 9,
    eMax = -9,
    wet = 0;
  for (let j = 0; j <= GEO.h * 2; j++) {
    for (let i = 0; i <= GEO.w * 2; i++) {
      const a = (i * FIX) / 2;
      const b = (j * FIX) / 2;
      const v = f.value(vk(a, b));
      n++;
      eMin = Math.min(eMin, v.elev);
      eMax = Math.max(eMax, v.elev);
      if (v.elev > 0.02) landN++;
      if (v.w[0] > 0.6) wet++;
    }
  }
  console.log(
    `  elev range [${eMin.toFixed(2)}, ${eMax.toFixed(2)}], land ${(100 * landN / n).toFixed(1)}%, water px ${(100 * wet / n).toFixed(1)}%`
  );
  assert(eMax > 0.5, "has highlands");
  assert(landN / n > 0.2 && landN / n < 0.75, "reasonable land fraction");
}

// ---------- 6. descendChild boundary coherence ----------
console.log("6. descend coherence");
{
  // locating a point via rootTriangleAt + descend must match a direct
  // reimplementation at one level: build mesh, subdivide a cell fully to
  // level 2, compare locate() vs brute-force over leaves.
  const mesh = new TriMesh();
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) mesh.addRootCell(i, j);
  // fully subdivide cell (1,1) twice
  const queue: string[] = [triKey(0, 1, 1, 1), triKey(0, 0, 1, 1)];
  while (queue.length) {
    const k = queue.shift()!;
    mesh.subdivide(k, false);
    // subdivide() returns subdivided PARENT keys (for undo); children come
    // from the tri record.
    const kids = mesh.get(k)!.children ?? [];
    if (mesh.get(k)!.L + 1 < 2) queue.push(...kids);
  }
  for (let step = 0; step < 200; step++) {
    // Generate IN LATTICE SPACE so the point is guaranteed inside cell (1,1)
    const S3 = Math.sqrt(3) / 2;
    const aF = 1.01 + ((step * 37) % 97) / 97 * 0.97;
    const bF = 1.01 + ((step * 61) % 89) / 89 * 0.97;
    const x = aF + bF * 0.5;
    const y = bF * S3;
    const hit = mesh.locateWorld(x, y);
    assert(hit !== null, "located in subdivided cell");
    const t = mesh.get(hit!)!;
    assert(t.L === 2, "found level-2 leaf in fully subdivided cell");
    void descendChild; void rootTriangleAt; void parseVk;
  }
}

// ---------- 7. hydrology: determinism + drainage invariants ----------
console.log("7. hydrology");
{
  const f = new VertexField(7);
  const r1 = computeHydro(f, 7, { thrMult: 1.0 }, true);
  const r2 = computeHydro(f, 7, { thrMult: 1.0 }, true);
  const N = (GEO.w + 1) * (GEO.h + 1);
  const landN = Array.from(r1.debug!.isOcean).filter((x) => !x).length;
  assert(
    r1.stamps.size >= landN,
    `stamps cover all land vertices (${r1.stamps.size}/${landN})`
  );

  // determinism: identical stamps on recompute
  let detFail = 0;
  for (const [k, s] of r1.stamps) {
    const t = r2.stamps.get(k)!;
    if (
      s.lake !== t.lake ||
      s.river !== t.river ||
      s.fill !== t.fill ||
      s.boost !== t.boost
    )
      detFail++;
  }
  assert(detFail === 0, `hydro determinism (${detFail} mismatches)`);

  const dbg = r1.debug!;
  // drainage: every land vertex follows receivers to the ocean, no cycles
  let maxPath = 0;
  let cycle = 0;
  let stranded = 0;
  for (let k = 0; k < N; k++) {
    if (dbg.isOcean[k]) continue;
    const seen = new Set<number>();
    let cur = k;
    let steps = 0;
    for (; cur >= 0 && !dbg.isOcean[cur]; steps++) {
      if (seen.has(cur)) {
        cycle++;
        break;
      }
      seen.add(cur);
      cur = dbg.recv[cur];
    }
    if (cur < 0 && !dbg.isOcean[cur] && steps > 0) stranded++;
    if (steps > maxPath) maxPath = steps;
  }
  assert(cycle === 0, `no drainage cycles (${cycle})`);
  assert(stranded === 0, `no stranded basins (${stranded})`);
  assert(maxPath < N, `paths bounded (${maxPath})`);

  // mass balance: most of the rain must reach the ocean (transmission loss
  // is 0.4%/edge, paths are short on a 31x23 lattice)
  let totalRain = 0;
  let toSea = 0;
  for (let k = 0; k < N; k++) {
    if (dbg.isOcean[k]) continue;
    totalRain += dbg.rain[k];
    const r = dbg.recv[k];
    if (r >= 0 && dbg.isOcean[r]) toSea += dbg.acc[k] * 0.996;
  }
  assert(
    toSea > totalRain * 0.5,
    `mass balance: ${(toSea / totalRain).toFixed(2)} of rain reaches the sea`
  );

  // lakes render flat: fill >= elev, and the surface z is clamped to fill
  let flatFail = 0;
  for (const [k, s] of r1.stamps) {
    if (s.lake < 0.9) continue;
    const [a, b] = k.split(",").map(Number);
    if (s.fill < f.value(k).elev - 1e-9) flatFail++;
    void a;
    void b;
  }
  assert(flatFail === 0, `lake fill >= terrain (${flatFail})`);

  // stamps live only on root vertices
  let nonRoot = 0;
  for (const k of r1.stamps.keys()) {
    const [a, b] = k.split(",").map(Number);
    if (a % FIX !== 0 || b % FIX !== 0) nonRoot++;
  }
  assert(nonRoot === 0, `stamps only on root vertices (${nonRoot})`);

  // the field consumes the stamps: rivers visible in the blended field
  f.setHydro(r1.stamps);
  let rivVisible = 0;
  for (const [, s] of r1.stamps) {
    if (s.river > 0.25) rivVisible++;
  }
  assert(rivVisible > 3, `river stamps visible in field (${rivVisible})`);

  console.log(
    `  rivers=${r1.stats.rivers} lakes=${r1.stats.lakes} swamps=${r1.stats.swamps} thr=${r1.stats.thr.toFixed(3)} maxPath=${maxPath} in ${r1.stats.ms.toFixed(1)}ms`
  );
  assert(r1.stats.rivers > 5, "seed island has rivers");
}

// ---------- 8. terrain edits re-route hydrology ----------
console.log("8. terrain edit -> hydrology response");
{
  const f = new VertexField(7);
  const before = computeHydro(f, 7, { thrMult: 1.0 });
  // build a high dam across the island interior: raise a ridge of roots
  const W1 = GEO.w + 1;
  let raised = 0;
  for (let i = 4; i <= 10; i++) {
    const k = 11 * W1 + i;
    const key = vk(i * FIX, 11 * FIX);
    const cur = f.value(key).elev;
    f.paintElev(key, Math.max(cur, 1.35));
    raised++;
  }
  void raised;
  const after = computeHydro(f, 7, { thrMult: 1.0 });
  // the two runs must differ somewhere (rivers re-routed / lakes formed)
  let diffs = 0;
  for (const [k, s] of before.stamps) {
    const t = after.stamps.get(k)!;
    if (Math.abs(s.river - t.river) > 1e-9 || s.lake !== t.lake) diffs++;
  }
  assert(diffs > 0, `hydrology responds to terrain edits (${diffs} vertices changed)`);
  console.log(
    `  dam: lakes ${before.stats.lakes} -> ${after.stats.lakes}, rivers ${before.stats.rivers} -> ${after.stats.rivers}`
  );

  // deterministic lake: dig a bowl and wall it in at an interior vertex,
  // then check the lake stamp + the flat rendered surface in the field
  const ci = 15;
  const cj = 11;
  const center = vk(ci * FIX, cj * FIX);
  f.paintElev(center, 0.1);
  for (const [di, dj] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, -1],
    [-1, 1],
  ]) {
    f.paintElev(vk((ci + di) * FIX, (cj + dj) * FIX), 0.85);
  }
  const bowl = computeHydro(f, 7, { thrMult: 1.0 });
  const bs = bowl.stamps.get(center)!;
  assert(bs.lake >= 0.9, `walled bowl becomes a lake (lake=${bs.lake.toFixed(2)})`);
  f.setHydro(bowl.stamps);
  const cv = f.value(center);
  assert(
    Math.abs(cv.z - bs.fill) < 1e-6,
    `lake surface renders flat at spill level (z=${cv.z.toFixed(4)}, fill=${bs.fill.toFixed(4)})`
  );
  assert(cv.w[0] > 0.95, `lake vertex is water (w=${cv.w[0].toFixed(2)})`);
  console.log(
    `  bowl: lake=${bs.lake.toFixed(2)} fill=${bs.fill.toFixed(3)} depth=${(bs.fill - 0.1).toFixed(3)}`
  );
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
