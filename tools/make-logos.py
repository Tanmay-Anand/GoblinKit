"""Derive GoblinKit's web-sized logo marks from the two source logos.

The sources in assets/logo/ are the originals and are never edited:

    GoblinKit-transparent-logo.png   the mark on transparency, 612x408
    GoblinKit-logo.png               the mark on solid white, 1536x1024

Both carry most of their area as margin, and the solid one is ~1 MB, so they
are trimmed here rather than shipped as-is. The two outputs have different
jobs, which is why both exist:

    goblinkit-mark.png         transparent, for light backgrounds. Its outlines
                               are dark grey, so on a dark page they vanish.
    goblinkit-mark-solid.png   the solid mark on a rounded white tile, for dark
                               backgrounds, where the tile keeps the outlines
                               legible.

    python tools/make-logos.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

LOGO_DIR = Path(__file__).resolve().parent.parent / "assets" / "logo"
TRANSPARENT_SRC = LOGO_DIR / "GoblinKit-transparent-logo.png"
SOLID_SRC = LOGO_DIR / "GoblinKit-logo.png"

WIDTH = 480  # 2x the width the README shows it at, so it stays sharp on HiDPI


def pad_box(box, size, frac):
    """Grow a bbox by a fraction of its larger side, clamped to the image."""
    l, t, r, b = box
    p = round(max(r - l, b - t) * frac)
    return max(0, l - p), max(0, t - p), min(size[0], r + p), min(size[1], b + p)


def fit_width(img, width):
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def transparent_mark():
    src = Image.open(TRANSPARENT_SRC).convert("RGBA")
    box = pad_box(src.getchannel("A").getbbox(), src.size, 0.04)
    # The source is only ~270px of actual mark, so it is trimmed but never
    # upscaled: enlarging it would only soften the edges.
    out = src.crop(box)
    if out.width > WIDTH:
        out = fit_width(out, WIDTH)
    return out


def solid_mark():
    src = Image.open(SOLID_SRC).convert("RGB")
    # Near-white rather than exact white: the background is 254/255 noise, and
    # an exact match would take the whole canvas as "content".
    ink = src.convert("L").point(lambda v: 255 if v < 240 else 0)
    box = pad_box(ink.getbbox(), src.size, 0.12)
    tile = fit_width(src.crop(box), WIDTH).convert("RGBA")

    # Rounded corners, so on a dark page the white reads as a deliberate tile
    # rather than a pasted rectangle.
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, tile.width - 1, tile.height - 1],
                                           radius=round(tile.width * 0.06), fill=255)
    tile.putalpha(mask)
    return tile


if __name__ == "__main__":
    for name, img in (("goblinkit-mark.png", transparent_mark()),
                      ("goblinkit-mark-solid.png", solid_mark())):
        out = LOGO_DIR / name
        img.save(out, "PNG", optimize=True)
        print(f"{out}  {img.size[0]}x{img.size[1]}  {out.stat().st_size // 1024} KB")
