/**
 * ASCII preview of the seeded island + hydrology, for headless tuning.
 * Run: bun scripts/preview-hydro.ts [seed] [thrMult]
 */
import { VertexField, GEO } from "../src/lib/isotri/field";
import { computeHydro } from "../src/lib/isotri/hydro";
import { FIX, vk } from "../src/lib/isotri/lattice";

const seed = parseInt(process.argv[2] ?? "7", 10) || 7;
const thrMult = parseFloat(process.argv[3] ?? "1") || 1;

const field = new VertexField(seed);
const { stamps, stats } = computeHydro(field, seed, { thrMult });
field.setHydro(stamps);

const W = GEO.w;
const H = GEO.h;
const ramp = " .:-=+*#@";

let out = "";
for (let j = 0; j <= H; j++) {
  out += " ".repeat(Math.round(j * 0.5));
  let line = "";
  for (let i = 0; i <= W; i++) {
    const key = vk(i * FIX, j * FIX);
    const s = stamps.get(key)!;
    const v = field.value(key);
    let ch: string;
    if (v.elev <= 0) ch = "~";
    else if (s.lake >= 0.9) ch = "O";
    else if (s.lake > 0.1) ch = "o";
    else if (s.river > 0.3) ch = "R";
    else {
      const t = Math.max(0, Math.min(0.999, v.elev / 2.0));
      ch = ramp[Math.floor(t * ramp.length)];
    }
    line += ch + " ";
  }
  out += line + "\n";
}
console.log(out);
console.log(
  `seed=${seed} thrMult=${thrMult} -> rivers=${stats.rivers} lakes=${stats.lakes} swamps=${stats.swamps} thr=${stats.thr.toFixed(3)} (${stats.ms.toFixed(1)}ms)`
);
