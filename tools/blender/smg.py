"""Supplementary SMG firing atlas with planted legs and independent upper-body aim.

  blender -b -P tools/blender/smg.py -- --jobs 2

Uses the original soldier rig, kit, lighting and grading. Each complete-figure entry
has 16 BODY headings and three recoil frames: rest, kick, recovery. Upper-body
twists are clockwise relative to that heading; no layering seam is introduced.
"""
import argparse
import fnmatch
import json
import math
import os
import subprocess
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import soldiers as S
import common as C

TWISTS = (-40, -20, 0, 20, 40)
PRONE_TWISTS = (-20, -10, 0, 10, 20)
FRAMES = ("rest", "kick", "recovery")
UPPER = ("chest", "head", "uarmL", "uarmR", "farmL", "farmR", "handL", "handR", "weapon")
LOWER = ("pelvis", "thighL", "thighR", "shinL", "shinR", "footL", "footR")


def firing_pose(posture, mode, frame):
    """Keep the shoulder stock pocket for aimed fire; support a low stock for hip fire.

    Recoil moves the chest, arms and gun only. The forward leg/knee and both feet
    remain planted. Hip elbows have ample bend, with the left hand bracing the
    fore-end and the right hand pulling the grip toward the ribs.
    """
    kick = (0.0, 1.0, 0.32)[frame]
    recoil = (0.022 if posture == "prone" else 0.042) * kick
    lift = (0.065 if posture == "prone" else 0.125) * kick
    p = S.aimed(posture, "smg", recoil=recoil, lift=lift)
    if mode == "hip":
        assert posture != "prone"
        c = p["chest_rot"]
        # Lean into automatic fire. The lower body never receives this motion.
        p["chest_rot"] = (c[0] + 9 - 4 * kick, c[1], c[2])
        neutral = S.solve(p, "smg")
        shoulder = neutral["chest"] @ S.SHOULDER
        p["weapon"] = dict(frame="root",
                           pos=tuple(shoulder + Vector((-0.14, 0.18 - 0.075 * kick, -0.255 + 0.025 * kick))),
                           rot=(12 * kick, 0, 0))
        p["handR"] = dict(frame="w", pos="grip", pole=(0.8, -0.8, -0.7), pole_frame="root")
        p["handL"] = dict(frame="w", pos="fore", pole=(-0.7, -0.3, -1), pole_frame="root")
    return p


def pose_matrices(posture, mode, twist, frame):
    p = firing_pose(posture, mode, frame)
    mats = S.solve(p, "smg")
    # Rotate about WORLD vertical at the waist, rather than the tilted chest's
    # local Z (which would roll a prone soldier sideways). Positive game heading
    # is clockwise from north; Blender positive Z is counterclockwise.
    pivot = mats["pelvis"] @ S.CHEST_PIVOT
    upper_rotation = S.T(pivot) @ S.Rz(-twist) @ S.T(-pivot)
    # Look along the gun, with a slight cheek tilt only when using the sights.
    # Preserve the neck position from the anatomically solved chest pose.
    head = S.Ry(10 if mode == "aimed" else 0) @ S.Rx(-5)
    head.translation = mats["head"].translation
    mats["head"] = head
    for part in UPPER:
        mats[part] = upper_rotation @ mats[part]
    return mats


def build_entries():
    return {
        f"{posture}.{mode}.twist{i}": (posture, mode, angle)
        for posture in S.POSTURES
        for mode in (("aimed",) if posture == "prone" else ("aimed", "hip"))
        for i, angle in enumerate(PRONE_TWISTS if posture == "prone" else TWISTS)
    }


def muzzle_points(side, posture, mode, twist):
    """Actual barrel endpoint in figure-scaled metres: +x right, +y forward, +z up.

    Coordinates already include each entry's torso twist, but not atlas body
    direction. Rotate XY by the selected clockwise body heading at runtime.
    """
    local = Vector((0, 0.50, 0.015) if side == "german" else (0, 0.47, 0.02))
    points = []
    for frame in range(3):
        point = (pose_matrices(posture, mode, twist, frame)["weapon"] @ local) * S.FIG
        points.append({axis: round(value, 5) for axis, value in zip(("x", "y", "z"), point)})
    return points


def validate_poses():
    """Geometric checks catch lower-body motion and aim-sign mistakes before rendering."""
    for posture in S.POSTURES:
        rest = pose_matrices(posture, "aimed", 0, 0)
        for mode in (("aimed",) if posture == "prone" else ("aimed", "hip")):
            for angle in (PRONE_TWISTS if posture == "prone" else TWISTS):
                for frame in range(3):
                    mats = pose_matrices(posture, mode, angle, frame)
                    for part in LOWER:
                        assert max(abs(x - y) for ra, rb in zip(rest[part], mats[part])
                                   for x, y in zip(ra, rb)) < 1e-6, (posture, mode, part)
                    direction = mats["weapon"].to_3x3() @ Vector((0, 1, 0))
                    heading = math.degrees(math.atan2(direction.x, direction.y))
                    assert abs(heading - angle) < 0.001, (posture, mode, angle, heading)
    print("SMG pose checks passed: planted lower body and barrel heading in all 105 poses", flush=True)


def render_atlas(side, season, scale, only, force, pack_only, samples):
    name = f"smg_{side}_{season}_{scale}"
    cache = os.path.join(S.CACHE_DIR, name)
    os.makedirs(cache, exist_ok=True)
    entries = build_entries()
    cell, anchor = S.CELL * scale, tuple(v * scale for v in S.ANCHOR)
    todo = [k for k in entries if not pack_only
            and (not only or any(fnmatch.fnmatch(k, pat) or k.startswith(pat) for pat in only))
            and (force or only or not os.path.exists(os.path.join(cache, k + ".png")))]
    t0 = time.monotonic()
    if todo:
        ctx = C.setup_scene(10 * scale, cell, cell, anchor=anchor, grid=(S.DIRS, 3), samples=samples)
        S.soldier_look(ctx, side, season)          # same lights, uniforms and matt cloth as the soldier atlases
        meshes = S.build_meshes(side)
        coll = bpy.data.collections.new("smg_rigs")
        ctx.scene.collection.children.link(coll)
        rigs = [[S.Rig(meshes, coll, ctx.cell_origin(d, f, exact=True), d)
                 for d in range(S.DIRS)] for f in range(3)]
        for n, key in enumerate(todo):
            posture, mode, angle = entries[key]
            t1 = time.monotonic()
            for frame in range(3):
                mats = pose_matrices(posture, mode, angle, frame)
                for rig in rigs[frame]:
                    rig.apply(mats, "smg")
            cells = C.render_grid(ctx)
            strip = np.zeros((3 * cell, S.DIRS * cell, 4), dtype=np.uint8)
            for frame in range(3):
                for d in range(S.DIRS):
                    image = S.add_outline(cells[frame][d], S.OUTLINE_ALPHA)
                    opaque = (image[..., 3] > 200) & (image[..., :3].max(axis=2) > 46)
                    if opaque[0, :].any() or opaque[-1, :].any() or opaque[:, 0].any() or opaque[:, -1].any():
                        raise RuntimeError(f"Figure clipped at {name}/{key} direction {d} frame {frame}")
                    strip[frame * cell:(frame + 1) * cell, d * cell:(d + 1) * cell] = image
            C.save_png(os.path.join(cache, key + ".png"), strip)
            print(f"[{name}] {n + 1}/{len(todo)} {key} {time.monotonic() - t1:.2f}s", flush=True)
    render_seconds = time.monotonic() - t0
    packer = C.AtlasPacker(scale, cell, cell, anchor, S.DIRS, columns=S.COLUMNS)
    missing = []
    for key, (posture, mode, angle) in entries.items():
        path = os.path.join(cache, key + ".png")
        if not os.path.exists(path):
            missing.append(key)
            continue
        strip = S.grade(C.load_png(path), scale, S.PALETTE_GAIN.get((side, season), 1.0))
        cells = [[strip[f * cell:(f + 1) * cell, d * cell:(d + 1) * cell]
                  for f in range(3)] for d in range(S.DIRS)]
        packer.add(key, cells, fps=20, loop=False, twistDegrees=angle, fireMode=mode,
                   muzzleBodyM=muzzle_points(side, posture, mode, angle))
    if packer.entries:
        packer.save(os.path.join(S.OUT_DIR, name), extra=dict(
            side=side, season=season, pxPerM=10 * scale, figureScale=S.FIG, tiltDeg=C.TILT_DEG,
            weapons=["smg"], bodyHeading=True, twistDegrees=list(TWISTS),
            proneTwistDegrees=list(PRONE_TWISTS), recoilFrames=list(FRAMES),
            muzzleCoordinateFrame="body-local: x right, y forward, z up; figureScale already applied"),
            webp="lossless")
    print(f"[{name}] rendered {len(todo)} entries in {render_seconds:.1f}s; packed {len(packer.entries)}"
          + (f"; MISSING {len(missing)} entries" if missing else ""), flush=True)
    with open(os.path.join(cache, "_timing.json"), "w") as fh:
        json.dump(dict(atlas=name, rendered=len(todo), seconds=round(render_seconds, 1)), fh)
    if missing and not only:
        raise RuntimeError(f"Incomplete atlas {name}: {missing}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--side", choices=("all", "german", "soviet"), default="all")
    ap.add_argument("--season", choices=("all", "summer", "winter"), default="all")
    ap.add_argument("--scale", choices=("all", "1", "2"), default="all")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--pack-only", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check-poses", action="store_true")
    a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    validate_poses()
    if a.check_poses:
        return
    if a.list:
        for key in build_entries():
            print(key, 3)
        return
    sides = ("german", "soviet") if a.side == "all" else (a.side,)
    seasons = ("summer", "winter") if a.season == "all" else (a.season,)
    scales = (1, 2) if a.scale == "all" else (int(a.scale),)
    pending = [(side, season, scale) for side in sides for season in seasons for scale in scales]
    t0 = time.monotonic()
    if a.jobs > 1 and len(pending) > 1:
        procs = []
        while pending or procs:
            while pending and len(procs) < a.jobs:
                side, season, scale = pending.pop(0)
                cmd = [bpy.app.binary_path, "-b", "-t", str(max(2, (os.cpu_count() or 8) // a.jobs)),
                       "-P", os.path.abspath(__file__), "--", "--side", side, "--season", season,
                       "--scale", str(scale), "--samples", str(a.samples)]
                if a.only:
                    cmd += ["--only", a.only]
                if a.force:
                    cmd += ["--force"]
                if a.pack_only:
                    cmd += ["--pack-only"]
                procs.append(subprocess.Popen(cmd))
            for proc in list(procs):
                code = proc.poll()
                if code is not None:
                    procs.remove(proc)
                    if code:
                        for other in procs:
                            other.terminate()
                        raise RuntimeError(f"Blender atlas job failed with status {code}")
            time.sleep(0.3)
    else:
        for side, season, scale in pending:
            render_atlas(side, season, scale, [p for p in a.only.split(",") if p],
                         a.force, a.pack_only, a.samples)
    print(f"SMG atlases completed in {time.monotonic() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
