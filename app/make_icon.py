# Builds CVIM.icns from the idle sprite frame dumped by build.sh
import sys, os, subprocess
from PIL import Image, ImageDraw
frame_file, pal_file, out_icns, work = sys.argv[1:5]


def pokeball(n=32):
    """Procedural pixel Poké Ball: rows of palette keys (r red, R dark red, h highlight,
    w white, g shade, k outline/band, b button)."""
    c = (n - 1) / 2
    rows = []
    for y in range(n):
        row = ""
        for x in range(n):
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            bd = ((x - c) ** 2 + (y - c) ** 2) ** 0.5  # distance to button centre
            if d > n / 2 - 0.5:
                row += "."
            elif d > n / 2 - 2:
                row += "k"
            elif bd <= 3.2:
                row += "b" if bd <= 2.0 else "k"
            elif bd <= 5.0:
                row += "k"
            elif abs(y - c) <= 1.2:
                row += "k"
            elif y < c:
                hl = ((x - c * 0.55) ** 2 + (y - c * 0.5) ** 2) ** 0.5
                row += "h" if hl < 2.6 else ("R" if x > c + n * 0.22 or y < 4 else "r")
            else:
                row += "g" if x > c + n * 0.2 or y > n - 6 else "w"
        rows.append(row)
    return rows


if frame_file == "pokeball":
    pal = {"r": "#E3350D", "R": "#B0280A", "h": "#FF8A70", "w": "#F4F1EA", "g": "#C9C4BA",
           "k": "#1B1B1F", "b": "#F4F1EA"}
    rows = pokeball()
else:
    pal = {l.split("=")[0]: l.split("=")[1].strip() for l in open(pal_file)}
    rows = open(frame_file).read().strip().split(",")
# crop to painted area
pts = [(x, y) for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."]
x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
pw, ph = x1 - x0 + 1, y1 - y0 + 1

N = 1024
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
m = 100  # macOS icon grid: 824px body
bg, edge = ("#2b3150", "#3d4570") if frame_file == "pokeball" else ("#16161c", "#2c2c34")
d.rounded_rectangle([m, m, N - m, N - m], radius=185, fill=bg)
d.rounded_rectangle([m, m, N - m, N - m], radius=185, outline=edge, width=6)
S = int((640 if frame_file == "pokeball" else 560) / max(pw, ph))
ox, oy = (N - pw * S) // 2, (N - ph * S) // 2 + (0 if frame_file == "pokeball" else 30)
for (x, y) in pts:
    c = rows[y][x]
    d.rectangle([ox + (x - x0) * S, oy + (y - y0) * S, ox + (x - x0 + 1) * S - 1, oy + (y - y0 + 1) * S - 1], fill=pal[c])
# sparkle (mascot icon only)
for (sx, sy) in ([] if frame_file == "pokeball" else [(250, 250), (770, 300)]):
    d.rectangle([sx - 14, sy - 42, sx + 14, sy + 42], fill="#F5C542")
    d.rectangle([sx - 42, sy - 14, sx + 42, sy + 14], fill="#F5C542")

iconset = os.path.join(work, "CVIM.iconset")
os.makedirs(iconset, exist_ok=True)
for s in [16, 32, 128, 256, 512]:
    img.resize((s, s), Image.NEAREST).save(f"{iconset}/icon_{s}x{s}.png")
    img.resize((s * 2, s * 2), Image.NEAREST).save(f"{iconset}/icon_{s}x{s}@2x.png")
img.save(os.path.join(work, "icon.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out_icns], check=True)
