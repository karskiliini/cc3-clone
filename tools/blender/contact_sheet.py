#!/usr/bin/env python3
"""Contact sheets for the sprite atlases, composited over the game's painted ground.

  python3 tools/blender/contact_sheet.py --atlas soldiers_german_summer_1 [--only standing.*,prone.aim]
          [--mode dirs|frames] [--frame 0] [--mag 4] [--per-page 6] [--out ref/wf21]

mode dirs   : per entry, all directions of one frame: a 1x line on grass and on snow, then the
              same at --mag (default 4x at scale 1, 2x at scale 2) on the season's backdrop.
mode strip  : compact, one row per entry: every direction of one frame at --mag (label at left).
mode frames : per entry, every frame for a few directions at --mag (checks the animation).
Backdrops are crops of ref/wf18/full_steppe_grass_z1.png and ref/wf18/full_moscow_snow_z1.png
(scaled 2x for scale-2 atlases, as the game does at zoom 2).  Works for any atlas following
the contract (soldiers, vehicles, weapons).
"""
import argparse
import fnmatch
import json
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GRASS = os.path.join(ROOT, "ref/wf18/full_steppe_grass_z1.png")
SNOW = os.path.join(ROOT, "ref/wf18/full_moscow_snow_z1.png")


class Atlas:
    def __init__(self, base):
        self.meta = json.load(open(base + ".json"))
        self.img = Image.open(base + ".png").convert("RGBA")
        self.cw, self.ch = self.meta["cell"]["w"], self.meta["cell"]["h"]

    def cell(self, key, d, f):
        e = self.meta["entries"][key]
        i = e["start"] + d * e["frames"] + f
        cx, cy = i % self.meta["columns"], i // self.meta["columns"]
        return self.img.crop((cx * self.cw, cy * self.ch, (cx + 1) * self.cw, (cy + 1) * self.ch))


CLEAN = {GRASS: (300, 30, 900, 380), SNOW: (590, 170, 990, 390)}   # open-ground crops
_bg_cache = {}


def backdrop(path, scale, w, h, ox=0, oy=0):
    """Open-ground crop, mirror-tiled so any sheet size fits; scaled like the game zoom."""
    if (path, scale) not in _bg_cache:
        im = Image.open(path).convert("RGBA").crop(CLEAN[path])
        if scale > 1:
            im = im.resize((im.width * scale, im.height * scale), Image.BILINEAR)
        tile = Image.new("RGBA", (im.width * 2, im.height * 2))
        tile.paste(im, (0, 0)); tile.paste(im.transpose(Image.FLIP_LEFT_RIGHT), (im.width, 0))
        tile.paste(tile.crop((0, 0, im.width * 2, im.height)).transpose(Image.FLIP_TOP_BOTTOM), (0, im.height))
        _bg_cache[(path, scale)] = tile
    tile = _bg_cache[(path, scale)]
    out = Image.new("RGBA", (w, h))
    ox, oy = ox % tile.width, oy % tile.height
    for yy in range(-oy, h, tile.height):
        for xx in range(-ox, w, tile.width):
            out.paste(tile, (xx, yy))
    return out


def line(atlas, key, frame, dirs, bg_path, scale, seed):
    w, h = atlas.cw * len(dirs), atlas.ch
    bg = backdrop(bg_path, scale, w, h, ox=seed * 37, oy=seed * 91)
    for i, d in enumerate(dirs):
        bg.alpha_composite(atlas.cell(key, d, frame), (i * atlas.cw, 0))
    return bg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True, help="base name under public/sprites, e.g. soldiers_german_summer_1")
    ap.add_argument("--only", default="")
    ap.add_argument("--mode", default="dirs", choices=["dirs", "frames", "strip"])
    ap.add_argument("--frame", default="0")
    ap.add_argument("--mag", type=int, default=0)
    ap.add_argument("--per-page", type=int, default=6)
    ap.add_argument("--out", default=os.path.join(ROOT, "ref/wf21"))
    ap.add_argument("--tag", default="")
    ap.add_argument("--dirs", default="1,5,10,14", help="frames mode: which directions to show")
    a = ap.parse_args()
    at = Atlas(os.path.join(ROOT, "public/sprites", a.atlas))
    scale = at.meta.get("scale", 1)
    mag = a.mag or (4 if scale == 1 else 2)
    winter = "winter" in a.atlas
    main_bg = SNOW if winter else GRASS
    pats = [p for p in a.only.split(",") if p]
    keys = [k for k, e_ in at.meta["entries"].items() if not e_.get("alias")
            and (not pats or any(fnmatch.fnmatch(k, p) or k == p for p in pats))]
    ndirs = at.meta["dirs"]
    os.makedirs(a.out, exist_ok=True)
    pages = []
    for pi in range(0, len(keys), a.per_page):
        blocks = []
        for n, k in enumerate(keys[pi:pi + a.per_page]):
            e = at.meta["entries"][k]
            fr = e["frames"] // 2 if a.frame == "mid" else min(int(a.frame), e["frames"] - 1)
            seed = pi + n
            if a.mode == "strip":
                row = line(at, k, fr, list(range(ndirs)), main_bg, scale, seed)
                row = row.resize((row.width * mag, row.height * mag), Image.NEAREST)
                blk = Image.new("RGBA", (170 + row.width, row.height), (30, 30, 34, 255))
                ImageDraw.Draw(blk).text((2, row.height // 2 - 5), f"{k} f{fr}", fill=(230, 230, 230))
                blk.paste(row, (170, 0))
            elif a.mode == "dirs":
                dirs = list(range(ndirs))
                half = (ndirs + 1) // 2
                l1 = line(at, k, fr, dirs, GRASS, scale, seed)
                l2 = line(at, k, fr, dirs, SNOW, scale, seed)
                big = [line(at, k, fr, dirs[:half], main_bg, scale, seed + 1), line(at, k, fr, dirs[half:], main_bg, scale, seed + 2)]
                big = [b.resize((b.width * mag, b.height * mag), Image.NEAREST) for b in big]
                W = max(l1.width + l2.width + 8, big[0].width)
                stack = l1.width + l2.width + 8 > big[0].width
                if stack:
                    W = max(l1.width, big[0].width)
                H = 14 + l1.height * (2 if stack else 1) + 4 + sum(b.height + 2 for b in big)
                blk = Image.new("RGBA", (W, H), (30, 30, 34, 255))
                ImageDraw.Draw(blk).text((2, 1), f"{k}  frame {fr}/{e['frames']}  ({a.atlas})  1x grass | 1x snow, then {mag}x; dirs 0..{ndirs - 1} clockwise from north", fill=(230, 230, 230))
                blk.paste(l1, (0, 14)); blk.paste(l2, (0, 14 + l1.height) if stack else (l1.width + 8, 14))
                y = 14 + l1.height * (2 if stack else 1) + 4
                for b in big:
                    blk.paste(b, (0, y)); y += b.height + 2
            else:
                show = [int(d) for d in a.dirs.split(',') if int(d) < ndirs]
                rows = []
                for d in show:
                    w, h = at.cw * e["frames"], at.ch
                    bg = backdrop(main_bg, scale, w, h, ox=seed * 53 + d * 7, oy=seed * 17)
                    for f in range(e["frames"]):
                        bg.alpha_composite(at.cell(k, d, f), (f * at.cw, 0))
                    rows.append(bg.resize((w * mag, h * mag), Image.NEAREST))
                W = sum(r.width + 6 for r in rows)
                blk = Image.new("RGBA", (W, 14 + rows[0].height), (30, 30, 34, 255))
                ImageDraw.Draw(blk).text((2, 1), f"{k}  all {e['frames']} frames at dirs {show}  {mag}x ({a.atlas})", fill=(230, 230, 230))
                x = 0
                for r in rows:
                    blk.paste(r, (x, 14)); x += r.width + 6
            blocks.append(blk)
        W = max(b.width for b in blocks)
        H = sum(b.height + 6 for b in blocks)
        page = Image.new("RGBA", (W, H), (30, 30, 34, 255))
        y = 0
        for b in blocks:
            page.paste(b, (0, y)); y += b.height + 6
        tag = a.tag or (pats[0].replace("*", "").strip(".") if pats else "all")
        path = os.path.join(a.out, f"{a.atlas}_{a.mode}_{tag}_{pi // a.per_page:02d}.png")
        page.convert("RGB").save(path)
        pages.append(path)
    print("\n".join(pages))


if __name__ == "__main__":
    main()
