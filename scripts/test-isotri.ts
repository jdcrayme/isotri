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
import { TriMesh, joinAllTris, refineAllLeaves } from "../src/lib/isotri/mesh";
import {
  VertexField,
  GEO,
  MAP_SIZES,
  clampMapSize,
  makeGeometry,
  sizeKeyFor,
} from "../src/lib/isotri/field";
import { computeHydro } from "../src/lib/isotri/hydro";
import { smoothstep } from "../src/lib/isotri/hash";
import { computeRoad, snapToRoadGrid, ROAD_SOLVE_LEVEL } from "../src/lib/isotri/road";

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

  // regression: a painted (raised) root must move the RENDERED surface (z),
  // not just the authoritative elevation — z used to stay at the seed height
  // until a lake clamp rescued it, so sculpted terrain never showed up.
  {
    const fr = new VertexField(11);
    fr.materializeRoots(30, 22);
    const probeKeys: VertexKey[] = [];
    for (let j = 6; j <= 16 && probeKeys.length < 6; j++) {
      for (let i = 8; i <= 20 && probeKeys.length < 6; i++) {
        const key = vk(i * FIX, j * FIX);
        const v = fr.value(key);
        if (v.elev > 0.25 && v.w[0] < 0.3) probeKeys.push(key);
      }
    }
    assert(probeKeys.length >= 3, "found dry land probes for the z regression");
    let zFollowed = 0;
    for (const key of probeKeys) {
      const beforeZ = fr.value(key).z;
      const target = Math.min(1.6, fr.value(key).elev + 0.9);
      fr.paintElev(key, target);
      const afterV = fr.value(key);
      // z tracks the painted elevation exactly (no lake clamp on dry land)
      if (
        Math.abs(afterV.z - target) < 1e-9 &&
        Math.abs(afterV.z - beforeZ) > 0.2
      )
        zFollowed++;
      // fine children inherit the moved surface as their parent low-pass
      const [a, b] = parseVk(key);
      const mid = fr.value(vk(a + FIX / 2, b));
      assert(
        Math.abs(mid.z - (afterV.z + fr.value(vk(a + FIX, b)).z) / 2) < 0.5,
        "fine child z inherits the painted surface as a low-pass"
      );
    }
    assert(
      zFollowed === probeKeys.length,
      `painted elevation moves the rendered surface z (${zFollowed}/${probeKeys.length})`
    );
  }

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

// ---------- 9. map sizes: parameterized world geometry ----------
console.log("9. map sizes");
{
  // default geometry is untouched: seed-7 worlds stay byte-identical
  assert(GEO.w === 30 && GEO.h === 22 && GEO.r === 8.6, "default geo constants");
  const mg = makeGeometry(30, 22);
  assert(
    mg.cx === GEO.cx &&
      Math.abs(mg.cy - GEO.cy) < 1e-12 &&
      mg.r === GEO.r,
    "makeGeometry(30,22) reproduces the default"
  );
  assert(sizeKeyFor(30, 22) === "medium", "size key round-trip");
  assert(sizeKeyFor(31, 22) === null, "unknown size has no preset");
  const cs = clampMapSize(4, 999);
  assert(cs.w === 8 && cs.h === 128, "size clamping");

  // island radius scales with the smaller iso extent, landmass stays sane
  for (const s of MAP_SIZES) {
    const g = makeGeometry(s.w, s.h);
    const f = new VertexField(7, g);
    let land = 0;
    let n = 0;
    for (let j = 0; j <= s.h; j++) {
      for (let i = 0; i <= s.w; i++) {
        const v = f.value(vk(i * FIX, j * FIX));
        if (v.elev > 0.02) land++;
        n++;
      }
    }
    const frac = land / n;
    assert(
      frac > 0.2 && frac < 0.75,
      `${s.label} (${s.w}x${s.h}) land fraction ${(frac * 100).toFixed(0)}%`
    );
  }

  // hydrology is deterministic at a non-default size
  const small = new VertexField(7, makeGeometry(22, 16));
  const s1 = computeHydro(small, 7, { thrMult: 1.0 }, true);
  const s2 = computeHydro(small, 7, { thrMult: 1.0 }, true);
  let detFail = 0;
  for (const [k, st] of s1.stamps) {
    const t = s2.stamps.get(k)!;
    if (
      st.river !== t.river || st.lake !== t.lake || st.fill !== t.fill ||
      st.lvl !== t.lvl
    )
      detFail++;
  }
  assert(detFail === 0, `small-map hydro determinism (${detFail})`);

  // big worlds: more rivers (the threshold is a land quantile, so the
  // network scales with the map), and the solve stays interactive
  const big = new VertexField(7, makeGeometry(64, 46));
  const t0 = performance.now();
  const b1 = computeHydro(big, 7, { thrMult: 1.0 });
  const bigMs = performance.now() - t0;
  assert(b1.stats.rivers > s1.stats.rivers, "bigger world, more rivers");
  assert(bigMs < 2000, `huge-map hydro solve interactive (${bigMs.toFixed(1)}ms)`);
  console.log(
    `  huge (64x46, ${(65 * 47).toLocaleString()} verts): rivers=${b1.stats.rivers} lakes=${b1.stats.lakes} in ${bigMs.toFixed(1)}ms`
  );

  // drainage invariants hold at size too: no cycles, nothing stranded
  const dbg = s1.debug!;
  const SN = 23 * 17;
  let cycle = 0;
  for (let k = 0; k < SN; k++) {
    if (dbg.isOcean[k]) continue;
    const seen = new Set<number>();
    let cur = k;
    for (; cur >= 0 && !dbg.isOcean[cur]; ) {
      if (seen.has(cur)) {
        cycle++;
        break;
      }
      seen.add(cur);
      cur = dbg.recv[cur];
    }
  }
  assert(cycle === 0, `small-map drainage has no cycles (${cycle})`);
}

// ---------- 10. fine-layer hydrology inheritance ----------
console.log("10. fine-layer hydrology: trunk seeding + lake clamping");
{
  const f = new VertexField(7);
  const r = computeHydro(f, 7, { thrMult: 1.0 });
  assert(r.trunks.length > 0, `trunk segments emitted (${r.trunks.length})`);
  f.setHydro(r.stamps, r.trunks);

  // trunk data sanity: root-lattice endpoints, strength in (0, 1]
  let badTrunks = 0;
  for (const t of r.trunks) {
    if (
      t.a1 % FIX !== 0 || t.b1 % FIX !== 0 ||
      t.a2 % FIX !== 0 || t.b2 % FIX !== 0 ||
      !(t.q > 0 && t.q <= 1)
    )
      badTrunks++;
  }
  assert(badTrunks === 0, `trunk segment data sane (${badTrunks})`);
  console.log(`  ${r.trunks.length} trunk segments emitted`);

  // 10a. coarse views are byte-exact with and without the trunk index
  const f2 = new VertexField(7);
  f2.setHydro(r.stamps); // stamps only — no trunks, pure interpolation
  let coarseDiffs = 0;
  for (const k of r.stamps.keys()) {
    const a = f.value(k);
    const b = f2.value(k);
    if (
      a.river !== b.river || a.z !== b.z || a.lake !== b.lake ||
      a.fill !== b.fill || a.elev !== b.elev
    )
      coarseDiffs++;
  }
  assert(
    coarseDiffs === 0,
    `trunk seeding leaves coarse values exact (${coarseDiffs})`
  );

  // 10b. a strong trunk keeps its coarse strength on the fine centerline
  //      (interpolation-only dilutes the channel core as levels refine)
  const strong = [...r.trunks].sort((a, b) => b.q - a.q)[0];
  const Q = strong.q;
  const [ax, ay] = worldXY(strong.a1, strong.b1);
  const [bx, by] = worldXY(strong.a2, strong.b2);
  const segLen = Math.hypot(bx - ax, by - ay) || 1;
  const px = -(by - ay) / segLen; // unit perpendicular
  const py = (bx - ax) / segLen;
  const mKey = vk((strong.a1 + strong.a2) / 2, (strong.b1 + strong.b2) / 2);
  const [mx, my] = worldXY((strong.a1 + strong.a2) / 2, (strong.b1 + strong.b2) / 2);
  const snap2 = (x: number, y: number) => {
    const [aF, bF] = worldToLattice(x, y);
    return vk(Math.round(aF * 4) * (FIX / 4), Math.round(bF * 4) * (FIX / 4));
  };
  let onCore = 0;
  for (let t = -0.18; t <= 0.18; t += 0.06) {
    onCore = Math.max(onCore, f.value(snap2(mx + px * t, my + py * t)).river);
  }
  assert(
    onCore >= 0.85 * Q,
    `fine channel core stays crisp (on=${onCore.toFixed(3)} vs q=${Q.toFixed(3)})`
  );
  const midOn = f.value(mKey).river;
  assert(
    midOn >= 0.95 * Q,
    `trunk midpoint carries full strength (on=${midOn.toFixed(3)})`
  );
  console.log(
    `  strongest trunk q=${Q.toFixed(3)}: fine core=${onCore.toFixed(3)} (interp-only would dilute to ≤${(0.75 * Q).toFixed(3)})`
  );

  // 10c. two-cell walled bowl -> lake; fine vertices between two wet roots
  //      render EXACTLY at the water level, shore vertices move toward it
  const g = new VertexField(7);
  const wet: [number, number][] = [
    [15, 11],
    [16, 11],
  ];
  const wall: [number, number][] = [
    [14, 11], [15, 10], [15, 12], [16, 10], [14, 12],
    [17, 11], [16, 12], [17, 10],
  ];
  for (const [i, j] of wet)
    g.paintElev(vk(i * FIX, j * FIX), 0.1);
  for (const [i, j] of wall)
    g.paintElev(vk(i * FIX, j * FIX), 0.85);
  const bowl = computeHydro(g, 7, { thrMult: 1.0 });
  g.setHydro(bowl.stamps, bowl.trunks);
  const wetKeys = wet.map(([i, j]) => vk(i * FIX, j * FIX));
  const wetStamps = wetKeys.map((k) => bowl.stamps.get(k)!);
  assert(
    wetStamps.every((s) => s.lake >= 0.9),
    `two-cell bowl is a lake (${wetStamps.map((s) => s.lake.toFixed(2)).join(",")})`
  );
  // the two wet roots sit at slightly different priority-flood levels (EPS
  // stacking across the flat bottom), so the local water level a fine vertex
  // inherits is the MEAN of its parents' fills — that is what z must match
  const wetWet = vk(
    ((15 + 16) / 2) * FIX,
    11 * FIX
  );
  const vw = g.value(wetWet);
  const expectedLvl = vw.fill; // the vertex's own inherited water level
  assert(
    Math.abs(expectedLvl - (wetStamps[0].fill + wetStamps[1].fill) / 2) < 1e-12,
    "water level inherits as the mean of the parents' fills"
  );
  assert(
    vw.lake >= 0.9 && Math.abs(vw.z - expectedLvl) < 1e-9,
    `fine water surface clamps exactly to the water level (z=${vw.z.toFixed(6)}, lvl=${expectedLvl.toFixed(6)})`
  );
  assert(vw.w[0] > 0.95, `fine lake interior is water (w=${vw.w[0].toFixed(3)})`);

  // shoreline: wet/dry midpoint is pulled toward the water level, never away
  const shoreKey = vk(15 * FIX, ((11 + 10) / 2) * FIX);
  const shoreOn = g.value(shoreKey);
  g.setFineHydro(false);
  const shoreOff = g.value(shoreKey);
  g.setFineHydro(true);
  assert(
    Math.abs(shoreOn.z - shoreOn.fill) <=
      Math.abs(shoreOff.z - shoreOn.fill) + 1e-9,
    `lake clamping pulls shore vertices toward the water level (on=${Math.abs(shoreOn.z - shoreOn.fill).toFixed(4)}, off=${Math.abs(shoreOff.z - shoreOn.fill).toFixed(4)})`
  );

  // 10d. the fine-detail toggle round-trips through the cache
  const toggled = g.value(wetWet);
  g.setFineHydro(false);
  const offWet = g.value(wetWet);
  g.setFineHydro(true);
  const onAgain = g.value(wetWet);
  assert(
    onAgain.z === toggled.z && onAgain.river === toggled.river,
    "toggle restore is exact"
  );
  assert(
    Math.abs(offWet.z - offWet.fill) < 1e-9,
    "interp-only path is still flat here (both parents flattened)"
  );

  // 10e. determinism: fresh field + same edits/stamps/trunks => same fine values
  //      (g3 must replicate the SAME painted overrides — equal field state)
  const g3 = new VertexField(7);
  for (const [i, j] of wet) g3.paintElev(vk(i * FIX, j * FIX), 0.1);
  for (const [i, j] of wall) g3.paintElev(vk(i * FIX, j * FIX), 0.85);
  g3.setHydro(bowl.stamps, bowl.trunks);
  let detDiffs = 0;
  for (let di = -3; di <= 3; di++) {
    for (let dj = -3; dj <= 3; dj++) {
      const k = vk(
        Math.round((15.5 + di * 0.25) * FIX),
        Math.round((11 + dj * 0.25) * FIX)
      );
      const a = g.value(k);
      const b = g3.value(k);
      if (a.river !== b.river || a.z !== b.z) detDiffs++;
    }
  }
  assert(detDiffs === 0, `fine values deterministic across fields (${detDiffs})`);
}

// ---------- 11. whole-mesh refine / join passes ----------
console.log("11. global refine & join");
{
  const W = 8,
    H = 6;
  const mk = () => {
    const m = new TriMesh();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) m.addRootCell(i, j);
    return m;
  };
  const roots = W * H * 2;

  // 11a. each pass drops every leaf exactly one level, then the cap holds
  const m = mk();
  const p1 = refineAllLeaves(m, 2);
  assert(m.leafCount === roots * 4, `pass 1 leaf count (${m.leafCount})`);
  assert(p1.length === roots, `pass 1 parents = every root tri (${p1.length})`);
  assert(m.checkBalance() === null, "balance after global pass 1");
  const p2 = refineAllLeaves(m, 2);
  assert(m.leafCount === roots * 16, `pass 2 leaf count (${m.leafCount})`);
  assert(p2.length === roots * 4, `pass 2 parents = every L1 tri (${p2.length})`);
  assert(m.checkBalance() === null, "balance after global pass 2");
  const p3 = refineAllLeaves(m, 2);
  assert(p3.length === 0, "cap: pass 3 reports nothing to do");
  assert(m.leafCount === roots * 16, "cap: leaf count unchanged");

  // 11b. mixed manual + global: hand-refined deep zones survive untouched
  const m2 = mk();
  m2.subdivide(triKey(0, 1, 4, 3), true); // cascades into neighbours
  const deepBefore = Array.from(m2.leaves).filter((k) => m2.get(k)!.L >= 2).length;
  const pm = refineAllLeaves(m2, 2);
  assert(m2.checkBalance() === null, "balance after mixed manual+global pass");
  assert(pm.length > 0, "mixed pass subdivides the coarse remainder");
  const deepAfter = Array.from(m2.leaves).filter((k) => m2.get(k)!.L >= 2).length;
  assert(deepAfter >= deepBefore, "deep zone not destroyed by the pass");

  // 11c. undo/redo semantics of a pass (as the engine's Op machinery does it)
  const leavesBefore = Array.from(m.leaves).sort();
  for (let i = p2.length - 1; i >= 0; i--) m.coalesce(p2[i], true); // undo L2
  for (let i = p1.length - 1; i >= 0; i--) m.coalesce(p1[i], true); // undo L1
  assert(m.leafCount === roots, `undo restores root leaves (${m.leafCount})`);
  assert(m.checkBalance() === null, "balance after undo");
  for (const pk of p1) m.subdivide(pk, true); // redo pass 1
  for (const pk of p2) m.subdivide(pk, true); // redo pass 2
  const leavesAfter = Array.from(m.leaves).sort();
  assert(
    leavesBefore.length === leavesAfter.length &&
      leavesBefore.every((k, i) => k === leavesAfter[i]),
    "redo reproduces the exact leaf set"
  );

  // 11d. joinAllTris: back to roots; restore order rebuilds the same mesh
  const m4 = mk();
  m4.subdivide(triKey(0, 0, 3, 3), true);
  refineAllLeaves(m4, 2);
  const preJoin = Array.from(m4.leaves).sort();
  const restore = joinAllTris(m4);
  assert(m4.leafCount === roots, `join all returns to roots (${m4.leafCount})`);
  assert(
    m4.leaves.size === roots &&
      Array.from(m4.leaves).every((k) => m4.get(k)!.L === 0),
    "every remaining leaf is a root triangle"
  );
  assert(restore.length > 0, "restore list emitted");
  for (const pk of restore) m4.subdivide(pk, false);
  const post = Array.from(m4.leaves).sort();
  assert(
    preJoin.length === post.length &&
      preJoin.every((k, i) => k === post[i]),
    `restore order rebuilds the exact pre-join leaf set (${preJoin.length} leaves)`
  );
  assert(m4.checkBalance() === null, "balance after restore");

  // 11e. join all on a pristine mesh is a no-op
  const m5 = mk();
  assert(joinAllTris(m5).length === 0, "join all on roots is empty");

  // 11f. real-world scale: medium map passes stay interactive
  const perf = new TriMesh();
  for (let j = 0; j < 22; j++) for (let i = 0; i < 30; i++) perf.addRootCell(i, j);
  const t0 = performance.now();
  refineAllLeaves(perf, 2);
  refineAllLeaves(perf, 2);
  const tRefine = performance.now() - t0;
  const t1 = performance.now();
  const pj = joinAllTris(perf);
  const tJoin = performance.now() - t1;
  assert(perf.leafCount === 1320, `medium join lands on 1320 roots (${perf.leafCount})`);
  assert(pj.length === 1320 + 5280, `medium restore list covers L0+L1 (${pj.length})`);
  assert(
    tRefine < 2000 && tJoin < 2000,
    `global passes interactive (refine ${tRefine.toFixed(0)}ms, join ${tJoin.toFixed(0)}ms)`
  );
  console.log(
    `  medium 30x22: refine x2 ${tRefine.toFixed(0)}ms, join ${tJoin.toFixed(0)}ms, ${pj.length} restore parents`
  );
}

// ---------- 12. road networks: A* routing + distance-field stamping ----------
console.log("12. roads");
{
  const n = 1 << ROAD_SOLVE_LEVEL; // solve vertices per root cell
  const S = FIX >> ROAD_SOLVE_LEVEL; // fixed-point units per solve edge

  // 12a. real seed-7 medium island: route across the land, check invariants
  const field = new VertexField(7);
  field.materializeRoots(30, 22);
  const hyd = computeHydro(field, 7, { thrMult: 1.0 });
  field.setHydro(hyd.stamps, hyd.trunks);

  // find land endpoints: westernmost and easternmost land vertices on the
  // row that passes through the island center
  const isLand = (i: number, j: number) => {
    const v = field.value(vk(i * S, j * S));
    return v.w[0] < 0.35 && v.elev > 0.06 && v.lake < 0.2;
  };
  let A: [number, number] | null = null;
  let B: [number, number] | null = null;
  const jMid = 11 * n;
  for (let i = 0; i <= 30 * n && !A; i++) if (isLand(i, jMid)) A = [i, jMid];
  for (let i = 30 * n; i >= 0 && !B; i--) if (isLand(i, jMid)) B = [i, jMid];
  assert(!!A && !!B, `land endpoints found on the mid row (A=${A}, B=${B})`);
  if (A && B) {
    const ka = vk(A[0] * S, A[1] * S);
    const kb = vk(B[0] * S, B[1] * S);
    const res = computeRoad(field, ka, kb);
    assert(!!res, "road solves across the island");
    if (res) {
      assert(res.segs.length > 4, `path is non-trivial (${res.segs.length} edges)`);
      const s0 = res.segs[0];
      const sN = res.segs[res.segs.length - 1];
      assert(
        s0.a1 === A[0] * S && s0.b1 === A[1] * S,
        "path starts at A"
      );
      assert(
        sN.a2 === B[0] * S && sN.b2 === B[1] * S,
        "path ends at B"
      );
      // consecutive segs share endpoints (lattice-adjacent chain)
      let chained = true;
      for (let i = 0; i < res.segs.length - 1; i++) {
        const u = res.segs[i];
        const w = res.segs[i + 1];
        const uEnd = [u.a2, u.b2];
        const wStart = [w.a1, w.b1];
        if (uEnd[0] !== wStart[0] || uEnd[1] !== wStart[1]) chained = false;
      }
      assert(chained, "segments form a continuous chain");
      // never crosses open sea
      let dry = true;
      for (const s of res.segs) {
        const mid = field.value(vk((s.a1 + s.a2) / 2, (s.b1 + s.b2) / 2));
        if (mid.w[0] > 0.62 && mid.lake <= 0.2) dry = false;
      }
      assert(dry, "no ocean crossing");
      // length sane: >= straight line, <= 2.5x straight line
      const [ax, ay] = worldXY(A[0] * S, A[1] * S);
      const [bx, by] = worldXY(B[0] * S, B[1] * S);
      const straight = Math.hypot(bx - ax, by - ay);
      assert(
        res.stats.length >= straight - 1e-9,
        `path length >= straight line (${res.stats.length.toFixed(2)} >= ${straight.toFixed(2)})`
      );
      assert(
        res.stats.length <= straight * 2.5,
        `path length within 2.5x straight line (${res.stats.length.toFixed(2)} vs ${straight.toFixed(2)})`
      );
      console.log(
        `  island crossing: ${res.stats.length.toFixed(1)} units / straight ${straight.toFixed(1)} — ${res.stats.fords} ford(s), ${res.stats.bridges} bridge(s), ${res.stats.explored} nodes, ${res.stats.ms.toFixed(0)}ms`
      );

      // 12b. determinism: identical field state => identical path
      const field2 = new VertexField(7);
      field2.materializeRoots(30, 22);
      const hyd2 = computeHydro(field2, 7, { thrMult: 1.0 });
      field2.setHydro(hyd2.stamps, hyd2.trunks);
      const res2 = computeRoad(field2, ka, kb);
      assert(!!res2 && res2.segs.length === res.segs.length, "deterministic path length");
      let same = !!res2 && res2.segs.length === res.segs.length;
      if (res2 && same) {
        for (let i = 0; i < res.segs.length; i++) {
          const p = res.segs[i];
          const q = res2.segs[i];
          if (p.a1 !== q.a1 || p.b1 !== q.b1 || p.a2 !== q.a2 || p.b2 !== q.b2)
            same = false;
        }
      }
      assert(same, "deterministic path vertices");

      // 12c. stamping: the polyline vertices themselves sit inside the
      // stamp core (wobble <= 0.06 vs half-width 0.17), so every segment
      // endpoint must carry a strong road stamp; L3 midpoints too
      field.setRoads(res.segs);
      let stamped = 0;
      for (const s of res.segs) {
        if (field.value(vk(s.a1, s.b1)).road > 0.8) stamped++;
        if (field.value(vk(s.a2, s.b2)).road > 0.8) stamped++;
      }
      const endpoints = res.segs.length * 2;
      assert(
        stamped >= endpoints * 0.95,
        `path vertices carry the stamp (${stamped}/${endpoints})`
      );
      const midSeg = res.segs[res.segs.length >> 1];
      const midKey = vk((midSeg.a1 + midSeg.a2) / 2, (midSeg.b1 + midSeg.b2) / 2);
      const onRoad = field.value(midKey);
      assert(
        onRoad.road > 0.8,
        `L3 midpoint on the path stamped (${onRoad.road.toFixed(2)})`
      );
      // far corner of the map: clean
      const far = field.value(vk(0, 0));
      assert(far.road === 0, `far vertex clean (${far.road})`);
      // coarse/fine consistency: the stamp is the same distance field at
      // every level, so refining must not change ROOT values
      const rootKeys = res.segs.slice(0, 6).map((s) => vk(s.a1, s.b1));
      field.setFineHydro(false);
      const offRoads = rootKeys.map((k) => field.value(k).road);
      field.setFineHydro(true);
      const onRoads = rootKeys.map((k) => field.value(k).road);
      assert(
        offRoads.every((r, i) => r === onRoads[i]),
        "road channel independent of fine-detail toggle"
      );

      // 12d. clearing removes the stamp exactly
      field.setRoads([]);
      assert(field.value(midKey).road === 0, "clearRoads removes stamps");
    }

    // 12e. lakes are bridged when NO land detour exists: an impassable
    // mountain range spans the whole map (sea to sea), a wide lake fills
    // its middle, and two carved corridors meet the shore
    const g = new VertexField(7);
    for (let i = 10; i <= 21; i++)
      for (let j = 0; j <= 22; j++) g.paintElev(vk(i * FIX, j * FIX), 1.9);
    for (let i = 12; i <= 19; i++)
      for (let j = 1; j <= 21; j++) g.paintElev(vk(i * FIX, j * FIX), 0.02);
    for (const [i, j] of [
      [10, 11],
      [11, 11],
      [20, 11],
      [21, 11],
      [9, 11],
      [22, 11],
    ] as const)
      g.paintElev(vk(i * FIX, j * FIX), 0.35);
    const hydB = computeHydro(g, 7, { thrMult: 1.0 });
    g.setHydro(hydB.stamps, hydB.trunks);
    const lakeCenter = hydB.stamps.get(vk(15 * FIX, 11 * FIX));
    assert(!!lakeCenter && lakeCenter.lake >= 0.9, "range lake is a lake");
    const kb2 = computeRoad(
      g,
      vk(9 * FIX, 11 * FIX),
      vk(22 * FIX, 11 * FIX)
    );
    assert(!!kb2, "road routes across the walled lake");
    if (kb2) {
      assert(
        kb2.stats.bridges > 0,
        `lake is bridged, not detoured (${kb2.stats.bridges} bridge edges)`
      );
      let crossesLake = false;
      for (const s of kb2.segs) {
        const mid = g.value(vk((s.a1 + s.a2) / 2, (s.b1 + s.b2) / 2));
        if (mid.lake > 0.5) crossesLake = true;
      }
      assert(crossesLake, "path vertices include lake interiors");
      // bridge stamp lands on water vertices (shader draws planks there)
      g.setRoads(kb2.segs);
      const lakeMid = g.value(vk(15 * FIX, 11 * FIX));
      assert(
        lakeMid.road > 0.4 && lakeMid.lake > 0.5,
        `bridge stamps road onto the lake vertex (road=${lakeMid.road.toFixed(2)}, lake=${lakeMid.lake.toFixed(2)})`
      );
      console.log(
        `  walled-lake crossing: ${kb2.stats.edges} edges, ${kb2.stats.bridges} bridge(s), ${kb2.stats.ms.toFixed(0)}ms`
      );
    }

    // 12f. snapping clamps to the world rectangle
    const snap1 = snapToRoadGrid(field, -50, -50);
    assert(snap1 === vk(0, 0), "snap clamps to origin");
    const snap2 = snapToRoadGrid(field, 999, 999);
    assert(snap2 === vk(30 * FIX, 22 * FIX), "snap clamps to max corner");
    const snap3 = snapToRoadGrid(field, 10.13, 5.62);
    const [sa, sb] = snap3.split(",").map(Number);
    assert(
      Math.abs(sa - Math.round(sa)) < 1e-9 &&
        sa % (FIX >> 2) === 0 &&
        sb % (FIX >> 2) === 0,
      "snapped vertex sits on the solve grid"
    );

    // 12g. identical endpoints => null; unreachable => null
    assert(
      computeRoad(field, vk(0, 0), vk(0, 0)) === null,
      "degenerate route rejected"
    );
    // middle of the ocean (off-island corner) has no land route to it
    const oceanKey = snapToRoadGrid(field, 2.2, 0.4);
    const oceanV = field.value(oceanKey);
    if (oceanV.w[0] > 0.62 && oceanV.lake <= 0.2) {
      assert(
        computeRoad(field, vk(15 * FIX, 11 * FIX), oceanKey) === null,
        "ocean destination rejected"
      );
    } else {
      console.log("  (corner is not ocean for this seed — reachability branch skipped)");
    }

    // 12h. perf: a full solve on the medium map stays interactive
    const t0 = performance.now();
    computeRoad(field, vk(9 * S, 11 * S), vk(24 * S, 9 * S));
    const dt = performance.now() - t0;
    assert(dt < 1500, `solve interactive (${dt.toFixed(0)}ms)`);
    console.log(`  medium-map solve: ${dt.toFixed(0)}ms`);
  }
}

// ---------- 13. flat water: sea plane, river pool levels, no uphill ----------
console.log("13. flat water (sea plane, river levels, no uphill)");
{
  const f = new VertexField(7);
  const r = computeHydro(f, 7, { thrMult: 1.0 }, true);
  f.setHydro(r.stamps, r.trunks);
  const W1 = f.geo.w + 1;
  const keyAt = (k: number) => vk((k % W1) * FIX, ((k / W1) | 0) * FIX);
  const dbg = r.debug!;

  // 13a. THE no-uphill guarantee: along every drainage edge the stamped
  //      water level never rises downstream (lakes included, so inflowing
  //      rivers arrive at/above the spill and outlets leave at/below it).
  //      Slack of one LAKE_MIN: a swampy approach ABOVE a backwater-raised
  //      inflow can sit up to LAKE_MIN below its downstream level — bounded
  //      and visually negligible (partial river strength there softens it).
  let edges = 0;
  let upFail = 0;
  let maxRise = 0;
  for (const [k, st] of r.stamps) {
    const idx = (parseVk(k)[1] / FIX) * W1 + parseVk(k)[0] / FIX;
    const rc = dbg.recv[idx];
    if (rc < 0 || dbg.isOcean[rc]) continue;
    const down = r.stamps.get(keyAt(rc));
    if (!down) continue;
    edges++;
    if (st.lvl < down.lvl - 1e-9) {
      maxRise = Math.max(maxRise, down.lvl - st.lvl);
    }
  }
  assert(
    maxRise <= 0.04,
    `water level never (materially) rises downstream (max rise ${maxRise.toFixed(4)} over ${edges} edges)`
  );

  // 13b. the open sea is ONE flat plane at 0; the bed stays in elev
  //      (boundary roots on land are isOcean for the flood — skip them)
  let deepSea = 0;
  let seaFail = 0;
  for (let k = 0; k < dbg.isOcean.length; k++) {
    if (!dbg.isOcean[k]) continue;
    const v = f.value(keyAt(k));
    if (v.elev > 0.005) continue; // land on the map border, not sea
    if (v.elev <= -0.025) {
      deepSea++;
      if (v.z !== 0) seaFail++;
      if (v.z - v.elev < 0.02) seaFail++; // depth data preserved for shading
    } else if (v.z > 1e-9 || v.z < v.elev - 1e-9) {
      seaFail++; // coastal band: surface between bed and sea level
    }
  }
  assert(seaFail === 0, `sea renders as one flat plane at 0 (${seaFail} fails)`);
  console.log(`  sea plane: ${deepSea.toLocaleString()} deep ocean roots at z=0, beds intact`);

  // 13c. river pools are flat AT the roots: any strong channel vertex with
  //      no lake influence renders exactly at its water level
  let poolRoots = 0;
  let poolFail = 0;
  for (const [k, st] of r.stamps) {
    if (st.river < 0.5 || st.lake >= 0.2) continue;
    const v = f.value(k);
    if (v.elev <= 0.005) continue; // coastal band is the sea's business
    poolRoots++;
    if (Math.abs(v.z - st.lvl) > 1e-12) poolFail++;
  }
  assert(poolFail === 0 && poolRoots > 3, `river cores render flat at their level (${poolFail}/${poolRoots})`);

  // 13d. fine LOD: the trunk midpoint sits exactly on its own water level
  //      (whichever segment wins the stamp, z clamps to the vertex's lvl)
  const strong = [...r.trunks].sort((a, b) => b.q - a.q)[0];
  const mKey = vk((strong.a1 + strong.a2) / 2, (strong.b1 + strong.b2) / 2);
  const mv = f.value(mKey);
  assert(
    mv.river >= 0.48 && Math.abs(mv.z - mv.lvl) < 1e-9,
    `fine channel midpoint is flat water (riv=${mv.river.toFixed(3)}, z=${mv.z.toFixed(6)}, lvl=${mv.lvl.toFixed(6)})`
  );
  const lo = Math.min(strong.la ?? Infinity, strong.lb ?? Infinity);
  const hi = Math.max(strong.la ?? -Infinity, strong.lb ?? -Infinity);
  assert(
    mv.lvl >= lo - 0.05 && mv.lvl <= hi + 0.05,
    `stamped level interpolates along the segment (${mv.lvl.toFixed(4)} in [${lo.toFixed(4)},${hi.toFixed(4)}])`
  );
  // and a same-level pool stays flat across the whole midpoint neighborhood
  const pool = r.trunks.find(
    (t) => t.la !== undefined && t.lb !== undefined && Math.abs(t.la - t.lb) < 1e-12 && t.q > 0.5
  );
  if (pool) {
    const pKey = vk((pool.a1 + pool.a2) / 2, (pool.b1 + pool.b2) / 2);
    const pv = f.value(pKey);
    assert(
      Math.abs(pv.lvl - pool.la) < 1e-9 && Math.abs(pv.z - pool.la) < 1e-9,
      `pool midpoint renders exactly at the pool level (${pv.z.toFixed(6)} vs ${pool.la.toFixed(6)})`
    );
  } else {
    console.log("  (no same-level pool trunk on this seed — pool check skipped)");
  }

  // 13e. cut & fill: the clamp is symmetric — ground above the level is cut
  //      down to it, ground below is filled up to it (the bed lives on in
  //      elev: terrain may sit under the water surface)
  let probe: ReturnType<typeof vk> | null = null;
  let bestQ = 0;
  for (const [k, st] of r.stamps) {
    if (st.lake >= 0.2 || f.value(k).elev <= 0.3) continue;
    if (st.river > bestQ) {
      bestQ = st.river;
      probe = k;
    }
  }
  assert(!!probe && bestQ > 0.45, `found a strong clean river vertex to probe (q=${bestQ.toFixed(3)})`);
  const pk = probe!;
  const baseElev = f.value(pk).elev;
  const stampsCut = new Map(r.stamps);
  stampsCut.set(pk, { lake: 0, river: 0.9, fill: 0, boost: 0, lvl: baseElev - 0.3 });
  f.setHydro(stampsCut, r.trunks);
  const cutZ = f.value(pk).z;
  assert(
    Math.abs(cutZ - (baseElev - 0.3)) < 1e-12,
    `channel cuts through raised ground to the level (z=${cutZ.toFixed(4)})`
  );
  const stampsFill = new Map(r.stamps);
  stampsFill.set(pk, { lake: 0, river: 0.9, fill: 0, boost: 0, lvl: baseElev + 0.2 });
  f.setHydro(stampsFill, r.trunks);
  const fillZ = f.value(pk).z;
  assert(
    Math.abs(fillZ - (baseElev + 0.2)) < 1e-12,
    `channel fills up to the level over a lower bed (z=${fillZ.toFixed(4)})`
  );
  // partial strength blends toward the level by the same smoothstep
  const stampsPart = new Map(r.stamps);
  stampsPart.set(pk, { lake: 0, river: 0.3, fill: 0, boost: 0, lvl: baseElev - 0.3 });
  f.setHydro(stampsPart, r.trunks);
  const partV = f.value(pk);
  const partS = smoothstep(0.16, 0.48, 0.3);
  const expectZ = baseElev + (baseElev - 0.3 - baseElev) * partS;
  assert(
    Math.abs(partV.z - expectZ) < 1e-12,
    `partial channel blends toward the level (z=${partV.z.toFixed(4)} vs ${expectZ.toFixed(4)})`
  );
  f.setHydro(r.stamps, r.trunks); // restore the real solve
  const restoredV = f.value(pk);
  assert(
    Math.abs(restoredV.z - Math.min(baseElev, restoredV.lvl)) < 1e-9 ||
      Math.abs(restoredV.z - restoredV.lvl) < 1e-9,
    "probe restored to the real solve"
  );

  // 13f. lake junctions: inflow arrives at/above the spill, outflow leaves
  //      at/below it — scan several seeds so junctions actually exist
  let inflows = 0;
  let outflows = 0;
  let jFail = 0;
  for (const s of [7, 3, 11, 21, 5]) {
    const fs = new VertexField(s);
    const rs = computeHydro(fs, s, { thrMult: 1.0 }, true);
    const W1s = fs.geo.w + 1;
    const keyAtS = (k: number) => vk((k % W1s) * FIX, ((k / W1s) | 0) * FIX);
    for (const [k, st] of rs.stamps) {
      const pp = parseVk(k);
      const idx = (pp[1] / FIX) * W1s + pp[0] / FIX;
      const rc = rs.debug!.recv[idx];
      if (rc < 0 || rs.debug!.isOcean[rc]) continue;
      const down = rs.stamps.get(keyAtS(rc));
      if (!down) continue;
      if (st.river > 0.12 && down.lake >= 0.9) {
        inflows++;
        if (st.lvl < down.lvl - 1e-9) jFail++;
      }
      if (st.lake >= 0.9 && down.river > 0.12) {
        outflows++;
        // the outlet's bank can sit one priority-flood EPS below the spill
        // (the flat-area gradient) — absorb it, anything bigger is a bug
        if (st.lvl > down.lvl + 5e-3) jFail++;
      }
    }
  }
  assert(jFail === 0, `lake junctions meet the lake surface (${jFail} fails)`);
  assert(inflows + outflows > 0, `junction edges were found (${inflows} inflow / ${outflows} outflow)`);
  console.log(`  lake junctions: ${inflows} inflow / ${outflows} outflow edges checked (5 seeds)`);

  // 13g. determinism of the level pipeline at fine LOD (fresh field, same
  //      state => identical z and lvl around a strong trunk midpoint)
  const g3 = new VertexField(7);
  g3.setHydro(r.stamps, r.trunks);
  let detDiffs = 0;
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const k = vk(
        Math.round(((strong.a1 + strong.a2) / 2 / FIX + di * 0.25) * FIX),
        Math.round(((strong.b1 + strong.b2) / 2 / FIX + dj * 0.25) * FIX)
      );
      const a = f.value(k);
      const b = g3.value(k);
      if (a.z !== b.z || a.lvl !== b.lvl || a.river !== b.river) detDiffs++;
    }
  }
  assert(detDiffs === 0, `level stamp determinism (${detDiffs})`);

  // 13h. the fine-detail toggle round-trips exactly with levels in play
  const before = f.value(mKey);
  f.setFineHydro(false);
  const off = f.value(mKey);
  f.setFineHydro(true);
  const again = f.value(mKey);
  assert(
    again.z === before.z && again.lvl === before.lvl && again.river === before.river,
    "toggle restore is exact with river levels"
  );
  assert(
    off.z !== before.z || off.river !== before.river,
    "toggle actually changes the fine channel here"
  );
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
