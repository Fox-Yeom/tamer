// Pokémon sprites + names from PokéAPI, in the app itself (no Python / Pillow on the user's Mac).
// Same picks and cache files as the v1 (Neovim CVIM, removed 2026-10-05) fetch.py, minus its pixel
// conversion: the desktop app shows the original animated GIF.
//   $CVIM_CACHE_DIR/pokemon/<id>[s].json  { id, shiny, name_ko, name_en, legendary, capture_rate, types }
//   $CVIM_CACHE_DIR/pokemon/<id>[s].gif   Gen-V animated sprite
// Pokémon assets are fetched at runtime and cached locally only (unofficial fan feature, POLICY 4.1).
const fs = require("node:fs");
const path = require("node:path");
const { CACHE, mkdirPrivate, writeFile, writeJson } = require("./paths.cjs");

const SPRITES = path.join(CACHE, "pokemon");
const MAX_GEN5 = 649; // Gen-V animated sprites exist for #1-#649
const SPRITE = (id, shiny) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shiny ? "shiny/" : ""}${id}.gif`;
const SPECIES = (id) => `https://pokeapi.co/api/v2/pokemon-species/${id}`;
const POKEMON = (id) => `https://pokeapi.co/api/v2/pokemon/${id}`;
const SHINY_ODDS = 64;

let rng = Math.random; // tests can make picks predictable
const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));

async function get(url, as = "json") {
  if (process.env.CVIM_DESKTOP_TEST === "1" && process.env.CVIM_TEST_OFFLINE) throw new Error("offline (test)"); // npm run lab
  const r = await fetch(url, { headers: { "User-Agent": "cvim" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === "json" ? r.json() : Buffer.from(await r.arrayBuffer());
}

async function species(id) {
  const d = await get(SPECIES(id));
  const names = Object.fromEntries(d.names.map((n) => [n.language.name, n.name]));
  return {
    name_ko: names.ko || names.en, name_en: names.en, capture_rate: d.capture_rate ?? 45,
    legendary: !!(d.is_legendary || d.is_mythical), evolved: d.evolves_from_species != null,
  };
}

async function types(id) {
  const d = await get(POKEMON(id));
  return d.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name);
}

// id of a random next stage (only ones with Gen-V sprites), or null
async function nextEvolution(id) {
  const sp = await get(SPECIES(id));
  const chain = (await get(sp.evolution_chain.url)).chain;
  const sid = (n) => Number(n.species.url.replace(/\/$/, "").split("/").pop());
  const find = (n) => (sid(n) === id ? n : n.evolves_to.map(find).find(Boolean) || null);
  const options = (find(chain)?.evolves_to || []).map(sid).filter((x) => x <= MAX_GEN5);
  return options.length ? options[Math.floor(rng() * options.length)] : null;
}

// legendary / mythical (or very hard to catch) are re-rolled most of the time
async function pickRandom() {
  let id, info;
  for (let i = 0; i < 20; i++) {
    id = randInt(1, MAX_GEN5);
    info = await species(id);
    if (!(info.legendary || info.capture_rate <= 3) || rng() < 0.15) break;
  }
  return [id, info];
}

// game-like rarity: common base forms, rarer evolved forms, legendary almost never
async function pickWild() {
  let id, info;
  for (let i = 0; i < 40; i++) {
    id = randInt(1, MAX_GEN5);
    info = await species(id);
    const weight = info.legendary ? 0.02 : (info.evolved ? 0.5 : 1) * (0.25 + (0.75 * info.capture_rate) / 255);
    if (rng() < weight) break;
  }
  return [id, info];
}

// a starter: unevolved, not legendary, first type not among `avoid`
async function pickStarter(avoid) {
  let id, info;
  for (let i = 0; i < 40; i++) {
    id = randInt(1, MAX_GEN5);
    info = await species(id);
    if (info.legendary || info.evolved) continue;
    if (avoid.includes((await types(id))[0])) continue;
    break;
  }
  return [id, info];
}

// the cached JSON path of this Pokémon (downloaded if needed)
async function fetchOne(id, shiny, info = null) {
  mkdirPrivate(SPRITES);
  const base = path.join(SPRITES, `${id}${shiny ? "s" : ""}`);
  if (fs.existsSync(base + ".json") && fs.existsSync(base + ".gif")) return base + ".json";
  const gif = await get(SPRITE(id, shiny), "buffer");
  info = info || (await species(id));
  writeFile(base + ".gif", gif);
  writeJson(base + ".json", {
    id, shiny, name_ko: info.name_ko, name_en: info.name_en, legendary: info.legendary,
    capture_rate: info.capture_rate, types: await types(id),
  });
  return base + ".json";
}

const shinyRoll = () => Math.floor(rng() * SHINY_ODDS) === 0;

// the commands (v1 fetch.py's command line): ["random"] ["wild"] ["starter", …types] ["<id>", "shiny"?]
// ["evolve", "<id>"] → a JSON path / the next id as text / "none" (it has no next stage) / "" (offline,
// failed — not the same as "none": an offline evolution must not mark it final, PKM-04)
async function run(args) {
  try {
    const [a = "random", ...rest] = args.map(String);
    if (a === "evolve") return String((await nextEvolution(Number(rest[0]))) ?? "none");
    if (a === "starter") { const [id, info] = await pickStarter(rest); return await fetchOne(id, shinyRoll(), info); }
    if (a === "random" || a === "wild") { const [id, info] = await (a === "random" ? pickRandom() : pickWild()); return await fetchOne(id, shinyRoll(), info); }
    return await fetchOne(Number(a), rest[0] === "shiny");
  } catch {
    return "";
  }
}

module.exports = { run, setRng: (f) => { rng = f || Math.random; } };
