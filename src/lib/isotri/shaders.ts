/**
 * The "tile factory" shader.
 *
 * Each vertex carries a material weight vector; the fragment shader
 * barycentrically interpolates the three corner vectors, adds cosmetic
 * per-pixel noise (domain wobble -> organic coastline), then CLASSIFIES:
 *   water        w_water > 0.60        (depth-tinted, animated sparkle)
 *   beach band   0.30 < w_water <= 0.60 (dry->wet sand + foam line)
 *   land         weighted blend of the rest
 *
 * The beach between a water vertex and a grass vertex EMERGES from the
 * weight interpolation — it is not authored anywhere. Lakes get their beach
 * ring for the same reason: hydrology stamps water weight on the vertices.
 *
 * Phase 2 additions:
 *   - river overlay channel (vN.w): mud banks, then a deep-teal channel with
 *     animated flow shimmer. Rivers are an OVERLAY, not a palette entry —
 *     they ride on top of whatever the weights classify (they visibly run
 *     into the sea and out of lakes).
 *   - rendered surface elevation (vP.w) differs from terrain elevation
 *     (vP.z) over water — the FLAT-WATER contract: the open sea renders as
 *     one plane at sea level, lakes at their spill level, rivers at their
 *     pool-and-drop level (monotone downstream — water never climbs). The
 *     bed below the surface stays in vP.z; depth shading reads vP.w - vP.z.
 *
 * Shading: screen-space derivative normals (flat-shaded 2.5D relief).
 * uMode: 0 = mesh triangles, 1 = vertex dots (round), 2 = wireframe lines.
 *
 * Vertex layout (STRIDE 16 floats):
 *   loc0 vec4 aPos = (x, y, elev, z)      world units, level-0 space
 *   loc1 vec4 aM   = (water, sand, grass, forest)
 *   loc2 vec4 aN   = (rock, snow, moist, river)
 *   loc3 vec4 aR   = (road, 0, 0, 0)
 */

export const VERT_SRC = `#version 300 es
precision highp float;

in vec4 aPos;   // x, y, elev(terrain), z(render surface)
in vec4 aM;     // water, sand, grass, forest
in vec4 aN;     // rock, snow, moist, river
in vec4 aR;     // road

uniform vec2 uResolution; // device pixels
uniform float uZoom;
uniform vec2 uPan;        // device pixels
uniform float uES;        // elevation scale
uniform float uPointSize;

out vec4 vP;
out vec4 vM;
out vec4 vN;
out vec4 vR;

void main() {
  vec2 iso = vec2(aPos.x - aPos.y, (aPos.x + aPos.y) * 0.5 - aPos.w * uES);
  vec2 screen = iso * uZoom + uPan;
  vec2 clip = screen / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vP = aPos;
  vM = aM;
  vN = aN;
  vR = aR;
}
`;

export const FRAG_SRC = `#version 300 es
precision highp float;

in vec4 vP;   // x, y, elev, z
in vec4 vM;   // water, sand, grass, forest
in vec4 vN;   // rock, snow, moist, river
in vec4 vR;   // road

uniform float uTime;
uniform int uMode;
uniform vec3 uFlatColor;
uniform float uRiverOn;
uniform float uRoadOn;

out vec4 frag;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  if (uMode == 2) {
    frag = vec4(uFlatColor, 1.0);
    return;
  }
  if (uMode == 3) {
    // road overlay quad (uRoadOn handled by the draw call): flat dirt or
    // plank-over-water color with grain. vM.x carries the endpoint water
    // weight so lake crossings render as bridges at every LOD.
    float grain = vnoise(vP.xy * 42.0);
    vec3 rc = (vM.x > 0.6)
      ? mix(vec3(0.36, 0.26, 0.15), vec3(0.47, 0.36, 0.21), grain)
      : mix(vec3(0.46, 0.37, 0.24), vec3(0.56, 0.47, 0.32), grain);
    frag = vec4(rc * (0.86 + 0.2 * grain), 1.0);
    return;
  }
  if (uMode == 1) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }

  // cosmetic domain wobble (non-authoritative, GPU-side)
  float n1 = vnoise(vP.xy * 9.0) - 0.5;
  float n2 = vnoise(vP.xy * 27.0 + 13.7) - 0.5;
  vec4 m = max(vM + vec4(n1, n2, n1, n2) * 0.16, 0.0);
  vec4 nn = max(vN + vec4(n2, n1, 0.0, 0.0) * 0.16, 0.0);
  float sum = m.x + m.y + m.z + m.w + nn.x + nn.y;
  m /= sum;
  nn /= sum;

  float water = m.x;
  float riv = nn.w;
  vec3 col;

  if (water > 0.60) {
    // open water: depth = surface - bed (vP.z) — works for the sea (the
    // surface is the sea-level plane), lakes (spill level) and rivers
    // (pool level); the bed stays in vP.z under all of them.
    float depth = clamp(max(-vP.z, vP.w - vP.z) * 1.9 + (water - 0.60) * 0.9, 0.0, 1.0);
    vec3 shallow = vec3(0.26, 0.58, 0.62);
    vec3 deep = vec3(0.045, 0.19, 0.33);
    col = mix(shallow, deep, depth);
    float sp = vnoise(vP.xy * 34.0 + vec2(uTime * 0.55, -uTime * 0.35));
    col += vec3(0.09) * smoothstep(0.80, 0.96, sp) * (1.0 - depth);
  } else if (water > 0.30) {
    float t = (water - 0.30) / 0.30;
    vec3 dry = vec3(0.87, 0.80, 0.58);
    vec3 wet = vec3(0.53, 0.50, 0.36);
    col = mix(dry, wet, t);
    if (water > 0.545) {
      col = mix(col, vec3(0.93, 0.96, 0.94),
                (water - 0.545) / 0.055 * 0.65);
    }
  } else {
    vec3 cSand = vec3(0.84, 0.77, 0.54);
    vec3 cGrass = vec3(0.33, 0.55, 0.23);
    vec3 cForest = vec3(0.09, 0.30, 0.14);
    vec3 cRock = vec3(0.47, 0.45, 0.42);
    vec3 cSnow = vec3(0.92, 0.94, 0.96);
    col = cSand * m.y + cGrass * m.z + cForest * m.w
        + cRock * nn.x + cSnow * nn.y;
  }

  // ---- river overlay (an overlay channel, not a palette entry) ----
  if (water <= 0.60 && uRiverOn > 0.5 && riv > 0.003) {
    // muddy banks before the water itself
    float bank = smoothstep(0.035, 0.14, riv);
    col = mix(col, vec3(0.40, 0.33, 0.23), bank * 0.7);
    // the channel: jittered edge keeps it organic. The blue end is kept
    // clearly bluer than the forest palette so channels read on any ground.
    float core = smoothstep(0.22, 0.55, riv + (n1 - 0.5) * 0.14);
    vec3 rcol = mix(vec3(0.34, 0.58, 0.62), vec3(0.10, 0.32, 0.47),
                    smoothstep(0.30, 0.90, riv));
    float flow = vnoise(vP.xy * 22.0 + vec2(uTime * 0.9, -uTime * 0.6));
    rcol += vec3(0.11) * smoothstep(0.74, 0.95, flow) * core;
    col = mix(col, rcol, core);
  }

  // ---- road overlay (authored infrastructure, rides over everything) ----
  // On land: a worn dirt track. Over open water: a plank bridge, so roads
  // that cross lakes stay readable. Drawn AFTER rivers (a road fords or
  // bridges a river on top of it).
  if (uRoadOn > 0.5 && vR.x > 0.015) {
    float rd = vR.x + (n2 - 0.5) * 0.12;
    float core = smoothstep(0.30, 0.62, rd);
    float shoulder = smoothstep(0.10, 0.30, rd);
    if (core > 0.002) {
      float grain = vnoise(vP.xy * 42.0);
      vec3 rcol = (water > 0.60)
        ? mix(vec3(0.36, 0.26, 0.15), vec3(0.47, 0.36, 0.21), grain)  // planks
        : mix(vec3(0.46, 0.37, 0.24), vec3(0.56, 0.47, 0.32), grain); // dirt
      col = mix(col, rcol * (0.82 + 0.30 * core), core);
    }
    // dark trampled rim where the path meets the ground
    col = mix(col, vec3(0.30, 0.24, 0.16), shoulder * (1.0 - core) * 0.35);
  }

  // flat-shaded relief from screen-space derivatives (land only)
  if (water <= 0.60 && uMode == 0) {
    vec3 dx = dFdx(vec3(vP.xy, vP.w));
    vec3 dy = dFdy(vec3(vP.xy, vP.w));
    vec3 n = normalize(cross(dx, dy));
    if (n.z < 0.0) n = -n;
    vec3 Ldir = normalize(vec3(-0.45, -0.30, 0.84));
    float diff = max(dot(n, Ldir), 0.0);
    col *= 0.60 + 0.55 * diff;
  } else if (water > 0.60) {
    col *= 0.93;
  }

  frag = vec4(col, 1.0);
}
`;
