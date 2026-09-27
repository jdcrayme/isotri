/** ASCII preview of the seed island. Run: bun scripts/preview-island.ts */
import { vk, worldXY, FIX } from "../src/lib/isotri/lattice";
import { VertexField, GEO } from "../src/lib/isotri/field";

const seed = parseInt(process.argv[2] ?? "7", 10);
const f = new VertexField(seed);
const COLS = 78,
  ROWS = 30;

// world bounds
const x0 = 0,
  x1 = GEO.w + GEO.h * 0.5,
  y0 = 0,
  y1 = GEO.h * (Math.sqrt(3) / 2);

let out = "";
for (let r = 0; r < ROWS; r++) {
  const wy = y0 + ((y1 - y0) * (r + 0.5)) / ROWS;
  for (let c = 0; c < COLS; c++) {
    const wx = x0 + ((x1 - x0) * (c + 0.5)) / COLS;
    // invert to lattice
    const bF = (wy * 2) / Math.sqrt(3);
    const aF = wx - bF * 0.5;
    if (aF < 0 || bF < 0 || aF > GEO.w || bF > GEO.h) {
      out += " ";
      continue;
    }
    const v = f.value(vk(Math.round(aF * FIX), Math.round(bF * FIX)));
    if (v.w[0] > 0.6) out += "~"; // water
    else if (v.w[0] > 0.3) out += "."; // beach
    else if (v.w[5] > 0.4) out += "*"; // snow
    else if (v.w[4] > 0.4) out += "^"; // rock
    else if (v.w[3] > 0.4) out += "f"; // forest
    else if (v.w[2] > 0.4) out += "g"; // grass
    else out += "s"; // sand
  }
  out += "\n";
}
console.log(`seed ${seed}  center=(${GEO.cx.toFixed(1)},${GEO.cy.toFixed(1)}) r=${GEO.r}`);
console.log(out);
