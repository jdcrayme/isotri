/**
 * IsoTriEngine: glues lattice + field + mesh + hydrology to a WebGL2 canvas
 * and implements the editor interaction model.
 *
 * Render data is rebuilt from the leaf set after any edit (cheap at
 * prototype scale); pan/zoom are uniform-only. T-junction interfaces are
 * stitched from the fine side: a coarse leaf whose edge is covered by two
 * finer leaves splits that edge at the midpoint (LOD contract rule 3).
 *
 * Hydrology (phase 2) runs on the level-0 lattice and is STAMPED into the
 * vertex field; it re-runs (debounced) whenever terrain is painted, so
 * rivers re-route live while you sculpt. The authoritative document is
 * {seed, partial overrides, subdivision structure} — auto-saved to
 * localStorage; hydrology, weights, meshes are all pure derivations.
 */

import {
  FIX,
  MAX_LEVEL,
  parseVk,
  triCorners,
  vk,
  worldXY,
  type TriKey,
  type VertexKey,
} from "./lattice";
import {
  GEO,
  VertexField,
  MATERIALS,
  K,
  type Override,
  type VV,
} from "./field";
import { TriMesh } from "./mesh";
import { computeHydro, type HydroStats } from "./hydro";
import { FRAG_SRC, VERT_SRC } from "./shaders";

export type Tool =
  | "paint"
  | "raise"
  | "lower"
  | "subdivide"
  | "coalesce"
  | "pan";

export interface Stats {
  leaves: number;
  vertices: number;
  maxLevel: number;
  rivers: number;
  lakes: number;
  swamps: number;
  hydroMs: number;
}

export interface HoverCorner {
  key: VertexKey;
  w: number[];
  elev: number;
  z: number;
  river: number;
  lake: number;
  dominant: number;
}

export interface HoverInfo {
  triKey: TriKey;
  level: number;
  world: [number, number];
  corners: HoverCorner[];
}

interface PaintChange {
  key: VertexKey;
  prev: Override | null;
  next: Override | null;
}

type Op =
  | { kind: "paint"; changes: PaintChange[] }
  | { kind: "subdivide"; parents: TriKey[] }
  | { kind: "coalesce"; parent: TriKey };

export interface EngineCallbacks {
  onStats?: (s: Stats) => void;
  onHover?: (h: HoverInfo | null) => void;
  onToast?: (msg: string) => void;
}

interface RenderMesh {
  vertexCount: number;
  triCount: number;
  lineCount: number;
}

const STRIDE = 12; // x, y, elev, z | w0..w3 | w4, w5, moist, river
const ELEV_SCALE = 0.6;
const SAVE_KEY = "isotri.doc.v2";
const ELEV_MIN = -0.55;
const ELEV_MAX = 2.1;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile error: " + log);
  }
  return sh;
}

export class IsoTriEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private cb: EngineCallbacks;
  private container: HTMLElement;

  mesh = new TriMesh();
  field: VertexField;
  seed = 7;

  tool: Tool = "paint";
  material = 2; // grass
  brushSize = 1.4;
  showWireframe = false;
  showVertices = false;
  showRivers = true;
  thrMult = 1.0;

  private zoom = 20;
  private panX = 0;
  private panY = 0;
  private dpr = 1;
  private lastW = 0;
  private lastH = 0;
  private userCamera = false;

  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private triIbo: WebGLBuffer;
  private lineIbo: WebGLBuffer;
  private pointVao: WebGLVertexArrayObject;
  private pointVbo: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};

  private r: RenderMesh | null = null;
  private pointData: Float32Array | null = null;
  private dirty = true;
  private raf = 0;
  private destroyed = false;

  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  private lastHydro: HydroStats | null = null;
  private hydroTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // input state
  private painting = false;
  private paintKind: "mat" | "elev" = "mat";
  private elevDir = 1;
  private panning = false;
  private panLast: [number, number] = [0, 0];
  private strokeChanges = new Map<VertexKey, PaintChange>();
  private lastBrushPos: [number, number] | null = null;
  private hoverPending = false;
  private lastMouse: [number, number] = [0, 0];

  constructor(container: HTMLElement, cb: EngineCallbacks = {}) {
    this.container = container;
    this.cb = cb;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block h-full w-full touch-none";
    container.appendChild(canvas);
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    for (const name of [
      "uResolution",
      "uZoom",
      "uPan",
      "uES",
      "uTime",
      "uMode",
      "uFlatColor",
      "uPointSize",
      "uRiverOn",
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.triIbo = gl.createBuffer()!;
    this.lineIbo = gl.createBuffer()!;
    this.pointVao = gl.createVertexArray()!;
    this.pointVbo = gl.createBuffer()!;

    // static VAO setup: attrib 0 = pos(vec4), 1 = mats(vec4), 2 = extras(vec4)
    const setupVao = (vao: WebGLVertexArrayObject, vbo: WebGLBuffer) => {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const s = STRIDE * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, s, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, s, 16);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, s, 32);
      gl.bindVertexArray(null);
    };
    setupVao(this.vao, this.vbo);
    setupVao(this.pointVao, this.pointVbo);

    if (!this.tryLoad()) {
      this.resetWorld(this.seed);
    }
    this.attachInput();
  }

  // ---------------- world setup ----------------

  resetWorld(seed: number): void {
    this.seed = seed | 0;
    this.mesh = new TriMesh();
    for (let j = 0; j < GEO.h; j++)
      for (let i = 0; i < GEO.w; i++) this.mesh.addRootCell(i, j);
    this.field = new VertexField(this.seed);
    this.field.materializeRoots(GEO.w, GEO.h);
    this.undoStack = [];
    this.redoStack = [];
    this.runHydro();
    this.dirty = true;
    this.fitCamera();
    this.emitStats();
    this.scheduleSave();
  }

  // ---------------- hydrology ----------------

  /** Full recompute on the root lattice + stamp into the field. */
  private runHydro(): void {
    const res = computeHydro(this.field, this.seed, { thrMult: this.thrMult });
    this.field.setHydro(res.stamps);
    this.lastHydro = res.stats;
    this.dirty = true;
  }

  /** Debounced recompute — terrain strokes fire this continuously. */
  private scheduleHydro(): void {
    if (this.hydroTimer) clearTimeout(this.hydroTimer);
    this.hydroTimer = setTimeout(() => {
      this.hydroTimer = null;
      if (this.destroyed) return;
      this.runHydro();
      this.emitStats();
    }, 240);
  }

  setThrMult(v: number): void {
    this.thrMult = Math.max(0.05, Math.min(6, v));
    this.runHydro();
    this.emitStats();
    this.scheduleSave();
  }

  // ---------------- persistence ----------------

  serialize(): string {
    const subdiv: { k: TriKey; L: number }[] = [];
    for (const [k, t] of this.mesh.tris)
      if (t.children) subdiv.push({ k, L: t.L });
    subdiv.sort((a, b) => a.L - b.L);
    const ov: [string, { e?: number; m?: number; w?: number[] }][] = [];
    for (const [key, o] of this.field.overrides) {
      ov.push([
        key,
        {
          e: o.elev,
          m: o.moist,
          w: o.w ? Array.from(o.w) : undefined,
        },
      ]);
    }
    return JSON.stringify({
      v: 1,
      seed: this.seed,
      thrMult: this.thrMult,
      ov,
      subdiv: subdiv.map((s) => s.k),
    });
  }

  private static parseDoc(json: string): {
    seed: number;
    thrMult: number;
    ov: [VertexKey, Override][];
    subdiv: TriKey[];
  } | null {
    try {
      const d = JSON.parse(json) as {
        v?: number;
        seed?: number;
        thrMult?: number;
        ov?: [string, { e?: number; m?: number; w?: number[] }][];
        subdiv?: string[];
      };
      if (!d || d.v !== 1 || typeof d.seed !== "number") return null;
      const ov: [VertexKey, Override][] = [];
      for (const [key, o] of d.ov ?? []) {
        if (!/^-?\d+,-?\d+$/.test(key)) return null;
        const entry: Override = {};
        if (typeof o.e === "number" && isFinite(o.e)) entry.elev = o.e;
        if (typeof o.m === "number" && isFinite(o.m))
          entry.moist = Math.max(0, Math.min(1, o.m));
        if (Array.isArray(o.w) && o.w.length === K && o.w.every((x) => typeof x === "number" && isFinite(x)))
          entry.w = new Float32Array(o.w);
        if (Object.keys(entry).length > 0) ov.push([key, entry]);
      }
      const subdiv: TriKey[] = [];
      for (const k of d.subdiv ?? []) {
        if (!/^\d+:[01]:-?\d+:-?\d+$/.test(k)) return null;
        const L = parseInt(k.split(":")[0], 10);
        // L=0 is valid: cascaded subdivision always lists subdivided roots
        if (L < 0 || L > MAX_LEVEL) return null;
        subdiv.push(k);
      }
      subdiv.sort(
        (a, b) => parseInt(a.split(":")[0], 10) - parseInt(b.split(":")[0], 10)
      );
      return {
        seed: Math.floor(d.seed),
        thrMult: typeof d.thrMult === "number" ? d.thrMult : 1,
        ov,
        subdiv,
      };
    } catch {
      return null;
    }
  }

  private tryLoad(): boolean {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const doc = IsoTriEngine.parseDoc(raw);
    if (!doc) return false;
    this.seed = doc.seed;
    this.thrMult = doc.thrMult;
    this.mesh = new TriMesh();
    for (let j = 0; j < GEO.h; j++)
      for (let i = 0; i < GEO.w; i++) this.mesh.addRootCell(i, j);
    this.field = new VertexField(this.seed);
    this.field.materializeRoots(GEO.w, GEO.h);
    for (const [key, o] of doc.ov) this.field.overrides.set(key, o);
    for (const k of doc.subdiv) {
      const t = this.mesh.get(k);
      if (t) this.mesh.subdivide(k, false);
    }
    this.materializeLeafCorners();
    this.field.clearCache();
    this.runHydro();
    this.dirty = true;
    this.fitCamera();
    this.emitStats();
    return true;
  }

  private materializeLeafCorners(): void {
    for (const key of this.mesh.leaves) {
      const t = this.mesh.get(key);
      if (!t) continue;
      for (const c of triCorners(t.L, t.o, t.i, t.j))
        this.field.ensure(c[0], c[1]);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.destroyed) return;
      try {
        localStorage.setItem(SAVE_KEY, this.serialize());
      } catch {
        // storage full/blocked — prototype ignores
      }
    }, 700);
  }

  reset(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // ignore
    }
    this.resetWorld(this.seed);
  }

  // ---------------- camera ----------------

  private fitCamera(): void {
    const [cw, ch] = this.cssSize();
    // iso extents of the map rectangle (z = 0) plus elevation headroom
    const ixMin = -(GEO.h * Math.sqrt(3) / 2 - 0) - 1;
    const ixMax = GEO.w + 1;
    const iyMin = -2.2; // headroom for peaks
    const iyMax = (GEO.w + GEO.h * 0.5) / 2 + 1;
    const spanX = ixMax - ixMin;
    const spanY = iyMax - iyMin;
    this.zoom = Math.min(cw / spanX, ch / spanY) * 0.97;
    const ciX = (ixMin + ixMax) / 2;
    const ciY = (iyMin + iyMax) / 2;
    this.panX = (cw / 2 - ciX * this.zoom) * this.dpr;
    this.panY = (ch / 2 - ciY * this.zoom) * this.dpr;
  }

  refit(): void {
    this.fitCamera();
    this.userCamera = false;
  }

  private cssSize(): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [Math.max(1, r.width), Math.max(1, r.height)];
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const [cw, ch] = this.cssSize();
    const w = Math.round(cw * this.dpr);
    const h = Math.round(ch * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ---------------- render data ----------------

  private buildRenderData(): void {
    const field = this.field;
    const verts: number[] = [];
    const tris: number[] = [];
    const lines: number[] = [];
    const leafList: { key: TriKey; depth: number }[] = [];
    for (const key of this.mesh.leaves) {
      const t = this.mesh.get(key)!;
      const cs = triCorners(t.L, t.o, t.i, t.j);
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const c of cs) {
        const [x, y] = worldXY(c[0], c[1]);
        sx += x;
        sy += y;
        sz += field.value(vk(c[0], c[1])).z;
      }
      leafList.push({ key, depth: sx + sy - sz * 1.1 });
    }
    leafList.sort((a, b) => a.depth - b.depth);

    for (const { key } of leafList) {
      const t = this.mesh.get(key)!;
      const corners = triCorners(t.L, t.o, t.i, t.j).map((c) => vk(c[0], c[1]));
      // resolve stitching per edge: (0,1), (1,2), (2,0)
      const mids: (VertexKey | null)[] = [null, null, null];
      for (let e = 0; e < 3; e++) {
        const nb = this.mesh.resolveEdge(key, corners[e], corners[(e + 1) % 3]);
        if (nb.rel === "finer" && nb.mid) mids[e] = nb.mid;
      }
      // polygon = c0, m01, c1, m12, c2, m20 (existing entries only)
      const poly: VertexKey[] = [corners[0]];
      if (mids[0]) poly.push(mids[0]);
      poly.push(corners[1]);
      if (mids[1]) poly.push(mids[1]);
      poly.push(corners[2]);
      if (mids[2]) poly.push(mids[2]);

      // One row per polygon vertex; the mesh and wireframe passes address
      // them through index buffers so no stray "dangling" vertex can ever
      // pair with a neighbour's data (the drawArrays bug).
      const polyBase = verts.length / STRIDE;
      for (const vkey of poly) {
        const [a, b] = parseVk(vkey);
        const [x, y] = worldXY(a, b);
        const v = field.value(vkey);
        verts.push(
          x, y, v.elev, v.z,
          v.w[0], v.w[1], v.w[2], v.w[3],
          v.w[4], v.w[5], v.moist, v.river
        );
      }
      // mesh: fan from polygon vertex 0
      for (let i = 1; i < poly.length - 1; i++) {
        tris.push(polyBase, polyBase + i, polyBase + i + 1);
      }
      // wireframe: polygon boundary segments
      for (let i = 0; i < poly.length; i++) {
        lines.push(polyBase + i, polyBase + ((i + 1) % poly.length));
      }
    }

    // upload (WebGL needs typed arrays)
    const vertData = new Float32Array(verts);
    const triData = new Uint32Array(tris);
    const lineData = new Uint32Array(lines);
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertData, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triData, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);

    this.r = {
      vertexCount: vertData.length / STRIDE,
      triCount: triData.length,
      lineCount: lineData.length,
    };
    const pts: number[] = [];
    for (const vkey of this.field.materialized) {
      const [a, b] = parseVk(vkey);
      const [x, y] = worldXY(a, b);
      const v = field.value(vkey);
      pts.push(
        x, y, v.elev, v.z,
        v.w[0], v.w[1], v.w[2], v.w[3],
        v.w[4], v.w[5], v.moist, v.river
      );
    }
    this.pointData = new Float32Array(pts);
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.pointData, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
  }

  // ---------------- loop ----------------

  start(): void {
    // debug/verification handle (harmless in production)
    (window as unknown as { __isotri?: IsoTriEngine }).__isotri = this;
    this.resize();
    const loop = (t: number) => {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(loop);
      this.resize();
      if (
        this.canvas.width !== this.lastW ||
        this.canvas.height !== this.lastH
      ) {
        const firstFrame = this.lastW === 0;
        this.lastW = this.canvas.width;
        this.lastH = this.canvas.height;
        // refit on layout changes unless the user has moved the camera
        if (firstFrame || !this.userCamera) this.fitCamera();
      }
      if (this.dirty) {
        this.buildRenderData();
        this.dirty = false;
      }
      this.draw(t / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private draw(time: number): void {
    const gl = this.gl;
    if (!this.r) {
      this.buildRenderData();
      this.dirty = false;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.06, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.u.uResolution!, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uZoom!, this.zoom * this.dpr);
    gl.uniform2f(this.u.uPan!, this.panX, this.panY);
    gl.uniform1f(this.u.uES!, ELEV_SCALE);
    gl.uniform1f(this.u.uTime!, time);
    gl.uniform1i(this.u.uMode!, 0);
    gl.uniform3f(this.u.uFlatColor!, 1, 1, 1);
    gl.uniform1f(
      this.u.uPointSize!,
      Math.max(2.5, Math.min(6, this.zoom * this.dpr * 0.05))
    );
    gl.uniform1f(this.u.uRiverOn!, this.showRivers ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIbo);
    gl.drawElements(gl.TRIANGLES, this.r!.triCount, gl.UNSIGNED_INT, 0);

    if (this.showWireframe && this.r!.lineCount > 0) {
      gl.uniform1i(this.u.uMode!, 2);
      gl.uniform3f(this.u.uFlatColor!, 0.06, 0.07, 0.09);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIbo);
      gl.drawElements(gl.LINES, this.r!.lineCount, gl.UNSIGNED_INT, 0);
    }

    if (this.showVertices && this.pointData && this.pointData.length > 0) {
      gl.uniform1i(this.u.uMode!, 1);
      gl.bindVertexArray(this.pointVao);
      gl.drawArrays(gl.POINTS, 0, this.pointData.length / STRIDE);
      gl.bindVertexArray(this.vao);
    }
  }

  // ---------------- coordinate transforms ----------------

  /** CSS px -> world (x, y) assuming z = 0. */
  private screenToWorld(cssX: number, cssY: number): [number, number] {
    const dx = cssX * this.dpr;
    const dy = cssY * this.dpr;
    const ix = (dx - this.panX) / (this.zoom * this.dpr);
    const iy = (dy - this.panY) / (this.zoom * this.dpr);
    const x = ix * 0.5 + iy;
    const y = iy - ix * 0.5;
    return [x, y];
  }

  // ---------------- tools ----------------

  private emitStats(): void {
    this.cb.onStats?.({
      leaves: this.mesh.leafCount,
      vertices: this.field.materialized.size,
      maxLevel: this.mesh.maxLevelSeen,
      rivers: this.lastHydro?.rivers ?? 0,
      lakes: this.lastHydro?.lakes ?? 0,
      swamps: this.lastHydro?.swamps ?? 0,
      hydroMs: this.lastHydro?.ms ?? 0,
    });
  }

  private scheduleRebuild(): void {
    this.dirty = true;
  }

  /** Paint all materialized vertices within brush radius of (wx, wy). */
  private applyBrushAt(wx: number, wy: number, erase: boolean): void {
    const r = this.brushSize;
    const r2 = r * r;
    let touched = false;
    for (const key of this.field.materialized) {
      const [a, b] = parseVk(key);
      const [x, y] = worldXY(a, b);
      const dx = x - wx;
      const dy = y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const fall = t * t * (3 - 2 * t) * 0.85;
      if (!this.strokeChanges.has(key)) {
        this.strokeChanges.set(key, {
          key,
          prev: this.field.getOverride(key),
          next: null,
        });
      }
      this.field.paint(key, this.material, erase ? -fall : fall);
      touched = true;
    }
    if (touched) {
      this.scheduleRebuild();
      this.scheduleSave();
    }
  }

  /**
   * Terrain brush: raises/lowers the CONTINENTAL (level-0) vertices within
   * radius. Hydrology re-runs debounced, so rivers re-route live.
   */
  private applyElevBrush(wx: number, wy: number): void {
    const r = this.brushSize;
    const r2 = r * r;
    let touched = false;
    for (const key of this.field.materialized) {
      if (!this.field.isRoot(key)) continue;
      const [a, b] = parseVk(key);
      const [x, y] = worldXY(a, b);
      const dx = x - wx;
      const dy = y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const fall = t * t * (3 - 2 * t) * 0.85;
      const cur = this.field.value(key);
      const ne = Math.max(
        ELEV_MIN,
        Math.min(ELEV_MAX, cur.elev + this.elevDir * 0.045 * fall)
      );
      if (Math.abs(ne - cur.elev) < 1e-6) continue;
      if (!this.strokeChanges.has(key)) {
        this.strokeChanges.set(key, {
          key,
          prev: this.field.getOverride(key),
          next: null,
        });
      }
      this.field.paintElev(key, ne);
      touched = true;
    }
    if (touched) {
      this.scheduleRebuild();
      this.scheduleHydro();
    }
  }

  private toolClick(cssX: number, cssY: number, alt: boolean): void {
    const [wx, wy] = this.screenToWorld(cssX, cssY);
    if (this.tool === "paint") {
      this.painting = true;
      this.paintKind = "mat";
      this.lastBrushPos = [wx, wy];
      this.applyBrushAt(wx, wy, alt);
      return;
    }
    if (this.tool === "raise" || this.tool === "lower") {
      this.painting = true;
      this.paintKind = "elev";
      this.elevDir = (this.tool === "raise" ? 1 : -1) * (alt ? -1 : 1);
      this.lastBrushPos = [wx, wy];
      this.applyElevBrush(wx, wy);
      return;
    }
    const leafKey = this.mesh.locateWorld(wx, wy);
    if (!leafKey) return;
    if (this.tool === "subdivide") {
      const parents = this.mesh.subdivide(leafKey, true);
      if (parents.length === 0) {
        this.cb.onToast?.("Maximum detail level reached here");
        return;
      }
      // materialize any new corner vertices for painting/inspection
      for (const pk of parents) {
        const t = this.mesh.get(pk)!;
        if (t.children)
          for (const ck of t.children) {
            const c = this.mesh.get(ck)!;
            for (const corner of triCorners(c.L, c.o, c.i, c.j))
              this.field.ensure(corner[0], corner[1]);
          }
      }
      this.undoStack.push({ kind: "subdivide", parents });
      this.redoStack = [];
      this.scheduleRebuild();
      this.emitStats();
      this.scheduleSave();
      return;
    }
    if (this.tool === "coalesce") {
      const t = this.mesh.get(leafKey)!;
      if (t.L === 0 || !t.parent) {
        this.cb.onToast?.("This tile is already at the coarsest level");
        return;
      }
      const ok = this.mesh.coalesce(t.parent, false);
      if (!ok) {
        this.cb.onToast?.("Blocked: a finer neighbour touches this block");
        return;
      }
      this.undoStack.push({ kind: "coalesce", parent: t.parent });
      this.redoStack = [];
      this.scheduleRebuild();
      this.emitStats();
      this.scheduleSave();
    }
  }

  private endStroke(): void {
    if (!this.painting) return;
    this.painting = false;
    this.lastBrushPos = null;
    if (this.strokeChanges.size > 0) {
      for (const ch of this.strokeChanges.values()) {
        ch.next = this.field.getOverride(ch.key);
      }
      this.undoStack.push({ kind: "paint", changes: [...this.strokeChanges.values()] });
      this.redoStack = [];
      this.strokeChanges = new Map();
      this.scheduleSave();
    }
  }

  private applyOpForward(op: Op): void {
    if (op.kind === "paint") {
      for (const ch of op.changes) this.field.setOverride(ch.key, ch.next);
    } else if (op.kind === "subdivide") {
      for (const pk of op.parents) {
        if (this.mesh.get(pk)) this.mesh.subdivide(pk, true);
      }
      this.materializeLeafCorners();
    } else {
      if (this.mesh.get(op.parent)) this.mesh.subdivide(op.parent, false);
    }
  }

  private applyOpBackward(op: Op): void {
    if (op.kind === "paint") {
      for (const ch of op.changes) this.field.setOverride(ch.key, ch.prev);
    } else if (op.kind === "subdivide") {
      for (let i = op.parents.length - 1; i >= 0; i--)
        this.mesh.coalesce(op.parents[i], true);
    } else {
      this.mesh.coalesce(op.parent, true);
    }
  }

  private afterHistory(): void {
    // undo/redo can revert terrain — the stamped water layer must follow,
    // otherwise rivers keep flowing along an erased dam until the next edit
    this.runHydro();
    this.scheduleRebuild();
    this.emitStats();
    this.scheduleSave();
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) {
      this.cb.onToast?.("Nothing to undo");
      return;
    }
    this.applyOpBackward(op);
    this.redoStack.push(op);
    this.afterHistory();
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) {
      this.cb.onToast?.("Nothing to redo");
      return;
    }
    this.applyOpForward(op);
    this.undoStack.push(op);
    this.afterHistory();
  }

  // ---------------- hover ----------------

  private requestHover(): void {
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      if (this.destroyed) return;
      const [cssX, cssY] = this.lastMouse;
      const [wx, wy] = this.screenToWorld(cssX, cssY);
      const leafKey = this.mesh.locateWorld(wx, wy);
      if (!leafKey) {
        this.cb.onHover?.(null);
        return;
      }
      const t = this.mesh.get(leafKey)!;
      const corners = triCorners(t.L, t.o, t.i, t.j).map((c) => {
        const key = vk(c[0], c[1]);
        const v = this.field.value(key);
        return {
          key,
          w: Array.from(v.w),
          elev: v.elev,
          z: v.z,
          river: v.river,
          lake: v.lake,
          dominant: this.field.dominant(v.w),
        };
      });
      this.cb.onHover?.({
        triKey: leafKey,
        level: t.L,
        world: [wx, wy],
        corners,
      });
    });
  }

  // ---------------- input ----------------

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection / native drag from canvas
      const rect = c.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      if (e.button === 1 || e.button === 2 || this.tool === "pan") {
        this.panning = true;
        this.panLast = [e.clientX, e.clientY];
        e.preventDefault();
        return;
      }
      if (e.button === 0) this.toolClick(cssX, cssY, e.altKey);
    });
    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      this.lastMouse = [e.clientX - rect.left, e.clientY - rect.top];
      if (this.panning) {
        this.panX += (e.clientX - this.panLast[0]) * this.dpr;
        this.panY += (e.clientY - this.panLast[1]) * this.dpr;
        this.panLast = [e.clientX, e.clientY];
        this.userCamera = true;
        return;
      }
      if (this.painting) {
        const [wx, wy] = this.screenToWorld(this.lastMouse[0], this.lastMouse[1]);
        // interpolate along the drag path so fast strokes stay continuous
        const last = this.lastBrushPos ?? [wx, wy];
        const dist = Math.hypot(wx - last[0], wy - last[1]);
        const steps = Math.max(1, Math.ceil(dist / (this.brushSize * 0.4)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const bx = last[0] + (wx - last[0]) * t;
          const by = last[1] + (wy - last[1]) * t;
          if (this.paintKind === "elev") this.applyElevBrush(bx, by);
          else this.applyBrushAt(bx, by, e.altKey);
        }
        this.lastBrushPos = [wx, wy];
      }
      this.requestHover();
    });
    const up = () => {
      this.panning = false;
      this.endStroke();
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", () => {
      if (!this.painting && !this.panning) this.cb.onHover?.(null);
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * this.dpr;
        const my = (e.clientY - rect.top) * this.dpr;
        const factor = Math.exp(-e.deltaY * 0.0012);
        const nz = Math.max(3, Math.min(240, this.zoom * factor));
        const k = nz / this.zoom;
        // keep the cursor anchored
        this.panX = mx - (mx - this.panX) * k;
        this.panY = my - (my - this.panY) * k;
        this.zoom = nz;
        this.userCamera = true;
      },
      { passive: false }
    );
    window.addEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    }
  };

  zoomBy(factor: number): void {
    const [cw, ch] = this.cssSize();
    const mx = (cw / 2) * this.dpr;
    const my = (ch / 2) * this.dpr;
    const nz = Math.max(3, Math.min(240, this.zoom * factor));
    const k = nz / this.zoom;
    this.panX = mx - (mx - this.panX) * k;
    this.panY = my - (my - this.panY) * k;
    this.zoom = nz;
    this.userCamera = true;
  }

  // ---------------- lifecycle ----------------

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.hydroTimer) clearTimeout(this.hydroTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    window.removeEventListener("keydown", this.onKey);
    this.canvas.remove();
  }
}

// re-export for UI convenience
export { MATERIALS, GEO, MAX_LEVEL, FIX };
export type { VV, Override };
