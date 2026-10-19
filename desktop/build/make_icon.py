# Tamer app icon: a pixel "capture ball" whose top half is a terminal screen (>_) and whose button
# is the cursor block. Drawn here (no game art); not the red-and-white ball — teal / orange / cream.
#   python3 build/make_icon.py [out_dir] [theme]   → icon.png (1024) + icon.icns
#   themes: logo (the app icon: the symbol of build/logo-source.png — terminal + tamer, without the
#   "tamer" wordmark — on white), ember / steel / night / window (pixel ball drafts)
import os, subprocess, sys
from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
theme = sys.argv[2] if len(sys.argv) > 2 else "logo"  # the user's logo (2026-10-02); "ember" before
THEMES = {
    "logo": ("#FFFFFF", "#D9DEE8", "", ""),  # background, its edge, prompt colour, cursor colour
    "steel": ("#3B6E8F", "#4F86A8", "#3FD6B4", "#FF8A3D"),
    "night": ("#15171E", "#2A3040", "#3FD6B4", "#FF8A3D"),
    "ember": ("#F07B35", "#F59A62", "#3FD6B4", "#3FD6B4"),
    "window": ("#2D3B4E", "#41546C", "#7EE787", "#FF8A3D"),
}
BG, EDGE, PROMPT, CURSOR = THEMES[theme]
PAL = {
    "k": "#14161D",  # outline, band
    "s": "#1F2A36",  # screen (top half)
    "S": "#172029",  # screen shade
    "p": PROMPT,  # prompt >_
    "c": CURSOR,  # cursor block (button)
    "1": "#FF5F57", "2": "#FEBC2E", "3": "#28C840",  # title-bar dots (theme "window")
    "w": "#F4EFE4",  # bottom half
    "g": "#D6CDBB",  # bottom shade
    "h": "#2C3A49",  # screen glare
}


def ball(n=32):
    c = (n - 1) / 2
    rows = [["." for _ in range(n)] for _ in range(n)]
    for y in range(n):
        for x in range(n):
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            if d > n / 2 - 0.5:
                continue
            if d > n / 2 - 2:
                rows[y][x] = "k"
            elif abs(y - c) <= 1.2:
                rows[y][x] = "k"
            elif y < c:
                rows[y][x] = "S" if x > c + n * 0.24 or y < 4 else "s"
            else:
                rows[y][x] = "g" if x > c + n * 0.2 or y > n - 6 else "w"
    # glare on the screen
    for (x, y) in [(21, 5), (22, 5), (23, 6), (23, 7)]:
        rows[y][x] = "h"
    # the prompt ">_" on the screen, above the band
    for (x, y) in [(8, 6), (9, 7), (10, 8), (9, 9), (8, 10)]:
        rows[y][x] = "p"
    for x in range(12, 17):
        rows[10][x] = "p"
    # the button: a square ring on the band with the cursor block inside
    for y in range(int(c) - 3, int(c) + 5):
        for x in range(int(c) - 3, int(c) + 5):
            edge = y in (int(c) - 3, int(c) + 4) or x in (int(c) - 3, int(c) + 4)
            rows[y][x] = "k" if edge else ("w" if y in (int(c) - 2, int(c) + 3) or x in (int(c) - 2, int(c) + 3) else "c")
    if theme == "window":  # the band as a window title bar: three dots on its left
        for i, x in enumerate((4, 6, 8)):
            rows[int(c)][x] = "123"[i]
    return ["".join(r) for r in rows]


N, m = 1024, 100  # macOS icon grid: 824 px body
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)


def from_logo():
    from logo_clean import clean
    # the source is transparent around the shapes (its glow is only colour left in transparent
    # pixels): keep its alpha and lay it on the white icon — its terminal window cleaned first (the
    # smudge right of the prompt let the white show through)
    src = clean()
    sym = src.crop(src.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())  # the symbol + wordmark
    sym = sym.crop((0, 0, sym.width, int(sym.height * 0.70)))  # the symbol above the "tamer" wordmark
    sym = sym.crop(sym.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())
    w = 680
    h = int(sym.height * w / sym.width)
    body = Image.new("RGBA", (N, N), BG)
    body.alpha_composite(sym.resize((w, h), Image.LANCZOS), ((N - w) // 2, (N - h) // 2))
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, N - m, N - m], radius=185, fill=255)
    img.paste(body, (0, 0), mask)
    d.rounded_rectangle([m, m, N - m, N - m], radius=185, outline=EDGE, width=6)


if theme == "logo":
    from_logo()
rows = ball() if theme != "logo" else []
if rows:
    d.rounded_rectangle([m, m, N - m, N - m], radius=185, fill=BG)
    d.rounded_rectangle([m, m, N - m, N - m], radius=185, outline=EDGE, width=6)
    pts = [(x, y) for y, r in enumerate(rows) for x, ch in enumerate(r) if ch != "."]
    x0, y0 = min(p[0] for p in pts), min(p[1] for p in pts)
    w = max(p[0] for p in pts) - x0 + 1
    S = 640 // w
    o = (N - w * S) // 2
    for (x, y) in pts:
        d.rectangle([o + (x - x0) * S, o + (y - y0) * S, o + (x - x0 + 1) * S - 1, o + (y - y0 + 1) * S - 1], fill=PAL[rows[y][x]])

import tempfile
iconset = os.path.join(tempfile.mkdtemp(), "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for s in [16, 32, 128, 256, 512]:
    img.resize((s, s), Image.NEAREST).save(f"{iconset}/icon_{s}x{s}.png")
    img.resize((s * 2, s * 2), Image.NEAREST).save(f"{iconset}/icon_{s}x{s}@2x.png")
img.save(os.path.join(out, "icon.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(out, "icon.icns")], check=True)
print(os.path.join(out, "icon.icns"))
