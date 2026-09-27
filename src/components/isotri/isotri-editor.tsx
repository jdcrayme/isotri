"use client";

/**
 * IsoTri — hierarchical isometric triangle map editor (prototype).
 *
 * Left: tools + palette + hydrology + display toggles. Right: the map.
 * The beach between a water vertex and a grass vertex is not authored —
 * it emerges from the tile factory's weight interpolation. Rivers and
 * lakes are derived from terrain by the hydrology core and stamped into
 * the vertex field; sculpting terrain re-routes them live.
 */

import { useEffect, useRef, useState } from "react";
import {
  IsoTriEngine,
  type HoverInfo,
  type Stats,
  type Tool,
} from "@/lib/isotri/engine";
import { MATERIALS, MAP_SIZES } from "@/lib/isotri/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  ArrowDownToLine,
  Dices,
  Eraser,
  Expand,
  Hand,
  Merge,
  Minus,
  Mountain,
  Paintbrush,
  Plus,
  RotateCcw,
  Route,
  Split,
  Undo2,
  Redo2,
} from "lucide-react";

const MAT_UI_COLORS = [
  "#2e7396",
  "#d9c58a",
  "#5a9440",
  "#1f5226",
  "#7a766f",
  "#e8edf0",
];

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; hint: string }[] =
  [
    {
      id: "paint",
      label: "Paint",
      icon: <Paintbrush className="h-4 w-4" />,
      hint: "Drag to paint the selected material onto nearby vertices. Alt-drag erases.",
    },
    {
      id: "raise",
      label: "Raise",
      icon: <Mountain className="h-4 w-4" />,
      hint: "Drag to raise terrain at the continental layer. Rain collects and rivers re-route live — dams, diversions and new lakes appear as you sculpt.",
    },
    {
      id: "lower",
      label: "Lower",
      icon: <ArrowDownToLine className="h-4 w-4" />,
      hint: "Drag to lower terrain. Carve a valley across a ridge and the river will find it; dig below the water table and a lake fills the hollow.",
    },
    {
      id: "subdivide",
      label: "Subdivide",
      icon: <Split className="h-4 w-4" />,
      hint: "Click a tile to split it into 4 children with interpolated + noisy vertex values. Coarse neighbours auto-refine to keep the mesh seamless.",
    },
    {
      id: "coalesce",
      label: "Merge",
      icon: <Merge className="h-4 w-4" />,
      hint: "Click a refined tile to merge its 4 children back. Blocked when a finer neighbour would be orphaned.",
    },
    {
      id: "road",
      label: "Road",
      icon: <Route className="h-4 w-4" />,
      hint: "Click a start point, then a destination — a road is routed over the terrain: it grades around slopes, fords rivers and bridges lakes, but never crosses the sea. Click again to start the next road; Esc cancels.",
    },
    {
      id: "pan",
      label: "Pan",
      icon: <Hand className="h-4 w-4" />,
      hint: "Drag to pan. You can also right- or middle-drag with any tool.",
    },
  ];

export default function IsoTriEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IsoTriEngine | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetArmed = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const [tool, setTool] = useState<Tool>("paint");
  const [material, setMaterial] = useState(2);
  const [brush, setBrush] = useState(1.4);
  const [wireframe, setWireframe] = useState(false);
  const [dots, setDots] = useState(false);
  const [riversOn, setRiversOn] = useState(true);
  const [roadsOn, setRoadsOn] = useState(true);
  const [fineDetail, setFineDetail] = useState(true);
  const [thrMult, setThrMult] = useState(1);
  const [seedText, setSeedText] = useState("7");
  const [stats, setStats] = useState<Stats>({
    leaves: 0,
    vertices: 0,
    maxLevel: 0,
    rivers: 0,
    lakes: 0,
    swamps: 0,
    trunks: 0,
    roads: 0,
    hydroMs: 0,
    mapW: 30,
    mapH: 22,
  });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [sizeArm, setSizeArm] = useState<string | null>(null);
  const sizeArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // mount the engine once
  useEffect(() => {
    if (!hostRef.current) return;
    let engine: IsoTriEngine;
    try {
      engine = new IsoTriEngine(hostRef.current, {
        onStats: setStats,
        onHover: setHover,
        onToast: showToast,
      });
    } catch (e) {
      // defer so we don't setState synchronously inside the effect
      requestAnimationFrame(() =>
        setGlError(
          "WebGL2 is not available in this browser, which the editor needs to render."
        )
      );
      return;
    }
    engineRef.current = engine;
    engine.tool = "paint";
    setSeedText(String(engine.seed));
    setThrMult(engine.thrMult);
    engine.start();
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // sync control state -> engine
  useEffect(() => {
    if (engineRef.current) engineRef.current.tool = tool;
  }, [tool]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.material = material;
  }, [material]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.brushSize = brush;
  }, [brush]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.showWireframe = wireframe;
  }, [wireframe]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.showVertices = dots;
  }, [dots]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.showRivers = riversOn;
  }, [riversOn]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.showRoads = roadsOn;
  }, [roadsOn]);
  useEffect(() => {
    engineRef.current?.setThrMult(thrMult);
  }, [thrMult]);
  useEffect(() => {
    if (engineRef.current) engineRef.current.fineDetail = fineDetail;
  }, [fineDetail]);

  const regenerate = (seed: number) => {
    const s = Number.isFinite(seed) ? Math.floor(seed) : 1;
    setSeedText(String(s));
    engineRef.current?.resetWorld(s);
  };

  const doReset = () => {
    if (!resetConfirm) {
      setResetConfirm(true);
      if (resetArmed.current) clearTimeout(resetArmed.current);
      resetArmed.current = setTimeout(() => setResetConfirm(false), 2600);
      return;
    }
    setResetConfirm(false);
    engineRef.current?.reset();
  };

  // Map size: two-click confirm, since resizing regenerates the world
  // (same seed, but painted edits and subdivision are lost).
  const doSetSize = (w: number, h: number, key: string) => {
    if (sizeArm !== key) {
      setSizeArm(key);
      if (sizeArmTimer.current) clearTimeout(sizeArmTimer.current);
      sizeArmTimer.current = setTimeout(() => setSizeArm(null), 2600);
      return;
    }
    setSizeArm(null);
    engineRef.current?.setMapSize(w, h);
  };

  const curSize =
    MAP_SIZES.find((s) => s.w === stats.mapW && s.h === stats.mapH) ?? null;

  const activeTool = TOOLS.find((t) => t.id === tool)!;

  const doRefineAll = () => {
    const n = engineRef.current?.subdivideAll() ?? 0;
    if (n > 0)
      showToast(
        `Refined ${n.toLocaleString()} tiles one level — rivers re-stamp crisp on the finer mesh`
      );
  };

  const doJoinAll = () => {
    const n = engineRef.current?.coalesceAll() ?? 0;
    if (n > 0)
      showToast(`Joined ${n.toLocaleString()} blocks back to base tiles`);
  };

  const doClearRoads = () => {
    const n = engineRef.current?.clearRoads() ?? 0;
    if (n > 0)
      showToast(`Removed ${n.toLocaleString()} road segments (undo brings them back)`);
  };

  const fmtPct = (x: number) => Math.round(x * 100) + "%";

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold tracking-wide">
            IsoTri
            <span className="ml-2 text-xs font-normal text-zinc-400">
              hierarchical isometric triangle editor
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-mono text-[11px]">
            {stats.leaves.toLocaleString()} tiles
          </Badge>
          <Badge variant="secondary" className="font-mono text-[11px]">
            {stats.vertices.toLocaleString()} verts
          </Badge>
          <Badge variant="secondary" className="font-mono text-[11px]">
            L{stats.maxLevel}
          </Badge>
          <Badge variant="secondary" className="hidden font-mono text-[11px] sm:inline-flex">
            {stats.rivers} river · {stats.lakes} lake · {stats.swamps} wet
          </Badge>
          {stats.roads > 0 && (
            <Badge variant="secondary" className="hidden font-mono text-[11px] md:inline-flex">
              {stats.roads} road
            </Badge>
          )}
          <Badge
            variant="outline"
            className="hidden font-mono text-[10px] text-zinc-500 lg:inline-flex"
            title="world size in root cells"
          >
            {stats.mapW}×{stats.mapH}
          </Badge>
          <Badge
            variant="outline"
            className="hidden font-mono text-[10px] text-zinc-500 md:inline-flex"
            title="hydrology solve time on the root lattice"
          >
            hydro {stats.hydroMs.toFixed(1)}ms
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="seed" className="text-xs text-zinc-400">
              Seed
            </Label>
            <Input
              id="seed"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") regenerate(parseInt(seedText, 10));
              }}
              className="h-8 w-24 bg-zinc-900"
              inputMode="numeric"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => regenerate(parseInt(seedText, 10) || 1)}
            >
              New
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              title="Random seed"
              onClick={() => regenerate(1 + Math.floor(Math.random() * 99999))}
            >
              <Dices className="h-4 w-4" />
            </Button>
          </div>
          <Separator orientation="vertical" className="hidden h-6 sm:block" />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => engineRef.current?.undo()}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
            Undo
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => engineRef.current?.redo()}
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            variant={resetConfirm ? "destructive" : "outline"}
            size="sm"
            className="h-8 px-2"
            onClick={doReset}
            title="Reset world (clears edits and the saved session)"
          >
            <RotateCcw className="h-4 w-4" />
            {resetConfirm ? "Sure?" : ""}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* sidebar */}
        <aside className="flex shrink-0 gap-4 overflow-x-auto border-b border-zinc-800 bg-zinc-900/40 p-3 md:w-60 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
          <section className="shrink-0">
            <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Tools
            </h2>
            <ToggleGroup
              type="single"
              value={tool}
              onValueChange={(v) => v && setTool(v as Tool)}
              className="grid grid-cols-3 gap-1"
            >
              {TOOLS.map((t) => (
                <ToggleGroupItem
                  key={t.id}
                  value={t.id}
                  title={t.label}
                  aria-label={t.label}
                  className="m-0 flex flex-col items-center gap-0.5 px-1 py-1.5"
                >
                  {t.icon}
                  <span className="text-[10px] leading-none">{t.label}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </section>

          {tool === "paint" && (
            <section className="shrink-0">
              <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Material
              </h2>
              <div className="grid grid-cols-6 grid-rows-1 gap-1 md:grid-cols-3">
                {MATERIALS.map((m, i) => (
                  <button
                    key={m}
                    onClick={() => setMaterial(i)}
                    title={m}
                    aria-label={`Paint ${m}`}
                    aria-pressed={material === i}
                    className={`flex h-9 items-center justify-center rounded-md border text-[10px] font-medium transition-colors ${
                      material === i
                        ? "border-zinc-100 ring-2 ring-zinc-300"
                        : "border-zinc-700 hover:border-zinc-500"
                    }`}
                    style={{ background: MAT_UI_COLORS[i] }}
                  >
                    <span className="rounded bg-black/45 px-1 py-0.5 text-zinc-100">
                      {m.slice(0, 4)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="w-40 shrink-0 md:w-auto">
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Brush radius
            </h2>
            <div className="flex items-center gap-2">
              <Slider
                value={[brush]}
                min={0.6}
                max={3}
                step={0.1}
                onValueChange={(v) => setBrush(v[0])}
                aria-label="Brush radius"
              />
              <span className="w-8 shrink-0 text-right font-mono text-xs text-zinc-400">
                {brush.toFixed(1)}
              </span>
            </div>
          </section>

          <section className="w-40 shrink-0 space-y-2 md:w-auto">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Map size
            </h2>
            <div className="grid w-40 grid-cols-2 gap-1 md:w-auto">
              {MAP_SIZES.map((s) => {
                const active = curSize?.key === s.key;
                const armed = sizeArm === s.key;
                return (
                  <Button
                    key={s.key}
                    variant={armed ? "destructive" : active ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    title={
                      active
                        ? `${s.label} is the current size — click twice to regenerate`
                        : `Resize the world to ${s.w}×${s.h} (regenerates, keeps the seed)`
                    }
                    onClick={() => doSetSize(s.w, s.h, s.key)}
                  >
                    {armed ? "Sure?" : s.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-[10px] leading-snug text-zinc-500">
              {stats.mapW}×{stats.mapH} · {((stats.mapW + 1) * (stats.mapH + 1)).toLocaleString()} hydro vertices.
              Resizing regenerates the world at the same seed; painted edits
              are cleared.
            </p>
          </section>

          <section className="w-40 shrink-0 space-y-2 md:w-auto">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Mesh detail
            </h2>
            <div className="grid w-40 grid-cols-2 gap-1 md:w-auto">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title="Subdivide every tile one level (whole-map cap L2)"
                onClick={doRefineAll}
              >
                <Split className="mr-1 h-3.5 w-3.5" />
                Refine all
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title="Merge the whole mesh back to base tiles"
                onClick={doJoinAll}
              >
                <Merge className="mr-1 h-3.5 w-3.5" />
                Join all
              </Button>
            </div>
            <p className="text-[10px] leading-snug text-zinc-500">
              The fine hydrology detail lives on refined tiles: refine the
              whole map to see crisp, meandering, branching rivers and flat
              lake surfaces. Coarse views are the exact low-pass of fine
              views, so nothing changes until you refine. Each click is one
              undo step; the Subdivide tool still goes deeper per tile.
            </p>
          </section>

          <section className="w-40 shrink-0 space-y-2 md:w-auto">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Roads
            </h2>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="roads" className="text-xs text-zinc-300">
                Show roads
              </Label>
              <Switch id="roads" checked={roadsOn} onCheckedChange={setRoadsOn} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs text-zinc-300">Network</Label>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title="Remove every road (one undo step)"
                onClick={doClearRoads}
                disabled={stats.roads === 0}
              >
                <Eraser className="mr-1 h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
            <p className="text-[10px] leading-snug text-zinc-500">
              {stats.roads === 0
                ? "Use the Road tool to route a path over the terrain — it grades around slopes, fords rivers and bridges lakes."
                : `${stats.roads.toLocaleString()} segments authored. Roads persist in the save; they don't re-route when you sculpt (rivers do).`}
            </p>
          </section>

          <section className="w-40 shrink-0 space-y-2 md:w-auto">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Hydrology
            </h2>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="riv" className="text-xs text-zinc-300">
                Rivers
              </Label>
              <Switch id="riv" checked={riversOn} onCheckedChange={setRiversOn} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="fd" className="text-xs text-zinc-300">
                Fine detail
              </Label>
              <Switch id="fd" checked={fineDetail} onCheckedChange={setFineDetail} />
            </div>
            <p className="text-[10px] leading-snug text-zinc-500">
              seeds {stats.trunks.toLocaleString()} trunk segments into refined
              tiles — click Refine all (above) to see the branching network.
              Water is flat everywhere: the sea sits at sea level, lakes at
              their spill, and rivers at a pool level that only ever drops
              downstream — the channel is cut through hills, never climbs.
            </p>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label htmlFor="thr" className="text-xs text-zinc-300">
                  River threshold
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Slider
                  id="thr"
                  value={[thrMult]}
                  min={0.3}
                  max={3}
                  step={0.1}
                  onValueChange={(v) => setThrMult(v[0])}
                  aria-label="River threshold multiplier"
                />
                <span className="w-8 shrink-0 text-right font-mono text-xs text-zinc-400">
                  {thrMult.toFixed(1)}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-zinc-500">
                lower = more streams, higher = fewer but bigger rivers
              </p>
            </div>
          </section>

          <Separator className="hidden md:block" />

          <section className="shrink-0 space-y-2">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Display
            </h2>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="wf" className="text-xs text-zinc-300">
                Wireframe
              </Label>
              <Switch id="wf" checked={wireframe} onCheckedChange={setWireframe} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="dots" className="text-xs text-zinc-300">
                Vertex dots
              </Label>
              <Switch id="dots" checked={dots} onCheckedChange={setDots} />
            </div>
          </section>

          <Separator className="hidden md:block" />

          <section className="hidden w-full md:block">
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              How it works
            </h2>
            <p className="text-[11px] leading-relaxed text-zinc-400">
              {activeTool.hint}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Vertices carry material weights; tiles blend them, so a beach
              appears wherever water and grass weights meet. Rain falls on the
              continent, fills depressions into lakes, and discharge above a
              threshold carves rivers that widen with flow. Water always
              renders LEVEL: the sea is one plane at sea level, lakes sit at
              their spill, and each river pool sits at a level computed as the
              highest surface that never climbs — where the ground rises
              across a channel it is cut into a gorge; dig the bed deeper and
              the water stays. Everything is derived — sculpt the terrain and
              the water re-routes. Roads are the authored exception: the Road
              tool plans them over the current terrain (A\* across slopes,
              rivers and lakes), then they stay put in the save. Refining
              tiles re-derives children as parent interpolation + deterministic
              noise, and the coarse drainage network is re-seeded onto refined
              tiles so rivers stay crisp and pick up meander detail as you
              zoom. Your session auto-saves locally.
            </p>
          </section>
        </aside>

        {/* canvas host */}
        <main className="relative min-h-0 min-w-0 flex-1">
          <div ref={hostRef} className="absolute inset-0 cursor-crosshair" />

          {glError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
              <div className="max-w-sm rounded-lg border border-red-900 bg-zinc-900 p-4 text-sm text-red-200">
                {glError}
              </div>
            </div>
          )}

          {toast && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-200 shadow-lg">
              {toast}
            </div>
          )}

          {/* zoom controls */}
          <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-zinc-900/90"
              aria-label="Zoom in"
              onClick={() => engineRef.current?.zoomBy(1.3)}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-zinc-900/90"
              aria-label="Zoom out"
              onClick={() => engineRef.current?.zoomBy(1 / 1.3)}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-zinc-900/90"
              aria-label="Fit map"
              title="Fit map"
              onClick={() => engineRef.current?.refit()}
            >
              <Expand className="h-4 w-4" />
            </Button>
          </div>

          {/* hover inspector */}
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-lg border border-zinc-800 bg-zinc-900/90 px-3 py-2 font-mono text-[11px] text-zinc-300 shadow-lg backdrop-blur">
            {hover ? (
              <div className="space-y-1">
                <div className="text-zinc-400">
                  tile <span className="text-zinc-100">{hover.triKey}</span>
                  <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5">
                    L{hover.level}
                  </span>
                </div>
                <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-3">
                  {hover.corners.map((c, i) => {
                    const pairs = c.w
                      .map((w, mi) => ({ w, mi }))
                      .sort((a, b) => b.w - a.w)
                      .slice(0, 2)
                      .filter((p) => p.w > 0.01);
                    const extras: string[] = [
                      `z ${c.z.toFixed(2)}`,
                    ];
                    if (Math.abs(c.elev - c.z) > 0.005)
                      extras.push(`bed ${c.elev.toFixed(2)}`);
                    if (c.river > 0.02) extras.push(`riv ${fmtPct(c.river)}`);
                    if (c.road > 0.02) extras.push(`road ${fmtPct(c.road)}`);
                    if (c.lake > 0.02) extras.push(`lake ${fmtPct(c.lake)} · lvl ${c.fill.toFixed(2)}`);
                    else if (c.river > 0.16) extras.push(`water lvl ${c.lvl.toFixed(2)}`);
                    return (
                      <div key={i} className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ background: MAT_UI_COLORS[c.dominant] }}
                        />
                        <span className="truncate text-zinc-500">
                          {pairs
                            .map(
                              (p) => `${MATERIALS[p.mi]} ${fmtPct(p.w)}`
                            )
                            .join(" · ")}
                          {" · "}
                          <span className="text-zinc-400">
                            {extras.join(" · ")}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <span className="text-zinc-500">
                hover a tile to inspect its vertex weights
              </span>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
