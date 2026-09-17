"""Ground items atlas (spec section 9): period kit lying on the ground, 16 directions each.

  blender -b -P tools/blender/items.py -- [--scale 1|2|all] [--only id,id] [--samples 8]

Writes public/sprites/items_<scale>.png/.json in the atlas contract format, entry keys
`item.<id>` (1 frame, 16 dirs; direction 0 = the item's long axis / muzzle pointing north).
The meshes come from kit.py, the same builders that make the gear the soldier sprites carry,
and are enlarged by the same figure scale, so a dropped MG matches the one the gunner held.
"""
import argparse
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402
import kit as K  # noqa: E402
from kit import MeshB, Rx, Ry, Rz, T, S  # noqa: E402
import soldiers as SOL  # noqa: E402  (palettes, figure scale, outline)

OUT_DIR = SOL.OUT_DIR
CELL, ANCHOR, DIRS = 28, (14, 14), 16
BATCH = 8
FIG, HEAD = SOL.FIG, SOL.HEAD


def side_on(mid, z=0.04):
    """Long weapon lying on its side, centred on its middle."""
    return T((0, 0, z)) @ Ry(90) @ T((0, -mid, 0))


# id -> (side palette 'g'|'s', builder(b), placement matrix)
ITEMS = {
    "kar98k": ("g", lambda b: K.w_rifle(b, "kar98k"), side_on(0.24)),
    "mosin": ("s", lambda b: K.w_rifle(b, "mosin"), side_on(0.27)),
    "svt40": ("s", lambda b: K.w_rifle(b, "svt40"), side_on(0.26)),
    "kar98k_scoped": ("g", lambda b: K.w_rifle(b, "kar98k_scoped"), side_on(0.24)),
    "mosin_scoped": ("s", lambda b: K.w_rifle(b, "mosin_scoped"), side_on(0.27)),
    "mp40": ("g", lambda b: K.w_smg(b, True), side_on(0.08)),
    "ppsh41": ("s", lambda b: K.w_smg(b, False), side_on(0.06, 0.05)),
    "mg34": ("g", lambda b: K.w_lmg(b, True), side_on(0.25, 0.06)),
    "dp28": ("s", lambda b: K.w_lmg(b, False), side_on(0.25, 0.06)),
    "pistol": ("g", K.w_pistol, S(1.4) @ side_on(0.04, 0.03)),
    "grenade_stick": ("g", K.w_stick_grenade, S(1.5) @ T((0, -0.03, 0.045))),
    "grenade_egg": ("s", K.w_egg_grenade, S(1.8) @ T((0, 0, 0.042))),
    "panzerfaust": ("g", K.w_panzerfaust, T((0, -0.08, 0.085))),
    "panzerschreck": ("g", K.w_panzerschreck, T((0, 0, 0.06)) @ Ry(90)),
    "ptrd": ("s", K.w_ptrd, side_on(0.48, 0.05)),
    "satchel": ("g", K.w_satchel, T((0, 0, 0.05))),
    "ammo_pouch": ("g", lambda b: K.k_pouch(b, True), S(1.4) @ T((0, 0, 0.03)) @ Rx(-90)),
    "ammo_box": ("g", K.w_ammo_box, T((0, 0, 0.075))),
    "belt_box": ("g", K.w_belt_box, T((0, -0.08, 0))),
    "mortar_bomb": ("g", K.w_mortar_bomb, T((0, 0.05, 0.05)) @ Rx(-90)),
    "helmet_german": ("g", lambda b: K.k_helmet(b, True), S(HEAD) @ T((0, -0.005, -0.065))),
    "helmet_soviet": ("s", lambda b: K.k_helmet(b, False), S(HEAD) @ T((0, -0.005, -0.09))),
    "backpack": ("g", lambda b: K.k_pack(b, True), T((0, -0.22, -0.10)) @ Rx(-90)),
    "backpack_soviet": ("s", lambda b: K.k_pack(b, False), T((0, -0.17, -0.07)) @ Rx(-90)),
    "bread_bag": ("g", K.k_breadbag, T((0, 0, 0.04)) @ Rx(-90)),
    "greatcoat_roll": ("s", K.k_greatcoat_roll, T((0, 0, 0.06)) @ Ry(-52) @ T((0, 0, -0.20))),
    "entrenching_tool": ("g", K.k_tool, T((0, -0.10, 0.02)) @ Rx(-90)),
    "canteen": ("g", lambda b: K.k_canteen(b, True), T((0, 0, 0.045)) @ Rx(-90)),
    "canteen_soviet": ("s", lambda b: K.k_canteen(b, False), T((0, 0, 0.045)) @ Rx(-90)),
    "binoculars": ("g", K.k_binoculars, S(1.4) @ T((0, 0, 0.04))),
    "map_case": ("s", K.k_mapcase, T((0, 0, 0.02))),
}
# other ids the game may ask for, drawn with the nearest model
ALIASES = {"mg42": "mg34", "pistol_p38": "pistol", "pistol_tt": "pistol", "grenade": "grenade_stick",
           "grenade_german": "grenade_stick", "grenade_soviet": "grenade_egg", "rolled_greatcoat": "greatcoat_roll",
           "helmet": "helmet_german", "at_rifle": "ptrd", "semi_auto_rifle": "svt40", "mg_belt_box": "belt_box"}


def build(scale, only, samples):
    ids = [i for i in ITEMS if not only or i in only]
    cell = CELL * scale
    anchor = (ANCHOR[0] * scale, ANCHOR[1] * scale)
    packer = C.AtlasPacker(scale, cell, cell, anchor, DIRS, columns=16)
    t0 = time.time()
    for b0 in range(0, len(ids), BATCH):
        batch = ids[b0:b0 + BATCH]
        ctx = C.setup_scene(10 * scale, cell, cell, anchor=anchor, grid=(DIRS, len(batch)), samples=samples)
        for pre, key in (("g_", ("german", "summer")), ("s_", ("soviet", "summer"))):
            for role, (col, rough) in SOL.PALETTES[key].items():
                C.make_material(pre + role, col, roughness=rough, metallic=0.6 if role == "metal" else 0.0)
        for r, iid in enumerate(batch):
            pal, fn, place = ITEMS[iid]
            mb = MeshB(iid, prefix=pal + "_")
            mb.xf = S(FIG) @ place
            fn(mb)
            me = mb.finish()
            for d in range(DIRS):
                o = bpy.data.objects.new(f"{iid}_{d}", me)
                ctx.scene.collection.objects.link(o)
                x, y = ctx.cell_origin(d, r)
                o.matrix_world = T((x, y, 0)) @ Matrix.Rotation(C.dir_angle(d, DIRS), 4, "Z")
        cells = C.render_grid(ctx)
        for r, iid in enumerate(batch):
            packer.add("item." + iid, [[SOL.add_outline(cells[r][d], SOL.OUTLINE_ALPHA * 0.8)] for d in range(DIRS)], fps=0, loop=False)
    base = os.path.join(OUT_DIR, f"items_{scale}")
    meta = packer.save(base, extra=dict(pxPerM=10 * scale, figureScale=FIG))
    if not only:
        import json
        for al, k in ALIASES.items():
            meta["entries"]["item." + al] = dict(meta["entries"]["item." + k], alias="item." + k)
        json.dump(meta, open(base + ".json", "w"), indent=1)
    print(f"[items_{scale}] {len(ids)} items in {time.time() - t0:.1f}s", flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="items.py")
    ap.add_argument("--scale", default="all", choices=["1", "2", "all"])
    ap.add_argument("--only", default="")
    ap.add_argument("--samples", type=int, default=12)
    a = ap.parse_args(argv)
    for sc in ([1, 2] if a.scale == "all" else [int(a.scale)]):
        build(sc, [i for i in a.only.split(",") if i], a.samples)


if __name__ == "__main__":
    main()
