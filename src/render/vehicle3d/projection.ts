// ============================================================================
// The 2D map's mapping as a 4x4 matrix for three.js. World = metres, x east,
// y up, z south. Ground maps exactly as worldToScreen does (10 px/m x zoom);
// height lifts a point z*sin(12 deg)*ppm up the screen, like the Blender sprite
// camera (orthographic, tilted 12 deg from vertical, south of the subject).
// Pure math, no three import: tested in Node.
// ============================================================================
import type { Vec2 } from '@/shared/types';
import { TILE_M, TILE_PX } from '@/shared/types';

export const TILT_RAD = (12 * Math.PI) / 180;
/** depth range (m) either side of the view centre mapped onto clip -1..1 */
export const DEPTH_RANGE_M = 500;
/** unit vector towards the sun: azimuth 315 deg (NW), elevation 45 deg (tools/blender/common.py) */
export const SUN_TO: readonly [number, number, number] = [-0.5, Math.SQRT1_2, -0.5];

export interface ViewCam { x: number; y: number; zoom: number }

export function worldPoint(posTiles: Vec2, heightM = 0): [number, number, number] {
  return [posTiles.x * TILE_M, heightM, posTiles.y * TILE_M];
}

/** world -> clip, column-major (three.js Matrix4.elements). */
export function viewProjection(cam: ViewCam, viewW: number, viewH: number): number[] {
  const ppm = (TILE_PX * cam.zoom) / TILE_M;
  const s = Math.sin(TILT_RAD), c = Math.cos(TILT_RAD), R = DEPTH_RANGE_M;
  const cx = cam.x * TILE_M, cy = cam.y * TILE_M;
  const zc = cy + viewH / (2 * ppm);
  const a = (2 * ppm) / viewW, b = (2 * ppm) / viewH;
  const r0 = [a, 0, 0, -a * cx - 1];
  const r1 = [0, b * s, -b, 1 + b * cy];
  const r2 = [0, -c / R, -s / R, (zc * s) / R];
  const r3 = [0, 0, 0, 1];
  return [0, 1, 2, 3].flatMap((col) => [r0[col], r1[col], r2[col], r3[col]]);
}

export function toScreen(m: number[], p: [number, number, number], viewW: number, viewH: number): { x: number; y: number; depth: number } {
  const [X, Y, Z] = p;
  const nx = m[0] * X + m[4] * Y + m[8] * Z + m[12];
  const ny = m[1] * X + m[5] * Y + m[9] * Z + m[13];
  const nz = m[2] * X + m[6] * Y + m[10] * Z + m[14];
  return { x: ((nx + 1) * viewW) / 2, y: ((1 - ny) * viewH) / 2, depth: nz };
}

/** Flattens geometry onto the ground (y = 0.002) along the sun's rays. Column-major. */
export function shadowMatrix(): number[] {
  const kx = -SUN_TO[0] / SUN_TO[1], kz = -SUN_TO[2] / SUN_TO[1];
  const r0 = [1, kx, 0, 0];
  const r1 = [0, 0, 0, 0.002];
  const r2 = [0, kz, 1, 0];
  const r3 = [0, 0, 0, 1];
  return [0, 1, 2, 3].flatMap((col) => [r0[col], r1[col], r2[col], r3[col]]);
}

/** Hull-local metres (x right, y forward) -> world [east, south] metres for a hull facing hullRad. */
export function localToWorldXZ(localX: number, localY: number, hullRad: number): [number, number] {
  const c = Math.cos(hullRad), s = Math.sin(hullRad);
  return [localX * c + localY * s, localX * s - localY * c];
}
