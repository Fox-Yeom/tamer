// 환상 스페셜 리서치 (E6, #86, docs/spec PKM-27): a mythical's few steps, one at a time; the last one
// brings it (an encounter like a breakthrough — PKM-24 rule 4) and a Master Ball.
//   economy/research.json { id, step, folders: [hash], evolves, ready, done: [ids] }
// "different folders" are counted by a hash of the path, only while that step runs (POL-DATA-02 — no
// folder names or paths kept); the evolutions count from the step's start; caught species are taken
// as they are now (PKM-27 rule 2)
const crypto = require("node:crypto");
const path = require("node:path");
const { CACHE, readJson, writeJson, mkdirPrivate } = require("./paths.cjs");

const FILE = path.join(CACHE, "economy", "research.json");
// each research's steps go on the card before they are made (PKM-27 rule 5) — Mew is the first
const RESEARCH = [
  { id: 151, name: "뮤", title: "뮤를 찾아서", steps: [
    { kind: "folders", n: 3, text: "서로 다른 폴더 3곳에서 작업 끝내기" },
    { kind: "species", n: 20, text: "20종 잡기" },
    { kind: "evolve", n: 3, text: "진화 3번" },
  ] },
];
const hash = (cwd) => crypto.createHash("sha256").update(String(cwd)).digest("hex").slice(0, 16);
const blank = (id) => ({ id, step: 0, folders: [], evolves: 0, ready: false });
function state() {
  const s = readJson(FILE, null) || { ...blank(RESEARCH[0].id), done: [] };
  s.done ||= [];
  return s;
}
function save(s) { mkdirPrivate(path.dirname(FILE)); writeJson(FILE, s); }
const current = (s) => RESEARCH.find((r) => r.id === s.id && !s.done.includes(r.id));
// the next one once this is done (none yet after Mew)
function advance(s) {
  const next = RESEARCH.find((r) => !s.done.includes(r.id));
  Object.assign(s, next ? blank(next.id) : { id: null, step: 0, folders: [], evolves: 0, ready: false });
}

// steps that are met by what you have now move on at once (20 species already caught …)
function settle(s, caught) {
  const r = current(s);
  if (!r || s.ready) return;
  for (;;) {
    const st = r.steps[s.step];
    if (!st) { s.ready = true; return; }
    const have = st.kind === "folders" ? s.folders.length : st.kind === "species" ? caught : s.evolves;
    if (have < st.n) return;
    s.step++; s.folders = []; s.evolves = 0; // the next step counts from now
  }
}
// what the screens show: its steps with how far each is, or null when there is none left
function view(caught = 0, owned = new Set()) {
  const s = state(), r = current(s);
  if (!r) return { finished: s.done.length, title: null };
  return { id: r.id, name: r.name, title: r.title, ready: s.ready, owned: owned.has(r.id),
    steps: r.steps.map((st, i) => ({ text: st.text, n: st.n, done: i < s.step || s.ready,
      // a later "N종 잡기" already shows what you have (it counts what's caught so far, rule 2)
      have: i < s.step || s.ready ? st.n : Math.min(st.n, st.kind === "species" ? caught : i === s.step ? (st.kind === "folders" ? s.folders.length : s.evolves) : 0) })) };
}
function onDone(cwd, caught) {
  const s = state(), r = current(s);
  if (!r || s.ready) return false;
  if (r.steps[s.step]?.kind === "folders" && !s.folders.includes(hash(cwd))) s.folders.push(hash(cwd));
  settle(s, caught);
  save(s);
  return s.ready;
}
function onCatch(caught) { const s = state(); if (!current(s) || s.ready) return false; settle(s, caught); save(s); return s.ready; }
function onEvolve(caught) {
  const s = state(), r = current(s);
  if (!r || s.ready) return false;
  if (r.steps[s.step]?.kind === "evolve") s.evolves++;
  settle(s, caught);
  save(s);
  return s.ready;
}
// all steps done: its mythical (once — the next research opens). Already with you: done, nothing to meet
function take(owned = new Set()) {
  const s = state(), r = current(s);
  if (!r || !s.ready) return null;
  s.done.push(r.id);
  advance(s);
  save(s);
  return owned.has(r.id) ? { id: r.id, name: r.name, owned: true } : { id: r.id, name: r.name };
}

module.exports = { view, onDone, onCatch, onEvolve, take, RESEARCH, _hash: hash };
