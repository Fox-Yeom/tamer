# The logo source (build/logo-source.png) with its terminal window cleaned: right of the prompt the
# window has a half-transparent, darker smudge (source x ~720-930, y ~650-1120), so whatever is behind
# shows through — white on the app icon, the page on the README. Every window pixel that isn't the
# prompt, the cursor or the dots gets the window's own colour; those get it as their backdrop.
# Used by make_icon.py (the app icon) and make_logo.py (assets/logo.png).
import os
from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo-source.png")


# where the window's light shapes are (source px, with a margin): the three dots, the prompt ">", the cursor
SHAPES = [(540, 645, 790, 726), (557, 815, 726, 1055), (691, 991, 864, 1063)]


def clean(src=None):
    src = (src or Image.open(SRC)).convert("RGBA")
    px = src.load()
    win = px[700, 760][:3]
    shape = lambda x, y: any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in SHAPES)
    # see-through pixels joined to the outside (the gap between the window and the trainer is one);
    # the smudge's holes are closed in by the window, so they aren't
    out = src.getchannel("A").point(lambda a: 255 if a < 20 else 0)  # the gap is near 0, the smudge 25+
    ImageDraw.floodfill(out, (0, 0), 128)
    op = out.load()
    for y in range(600, 1176):
        # the window ends where that gap starts (a slanted line)
        right = next((x for x in range(890, 1100) if op[x, y] == 128), 890)
        inner = 640 <= y <= 1130  # clear of the rounded corners: the smudge's see-through pixels too
        for x in range(490, right - 1):
            r, g, b, a = px[x, y]
            if a < 200 and (x < 560 or not inner):
                continue  # outside the window, or its corners' soft edge: stays
            if shape(x, y) and b >= 150:  # a dot, the prompt, the cursor: over the window, opaque
                k = a / 255
                px[x, y] = (round(r * k + win[0] * (1 - k)), round(g * k + win[1] * (1 - k)), round(b * k + win[2] * (1 - k)), 255)
            else:  # the window (or the smudge on it)
                px[x, y] = (*win, 255)
    return src
