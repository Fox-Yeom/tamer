# README logo (assets/logo.png): the whole logo — terminal + tamer and the "tamer" wordmark — on a
# transparent background, from build/logo-source.png cleaned like the app icon (logo_clean.py).
#   python3 build/make_logo.py [out.png]   (default: ../assets/logo.png, 600 px wide — README shows it at 200)
import os, sys
from PIL import Image
from logo_clean import clean

here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "..", "assets", "logo.png")
src = clean()
logo = src.crop(src.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())
w = 600
logo.resize((w, round(logo.height * w / logo.width)), Image.LANCZOS).save(out, optimize=True)
print(os.path.abspath(out))
