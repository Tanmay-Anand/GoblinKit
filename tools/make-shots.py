"""Render GoblinKit's CLI output as capture frames.

Rendered rather than photographed, for three reasons: a screenshot of a
terminal is a picture of a picture and goes soft the moment it is scaled, the
text here stays selectable-crisp at 1920px, and this needs no window manager,
no network and no fonts to download.

Every character in FRAMES below is the verbatim output of the command above
it, run against `examples/order-triage.json`. A capture that shows something
the program does not print is a lie with a nicer font, so when the CLI's
output changes, re-run this rather than editing the picture. The logo in the
title bar is window chrome, like a terminal tab's icon, not program output.

    python tools/make-logos.py    # once, if assets/logo/goblinkit-mark.png is missing
    python tools/make-shots.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1200
BG, PANEL, BAR, EDGE = "#0b0c0e", "#121317", "#191b20", "#23252b"
FG, DIM, GREEN, BLUE, AMBER = "#d7dae0", "#6f737d", "#7fa650", "#5b8dd9", "#cf9b4b"
KEY, STR, NUM = "#9aa0ac", "#a8894f", "#7aa2c9"

# Cascadia Mono is what Windows Terminal ships with, and unlike Consolas it
# has the arrow, the loop and the tick the CLI actually prints — which would
# otherwise render as three empty boxes.
FONT_DIR = Path("C:/Windows/Fonts")
font = ImageFont.truetype(str(FONT_DIR / "CascadiaMono.ttf"), 25)
bold = ImageFont.truetype(str(FONT_DIR / "CascadiaMono.ttf"), 25)
small = ImageFont.truetype(str(FONT_DIR / "CascadiaMono.ttf"), 19)

# Pillow does no font fallback: a glyph the chosen face lacks is drawn as an
# empty box rather than borrowed from another font. Cascadia Mono has the
# arrow and the tick but not the loop, so that one character is drawn from
# Segoe UI Symbol and the rest of the line stays monospaced.
symbol = ImageFont.truetype(str(FONT_DIR / "seguisym.ttf"), 25)
SYMBOL_CHARS = "↻⟳⏲"

LINE_H = 38

# The transparent mark, not the solid one: on the dark title bar a white tile
# would be the brightest thing in the frame, while the transparent mark's pale
# fills read as the goblin and its dark outlines simply recede.
LOGO = Image.open(Path(__file__).resolve().parent.parent / "assets" / "logo" / "goblinkit-mark.png").convert("RGBA")
LOGO_H = 34
LOGO = LOGO.resize((round(LOGO.width * LOGO_H / LOGO.height), LOGO_H), Image.LANCZOS)


def S(text, colour=FG, strong=False):
    return (text, colour, strong)


def _split_by_font(text, base):
    """Split a run of text wherever the face has to change, keeping order."""
    out, buf, buf_symbol = [], "", False
    for ch in text:
        is_symbol = ch in SYMBOL_CHARS
        if buf and is_symbol != buf_symbol:
            out.append((buf, symbol if buf_symbol else base))
            buf = ""
        buf, buf_symbol = buf + ch, is_symbol
    if buf:
        out.append((buf, symbol if buf_symbol else base))
    return out


def render(lines, title, out):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # The panel is sized to its contents rather than to a guess, so a frame
    # with more lines does not spill its last row outside the window.
    pad_x, pad_top, pad_bottom = 46, 100, 46
    panel_w = W - 280
    panel_h = pad_top + LINE_H * len(lines) + pad_bottom
    left = (W - panel_w) // 2
    top = max(60, (H - panel_h) // 2)

    d.rounded_rectangle([left, top, left + panel_w, top + panel_h], radius=14, fill=PANEL, outline=EDGE)
    d.rounded_rectangle([left, top, left + panel_w, top + 60], radius=14, fill=BAR)
    d.rectangle([left, top + 40, left + panel_w, top + 60], fill=BAR)
    d.line([left, top + 60, left + panel_w, top + 60], fill=EDGE)
    for i in range(3):
        cx = left + 26 + i * 26
        d.ellipse([cx, top + 23, cx + 13, top + 36], fill="#34363d")
    img.paste(LOGO, (left + 114, top + 30 - LOGO_H // 2), LOGO)
    d.text((left + 114 + LOGO.width + 12, top + 21), title, font=small, fill=DIM)

    y = top + pad_top
    for segments in lines:
        cx = left + pad_x
        for text, colour, strong in segments:
            base = bold if strong else font
            for chunk, f in _split_by_font(text, base):
                d.text((cx, y), chunk, font=f, fill=colour)
                cx += d.textlength(chunk, font=f)
        y += LINE_H

    img.save(out, "WEBP", quality=92, method=6)
    print(f"{out}  {img.size[0]}x{img.size[1]}")


RUN = [
    [S("$ ", BLUE, True), S("goblin run examples/order-triage.json --input '{\"total\":250,…}'", "#e8e9ec", True)],
    [],
    [S("  [summary] priced 2 lines", DIM)],
    [],
    [S("  \u2192 ", BLUE), S("trigger")],
    [S("  \u2192 ", BLUE), S("classify")],
    [S("  \u2192 ", BLUE), S("flagHigh")],
    [S("  \u00b7 flagNormal skipped \u2014 every required input was pruned", DIM)],
    [S("  \u2192 ", BLUE), S("merge")],
    [S("  \u21bb ", AMBER), S("eachLine over 2 items")],
    [S("  \u2192 ", BLUE), S("priceLine "), S("@eachLine[0]", DIM)],
    [S("  \u2192 ", BLUE), S("priceLine "), S("@eachLine[1]", DIM)],
    [S("  \u2192 ", BLUE), S("summary")],
    [S("  \u2713 run succeeded in 14ms", GREEN)],
    [],
    [S("{")],
    [S('  "items"', KEY), S(": [")],
    [S('    { "data"', KEY), S(": { "), S('"sku"', KEY), S(": "), S('"A-1140"', STR), S(", "),
     S('"lineTotal"', KEY), S(": "), S("60", NUM), S(" } },")],
    [S('    { "data"', KEY), S(": { "), S('"sku"', KEY), S(": "), S('"B-0072"', STR), S(", "),
     S('"lineTotal"', KEY), S(": "), S("190", NUM), S(" } }")],
    [S("  ]")],
    [S("}")],
]

REPLAY = [
    [S("$ ", BLUE, True), S("goblin run examples/order-triage.json --journal run.json", "#e8e9ec", True)],
    [S("  \u2713 run succeeded in 14ms", GREEN)],
    [S("  journal \u2192 run.json", DIM)],
    [],
    [S("$ ", BLUE, True), S("goblin replay run.json", "#e8e9ec", True)],
    [],
    [S("status      "), S("succeeded", GREEN)],
    [S("entries     "), S("32", NUM)],
    [S("nodes run   "), S("7", NUM)],
    [S("items       "), S("8", NUM)],
    [S("errors      "), S("0", NUM), S(", retries "), S("0", NUM)],
    [],
    [S("The state was never stored. It was folded back out of those 32", DIM)],
    [S("journal entries \u2014 which is why a run exported from production", DIM)],
    [S("replays to what it did there, with no database in between.", DIM)],
]

if __name__ == "__main__":
    out_dir = Path(__file__).resolve().parent.parent / "assets"
    out_dir.mkdir(exist_ok=True)
    render(RUN, "goblinkit \u2014 pnpm goblin", out_dir / "goblinkit-run.webp")
    render(REPLAY, "goblinkit \u2014 replay", out_dir / "goblinkit-replay.webp")
