/** Shared night pass for the Canvas battlefield and the already-composited 3D hulls.
 * Simulation owns light positions, time, perception and physical occlusion. This
 * module owns only disposable textures, a lower-resolution GPU approximation of
 * the same ray test, and an exact-CPU/coarse-raster fallback. No GPU result is read
 * by the simulation. World coordinates below are east/south/height in metres. */
import type { BattleState, Camera, HeightField, HullQuat, IlluminationFlare, Side, Vec3, Vehicle } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { VEHICLE_ARMOR_GEOMETRY } from '@/data/vehicleArmorGeometry';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { hullParams } from '@/data/vehiclePhysics';
import { add, inverseRotate, multiply, rotate, yawQuat } from '@/sim/hullMath';
import { canopyAt, groundAt, heightAt } from '@/sim/heightField';
import { flarePose, lightSources, prepareIllumination, nightFogAt, FOG_CELL_TILES, NIGHT_AMBIENT, type IlluminationSource } from '@/sim/illumination';
import { vehicles3d } from './vehicle3d';
import { TILT_RAD } from './vehicle3d/projection';

// Render-only quality. The canonical CPU still uses five emitter samples at
// every acquisition point. Three fixed samples preserve that set's centre and
// covariance; the smaller raster is smoothly enlarged by Canvas. No RNG/jitter.
const GPU_W = 192, GPU_H = Math.round(GPU_W * VIEW_H / VIEW_W);
const CPU_W = 40, CPU_H = Math.round(CPU_W * VIEW_H / VIEW_W);
const MAX_LIGHTS = 8, MAX_BOXES = 96;
const BOUND_CELLS = 8;
export const NIGHT_EMITTER_OFFSETS: readonly (readonly [number, number])[] = [
  [Math.sqrt(.8), 0], [-Math.sqrt(.2), Math.sqrt(.6)], [-Math.sqrt(.2), -Math.sqrt(.6)],
];
const TILT = Math.sin(TILT_RAD);
const AMBIENT_RGB = [0.13, 0.18, 0.29] as const;
const WARM_RGB = [1, 0.91, 0.73] as const;

export interface NightOccluder {
  vehicleId: number;
  position: Vec3;
  orientation: HullQuat;
  min: Vec3;
  max: Vec3;
}
interface RenderFlare { flare: IlluminationFlare; pos: Vec3; strength: number }

/** Conservative maxima over 4 m blocks at the current .5 m physical resolution.
 * Include both sides of every bilinear boundary: a tall sample immediately
 * outside a block still contributes inside it. This is a disposable accelerator,
 * not a coarser substitute for the authoritative surface. */
export function nightHeightBounds(field: HeightField): { data: Float32Array; width: number; height: number; stepM: number; maximum: number } {
  const width = Math.ceil(field.w / BOUND_CELLS), height = Math.ceil(field.h / BOUND_CELLS);
  const data = new Float32Array(width * height); data.fill(-Infinity);
  let maximum = -Infinity;
  for (let y = 0; y < field.h; y++) {
    const by = Math.floor(y / BOUND_CELLS), ry = y % BOUND_CELLS;
    const y0 = ry === 0 ? Math.max(0, by - 1) : by, y1 = ry === BOUND_CELLS - 1 ? Math.min(height - 1, by + 1) : by;
    for (let x = 0; x < field.w; x++) {
      const i = y * field.w + x, value = Math.max(field.height[i], field.ground[i] + field.canopy[i]);
      maximum = Math.max(maximum, value);
      const bx = Math.floor(x / BOUND_CELLS), rx = x % BOUND_CELLS;
      const x0 = rx === 0 ? Math.max(0, bx - 1) : bx, x1 = rx === BOUND_CELLS - 1 ? Math.min(width - 1, bx + 1) : bx;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const key = yy * width + xx; if (value > data[key]) data[key] = value;
      }
    }
  }
  return { data, width, height, stepM: BOUND_CELLS * TILE_M / field.res, maximum };
}

/** An undiscovered hull must never appear as a sharp moving shadow in the UI.
 * Canonical sensing still traces ALL hulls; only this display projection filters
 * entities using the same gate as unitRender.drawVehicles. */
function shownVehicle(state: BattleState, viewer: Side, v: Vehicle): boolean {
  return v.side === viewer || !!state.config.alwaysSeeEnemy || state.spottedVehicles[viewer].has(v.id);
}

/** Exactly the solid hull/turret envelopes used by hullAim.intersectVehicle,
 * including suspension pitch, roll, turret yaw and the legacy ground datum.
 * This does not create a height field or write to a vehicle. */
export function nightOccluders(state: BattleState, viewer: Side): NightOccluder[] {
  const field = state.map.heightField, out: NightOccluder[] = [];
  if (!field) return out;
  for (const v of state.vehicles.values()) {
    if (!shownVehicle(state, viewer, v)) continue;
    const def = VEHICLE_DEFS[v.defId]; if (!def) continue;
    const p = hullParams(def), q = v.body?.orientation ?? yawQuat(v.hullFacing);
    const position = v.body?.position ?? { x: v.pos.x * TILE_M, y: v.pos.y * TILE_M,
      z: heightAt(field, v.pos.x, v.pos.y) + p.cgHeightM };
    out.push({ vehicleId: v.id, position, orientation: q, min: p.solidBox.min, max: p.solidBox.max });
    const ring = VEHICLE_GUN_GEOMETRY[def.id]?.ring, box = VEHICLE_ARMOR_GEOMETRY[def.id];
    if (def.hasTurret && !v.turretBlown && ring && box) out.push({ vehicleId: v.id,
      position: add(position, rotate(q, add(p.modelOriginLocal, ring))),
      orientation: multiply(q, yawQuat(v.turretFacing - v.hullFacing)), min: box.min, max: box.max });
  }
  return out;
}

/** Positive first intersection parameter, or Infinity. Shared by the fallback's
 * visible receiver-height reconstruction and its projection fixtures. */
export function nightBoxHit(origin: Vec3, direction: Vec3, box: NightOccluder): number {
  const o = inverseRotate(box.orientation, { x: origin.x - box.position.x, y: origin.y - box.position.y, z: origin.z - box.position.z });
  const d = inverseRotate(box.orientation, direction);
  let entry = -Infinity, exit = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[axis]) < 1e-9) { if (o[axis] < box.min[axis] || o[axis] > box.max[axis]) return Infinity; continue; }
    const a = (box.min[axis] - o[axis]) / d[axis], b = (box.max[axis] - o[axis]) / d[axis];
    entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return Infinity;
  }
  return exit < 0 ? Infinity : entry >= 0 ? entry : exit;
}

export function projectNightPoint(cam: Camera, p: Vec3): { x: number; y: number } {
  const ppm = TILE_PX * cam.zoom / TILE_M;
  return { x: (p.x - cam.x * TILE_M) * ppm, y: (p.y - cam.y * TILE_M - p.z * TILT) * ppm };
}

function flaresFor(state: BattleState): RenderFlare[] {
  return (state.flares ?? []).flatMap(flare => {
    const p = flarePose(state, flare); return p && p.strength > 0 ? [{ flare, ...p }] : [];
  });
}

/** Call before drawUnits. fitSun changes only its transform, so the sun remains
 * disabled when GlOutput subsequently fits its camera. */
export function configureNightVehicleLighting(state: BattleState): void {
  const gl = vehicles3d(); if (!gl) return;
  const night = state.config.timeOfDay === 'night';
  const lights = night && state.map.heightField ? lightSources(state) : [];
  gl.scene.setNightLighting(night, lights.slice(0, MAX_LIGHTS).map(l => ({ ...l.pos, strength: l.strength })));
}

const VERTEX = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Same .5 m march, .12 m solid bias, crown interval/density, falloff and
 * saturation as sim/illumination.ts; three moment-matched emitter samples are
 * the explicit render-only approximation. Conservative local height bounds skip
 * expensive surface reads, and a global bound stops the ray in empty sky.
 * No shadow-map cube renders, geometry readbacks or per-frame terrain packing. */
export const NIGHT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
out vec4 color;
uniform sampler2D uHeight, uGround, uCanopy, uFog, uBounds;
uniform vec2 uMapM, uOriginM, uViewM;
uniform float uStepM, uMaxHeight, uBoundStepM;
uniform int uLightCount, uBoxCount;
uniform vec4 uLights[${MAX_LIGHTS}]; // east/south/height/strength
uniform vec2 uLightShape[${MAX_LIGHTS}]; // useful radius, emitter radius
uniform vec4 uBoxPosition[${MAX_BOXES}]; // xyz, vehicle id
uniform vec4 uBoxQuaternion[${MAX_BOXES}];
uniform vec3 uBoxMin[${MAX_BOXES}], uBoxMax[${MAX_BOXES}];

vec3 rotateQ(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float fieldAt(sampler2D field, vec2 p) {
#ifdef FLOAT_LINEAR
  return texture(field, p / uMapM).r;
#else
  ivec2 size = textureSize(field, 0);
  vec2 f = p / uStepM - .5;
  ivec2 i = ivec2(clamp(floor(f), vec2(0), vec2(size - 1)));
  ivec2 j = min(i + 1, size - 1);
  vec2 a = clamp(f - vec2(i), 0.0, 1.0);
  return mix(mix(texelFetch(field, i, 0).r, texelFetch(field, ivec2(j.x, i.y), 0).r, a.x),
             mix(texelFetch(field, ivec2(i.x, j.y), 0).r, texelFetch(field, j, 0).r, a.x), a.y);
#endif
}
float boxHit(vec3 origin, vec3 direction, int b) {
  vec4 q = uBoxQuaternion[b]; q.xyz = -q.xyz;
  vec3 o = rotateQ(q, origin - uBoxPosition[b].xyz), d = rotateQ(q, direction);
  float nearT = -1e20, farT = 1e20;
  for (int a = 0; a < 3; a++) {
    if (abs(d[a]) < 1e-8) { if (o[a] < uBoxMin[b][a] || o[a] > uBoxMax[b][a]) return 1e20; }
    else {
      float x = (uBoxMin[b][a] - o[a]) / d[a], y = (uBoxMax[b][a] - o[a]) / d[a];
      nearT = max(nearT, min(x, y)); farT = min(farT, max(x, y));
      if (nearT > farT) return 1e20;
    }
  }
  return farT < 0.0 ? 1e20 : nearT >= 0.0 ? nearT : farT;
}
float transmission(vec3 source, vec3 receiver, float receiverId) {
  vec3 delta = receiver - source;
  float rayLength = length(delta);
  for (int b = 0; b < ${MAX_BOXES}; b++) {
    if (b >= uBoxCount) break;
    if (uBoxPosition[b].w == receiverId) continue;
    vec3 centre = uBoxPosition[b].xyz;
    float reach = length(max(abs(uBoxMin[b]), abs(uBoxMax[b])));
    if (any(lessThan(centre.xy, min(source.xy, receiver.xy) - reach)) ||
        any(greaterThan(centre.xy, max(source.xy, receiver.xy) + reach))) continue;
    float t = boxHit(source, delta, b);
    if (t * rayLength > .05 && t * rayLength < rayLength - .12) return 0.0;
  }
  int steps = max(2, int(ceil(length(delta.xy) / .5)));
  float result = 1.0;
  // Reverse the canonical sample order to skip the empty sky above a tall flare.
  // The sampled coordinates and product of crown transmissions are unchanged.
  for (int k = 0; k < 1024; k++) {
    int i = steps - k; if (i < 1) break;
    vec3 p = source + delta * (float(i) / float(steps));
    if (p.z > uMaxHeight + .2 && source.z >= p.z) break;
    if (any(lessThan(p.xy, vec2(0))) || any(greaterThanEqual(p.xy, uMapM))) continue;
    ivec2 boundCell = min(ivec2(p.xy / uBoundStepM), textureSize(uBounds, 0) - 1);
    if (p.z > texelFetch(uBounds, boundCell, 0).r + .2) continue;
    if (fieldAt(uHeight, p.xy) > p.z + .12) return 0.0;
    float crown = fieldAt(uCanopy, p.xy);
    if (crown <= 2.0) continue;
    float ground = fieldAt(uGround, p.xy);
    if (crown > 2.0 && p.z > ground + crown * .55 && p.z < ground + crown) {
      result *= .84; if (result < .02) return 0.0;
    }
    if (crown > 2.0 && p.z > ground + .15 && p.z < ground + crown * .55) {
      vec2 trunk = (fract(p.xy / 2.0) - .5) * 2.0;
      if (dot(trunk, trunk) < .0144) return 0.0;
    }
  }
  return result;
}
void main() {
  vec2 mapXY = uOriginM + vec2(uv.x, 1.0 - uv.y) * uViewM;
  if (any(lessThan(mapXY, vec2(0))) || any(greaterThanEqual(mapXY, uMapM))) { color = vec4(.04, .05, .08, 1); return; }
  float ground = fieldAt(uGround, mapXY);
  float surface = max(fieldAt(uHeight, mapXY), ground + fieldAt(uCanopy, mapXY));
  vec3 receiver = vec3(mapXY, surface + .16);
  float receiverId = -1.0;
  // The Canvas ground is top-down. Only actual projected vehicle surfaces need
  // the 12-degree camera reconstruction; this avoids a dark silhouette over the
  // top of an otherwise lit tank and retains its physically correct shadow.
  float eyeHeight = uMaxHeight + 150.0;
  vec3 eye = vec3(mapXY.x, mapXY.y + eyeHeight * ${TILT}, eyeHeight);
  vec3 eyeDir = vec3(0, -${TILT}, -1);
  float nearest = 1e20;
  for (int b = 0; b < ${MAX_BOXES}; b++) {
    if (b >= uBoxCount) break;
    float t = boxHit(eye, eyeDir, b);
    if (t < nearest && t < eyeHeight - ground + 1.0) {
      nearest = t; receiver = eye + eyeDir * t; receiver.z += .16; receiverId = uBoxPosition[b].w;
    }
  }
  float darkness = 1.0;
  for (int l = 0; l < ${MAX_LIGHTS}; l++) {
    if (l >= uLightCount) break;
    vec3 p = uLights[l].xyz; float radius = uLightShape[l].x;
    float d = length(receiver.xy - p.xy); if (d >= radius) continue;
    float r = uLightShape[l].y;
    float visibility = 0.0;
    ${NIGHT_EMITTER_OFFSETS.map(([x, y]) => `visibility += transmission(p + vec3(${x}, ${y}, 0.0) * r, receiver, receiverId);`).join('\n    ')}
    float falloff = 1.0 - d / radius;
    darkness *= 1.0 - clamp(uLights[l].w * falloff * falloff * visibility / 3.0, 0.0, .96);
  }
  float light = 1.0 - darkness;
  // Perceptual display exposure only; the simulation uses its linear .025 ambient.
  vec3 tint = mix(vec3(.13, .18, .29), vec3(1.0, .91, .73), sqrt(light));
  float fog = texture(uFog, clamp(mapXY / uMapM, 0.0, 1.0)).r;
  tint *= mix(.20, 1.0, fog);
  color = vec4(tint, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, kind: number, text: string): WebGLShader {
  const shader = gl.createShader(kind); if (!shader) throw new Error('Cannot create night shader');
  gl.shaderSource(shader, text); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`Night shader: ${error}`);
  }
  return shader;
}

class NightGpu {
  private readonly canvas: HTMLCanvasElement;
  readonly mask: HTMLCanvasElement;
  readonly linearSampling: boolean;
  private readonly maskContext: CanvasRenderingContext2D;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[] = [];
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private field: HeightField | undefined;
  private version = -1;
  private maxHeight = 0;
  private boundStepM = 4;
  private fogW = 0;
  private fogH = 0;
  private fog = new Uint8Array();
  private lost = false;
  private readonly lightData = new Float32Array(MAX_LIGHTS * 4);
  private readonly shapeData = new Float32Array(MAX_LIGHTS * 2);
  private readonly boxPositions = new Float32Array(MAX_BOXES * 4);
  private readonly boxQuaternions = new Float32Array(MAX_BOXES * 4);
  private readonly boxMin = new Float32Array(MAX_BOXES * 3);
  private readonly boxMax = new Float32Array(MAX_BOXES * 3);

  constructor() {
    const canvas = this.canvas = document.createElement('canvas'); canvas.width = GPU_W; canvas.height = GPU_H;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable'); this.gl = gl;
    this.linearSampling = !!gl.getExtension('OES_texture_float_linear');
    const source = this.linearSampling ? NIGHT_FRAGMENT_SHADER.replace('#version 300 es', '#version 300 es\n#define FLOAT_LINEAR') : NIGHT_FRAGMENT_SHADER;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX), fragment = compile(gl, gl.FRAGMENT_SHADER, source);
    const program = gl.createProgram(); if (!program) throw new Error('Cannot create night program');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const error = gl.getProgramInfoLog(program); gl.deleteProgram(program); throw new Error(`Night program: ${error}`); }
    this.program = program; gl.useProgram(program);
    for (let i = 0; i < 5; i++) {
      const texture = gl.createTexture(); if (!texture) throw new Error('Cannot create night texture');
      this.textures.push(texture); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texture);
      const filter = i === 3 || (i < 3 && this.linearSampling) ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    ['uHeight', 'uGround', 'uCanopy', 'uFog', 'uBounds'].forEach((name, i) => gl.uniform1i(this.uniform(name), i));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.viewport(0, 0, GPU_W, GPU_H);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    // Discard the whole context after loss; a subsequent frame uses the CPU path.
    this.mask = document.createElement('canvas'); this.mask.width = GPU_W; this.mask.height = GPU_H;
    const context = this.mask.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Cannot create night mask cache'); this.maskContext = context;
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }

  draw(state: BattleState, cam: Camera, viewer: Side, lights: readonly IlluminationSource[], boxes: readonly NightOccluder[]): boolean {
    const gl = this.gl, field = state.map.heightField;
    if (this.lost || gl.isContextLost() || !field) return false;
    if (field.w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || field.h > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return false;
    gl.useProgram(this.program);
    if (this.field !== field || this.version !== field.version) {
      [field.height, field.ground, field.canopy].forEach((data, i) => {
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
        if (this.field?.w === field.w && this.field?.h === field.h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, field.w, field.h, gl.RED, gl.FLOAT, data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, field.w, field.h, 0, gl.RED, gl.FLOAT, data);
      });
      const bounds = nightHeightBounds(field);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.textures[4]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, bounds.width, bounds.height, 0, gl.RED, gl.FLOAT, bounds.data);
      this.maxHeight = bounds.maximum; this.boundStepM = bounds.stepM;
      this.field = field; this.version = field.version;
    }
    const fogW = Math.ceil(state.map.width / FOG_CELL_TILES), fogH = Math.ceil(state.map.height / FOG_CELL_TILES);
    const resize = this.fogW !== fogW || this.fogH !== fogH;
    if (resize) { this.fogW = fogW; this.fogH = fogH; this.fog = new Uint8Array(fogW * fogH); }
    for (let y = 0; y < fogH; y++) for (let x = 0; x < fogW; x++) {
      const fog = nightFogAt(state, viewer, x * FOG_CELL_TILES, y * FOG_CELL_TILES);
      this.fog[y * fogW + x] = fog === 'visible' ? 255 : fog === 'remembered' ? 75 : 0;
    }
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.textures[3]); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (resize) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, fogW, fogH, 0, gl.RED, gl.UNSIGNED_BYTE, this.fog);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fogW, fogH, gl.RED, gl.UNSIGNED_BYTE, this.fog);
    gl.uniform2f(this.uniform('uMapM'), state.map.width * TILE_M, state.map.height * TILE_M);
    gl.uniform2f(this.uniform('uOriginM'), cam.x * TILE_M, cam.y * TILE_M);
    const ppm = TILE_PX * cam.zoom / TILE_M;
    gl.uniform2f(this.uniform('uViewM'), VIEW_W / ppm, VIEW_H / ppm);
    gl.uniform1f(this.uniform('uStepM'), TILE_M / field.res);
    gl.uniform1f(this.uniform('uMaxHeight'), this.maxHeight);
    gl.uniform1f(this.uniform('uBoundStepM'), this.boundStepM);
    const active = lights.filter(l => l.pos.x + l.radiusM >= cam.x * TILE_M && l.pos.x - l.radiusM <= cam.x * TILE_M + VIEW_W / ppm &&
      l.pos.y + l.radiusM >= cam.y * TILE_M && l.pos.y - l.radiusM <= cam.y * TILE_M + VIEW_H / ppm)
      .sort((a, b) => b.strength - a.strength || a.id - b.id).slice(0, MAX_LIGHTS);
    active.forEach((l, i) => { this.lightData.set([l.pos.x, l.pos.y, l.pos.z, l.strength], i * 4); this.shapeData.set([l.radiusM, l.sourceRadiusM], i * 2); });
    gl.uniform1i(this.uniform('uLightCount'), active.length);
    gl.uniform4fv(this.uniform('uLights[0]'), this.lightData); gl.uniform2fv(this.uniform('uLightShape[0]'), this.shapeData);
    const useful = boxes.filter(b => active.some(l => Math.hypot(b.position.x - l.pos.x, b.position.y - l.pos.y) <= l.radiusM + 10))
      .sort((a, b) => a.vehicleId - b.vehicleId).slice(0, MAX_BOXES);
    useful.forEach((b, i) => {
      this.boxPositions.set([b.position.x, b.position.y, b.position.z, b.vehicleId], i * 4);
      const q = b.orientation; this.boxQuaternions.set([q.x, q.y, q.z, q.w], i * 4);
      this.boxMin.set([b.min.x, b.min.y, b.min.z], i * 3); this.boxMax.set([b.max.x, b.max.y, b.max.z], i * 3);
    });
    gl.uniform1i(this.uniform('uBoxCount'), useful.length);
    gl.uniform4fv(this.uniform('uBoxPosition[0]'), this.boxPositions); gl.uniform4fv(this.uniform('uBoxQuaternion[0]'), this.boxQuaternions);
    gl.uniform3fv(this.uniform('uBoxMin[0]'), this.boxMin); gl.uniform3fv(this.uniform('uBoxMax[0]'), this.boxMax);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) return false;
    // Chromium can synchronously readPixels when a WebGL canvas is drawn into
    // the battlefield's Canvas. Do that once per updated tiny mask, not on every
    // otherwise unchanged RAF. This also brings that stall into diagnostics.
    this.maskContext.drawImage(this.canvas, 0, 0);
    return true;
  }
}

let gpu: NightGpu | null | undefined;
let fallback: HTMLCanvasElement | undefined;
let fallbackContext: CanvasRenderingContext2D | null | undefined;
let fallbackImage: ImageData | undefined;
let lastMask: CanvasImageSource | undefined;
let previousState: BattleState | undefined;
let previousKey = '';
let lastPassMs = 0;
let backend: 'webgl2' | 'canvas' | 'uninitialized' = 'uninitialized';

/** Diagnostics only. Includes the once-per-update Canvas copy/readback stall;
 * it is still wall-clock pass cost, not a GPU timer-query measurement. */
export function nightLightingDiagnostics(): { backend: string; cpuPassMs: number; width: number; height: number; sourceSamples: number; floatLinear: boolean } {
  return { backend, cpuPassMs: lastPassMs, width: backend === 'webgl2' ? GPU_W : CPU_W, height: backend === 'webgl2' ? GPU_H : CPU_H,
    sourceSamples: backend === 'webgl2' ? NIGHT_EMITTER_OFFSETS.length : 5, floatLinear: backend === 'webgl2' && !!gpu?.linearSampling };
}

function cpuMask(state: BattleState, cam: Camera, viewer: Side, boxes: readonly NightOccluder[]): CanvasImageSource | null {
  const field = state.map.heightField; if (!field) return null;
  if (!fallback) {
    fallback = document.createElement('canvas'); fallback.width = CPU_W; fallback.height = CPU_H;
    fallbackContext = fallback.getContext('2d'); fallbackImage = fallbackContext?.createImageData(CPU_W, CPU_H);
  }
  if (!fallbackContext || !fallbackImage) return null;
  // A render-only view prevents silhouettes of undiscovered live hulls appearing
  // in the fallback. It is never passed to simulation stepping or perception.
  const displayState: BattleState = { ...state, vehicles: new Map(Array.from(state.vehicles).filter(([, v]) => shownVehicle(state, viewer, v))) };
  const illumination = prepareIllumination(displayState, lightSources(state));
  const ppm = TILE_PX * cam.zoom / TILE_M, data = fallbackImage.data;
  const eyeDir = { x: 0, y: -TILT, z: -1 };
  for (let y = 0; y < CPU_H; y++) for (let x = 0; x < CPU_W; x++) {
    const mx = cam.x * TILE_M + (x + .5) / CPU_W * VIEW_W / ppm, my = cam.y * TILE_M + (y + .5) / CPU_H * VIEW_H / ppm;
    const tx = mx / TILE_M, ty = my / TILE_M;
    let p = { x: mx, y: my, z: Math.max(heightAt(field, tx, ty), groundAt(field, tx, ty) + canopyAt(field, tx, ty)) + .16 };
    const eyeHeight = p.z + 200, eye = { x: mx, y: my + TILT * eyeHeight, z: eyeHeight };
    let receiverId: number | undefined, nearest = Infinity;
    for (const box of boxes) {
      const t = nightBoxHit(eye, eyeDir, box);
      if (t < nearest && t < eyeHeight - groundAt(field, tx, ty) + 1) {
        nearest = t; p = { x: eye.x, y: eye.y + eyeDir.y * t, z: eye.z - t + .16 }; receiverId = box.vehicleId;
      }
    }
    const amount = illumination(p, receiverId);
    const light = Math.sqrt(Math.max(0, (amount - NIGHT_AMBIENT) / (1 - NIGHT_AMBIENT)));
    const fog = nightFogAt(state, viewer, tx, ty), exposure = fog === 'visible' ? 1 : fog === 'remembered' ? .435 : .2;
    const index = (y * CPU_W + x) * 4;
    for (let c = 0; c < 3; c++) data[index + c] = Math.round(255 * (AMBIENT_RGB[c] + (WARM_RGB[c] - AMBIENT_RGB[c]) * light) * exposure);
    data[index + 3] = 255;
  }
  fallbackContext.putImageData(fallbackImage, 0, 0); return fallback;
}

function drawIlluminationShots(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, viewer: Side): void {
  const field = state.map.heightField!;
  for (const shot of state.illuminationShots ?? []) {
    const f = (state.time - shot.firedAt) / Math.max(.01, shot.burstAt - shot.firedAt);
    if (f < 0 || f >= 1) continue;
    const at = (t: number): Vec3 => ({ x: (shot.from.x + (shot.target.x - shot.from.x) * t) * TILE_M,
      y: (shot.from.y + (shot.target.y - shot.from.y) * t) * TILE_M,
      z: heightAt(field, shot.from.x, shot.from.y) * (1 - t) + (groundAt(field, shot.target.x, shot.target.y) + shot.altitudeM) * t + Math.sin(t * Math.PI) * 16 });
    const world = at(f);
    if (shot.side !== viewer && nightFogAt(state, viewer, world.x / TILE_M, world.y / TILE_M) !== 'visible') continue;
    const p = projectNightPoint(cam, world), tail = projectNightPoint(cam, at(Math.max(0, f - .018)));
    ctx.strokeStyle = 'rgba(194,180,127,.65)'; ctx.lineWidth = Math.max(.7, cam.zoom); ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.fillStyle = '#e3d4a3'; ctx.fillRect(p.x - .75 * cam.zoom, p.y - .75 * cam.zoom, cam.zoom * 1.5, cam.zoom * 1.5);
  }
}

function drawFlares(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, lights: readonly RenderFlare[]): void {
  const ppm = TILE_PX * cam.zoom / TILE_M;
  ctx.save(); ctx.imageSmoothingEnabled = true;
  for (const l of lights) {
    const p = projectNightPoint(cam, l.pos), energy = Math.min(1, l.strength / Math.max(.01, l.flare.intensity));
    if (p.x < -80 || p.x > VIEW_W + 80 || p.y < -100 || p.y > VIEW_H + 80) continue;
    // Older burning positions sit higher and drift gently with the same authored
    // wind. These motes are cosmetic, analytic in sim time, and consume no RNG.
    for (let i = 12; i >= 1; i--) {
      const age = i * .65, old = flarePose(state, l.flare, state.time - age); if (!old) continue;
      const drift = state.time * .9 + l.flare.id * 1.7 + i;
      const smoke = projectNightPoint(cam, { x: old.pos.x + Math.sin(drift) * i * .055 + l.flare.wind.x * age,
        y: old.pos.y + Math.cos(drift * .7) * i * .045 + l.flare.wind.y * age, z: old.pos.z + age * .15 });
      const r = (0.22 + i * .055) * ppm;
      const mist = ctx.createRadialGradient(smoke.x, smoke.y, 0, smoke.x, smoke.y, r);
      mist.addColorStop(0, `rgba(215,190,155,${.055 * energy * (1 - i / 16)})`); mist.addColorStop(1, 'rgba(170,184,205,0)');
      ctx.fillStyle = mist; ctx.fillRect(smoke.x - r, smoke.y - r, r * 2, r * 2);
    }
    const swing = Math.sin(state.time * .65 + l.flare.id) * .24;
    const canopy = projectNightPoint(cam, { x: l.pos.x + swing, y: l.pos.y + .25, z: l.pos.z + 6 });
    const r = Math.max(3, ppm * .62);
    ctx.globalAlpha = energy * .8; ctx.strokeStyle = '#b9b2a3'; ctx.lineWidth = Math.max(.55, cam.zoom * .65);
    for (const edge of [-1, -.35, .35, 1]) { ctx.beginPath(); ctx.moveTo(canopy.x + edge * r, canopy.y); ctx.lineTo(p.x, p.y - 1); ctx.stroke(); }
    ctx.fillStyle = '#b7afa0'; ctx.beginPath(); ctx.ellipse(canopy.x, canopy.y, r, r * .47, swing * .4, Math.PI, Math.PI * 2); ctx.lineTo(canopy.x + r, canopy.y + r * .12); ctx.quadraticCurveTo(canopy.x, canopy.y - r * .17, canopy.x - r, canopy.y + r * .12); ctx.fill();
    ctx.strokeStyle = '#e8d3aa'; ctx.lineWidth = .7; ctx.beginPath(); ctx.ellipse(canopy.x, canopy.y, r, r * .47, swing * .4, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'screen';
    const glare = (13 + Math.sin(state.time * 9 + l.flare.id) * 1.1) * cam.zoom;
    const halo = ctx.createRadialGradient(p.x, p.y, .5, p.x, p.y, glare);
    halo.addColorStop(0, `rgba(255,248,211,${energy})`); halo.addColorStop(.12, `rgba(255,214,126,${.8 * energy})`);
    halo.addColorStop(.38, `rgba(255,161,62,${.22 * energy})`); halo.addColorStop(1, 'rgba(255,135,48,0)');
    ctx.fillStyle = halo; ctx.fillRect(p.x - glare, p.y - glare, glare * 2, glare * 2);
    ctx.strokeStyle = `rgba(255,237,182,${.55 * energy})`; ctx.lineWidth = .6;
    ctx.beginPath(); ctx.moveTo(p.x - glare * .65, p.y); ctx.lineTo(p.x + glare * .65, p.y); ctx.moveTo(p.x, p.y - glare * .4); ctx.lineTo(p.x, p.y + glare * .4); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

/** After world objects/effects, before targeting lines and HUD. The one mask
 * covers both the Canvas terrain and the 3D vehicle layer. A paused scene is
 * stable; camera movement re-renders immediately; simulation keeps its fixed
 * clock even when GPU quality, browser frame rate, or fallback changes. */
export function drawNightLighting(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, viewer: Side): void {
  if (state.config.timeOfDay !== 'night') return;
  // Physical fields must be prepared by simulation creation/restoration. A
  // renderer must never lazily initialize canonical terrain while drawing.
  if (!state.map.heightField) { ctx.save(); ctx.fillStyle = 'rgba(9,17,34,.7)'; ctx.fillRect(0, 0, VIEW_W, VIEW_H); ctx.restore(); return; }
  const lights = lightSources(state);
  const cadence = gpu === null ? 5 : 20;
  const key = `${cam.x}/${cam.y}/${cam.zoom}/${viewer}/${Math.floor(state.time * cadence)}/${state.map.heightField.version}/${state.flares?.length ?? 0}`;
  if (previousState !== state || previousKey !== key || !lastMask) {
    const began = performance.now(), boxes = nightOccluders(state, viewer);
    if (gpu === undefined) {
      try { gpu = new URLSearchParams(location.search).get('nightLighting') === 'canvas' ? null : new NightGpu(); }
      catch (error) { gpu = null; console.info('[night] Canvas lighting fallback:', error instanceof Error ? error.message : error); }
    }
    let rendered = false;
    if (gpu) {
      try { rendered = gpu.draw(state, cam, viewer, lights, boxes); }
      catch (error) { console.info('[night] WebGL lighting failed; using Canvas:', error); }
      if (rendered) { lastMask = gpu.mask; backend = 'webgl2'; }
      else gpu = null;
    }
    if (!rendered) { lastMask = cpuMask(state, cam, viewer, boxes) ?? undefined; backend = 'canvas'; }
    previousState = state; previousKey = key; lastPassMs = performance.now() - began;
  }
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VIEW_W, VIEW_H); ctx.clip();
  if (lastMask) { ctx.globalCompositeOperation = 'multiply'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(lastMask, 0, 0, VIEW_W, VIEW_H); }
  ctx.globalCompositeOperation = 'source-over'; drawIlluminationShots(ctx, cam, state, viewer); drawFlares(ctx, cam, state, flaresFor(state)); ctx.restore();
}
