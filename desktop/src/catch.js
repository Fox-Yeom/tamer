// 야생 잡기 창 (PKM-08 rule 3, #119): the overlay's wild notice clicked — a small window beside it with the
// wild card (src/wild.js, as the dashboard's), so it's caught without Tamer's window. It closes when the card
// goes (caught · fled · back to the grass), on ✕ / Esc, and (main) when another app is clicked.
// The page may call only its own short list of commands (catchCommands — POL-SEC-02).
import { invoke, listen } from "./host.js";
import { createWild } from "./wild.js";

const $ = (s) => document.querySelector(s);

// 테마 (APP-20): the app sets macOS's appearance for itself — follow it like the dashboard
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light"; };
applyTheme();
darkMedia.addEventListener("change", applyTheme);

const close = () => invoke("catch_close").catch(() => {});
// no 이 탭의 파트너로 / 도감에서 보기 here: the dex is the Pokémon window's, after #113
const wild = createWild($("#catch-wild"), { invoke, log: (line) => invoke("catch_log", { line }).catch(() => {}) });
listen("wild", (e) => wild.show(e.payload));
listen("wild-throw", (e) => wild.play(e.payload));
listen("wild-end", (e) => wild.end(e.payload));

// the card's gone (its own timers after the ending): so is the window
const card = $("#catch-wild .wild-card");
new MutationObserver(() => { if (card.hidden) close(); }).observe(card, { attributes: true, attributeFilter: ["hidden"] });

$("#catch-close").addEventListener("click", close);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
  else if (e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); wild.throwBall(); }
});

// the window follows the card's height
new ResizeObserver(() => invoke("catch_fit", { height: $("#catch").offsetHeight })).observe($("#catch"));
invoke("catch_state").then((e) => (e ? wild.show(e) : close())).catch(close); // over already: nothing to catch
