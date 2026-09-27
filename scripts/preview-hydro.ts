/**
 * ASCII preview of the seeded island + hydrology, for headless tuning.
 * Run: bun scripts/preview-hydro.ts [seed] [thrMult] [fine] [level]
 *
 * With fine=1, prints a zoomed window around the strongest trunk segment
 * at both coarse and fine resolution, so trunk seeding (crisp, meandering
 * channels) and lake-level clamping (flat water) can be checked headlessly.
 */
import { VertexField, GEO } from "../src/lib/isotri/field";
import { computeHydro } from "../src/lib/isotri/hydro";
import {
  FIX,
  vk,
  worldToLattice,
} from "../src/lib/isotri/lattice";

const seed = parseInt(process.argv[2] ?? "7", 10) || 7;
const thrMult = parseFloat(process.argv[3] ?? "1") || 1;
const fine = process.argv[4] === "1";
const fineLevel = Math.min(
  4,
  Math.max(1, parseInt(process.argv[5] ?? "2", 10) || 2)
);

const field = new VertexField(seed);
const { stamps, trunks, stats } = computeHydro(field, seed, { thrMult });
field.setHydro(stamps, trunks);

const ramp = " .:-=+*#@";
const charFor = (v: {
  elev: number;
  z: number;
  river: number;
  lake: number;
}) => {
  if (v.elev <= 0 && v.lake < 0.5) return "~";
  if (v.lake >= 0.9) return "O";
  if (v.lake > 0.1) return "o";
  if (v.river > 0.3) return "R";
  if (v.river > 0.12) return "r";
  const t = Math.max(0, Math.min(0.999, v.elev / 2.0));
  return ramp[Math.floor(t * ramp.length)];
};

// ---- whole-map coarse view ----
const W = GEO.w;
const H = GEO.h;
let out = "";
for (let j = 0; j <= H; j++) {
  out += " ".repeat(Math.round(j * 0.5));
  let line = "";
  for (let i = 0; i <= W; i++) {
    line += charFor(field.value(vk(i * FIX, j * FIX))) + " ";
  }
  out += line + "\n";
}
console.log(out);
console.log(
  `seed=${seed} thrMult=${thrMult} -> rivers=${stats.rivers} lakes=${stats.lakes} swamps=${stats.swamps} trunks=${stats.trunks} thr=${stats.thr.toFixed(3)} (${stats.ms.toFixed(1)}ms)`
);

// ---- zoomed fine window around the strongest trunk ----
if (fine) {
  if (trunks.length === 0) {
    console.log("no trunks to zoom on");
    process.exit(0);
  }
  const strong = [...trunks].sort((a, b) => b.q - a.q)[0];
  const [aF0, bF0] = worldToLattice(
    (strong.a1 + strong.a2) / 2 / FIX,
    (strong.b1 + strong.b2) / 2 / FIX
  );
  const ci = Math.round(aF0);
  const cj = Math.round(bF0);
  const half = 4; // window: 8x8 root cells

  const drawWindow = (lv: number, label: string) => {
    const st = FIX >> lv;
    // horizontal sampling doubled: iso projection squashes x by ~1/2
    const cols = (half * 2 * FIX) / (st >> 1) + 1;
    const rows = (half * 2 * FIX) / st + 1;
    let s = `${label}:\n`;
    for (let j = 0; j < rows; j++) {
      s += "  ";
      const b = (cj - half) * FIX + j * st;
      for (let i = 0; i < cols; i++) {
        const a = (ci - half) * FIX + (i * st) / 2;
        s += charFor(field.value(vk(a, b)));
      }
      s += "\n";
    }
    return s;
  };

  console.log(drawWindow(0, `coarse (level 0), q_max=${strong.q.toFixed(3)}`));
  console.log(drawWindow(fineLevel, `fine (level ${fineLevel})`));
  console.log("R/r = channel core/bank, O = lake, o = wetland, ~ = sea");
}
