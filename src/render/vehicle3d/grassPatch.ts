// ============================================================================
// The 3D grass on the GPU: one InstancedMesh of grass blades and one of wheat
// stalks, drawn in the vehicles' pass so the depth buffer sorts blades and
// hulls both ways. Each instance is a unit blade placed, turned toward its bend
// and scaled; the vertex shader bends it into an arc, the fragment shader
// dithers away the patch's fading edge (the 2x supersample smooths it).
// ============================================================================
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import { MAX_BLADES, type BladeInst, type BladeKind } from './grassField';

/** The shader's bend in TS: a unit-length blade bent into a circular arc of `angle` rad; returns
 * [up, along the bend] at fraction h of its length. */
export function bendPoint(h: number, angle: number): [number, number] {
  if (Math.abs(angle) < 1e-4) return [h, 0];
  return [Math.sin(angle * h) / angle, (1 - Math.cos(angle * h)) / angle];
}

/** A unit blade: width along x (centred), length along y 0..1, facing +z (the way it bends); the
 * vertex colour darkens the base and lightens the tip. */
export function bladeGeometry(kind: BladeKind): BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const shade = (h: number): number => 0.62 + 0.5 * h;
  const row = (h: number, half: number, k = shade(h)): number => {
    const i = pos.length / 3;
    pos.push(-half, h, 0, half, h, 0);
    col.push(k, k, k, k, k, k);
    return i;
  };
  const quad = (a: number, b: number): void => { idx.push(a, a + 1, b, a + 1, b + 1, b); };
  if (kind === 'grass') {
    const r = [row(0, 0.5), row(1 / 3, 0.4), row(2 / 3, 0.25), row(1, 0.04)];
    quad(r[0], r[1]); quad(r[1], r[2]); quad(r[2], r[3]);
  } else {
    const s = [row(0, 0.5), row(0.42, 0.45), row(0.85, 0.4)];
    quad(s[0], s[1]); quad(s[1], s[2]);
    // the ear: wider than the stem and one step lighter
    quad(row(0.85, 1.6, 1.25), row(1, 1.0, 1.3));
  }
  const g = new BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  return g;
}

/** Bends each vertex by its instance's aBendFade.x (bendPoint, in GLSL) and discards fragments by
 * an interleaved-gradient dither below aBendFade.y. */
export function patchBladeShader(sh: { vertexShader: string; fragmentShader: string }): void {
  sh.vertexShader = 'attribute vec2 aBendFade;\nvarying float vFade;\n' + sh.vertexShader
    .replace('#include <beginnormal_vertex>', 'float bendN = aBendFade.x * position.y;\nvec3 objectNormal = vec3(0.0, -sin(bendN), cos(bendN));')
    .replace('#include <begin_vertex>', [
      'float bendA = aBendFade.x;',
      'float bendUp = abs(bendA) < 1e-4 ? position.y : sin(bendA * position.y) / bendA;',
      'float bendAlong = abs(bendA) < 1e-4 ? 0.0 : (1.0 - cos(bendA * position.y)) / bendA;',
      'vec3 transformed = vec3(position.x, bendUp, bendAlong);',
      'vFade = aBendFade.y;',
    ].join('\n'));
  sh.fragmentShader = 'varying float vFade;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', [
    '#include <clipping_planes_fragment>',
    'if (vFade < 1.0 && vFade <= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;',
  ].join('\n'));
}

function bladeMesh(kind: BladeKind, capacity: number): InstancedMesh {
  const g = bladeGeometry(kind);
  g.setAttribute('aBendFade', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  const mat = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  mat.onBeforeCompile = patchBladeShader;
  const m = new InstancedMesh(g, mat, capacity);
  m.name = `grass3d_${kind}`;
  m.count = 0;
  m.visible = false;
  m.frustumCulled = false;            // instances spread far beyond the unit blade's bounds
  m.receiveShadow = true;             // the hull's shadow falls on the blades
  m.setColorAt(0, new Color(1, 1, 1));
  return m;
}

const M = new Matrix4(), Q = new Quaternion(), P = new Vector3(), S = new Vector3(), UP = new Vector3(0, 1, 0), C = new Color();

export class GrassLayer {
  readonly grass: InstancedMesh;
  readonly wheat: InstancedMesh;

  constructor(private readonly capacity = MAX_BLADES) {
    this.grass = bladeMesh('grass', capacity);
    this.wheat = bladeMesh('wheat', capacity);
  }

  /** This frame's blades (bladesFor), past the capacity dropped. */
  update(blades: readonly BladeInst[]): void {
    const n = { grass: 0, wheat: 0 };
    for (const b of blades) {
      const mesh = b.kind === 'wheat' ? this.wheat : this.grass, i = n[b.kind];
      if (i >= this.capacity) continue;
      // local +z (the bend) turned onto (dirX, dirZ); y = length squashed by heightScale
      Q.setFromAxisAngle(UP, Math.atan2(b.dirX, b.dirZ));
      M.compose(P.set(b.xM, 0, b.zM), Q, S.set(b.widthM, b.heightM * b.heightScale, b.heightM));
      mesh.setMatrixAt(i, M);
      mesh.setColorAt(i, C.setHex(b.colour));
      (mesh.geometry.getAttribute('aBendFade') as InstancedBufferAttribute).setXY(i, b.angle, b.fade);
      n[b.kind] = i + 1;
    }
    for (const [mesh, count] of [[this.grass, n.grass], [this.wheat, n.wheat]] as const) {
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute('aBendFade').needsUpdate = true;
    }
  }

  clear(): void {
    for (const m of [this.grass, this.wheat]) { m.count = 0; m.visible = false; }
  }
}
