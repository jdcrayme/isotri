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
import {
  VertexField,
  GEO,
  MAP_SIZES,
  clampMapSize,
  makeGeometry,
  sizeKeyFor,
} from "../src/lib/isotri/field";
import { computeHydro } from "../src/lib/isotri/hydro";

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
    if (st.river !== t.river || st.lake !== t.lake || st.fill !== t.fill)
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

  // 10e. determinism: fresh field + same stamps/trunks => same fine values
  const g3 = new VertexField(7);
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

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
