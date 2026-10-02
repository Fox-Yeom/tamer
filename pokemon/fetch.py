#!/usr/bin/env python3
"""Fetch a Pokémon (Gen-V animated sprite + names) from PokéAPI and convert it for cvim.

    fetch.py random        pick a random Pokémon (rarer = less likely), print the cached JSON path
    fetch.py wild          pick a wild encounter (game-like rarity), print the cached JSON path
    fetch.py starter [type …]  one partner candidate: a base form, not legendary, first type not in
                           the given list (3 calls = 3 different types), print the cached JSON path
    fetch.py <id> [shiny]  fetch a specific one
    fetch.py evolve <id>   print the next evolution's id (random branch, Gen-V only) or nothing

Output: $CVIM_CACHE_DIR (default ~/.cache/cvim)/pokemon/<id>[s].json (+ the original .gif, used by the desktop overlay)
  { id, shiny, name_ko, name_en, w, h, palette: ["#rrggbb", ...],
    frames: [{ "d": ms, "rows": ["..AB..", ...] }, ...] }
Each row char indexes `palette` via ALPHABET; "." is transparent.

Pokémon assets are fetched at runtime and cached locally only (unofficial, non-commercial fan
feature; all rights to their respective owners).
"""
import io
import json
import os
import random
import sys
import urllib.request

from PIL import Image, ImageSequence

os.umask(0o077)  # CVIM's cache is the user's alone (POLICY 11.3)

# CVIM_CACHE_DIR isolates tests from the real cache (same variable as nvim/lua/cvim/pokemon.lua)
CACHE = os.path.join(os.environ.get("CVIM_CACHE_DIR") or os.path.expanduser("~/.cache/cvim"), "pokemon")
MAX_GEN5 = 649  # Gen-V animated sprites exist for #1-#649
SPRITE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/{shiny}{id}.gif"
SPECIES = "https://pokeapi.co/api/v2/pokemon-species/{id}"
POKEMON = "https://pokeapi.co/api/v2/pokemon/{id}"
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-/:;<=>?@[]^_{|}~"
MAX_FRAMES = 40
SHINY_ODDS = 64


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cvim"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def species(pid):
    data = json.loads(get(SPECIES.format(id=pid)))
    names = {n["language"]["name"]: n["name"] for n in data["names"]}
    return {
        "name_ko": names.get("ko") or names.get("en"),
        "name_en": names.get("en"),
        "capture_rate": data.get("capture_rate", 45),
        "legendary": data.get("is_legendary") or data.get("is_mythical"),
        "evolved": data.get("evolves_from_species") is not None,
    }


def types(pid):
    data = json.loads(get(POKEMON.format(id=pid)))
    return [t["type"]["name"] for t in sorted(data["types"], key=lambda t: t["slot"])]


def next_evolution(pid):
    """id of a random next stage in the evolution chain (only ones with Gen-V sprites)."""
    sp = json.loads(get(SPECIES.format(id=pid)))
    chain = json.loads(get(sp["evolution_chain"]["url"]))["chain"]

    def sid(node):
        return int(node["species"]["url"].rstrip("/").split("/")[-1])

    def find(node):
        if sid(node) == pid:
            return node
        for child in node["evolves_to"]:
            hit = find(child)
            if hit:
                return hit
        return None

    node = find(chain)
    options = [sid(c) for c in (node or {}).get("evolves_to", []) if sid(c) <= MAX_GEN5]
    return random.choice(options) if options else None


def pick_random():
    # legendary/mythical (or very hard to catch) Pokémon are re-rolled most of the time
    for _ in range(20):
        pid = random.randint(1, MAX_GEN5)
        info = species(pid)
        rare = info["legendary"] or info["capture_rate"] <= 3
        if not rare or random.random() < 0.15:
            return pid, info
    return pid, info


def pick_wild():
    """Wild encounter, rarity like the games: base forms with high catch rates are common,
    evolved forms rarer, legendary/mythical almost never (rejection sampling on species data)."""
    for _ in range(40):
        pid = random.randint(1, MAX_GEN5)
        info = species(pid)
        if info["legendary"]:
            weight = 0.02
        else:
            weight = (0.5 if info["evolved"] else 1.0) * (0.25 + 0.75 * info["capture_rate"] / 255)
        if random.random() < weight:
            return pid, info
    return pid, info


def pick_starter(avoid):
    """A partner candidate like the games' starters: an unevolved, non-legendary Pokémon whose
    first type differs from the other candidates'."""
    for _ in range(40):
        pid = random.randint(1, MAX_GEN5)
        info = species(pid)
        if info["legendary"] or info["evolved"]:
            continue
        if types(pid)[0] in avoid:
            continue
        return pid, info
    return pid, info


def convert(gif_bytes):
    img = Image.open(io.BytesIO(gif_bytes))
    frames, durations = [], []
    for f in ImageSequence.Iterator(img):
        frames.append(f.convert("RGBA"))
        durations.append(max(40, f.info.get("duration", 100) or 100))
    if len(frames) > MAX_FRAMES:  # keep timing roughly right when sampling
        step = len(frames) / MAX_FRAMES
        idx = [int(i * step) for i in range(MAX_FRAMES)]
        durations = [int(sum(durations) / MAX_FRAMES)] * MAX_FRAMES
        frames = [frames[i] for i in idx]

    # crop to the union of all frames' opaque pixels
    box = None
    for f in frames:
        b = f.getchannel("A").point(lambda a: 255 if a > 32 else 0).getbbox()
        if b:
            box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    box = box or (0, 0, frames[0].width, frames[0].height)
    frames = [f.crop(box) for f in frames]

    palette, index, out = [], {}, []
    for f, d in zip(frames, durations):
        rows = []
        px = f.load()
        for y in range(f.height):
            row = []
            for x in range(f.width):
                r, g, b, a = px[x, y]
                if a <= 32:
                    row.append(".")
                    continue
                key = "#%02x%02x%02x" % (r, g, b)
                if key not in index:
                    if len(palette) >= len(ALPHABET):  # too many colours: snap to nearest known
                        key = min(palette, key=lambda c: sum((int(c[i:i + 2], 16) - v) ** 2 for i, v in zip((1, 3, 5), (r, g, b))))
                    else:
                        index[key] = ALPHABET[len(palette)]
                        palette.append(key)
                row.append(index[key])
            rows.append("".join(row))
        out.append({"d": d, "rows": rows})
    return frames[0].width, frames[0].height, palette, out


def fetch(pid, shiny, info=None):
    os.makedirs(CACHE, exist_ok=True)
    tag = f"{pid}{'s' if shiny else ''}"
    path = os.path.join(CACHE, tag + ".json")
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        stale = False
        if "types" not in data:  # cache from an older version: add types
            data["types"] = types(pid)
            stale = True
        if "capture_rate" not in data and info:  # wild encounters need the catch rate
            data["capture_rate"] = info["capture_rate"]
            stale = True
        gif_path = os.path.join(CACHE, tag + ".gif")
        if "frames" not in data and os.path.exists(gif_path):  # fetched by the desktop app (GIF only)
            with open(gif_path, "rb") as g:
                data["w"], data["h"], data["palette"], data["frames"] = convert(g.read())
            stale = True
        if stale:
            write_json(path, data)
        return path
    gif = get(SPRITE.format(id=pid, shiny="shiny/" if shiny else ""))
    info = info or species(pid)
    w, h, palette, frames = convert(gif)
    with open(os.path.join(CACHE, tag + ".gif"), "wb") as f:
        f.write(gif)
    data = {"id": pid, "shiny": shiny, "name_ko": info["name_ko"], "name_en": info["name_en"],
            "legendary": bool(info["legendary"]), "capture_rate": info["capture_rate"], "types": types(pid),
            "w": w, "h": h, "palette": palette, "frames": frames}
    write_json(path, data)
    return path


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "random"
    if arg == "evolve":
        nxt = next_evolution(int(sys.argv[2]))
        if nxt:
            print(nxt)
    elif arg == "starter":
        pid, info = pick_starter(sys.argv[2:])
        print(fetch(pid, random.randrange(SHINY_ODDS) == 0, info))
    elif arg in ("random", "wild"):
        pid, info = pick_random() if arg == "random" else pick_wild()
        print(fetch(pid, random.randrange(SHINY_ODDS) == 0, info))
    else:
        print(fetch(int(arg), len(sys.argv) > 2 and sys.argv[2] == "shiny"))


if __name__ == "__main__":
    main()
