// Test lab cases (npm run lab, docs/TESTING.md). A case: what it checks, the data it starts from,
// how the app is launched, optional twists (a slow shell, offline, a folder handed in late), the
// steps (src/main.js labRun) and the check. `vary` multiplies a case over values (timings …).
//   data: "empty" | "newuser" | "owner"      mode: "direct" | "open" (dropped on the app) | "late"
//   slowShell: seconds · offline: true · env: { … } · vary: { lateMs: [ … ] }
//   steps: { wait } { until: "path", match? } { key, code? } { click, button? } { probe: "name" } { shot } { call }
//   { select: "text" } mouse-drags over that text in the big pane · { confirm: true | false } answers confirm()
//   make: folders created but not handed in · session: last time's tabs (test-env sandbox)
//   steps also: { ime: "하" } composing · { text } committed text · { key, mods: 4 (⌘) | 8 (⇧), commands } · { resize: [w, h] }
//   check({ probe, log, v, box }) → a list: true = ok, a string = what went wrong (box.dir, box.data: the sandbox)
// Tags: smoke = must pass before every release · net = needs PokéAPI · explore = records how
// things are (an edge being looked at), not a release gate.
const startup = (log, what) => { const m = log.match(new RegExp(`startup ${what} \\+(\\d+)ms`)); return m ? Number(m[1]) : null; };
// ok(condition, what went wrong): true when it holds, else the message (a value is never a message)
const ok = (cond, msg) => (cond ? true : msg);
const fs = require("node:fs");
const path = require("node:path");
// every file under a folder (none: []) whose text contains `needle` (was something kept?)
const filesWith = (dir, needle) => { const out = []; if (!fs.existsSync(dir)) return out; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { if (fs.readFileSync(f, "utf8").includes(needle)) out.push(path.relative(dir, f)); } catch {} } } }; walk(dir); return out; };
// #45: a stand-in Claude for the shell (prints its arguments, feeds a status line through Tamer's script)
const FAKE_CLAUDE = "#!/bin/sh\n# a stand-in Claude: says what it was started with, then — like the real one, which redraws its status line all the time — reports a status line through Tamer's script every second\necho \"fake-claude args: $*\"\nfor i in $(seq 30); do\n  now=$(date +%s)\n  printf '{\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":30,\"resets_at\":%s},\"seven_day\":{\"used_percentage\":12}},\"context_window\":{\"used_percentage\":21,\"context_window_size\":1000000}}' $((now+3600)) | bash \"$CVIM_ROOT/claude/statusline.sh\" >/dev/null\n  sleep 1\ndone\n";
// a 메인 파트너 one task away from evolving (Charmander Lv 15, evolves at 16 — #74): uid 1, the party's first and only
// (#122 — no folder partners; the party grows in turn, so a one-member party is the one that grows) (PKM-04, PKM-21)
function evolvePartner(box, extra = {}) {
  const C = box.data, now = Math.floor(Date.now() / 1000);
  const b = JSON.parse(fs.readFileSync(path.join(C, "box.json"), "utf8"));
  b.mons.push({ uid: 99, id: 4, shiny: false, xp: 7, since_evo: 7, lv: 15, mile: 10, friend: 0, how: "starter", at: now - 3600, folder: null, ...extra });
  b.mons = b.mons.map((m) => (m.uid === 99 ? { ...m, uid: 1 } : m.uid === 1 ? { ...m, uid: 98 } : m));
  Object.assign(b, { party: [1], partyNext: 0, partyV: 2 });
  fs.writeFileSync(path.join(C, "box.json"), JSON.stringify(b));
}
// a scratch git repository (never the user's git config: no global/system config, so no hooks)
function gitRepo(dir, cmds) {
  const { execFileSync } = require("node:child_process");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => execFileSync("git", ["-c", "user.name=lab", "-c", "user.email=lab@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env, stdio: "pipe" });
  for (const c of cmds) typeof c === "function" ? c(dir) : git(...c);
}
// a CSS rgb() colour's contrast with white (WCAG), null if none (#70)
function contrast(css) {
  const m = String(css || "").match(/rgba?\((\d+), (\d+), (\d+)/);
  if (!m) return null;
  const lum = [m[1], m[2], m[3]].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 1.05 / (0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2] + 0.05);
}
const envMs = (log) => { const m = log.match(/env ready .*?\+(\d+)ms/); return m ? Number(m[1]) : null; };

// 🆙 levels (#74): a species the seed doesn't have, without the network — its card data, how it
// evolves and a borrowed picture (Charmander's), in the sandbox's cache
function fakeSpecies(box, id, name, evo) {
  const P = path.join(box.data, "pokemon");
  fs.writeFileSync(path.join(P, `${id}.json`), JSON.stringify({ id, shiny: false, name_ko: name, name_en: name, legendary: false, capture_rate: 45, types: ["normal"] }));
  fs.copyFileSync(path.join(P, "4.gif"), path.join(P, `${id}.gif`));
  if (evo) fs.writeFileSync(path.join(P, `${id}.evo.json`), JSON.stringify({ id, ...evo }));
}
// ⭐ 대발견 (#82): a day n days ago (this Mac's calendar), the three open legends without the network
const dayAgo = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
function birds(box) {
  for (const [id, name] of [[144, "프리저"], [145, "썬더"], [146, "파이어"]]) {
    fakeSpecies(box, id, name, { reach: null, next: [] });
    const f = path.join(box.data, "pokemon", `${id}.json`), j = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...j, legendary: true, capture_rate: 3 }));
    // its ✨ too: a breakthrough rolls shiny 1 in 64, and offline a missing picture kept the card away (flaky smoke 2026-10-16)
    fs.writeFileSync(path.join(box.data, "pokemon", `${id}s.json`), JSON.stringify({ ...j, shiny: true, legendary: true, capture_rate: 3 }));
    fs.copyFileSync(path.join(box.data, "pokemon", `${id}.gif`), path.join(box.data, "pokemon", `${id}s.gif`));
  }
}
// 🪙 포켓코인 (#72): today as the app counts it (this Mac's midnight), the economy files of a sandbox
// 한도 칸 (#115 A6 · A4): a window reset a minute ago; a week window half gone — fixed when the cases load, so +40 min:
// a smoke run reaches the case minutes later and "3일 12시간" · the tick at ~50 % still hold
const LIM_PAST = Math.floor(Date.now() / 1000) - 60, LIM_HALF_WEEK = Math.floor(Date.now() / 1000) + 3.5 * 86400 + 40 * 60;
// 오늘 사용량 (#115 A5): a line of now and one of two days ago
const SPEND_NOW = new Date().toISOString(), SPEND_OLD = new Date(Date.now() - 2 * 86400000).toISOString();
const todayLocal = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const econ = (box, f) => path.join(box.data, "economy", f);
const ledgerRows = (box) => { try { return fs.readFileSync(econ(box, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } };
const putEcon = (box, files) => { fs.mkdirSync(path.join(box.data, "economy"), { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(econ(box, f), typeof v === "string" ? v : JSON.stringify(v)); };
// 💎 the stone cases (#93 #94 #95): the partner an Eevee (three stone branches, 135 not in the Pokédex yet), `n` stones bought
function stoneSetup(box, n) {
  fakeSpecies(box, 133, "이브이", { reach: null, next: [{ to: 134, kind: "stone" }, { to: 135, kind: "stone" }, { to: 136, kind: "stone" }] });
  for (const [id, name] of [[134, "샤미드"], [135, "쥬피썬더"], [136, "부스터"]]) fakeSpecies(box, id, name, { reach: { kind: "stone" }, next: [] });
  evolvePartner(box, { id: 133, lv: 12, mile: 10 });
  const d = todayLocal();
  putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 1000 }, ...Array.from({ length: n }, () => ({ day: d, kind: "buy", item: "stone", n: 1, amount: -300 }))].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
}
// the bag → [쓸 포켓몬 고르기] → the Eevee (first: this tab's) → → 쥬피썬더
const STONE_TO_135 = [{ until: "partner", timeout: 10000 }, { wait: 500 }, { key: "p", mods: 4 }, { wait: 700 }, { key: "i" }, { wait: 900 }, { probe: "bag" },
  { key: "Enter" }, { wait: 1200 }, { probe: "pick" }, { click: "#dex-from [data-stone='135']" }, { wait: 2500 }];
const DONE = (ws, times) => [{ invoke: "agent_state_test", args: { ws, from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws, from: "thinking", to: "done", ...(times ? { times } : {}) } }];

module.exports = [
  {
    id: "launch-empty", tags: ["smoke", "launch"], what: "아무것도 없는 맥에서 실행 → 시작 화면이 1초 안에",
    data: "empty", mode: "direct", folders: [],
    steps: [{ wait: 1000 }, { probe: "at1s" }],
    check: ({ probe, log }) => [
      ok(probe.at1s?.start, "1초 때 시작 화면이 안 보임"),
      ok((startup(log, "start screen on screen") ?? 1e9) < 1000, `시작 화면이 보인 시각 ${startup(log, "start screen on screen")}ms`),
    ],
  },
  {
    id: "launch-folder", tags: ["smoke", "launch"], what: "폴더를 넘겨 실행 → 그 탭, 파트너 칸엔 메인 파트너(파티 1번) — 포켓몬 창 · 고르기 창은 저절로 안 뜸 (#113 A8 · #122)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partner", timeout: 8000 }, { wait: 1500 }, { probe: "tab" }],
    check: ({ probe }) => [ok(probe.tab?.tabs?.[0] === "proj", `탭 ${JSON.stringify(probe.tab?.tabs)}`), ok(probe.tab?.start === false, "시작 화면이 떠 있음"),
      ok(probe.tab?.partner && probe.tab?.needPartner === false, `파트너 칸 ${probe.tab?.partner} · [포켓몬 고르기] ${probe.tab?.needPartner}`),
      ok(probe.tab?.poke === null && probe.tab?.chooser === null, `저절로 뜬 창 ${probe.tab?.poke} · ${JSON.stringify(probe.tab?.chooser?.mode)}`)],
  },
  {
    id: "first-launch-dialogs", tags: ["smoke", "first-run"], what: "첫 실행: 에이전트 연결 창(메인 창 안)과 포켓몬 고르기 창이 저절로 한 번 (#122 J4) — Esc는 에이전트 창만 닫고, 파트너 칸엔 [포켓몬 고르기] (#30)",
    data: "empty", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_DESKTOP_FIRST_LAUNCH: "1" },
    steps: [{ until: "agents" }, { until: "chooser.mode", timeout: 8000 }, { wait: 1000 }, { probe: "both" }, { key: "Escape" }, { wait: 400 }, { probe: "esc" }],
    check: ({ probe }) => [
      ok(probe.both?.top === "agents" && probe.both?.poke === null, `맨 위 ${probe.both?.top} · 포켓몬 창 ${probe.both?.poke}`),
      ok(probe.both?.chooser?.mode === "first", `고르기 창 ${JSON.stringify(probe.both?.chooser)}`),
      ok(probe.esc?.agents === false, "Esc 후 에이전트 연결 창이 남음"),
      ok(probe.esc?.chooser?.mode === "first" && probe.esc?.needPartner === true, `고르기 창 ${probe.esc?.chooser?.mode} · 파트너 칸 [포켓몬 고르기] ${probe.esc?.needPartner}`),
    ],
  },
  {
    id: "first-partner-offline", tags: ["smoke", "first-run"], what: "첫 실행인데 오프라인: 고르기 창이 '받는 중…'으로 멈추지 않고 Esc로 닫힘 — 파트너 칸 [포켓몬 고르기]로 다시 열림 (#122)",
    data: "empty", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "chooser.mode", timeout: 8000 }, { wait: 3000 }, { probe: "waiting" }, { invoke: "own_key_test", args: { name: "choose", key: "Escape" } }, { wait: 600 }, { probe: "closed" },
      { click: "main.grid:not([hidden]) .need-partner" }, { until: "chooser.mode", timeout: 5000 }, { probe: "again" }],
    check: ({ probe, log }) => [
      ok(probe.waiting?.chooser?.mode === "first", "고르기 창이 안 열림"),
      ok(probe.waiting?.chooser?.ready === false && probe.waiting?.chooser?.goOff === true, `오프라인인데 후보가 준비됨 ${JSON.stringify(probe.waiting?.chooser)}`),
      ok(probe.closed?.chooser === null && probe.closed?.needPartner === true, `Esc로 안 닫힘 ${JSON.stringify(probe.closed?.chooser?.mode)} · 칸 ${probe.closed?.needPartner}`),
      ok(probe.again?.chooser?.mode === "first", "[포켓몬 고르기]로 다시 안 열림"),
      ok(!/lab-error/.test(log), "오류"),
    ],
  },
  {
    id: "first-partner-keys", tags: ["smoke", "first-run"], what: "새 사용자: 고르기 창에서 방향키 + Enter로 첫 포켓몬 → 메인 파트너, 창은 닫힘 (#122)",
    data: "newuser", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "chooser.ready", timeout: 8000 }, { invoke: "own_key_test", args: { name: "choose", key: "ArrowRight" } }, { wait: 200 }, { probe: "sel" },
      { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe, log }) => [ok(probe.sel?.chooser?.sel === 1 && /함께하기/.test(probe.sel?.chooser?.go || ""), `→ ${JSON.stringify(probe.sel?.chooser && { sel: probe.sel.chooser.sel, go: probe.sel.chooser.go })}`),
      ok(probe.picked?.partner && probe.picked?.needPartner === false, `파트너 ${probe.picked?.partner}`), ok(probe.picked?.chooser === null, "창이 안 닫힘"),
      ok(/^choose starter \d+#\d+$/m.test(log), "choose starter 기록이 없음")],
  },
  {
    id: "first-partner-net", tags: ["net", "first-run"], what: "첫 실행: PokéAPI에서 후보 셋을 받아 2 → Enter로 고르기 (#122)",
    data: "empty", mode: "direct", folders: ["proj"],
    steps: [{ until: "chooser.ready", timeout: 40000 }, { probe: "ready" }, { invoke: "own_key_test", args: { name: "choose", key: "2" } }, { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe }) => [ok(probe.ready?.chooser?.cards?.length === 3 && probe.ready.chooser.wait === 0, "후보 3마리가 안 옴"), ok(probe.picked?.partner, "파트너가 안 생김")],
  },
  // ── 파티 · 메인 파트너 · 포켓몬 고르기 창 (#122, PKM-31 · PKM-32 · POL-FUT-05) ──
  {
    id: "choose-first", tags: ["smoke", "first-run", "poke"], what: "첫 실행: 포켓몬 고르기 창이 저절로 한 번(제목 줄 있는 따로 창, 터미널 창은 그대로) → Enter로 고르면 파티 1번 = 메인 파트너, 창은 닫히고 다시 켜도 안 뜸(chooseAsked) (#122, PKM-32)",
    data: "newuser", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "chooser.ready", timeout: 8000 }, { probe: "first" }, { invoke: "own_read_test", args: { name: "choose" }, log: true },
      { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { until: "partner", timeout: 5000 }, { wait: 600 }, { probe: "picked" }, { invoke: "party_state", log: true }],
    check: ({ probe, log, box }) => {
      const w = JSON.parse(log.match(/^lab-invoke own_read_test (.*)$/m)?.[1] || "null"), p = JSON.parse(log.match(/^lab-invoke party_state (.*)$/m)?.[1] || "{}");
      let set = null; try { set = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      return [
        ok(probe.first?.chooser?.mode === "first" && probe.first.chooser.cards.length === 3 && /첫 포켓몬/.test(probe.first.chooser.title), `고르기 창 ${JSON.stringify(probe.first?.chooser && { mode: probe.first.chooser.mode, n: probe.first.chooser.cards.length, title: probe.first.chooser.title })}`),
        ok(w?.open && w.movable && w.title === "포켓몬 고르기" && w.win && w.bounds?.width === 720, `창 ${JSON.stringify(w && { open: w.open, movable: w.movable, title: w.title, win: w.win, w: w.bounds?.width })}`),
        ok(probe.picked?.chooser === null && probe.picked?.partner && p.list?.length === 1 && p.list[0].name === probe.picked.partner, `고른 뒤 ${probe.picked?.partner} · 파티 ${JSON.stringify(p.list?.map((m) => m.name))}`),
        ok(set?.chooseAsked === true, `chooseAsked ${set?.chooseAsked} (다시 켜면 안 뜸)`),
      ];
    },
  },
  {
    id: "party-migrate", tags: ["smoke", "poke", "data"], what: "폴더 파트너가 있던 사용자(#122 전): 처음 켤 때 box.json·folders.json 사본(600) → 폴더 연결·교환 표시 지움, 파티가 비면 예전 파트너(레벨 높은 순)를 고르기 창이 한 번 제안 → [파티에 넣기]로 그 순서가 파티 (POL-DATA-05, PKM-32)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      const f = path.join(box.data, "box.json"), b = JSON.parse(fs.readFileSync(f, "utf8"));
      delete b.partyV; b.party = [];
      for (const m of b.mons) {
        if (m.uid === 3) Object.assign(m, { folder: box.folder("proj"), last_folder: box.folder("proj"), lv: 20, mile: 20 });
        if (m.uid === 5) Object.assign(m, { folder: path.join(box.dir, "other"), lv: 30, mile: 30 });
        if (m.uid === 4) m.traded = true;
      }
      fs.writeFileSync(f, JSON.stringify(b));
      fs.writeFileSync(path.join(box.data, "folders.json"), JSON.stringify({ [box.folder("proj")]: { id: 222, uid: 3, pinned: true }, [path.join(box.dir, "other")]: { id: 422, uid: 5, pinned: true } }));
    },
    steps: [{ until: "chooser.mode", timeout: 8000 }, { wait: 500 }, { probe: "suggest" }, { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { until: "partner", timeout: 5000 }, { wait: 500 }, { probe: "after" },
      { invoke: "party_state", log: true }],
    check: ({ probe, log, box }) => {
      const bk = fs.existsSync(path.join(box.data, "backup")) ? fs.readdirSync(path.join(box.data, "backup")).find((n) => n.startsWith("party-")) : null, dir = bk && path.join(box.data, "backup", bk);
      const b = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8")), p = JSON.parse(log.match(/^lab-invoke party_state (.*)$/m)?.[1] || "{}");
      const mode = (f) => { try { return (fs.statSync(path.join(dir, f)).mode & 0o777).toString(8); } catch { return null; } };
      const ch = probe.suggest?.chooser;
      return [
        ok(dir && mode("box.json") === "600" && mode("folders.json") === "600" && /"folder":/.test(fs.readFileSync(path.join(dir, "box.json"), "utf8")), `사본 ${bk} box ${mode("box.json")} folders ${mode("folders.json")}`),
        ok(!b.mons.some((m) => m.folder || m.last_folder || m.traded) && b.partyV === 2 && !b.suggest, `옮긴 뒤 ${JSON.stringify({ folder: b.mons.filter((m) => m.folder || m.last_folder || m.traded).map((m) => m.uid), partyV: b.partyV, suggest: b.suggest })}`),
        ok(ch?.mode === "suggest" && /예전 파트너/.test(ch.title) && JSON.stringify(ch.picked) === "[5,3]", `제안 ${JSON.stringify(ch && { mode: ch.mode, title: ch.title, picked: ch.picked })} (레벨 높은 순, 미리 골라 둠)`),
        ok(JSON.stringify(p.list?.map((m) => m.uid)) === "[5,3]" && probe.after?.partner === p.list[0].name && probe.after?.chooser === null, `파티 ${JSON.stringify(p.list?.map((m) => m.uid))} · 메인 ${probe.after?.partner}`),
        ok(fs.readFileSync(path.join(box.data, "folders.json"), "utf8").includes('"uid":3'), "folders.json이 바뀜(그대로 둬야)"),
        ok(/^choose suggest 5,3$/m.test(log), "choose suggest 기록이 없음"),
      ];
    },
  },
  {
    id: "party-main", tags: ["smoke", "poke"], what: "메인 파트너 = 파티 1번: 두 탭 모두 같은 포켓몬, 칸 제목 \"메인 파트너\" · 완료는 어느 탭이든 파티 차례로(졸업한 Lv 100은 건너뜀) · 파티는 5칸까지 · 내 포켓몬 [메인 파트너로] → 모든 탭이 바뀜 (#122 J1, PKM-31 · POL-FUT-05)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    setup: (box) => {
      const f = path.join(box.data, "box.json"), b = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const m of b.mons) if (m.uid === 2) Object.assign(m, { lv: 100, mile: 100, final: true, grad: 1 }); // a graduate: in the party, skipped in turns
      b.party = [1, 2, 3]; b.partyNext = 0;
      fs.writeFileSync(f, JSON.stringify(b));
      putEcon(box, { "state.json": { startSeen: true } });
    },
    steps: [{ until: "tabs.1" }, { until: "partner", timeout: 8000 }, { wait: 800 }, { probe: "b" }, { key: "1", mods: 4 }, { wait: 600 }, { probe: "a" },
      ...DONE("$ws"), { wait: 1200 }, { key: "2", mods: 4 }, { wait: 400 }, ...DONE("$ws"), { wait: 1200 }, ...DONE("$ws"), { wait: 1200 },
      { invoke: "party_set", args: { uids: [1, 2, 3, 4, 5, 6] }, log: true },
      { call: "openDex" }, { invoke: "own_call_test", args: { name: "poke", fn: "view", args: ["box"] } }, { wait: 500 },
      { invoke: "own_call_test", args: { name: "poke", fn: "pickUid", args: [4] } }, { wait: 300 }, { probe: "pick" }, { invoke: "own_call_test", args: { name: "poke", fn: "enter" } }, { wait: 1500 }, { probe: "main" },
      { call: "closeDex" }, { wait: 300 }, { key: "1", mods: 4 }, { wait: 500 }, { probe: "other" }],
    check: ({ probe, log }) => {
      const grew = [...log.matchAll(/^exp ws=\S+ via=party \{"uid":(\d+)\}/gm)].map((m) => Number(m[1]));
      const set6 = JSON.parse(log.match(/^lab-invoke party_set (.*)$/m)?.[1] || "{}");
      return [
        ok(probe.a?.partner && probe.a.partner === probe.b?.partner && probe.a?.paneTitle === "🐾 메인 파트너", `두 탭 ${probe.a?.partner} · ${probe.b?.partner} · 제목 ${probe.a?.paneTitle}`),
        ok(JSON.stringify(grew) === "[1,3,1]", `차례 ${JSON.stringify(grew)} (1 → 3 → 1, 졸업한 2는 건너뜀)`),
        ok(set6.list?.length === 5 && set6.max === 5, `파티 ${set6.list?.length}/${set6.max} (6을 줘도 5)`),
        ok(/메인 파트너로/.test(probe.pick?.take?.text || "") && !probe.pick.take.off, `단추 ${JSON.stringify(probe.pick?.take)}`),
        ok(probe.main?.party?.names?.[0] && probe.other?.partner === probe.main.party.names[0] && probe.other.partner !== probe.a?.partner, `[메인 파트너로] 뒤 다른 탭 ${probe.other?.partner} · 파티 1번 ${probe.main?.party?.names?.[0]}`),
        ok(/메인 파트너가 됐어요/.test(probe.main?.toast || probe.other?.toast || ""), `알림 ${probe.main?.toast}`),
      ];
    },
  },
  {
    id: "wild-rate", tags: ["smoke", "poke"], what: "야생은 어디서나 한 번 기회·10분 쉼(#122 — 파트너 없는 폴더 30 %·5분 없음): 마지막 만남 6분 40초 전이면 완료해도 안 나옴",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_COOLDOWN: "600" },
    setup: (box) => fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ last: Math.floor(Date.now() / 1000) - 400, next: { id: 16, shiny: false } })),
    steps: [{ until: "tabs.0" }, { until: "partner", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(!/^wild appeared/m.test(log) && !probe.after?.wild, `만남 ${log.match(/^wild appeared .*$/m)?.[0]} (10분 안)`)],
  },
  {
    id: "wild-rate-open", tags: ["smoke", "poke"], what: "야생 10분 쉼이 지나면(마지막 만남 11분 40초 전) 완료에 나옴 — wild-rate의 짝 (#122)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_COOLDOWN: "600" },
    setup: (box) => fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ last: Math.floor(Date.now() / 1000) - 700, next: { id: 16, shiny: false } })),
    steps: [{ until: "tabs.0" }, { until: "partner", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(/^wild appeared 16 ws=/m.test(log) && probe.after?.wild, `만남 ${log.match(/^wild appeared .*$/m)?.[0] || "없음"}`)],
  },
  {
    id: "drop-at-launch", tags: ["smoke", "launch"], what: "꺼진 Tamer에 폴더를 끌어 실행 → 시작 화면 없이 그 탭 (#32)",
    data: "owner", mode: "open", folders: ["my folder"],
    steps: [{ until: "tabs.0" }, { wait: 800 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.tabs?.[0] === "my folder", `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.start === false, "시작 화면이 떠 있음")],
  },
  {
    id: "late-drop", tags: ["smoke", "launch", "timing"], what: "켜지는 중에 폴더를 넘김 → 마지막 화면은 그 탭 (#32)",
    data: "owner", mode: "late", folders: ["my folder"], vary: { lateMs: [100, 300, 600, 900] },
    steps: [{ until: "tabs.0", timeout: 15000 }, { wait: 1200 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.tabs?.[0] === "my folder", `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.start === false, "시작 화면이 탭을 가림")],
  },
  {
    id: "slow-shell-start", tags: ["smoke", "slow-shell"], what: "셸 시작이 3초 걸리는 맥: 시작 화면은 기다리지 않고 1초 안에 (#31)",
    data: "empty", slowShell: 3, mode: "direct", folders: [],
    steps: [{ wait: 1000 }, { probe: "at1s" }, { wait: 3500 }, { probe: "later" }],
    check: ({ probe, log }) => [ok(probe.at1s?.start, "1초 때 시작 화면이 없음"), ok((startup(log, "start screen on screen") ?? 1e9) < 1000, `시작 화면이 보인 시각 ${startup(log, "start screen on screen")}ms`), ok((envMs(log) ?? 0) >= 3000, `셸 환경 ${envMs(log)}ms (느린 셸이 안 걸림)`)],
  },
  {
    id: "slow-shell-env", tags: ["smoke", "slow-shell"], what: "셸 시작이 4초 걸려도 에이전트가 받을 환경 변수(PATH·API 키 …)가 온전 (#34)",
    data: "empty", slowShell: 4, mode: "direct", folders: [],
    steps: [{ wait: 8000 }, { probe: "later" }],
    check: ({ log }) => { const n = Number(log.match(/env ready \((\d+) vars\)/)?.[1] || 0); return [ok(n > 10, `환경 변수 ${n}개만 받음 (셸 환경 읽기 시간 초과)`)]; },
  },
  {
    id: "slow-shell-folder", tags: ["smoke", "slow-shell"], what: "셸 시작이 3초 걸리는 맥에 폴더를 넘겨 실행 → 셸 준비 전에도 탭이 보임 (#35)",
    data: "owner", slowShell: 3, mode: "direct", folders: ["proj"],
    steps: [{ wait: 1000 }, { probe: "at1s" }, { until: "tabs.0", timeout: 20000 }, { wait: 500 }, { probe: "tab" }],
    check: ({ probe }) => [
      ok(probe.at1s?.start === false, "기다리는 동안 시작 화면이 깜박임"),
      ok(probe.tab?.tabs?.[0] === "proj", "탭이 안 열림"),
      ok(probe.at1s?.tabs?.length > 0, "기다리는 동안 빈 창(탭도 안내도 없음)"),
    ],
  },
  {
    id: "env-read-fails", tags: ["smoke", "slow-shell"], what: "셸 환경을 끝내 못 읽으면(시간 초과) 기록에 남기고 앱은 정상 (#34)",
    data: "owner", slowShell: 6, env: { CVIM_ENV_WAIT_MS: "2000" }, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0", timeout: 15000 }, { wait: 9000 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(/READ FAILED/.test(log), "읽기 실패가 기록에 없음"), ok(probe.after?.tabs?.[0] === "proj", "탭이 안 열림")],
  },
  {
    id: "slow-shell-late-drop", tags: ["explore", "slow-shell", "timing"], what: "느린 셸 + 켜지는 중에 폴더",
    data: "owner", slowShell: 3, mode: "late", folders: ["my folder"], vary: { lateMs: [300, 1500] },
    steps: [{ until: "tabs.0", timeout: 20000 }, { wait: 1200 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.tabs?.[0] === "my folder", "탭이 안 열림"), ok(probe.after?.start === false, "시작 화면이 탭을 가림")],
  },
  // ── last time's tabs (session restore) ──
  {
    id: "restore-tabs", tags: ["smoke", "restore"], what: "지난번에 갑자기 꺼진 뒤(정전·충돌) 다시 켜면 탭이 그대로, 마지막 탭이 앞",
    data: "owner", mode: "direct", folders: [], make: ["a", "b"], session: { tabs: ["a", "b"], active: "b" },
    steps: [{ until: "tabs.1" }, { wait: 800 }, { probe: "after" }],
    check: ({ probe }) => [ok(JSON.stringify(probe.after?.tabs) === '["a","b"]', `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.active === "b", `앞 탭 ${probe.after?.active}`), ok(probe.after?.start === false, "시작 화면이 떠 있음")],
  },
  {
    id: "restore-after-quit", tags: ["smoke", "restore"], what: "⌘Q로 끈 뒤에는 탭 없이 시작 화면",
    data: "owner", mode: "direct", folders: [], make: ["a"], session: { tabs: ["a"], active: "a", quit: true },
    steps: [{ wait: 1500 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.start === true, "시작 화면이 없음"), ok(probe.after?.tabs?.length === 0, `탭 ${JSON.stringify(probe.after?.tabs)}`)],
  },
  {
    id: "restore-missing-folder", tags: ["smoke", "restore"], what: "지난 탭 중 지워진 폴더는 건너뛰고 나머지만",
    data: "owner", mode: "direct", folders: [], make: ["a"], session: { tabs: ["a", "gone"], active: "gone" },
    steps: [{ until: "tabs.0" }, { wait: 1000 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(JSON.stringify(probe.after?.tabs) === '["a"]', `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.start === false, "시작 화면이 떠 있음"), ok(!/lab-error/.test(log), "오류")],
  },
  {
    id: "restore-plus-drop", tags: ["smoke", "restore", "launch"], what: "지난 탭이 있는데 폴더를 끌어 실행 → 지난 탭 + 그 폴더, 그 폴더가 앞",
    data: "owner", mode: "open", folders: ["b"], make: ["a"], session: { tabs: ["a"], active: "a" },
    steps: [{ until: "tabs.1", timeout: 15000 }, { wait: 800 }, { probe: "after" }],
    check: ({ probe }) => [ok(JSON.stringify([...(probe.after?.tabs || [])].sort()) === '["a","b"]', `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.active === "b", `앞 탭 ${probe.after?.active}`)],
  },
  // ── a folder handed to the app that's already running ──
  {
    id: "drop-running", tags: ["smoke", "launch"], what: "켜져 있는(시작 화면) Tamer에 폴더를 끌어 놓기 → 그 탭",
    data: "owner", mode: "late", folders: ["my folder"], vary: { lateMs: [4000] },
    steps: [{ until: "start" }, { until: "tabs.0", timeout: 20000 }, { wait: 800 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.tabs?.[0] === "my folder", `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.start === false, "시작 화면이 남음")],
  },
  {
    id: "drop-running-tabs", tags: ["smoke", "launch", "restore"], what: "탭이 열린 Tamer에 다른 폴더를 끌어 놓기 → 새 탭이 앞, 기존 탭 유지",
    data: "owner", mode: "late", folders: ["b"], make: ["a"], session: { tabs: ["a"], active: "a" }, vary: { lateMs: [4000] },
    steps: [{ until: "tabs.0" }, { until: "tabs.1", timeout: 20000 }, { wait: 800 }, { probe: "after" }],
    check: ({ probe }) => [ok(JSON.stringify(probe.after?.tabs) === '["a","b"]', `탭 ${JSON.stringify(probe.after?.tabs)}`), ok(probe.after?.active === "b", `앞 탭 ${probe.after?.active}`)],
  },
  // ── data from before / damaged ──
  {
    id: "legacy-cvim", tags: ["smoke", "data"], what: "이전 CVIM(~/.cache/cvim) 데이터만 있는 맥: 처음 켤 때 옮겨 오고, 그 폴더의 파트너는 고르기 창의 '예전 파트너'로 → [파티에 넣기]면 메인 파트너, CVIM 쪽은 그대로 (#122)",
    data: "legacy", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "chooser.mode", timeout: 10000 }, { wait: 500 }, { probe: "suggest" }, { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { until: "partner", timeout: 5000 }, { probe: "after" }],
    check: ({ probe, box }) => {
      const home = path.join(box.dir, "home"), read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, f), "utf8")); } catch { return null; } };
      const b = read("tamer/box.json");
      return [
        ok(probe.suggest?.chooser?.mode === "suggest" && /예전 파트너/.test(probe.suggest.chooser.title) && probe.suggest.chooser.picked.length === 1, `고르기 창 ${JSON.stringify(probe.suggest?.chooser && { mode: probe.suggest.chooser.mode, title: probe.suggest.chooser.title, picked: probe.suggest.chooser.picked })}`),
        ok(probe.after?.partner === "피카츄" && probe.after?.chooser === null, `파트너 ${probe.after?.partner}`),
        ok(fs.existsSync(path.join(home, "tamer/.from-cvim.json")), "옮긴 기록이 없음"),
        ok(b?.mons?.some((m) => m.id === 25 && m.xp === 30), "박스에 이전 파트너(EXP 30)가 없음"),
        ok(b?.mons?.some((m) => m.id === 16), "도감에서 잡은 포켓몬이 박스에 없음"),
        ok(!b?.mons?.some((m) => m.id === 7), "못 잡은(만난) 포켓몬이 박스에 들어감"),
        ok(!fs.existsSync(path.join(home, "cvim/box.json")) && read("cvim/folders.json")?.[box.folder("proj")]?.uid === undefined, "CVIM 쪽 데이터가 바뀜"),
      ];
    },
  },
  {
    id: "corrupt-data", tags: ["smoke", "data"], what: "데이터 파일이 중간에 잘린 맥: 앱은 뜨고(고르기 창이 첫 포켓몬으로), 고른 뒤에도 잘린 원본은 backup/corrupt에 남음 (#122)",
    data: "corrupt", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "chooser.ready", timeout: 10000 }, { probe: "open" }, { invoke: "own_key_test", args: { name: "choose", key: "1" } }, { invoke: "own_key_test", args: { name: "choose", key: "Enter" } }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe, log, box }) => [
      ok(probe.open?.tabs?.[0] === "proj", "탭이 안 열림"),
      ok(!/lab-error|Uncaught/.test(log), "오류"),
      ok(probe.picked?.partner, "파트너를 못 고름"),
      ok(filesWith(path.join(box.data, "backup", "corrupt"), '"how":"starter","at":1,').length > 0, "잘린 box.json(피카츄 EXP 40 등)이 덮어써져 사라짐 — 복구할 원본이 없음"),
      ok(fs.readdirSync(path.join(box.data, "backup", "corrupt")).some((n) => n.startsWith("pokedex.json.")), "잘린 pokedex 사본이 없음"), // folders.json isn't read any more (#122)
    ],
  },
  // ── input ──
  {
    id: "hangul-in-shell", tags: ["smoke", "input"], what: "셸에서 한글 조합 → 확정, 이어서 영문 — 글자가 겹치거나 빠지지 않음",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 3000 }, { text: "echo " }, { ime: "ㅎ" }, { ime: "하" }, { ime: "한" }, { text: "한" }, { ime: "ㄱ" }, { ime: "그" }, { ime: "글" }, { text: "글" }, { text: "ab" }, { wait: 600 }, { probe: "typed" }],
    check: ({ probe }) => [ok(/echo 한글ab$/.test(probe.typed?.line || ""), `셸 줄 ${JSON.stringify(probe.typed?.line)}`)],
  },
  {
    id: "hangul-cmd-arrow", tags: ["smoke", "input"], what: "한글 조합 중 ⌘← → 조합만 끝내고 글자는 제자리 (#15, 다른 터미널 앱과 같음)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 3000 }, { text: "echo ab" }, { ime: "ㅎ" }, { ime: "하" }, { key: "ArrowLeft", mods: 4, commands: ["moveToBeginningOfLine"] }, { wait: 300 }, { text: "하" }, { wait: 600 }, { probe: "after" }],
    check: ({ probe }) => [ok(/echo ab하$/.test(probe.after?.line || ""), `셸 줄 ${JSON.stringify(probe.after?.line)}`)],
  },
  // ── window size ──
  {
    id: "narrow-window", tags: ["smoke", "layout"], what: "좁은 창(1100·900·720): 상단 바·단축키 줄이 한 줄로 들어감, 가로 넘침 없음 · 포켓몬 창을 가장 작게(820×560) 해도 틀이 창 안에 (#38, #113 P2)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { call: "fakeUsage" },
      { resize: [1100, 600] }, { probe: "w1100" }, { resize: [900, 600] }, { probe: "w900" }, { shot: "narrow-900" }, { resize: [720, 520] }, { probe: "main" }, { shot: "narrow-720" },
      { call: "openDex" }, { invoke: "own_resize_test", args: { name: "poke", w: 400, h: 300 } }, { wait: 600 }, { probe: "dex" }, { call: "box" }, { wait: 400 }, { probe: "box" }, { invoke: "own_read_test", args: { name: "poke" }, log: true }, { shot: "narrow-box" }],
    check: ({ probe, log }) => [
      ok(probe.main?.width <= 730, `창 폭 ${probe.main?.width} (크기 바꾸기가 안 됨)`),
      ok(probe.main?.overflow === false, "메인 화면이 가로로 넘침"),
      ...["w1100", "w900", "main"].flatMap((k) => [ok(probe[k]?.barFits === true, `${k}: 상단 바가 넘치거나 두 줄`), ok(probe[k]?.hintFits === true, `${k}: 단축키 줄이 두 줄`)]),
      ok(probe.dex?.pokeFits === true, "도감 틀이 포켓몬 창 밖으로 나감"),
      ok(probe.box?.pokeFits === true, "내 포켓몬 틀이 포켓몬 창 밖으로 나감"),
      ...(() => { const r = JSON.parse(log.match(/^lab-invoke own_read_test (.*)$/m)?.[1] || "null"); return [ok(r?.bounds?.width >= 820 && r?.bounds?.height >= 560, `포켓몬 창 최소 크기 ${JSON.stringify(r?.bounds)}`)]; })(),
    ],
  },
  // ── find in the terminal (#40) ──
  {
    id: "term-search", tags: ["smoke", "input"], what: "터미널 ⌘F: 결과 수·다음·이전, 한글도, Esc로 닫고 터미널로, 포켓몬 창이 열려 있으면 도감 검색 (#40)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "echo 바늘1; echo 바늘2; echo needle" }, { key: "Enter" }, { wait: 800 },
      { key: "f", mods: 4 }, { wait: 300 }, { probe: "open" },
      { text: "바늘" }, { wait: 400 }, { probe: "found" },
      { key: "Enter" }, { wait: 300 }, { probe: "next" },
      { key: "Enter", mods: 8 }, { wait: 300 }, { probe: "prev" },
      { key: "Escape" }, { wait: 300 }, { probe: "closed" },
      { call: "openDex" }, { wait: 500 }, { key: "f", mods: 4 }, { wait: 300 }, { probe: "dex" }],
    check: ({ probe }) => [
      ok(probe.open?.tsearch && probe.open.focus === "tsearch-q", `⌘F에 검색 줄이 안 열림 (${JSON.stringify(probe.open?.tsearch)}, focus ${probe.open?.focus})`),
      ok(/^\d\/4$/.test(probe.found?.tsearch?.n || ""), `"바늘" 결과 수 ${probe.found?.tsearch?.n} (명령 줄 2 + 출력 2 = 4)`),
      ok(probe.next?.tsearch?.n !== probe.found?.tsearch?.n, "Enter로 다음 결과로 안 감"),
      ok(probe.prev?.tsearch?.n === probe.found?.tsearch?.n, `⇧Enter로 이전 결과로 안 감 (${probe.found?.tsearch?.n} → ${probe.next?.tsearch?.n} → ${probe.prev?.tsearch?.n})`),
      ok(probe.closed?.tsearch === null && /xterm-helper-textarea/.test(probe.closed?.focus || ""), "Esc로 안 닫히거나 터미널로 안 돌아감"),
      ok(probe.dex?.tsearch === null && probe.dex?.focus === "dex-search", `포켓몬 창에서 ⌘F가 도감 검색으로 안 감 (focus ${probe.dex?.focus})`),
    ],
  },
  {
    id: "term-search-scrollback", tags: ["smoke", "input"], what: "⌘F가 화면 밖(스크롤백)의 줄도 찾음 — 300줄 위의 단어 (#40)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "echo TOPMARK; seq 1 300" }, { wait: 200 }, { key: "Enter" }, { wait: 1200 },
      { key: "f", mods: 4 }, { wait: 300 }, { text: "TOPMARK" }, { wait: 500 }, { probe: "found" }, { grep: "TOPMARK" }, { grep: "lab$" }, { grep: "299" }],
    check: ({ probe }) => [ok(/^\d\/2$/.test(probe.found?.tsearch?.n || ""), `300줄 위 단어 결과 ${probe.found?.tsearch?.n} (명령 줄 + 출력 = 2)`), ok(probe.found?.tsearch?.alt === false, "일반 화면인데 \"보이는 화면만\" 안내")],
  },
  {
    id: "term-search-alt", tags: ["smoke", "input"], what: "전체 화면 프로그램(대체 화면)에서 ⌘F: \"보이는 화면만\" 안내, 일반 화면에선 안내 없음 (#40)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "printf '\\033[?1049h'; seq 1 100; echo ALTMARK; sleep 30" }, { wait: 200 }, { key: "Enter" }, { wait: 1200 },
      { key: "f", mods: 4 }, { wait: 300 }, { text: "ALTMARK" }, { wait: 500 }, { probe: "alt" }, { grep: "ALTMARK" }],
    check: ({ probe }) => [ok(probe.alt?.tsearch?.alt === true, `대체 화면인데 안내가 없음 (${JSON.stringify(probe.alt?.tsearch)})`), ok(/^1\/1$/.test(probe.alt?.tsearch?.n || ""), `보이는 단어 결과 ${probe.alt?.tsearch?.n}`)],
  },
  // ── app size (D1): only en / ko language files are shipped ──
  {
    id: "locale-fallback", tags: ["smoke", "launch"], what: "지운 언어(일본어)로 설정된 맥: 영어로 대체해 정상 실행, 폴더 탭·한글 화면 그대로 (D1)",
    data: "owner", mode: "direct", folders: ["proj"], args: ["--lang=ja"],
    steps: [{ until: "tabs.0" }, { wait: 800 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(probe.after?.tabs?.[0] === "proj", "탭이 안 열림"), ok(!/lab-error/.test(log), "오류")],
  },
  // ── which agent program runs (#42) ──
  {
    id: "codex-path-first", tags: ["smoke", "agents"], what: "Codex는 터미널과 같은 PATH의 codex를 먼저(--version에 답하면) — Codex 앱 안의 구버전보다 (#42)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    files: { "fakebin/codex": "#!/bin/sh\necho 'codex-cli 9.9.9-lab'\n" },
    steps: [{ until: "tabs.0" }, { invoke: "agents_status", log: true }],
    check: ({ log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke agents_status (.*)$/m)?.[1] || "{}");
      const at = st.list?.find((a) => a.key === "codex")?.path;
      return [ok(at === path.join(box.dir, "fakebin/codex"), `Codex 경로 ${at}`)];
    },
  },
  {
    id: "codex-broken-wrapper", tags: ["smoke", "agents"], what: "PATH의 codex가 실행되지 않으면(실행 파일 빠진 npm 설치) 건너뜀 (#42)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    files: { "fakebin/codex": "#!/bin/sh\necho 'missing optional dependency' >&2\nexit 1\n" },
    steps: [{ until: "tabs.0" }, { invoke: "agents_status", log: true }],
    check: ({ log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke agents_status (.*)$/m)?.[1] || "{}");
      const at = st.list?.find((a) => a.key === "codex")?.path;
      return [ok(at !== path.join(box.dir, "fakebin/codex"), `실행 안 되는 codex를 고름 (${at})`)];
    },
  },
  {
    id: "shell-env-dump", tags: ["explore", "agents"], what: "Dock에서 켠 것처럼(open) 실행한 Tamer 셸의 환경 변수 — 터미널과 다른 것을 보기 위한 기록 (#42)",
    data: "owner", mode: "open", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "env | sort > env.txt" }, { wait: 200 }, { key: "Enter" }, { wait: 800 }, { probe: "done" }],
    check: ({ box }) => [ok(fs.existsSync(path.join(box.folder("proj"), "env.txt")), "env.txt가 안 생김")],
  },
  {
    id: "dex-hatched-row", tags: ["smoke", "poke"], what: "도감: 24시간 안에 부화한 포켓몬은 \"🥚 새로 부화한 포켓몬\" 줄에 따로(새로 잡은 줄 아래), 위 버튼도 따로 — ↓로 두 줄을 오감 (#89)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      const b = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8"));
      b.mons.push({ uid: b.next++, id: 25, shiny: false, xp: 0, lv: 5, mile: 0, how: "egg", hatched: Math.floor(Date.now() / 1000) - 600, at: Math.floor(Date.now() / 1000) - 600, folder: null, new: true });
      fs.writeFileSync(path.join(box.data, "box.json"), JSON.stringify(b));
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, { key: "d", mods: 4 }, { wait: 1000 }, { probe: "dex" },
      { key: "ArrowDown" }, { wait: 300 }, { probe: "down" }],
    check: ({ probe }) => [
      ok(JSON.stringify(probe.dex?.dexRows?.slice(0, 2)) === '["🆕 새로 잡은 포켓몬:3","🥚 새로 부화한 포켓몬:1"]', `줄 ${JSON.stringify(probe.dex?.dexRows?.slice(0, 2))}`),
      ok(probe.down?.dexSel === "recent:25", `↓ → ${probe.down?.dexSel} (부화한 피카츄)`),
    ],
  },
  // ── 전설의 길 · 환상 리서치 E6 (#86, PKM-26 · PKM-27) ──
  {
    id: "legend-road", tags: ["smoke", "poke"], what: "전설의 길: 관동 일반종 120/146 = 82% → 1세대 전설(새 셋·뮤츠) 열림, 홈에 세대별 줄, 상점 전설의 향 목록에 뮤츠 (#86)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      const f = path.join(box.data, "pokedex.json"), dex = JSON.parse(fs.readFileSync(f, "utf8"));
      for (let id = 1; id <= 121; id++) if (![144, 145, 146, 150, 151].includes(id)) dex[id] = { name: `#${id}`, count: 1, first: 1 };
      fs.writeFileSync(f, JSON.stringify(dex));
      putEcon(box, { "state.json": { startSeen: true } });
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, { key: "p", mods: 4 }, { wait: 900 }, { probe: "home" },
      { invoke: "legend_road", log: true }, { invoke: "shop_state", log: true }],
    check: ({ probe, log }) => {
      const lr = JSON.parse(log.match(/^lab-invoke legend_road (.*)$/m)?.[1] || "{}"), st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      const g1 = lr.road?.[0];
      return [
        ok(g1?.got >= 120 && g1.pct >= 80 && g1.legends.every((l) => l.open), `관동 ${g1?.got}/${g1?.of} ${g1?.pct}% ${JSON.stringify(g1?.legends?.map((l) => [l.name, l.open]))}`),
        ok(lr.road?.[1]?.legends.every((l) => !l.open), "성도 전설이 0%인데 열림"),
        ok((st.legends || []).some((l) => l.id === 150), `전설의 향 목록 ${JSON.stringify(st.legends?.map((l) => l.name))}`),
        ok(/^관동\d+% ✔ 프리저·썬더·파이어·뮤츠$/.test(probe.home?.road?.[0] || "") && /50%: 라이코·앤테이·스이쿤 · 80%: 루기아·칠색조/.test(probe.home?.road?.[1] || ""), `홈 전설의 길 ${JSON.stringify(probe.home?.road?.slice(0, 2))}`),
      ];
    },
  },
  {
    id: "usage-shared", tags: ["smoke", "agent"], what: "같은 Claude를 두 탭에서: 각 탭 상태줄이 자기 마지막 응답 값을 계속 보내도(a 20%·b 35%) 두 탭 모두 같은 창에서 더 늦게 받은 b의 값 5h 35%·7d 15%, 기억값도 흔들리지 않음 (STA-09 규칙 5, #96 #103)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    env: { CVIM_DESKTOP_AUTOSTART: "1", CVIM_DESKTOP_AGENT_CMD: (box) => path.join(box.dir, "fakebin", "claude-tabs") },
    // a stand-in Claude whose status line says what "its last reply" saw: tab a an older 20 % of the same windows
    // (b's reply comes 2 s later — the later one received wins, #103)
    files: { "fakebin/claude-tabs": "#!/bin/sh\ncase \"$(basename \"$PWD\")\" in a) p=20; w=12;; *) p=35; w=15; sleep 2;; esac\nfor i in $(seq 40); do\n  now=$(date +%s)\n  printf '{\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":%s,\"resets_at\":%s},\"seven_day\":{\"used_percentage\":%s,\"resets_at\":%s}},\"context_window\":{\"used_percentage\":21,\"context_window_size\":1000000}}' $p $(( (now / 3600 + 2) * 3600 )) $w $(( (now / 86400 + 3) * 86400 )) | bash \"$CVIM_ROOT/claude/statusline.sh\" >/dev/null\n  sleep 1\ndone\n" },
    steps: [{ until: "tabs.1" }, { wait: 1500 }, { call: "closeDex" }, { wait: 5000 },
      { key: "1", mods: 4 }, { wait: 2500 }, { probe: "a" }, { key: "2", mods: 4 }, { wait: 2500 }, { probe: "b" }, { key: "1", mods: 4 }, { wait: 2500 }, { probe: "a2" }],
    check: ({ probe }) => {
      const both = (p) => /5h\D*35%/.test(p?.usage || "") && /7d\D*15%/.test(p?.usage || "");
      return [
        ok(probe.a?.active === "a" && probe.b?.active === "b", `탭 ${probe.a?.active} ${probe.b?.active}`),
        ok(both(probe.a) && both(probe.a2), `탭 a 상단 바 ${probe.a?.usage} / ${probe.a2?.usage} — b가 알린 35%·15%여야`),
        ok(both(probe.b), `탭 b 상단 바 ${probe.b?.usage}`),
        ok([probe.a, probe.b, probe.a2].every((p) => p?.usageLast === "35/15"), `기억값 ${[probe.a, probe.b, probe.a2].map((p) => p?.usageLast)}`),
      ];
    },
  },
  {
    id: "usage-reset", tags: ["smoke", "agent"], what: "Claude 한도 초기화: 같은 창(초기화 시각 같음) 안에서 7d가 99% → 4%로 내려가면, 옛 99%를 계속 다시 쓰는 다른 탭이 있어도 두 탭 상단 바·기억값 모두 4% (STA-09 규칙 5, #103)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    env: { CVIM_DESKTOP_AUTOSTART: "1", CVIM_DESKTOP_AGENT_CMD: (box) => path.join(box.dir, "fakebin", "claude-reset") },
    // tab a waits: its status line keeps rewriting its last reply (7d 99 %); tab b replies again after the reset (4 %, new API time)
    files: { "fakebin/claude-reset": "#!/bin/sh\nfor i in $(seq 40); do\n  now=$(date +%s); w=99; api=5\n  if [ \"$(basename \"$PWD\")\" = b ] && [ $i -gt 4 ]; then w=4; api=9; fi\n  printf '{\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":30,\"resets_at\":%s},\"seven_day\":{\"used_percentage\":%s,\"resets_at\":%s}},\"cost\":{\"total_api_duration_ms\":%s},\"context_window\":{\"used_percentage\":21,\"context_window_size\":1000000}}' $(( (now / 3600 + 2) * 3600 )) $w $(( (now / 86400 + 3) * 86400 )) $api | bash \"$CVIM_ROOT/claude/statusline.sh\" >/dev/null\n  sleep 1\ndone\n" },
    steps: [{ until: "tabs.1" }, { wait: 1500 }, { call: "closeDex" }, { wait: 7000 },
      { key: "1", mods: 4 }, { wait: 2500 }, { probe: "a" }, { key: "2", mods: 4 }, { wait: 2500 }, { probe: "b" }],
    check: ({ probe }) => {
      const reset = (p) => /7d\D*4%/.test(p?.usage || "") && /5h\D*30%/.test(p?.usage || "");
      return [
        ok(probe.a?.active === "a" && probe.b?.active === "b", `탭 ${probe.a?.active} ${probe.b?.active}`),
        ok(reset(probe.a), `탭 a 상단 바 ${probe.a?.usage} — b가 초기화 뒤 받은 7d 4%여야`),
        ok(reset(probe.b), `탭 b 상단 바 ${probe.b?.usage}`),
        ok([probe.a, probe.b].every((p) => p?.usageLast === "30/4"), `기억값 ${[probe.a, probe.b].map((p) => p?.usageLast)}`),
      ];
    },
  },
  {
    id: "limits-codex", tags: ["smoke", "agent"], what: "채팅 없이 Codex 한도: 앱이 뜨고 몇 초 뒤 Codex 앱 서버(가짜)에 계정 한도만 물어 메뉴바·기억값에 5시간 12%·주간 30% — 대화 없음, Claude는 로그인이 없으면 묻지도 읽지도 않음 (STA-21, #104)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_LIMITS_CODEX_CMD: (box) => path.join(box.dir, "fakebin", "codex-app") },
    // a stand-in app server: answers initialize and account/rateLimits/read (the windows by their length), nothing else
    files: { "fakebin/codex-app": "#!/bin/sh\nnow=$(date +%s)\nwhile IFS= read -r line; do\n  case \"$line\" in\n    *'\"id\":1,'*) printf '{\"id\":1,\"result\":{\"userAgent\":\"x\"}}\\n';;\n    *'\"id\":2,'*) printf '{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":30,\"windowDurationMins\":10080,\"resetsAt\":%s},\"secondary\":{\"usedPercent\":12,\"windowDurationMins\":300,\"resetsAt\":%s}}}}\\n' $((now + 400000)) $((now + 7000));;\n  esac\ndone\n" },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 }, { invoke: "limits_test", log: true }, { invoke: "tray_test", log: true }],
    check: ({ log }) => {
      const st = JSON.parse(log.match(/^lab-invoke limits_test (.*)$/m)?.[1] || "{}");
      const tray = JSON.parse(log.match(/^lab-invoke tray_test (.*)$/m)?.[1] || "{}");
      const labels = (tray.items || []).map((i) => i.label || "");
      return [
        ok(st.state?.codex?.at > 0 && !st.state?.codex?.error, `Codex 한도를 읽었어야 ${JSON.stringify(st.state)}`),
        ok(labels.some((l) => /Codex\s+5시간 12%.*주간 30%/.test(l)), `메뉴바 Codex 줄(창 길이로 5시간·주간을 고름) ${JSON.stringify(labels.filter((l) => /%/.test(l)))}`),
        ok(labels.some((l) => /^↻ 한도 새로 고침 \(방금\)$/.test(l)), `새로 고침 줄 ${JSON.stringify(labels.filter((l) => /↻/.test(l)))}`),
        ok(st.keychainReads === 0 && st.fetches === 0 && st.settings?.claude === null && !/limits ask/.test(log), `Claude 로그인이 없으면 묻지도 읽지도 않아야 ${JSON.stringify({ k: st.keychainReads, f: st.fetches, s: st.settings })}`),
      ];
    },
  },
  {
    id: "limits-claude", tags: ["smoke", "agent"], what: "채팅 없이 Claude 한도(켬): 처음 한 번 묻고(가짜 답 '켜기') 그때 로그인 정보를 한 번 읽어 5시간 23%·주간 9% · 15분 자동 갱신은 메모리의 토큰으로(로그인 안 읽음) · 만료(401)면 토큰을 버리고 저절로 한 번 더 읽음 — 그것도 만료면 '눌러야 읽어요', 그 뒤 자동 갱신은 안 읽음 · 메뉴바 새로 고침을 누르면 다시 읽음 · 토큰 값은 기록·데이터 어디에도 없음 (STA-21, POL-AGENT-02 1-2~1-4, #104 #115 A1)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_TEST_LIMITS: (box) => path.join(box.dir, "limits"), CVIM_TEST_LIMITS_CONSENT: "yes" },
    files: {
      "limits/claude-cred.json": '{"claudeAiOauth":{"accessToken":"LAB-SECRET-TOKEN-104","expiresAt":4102444800000}}',
      "limits/claude-usage.json": '{"five_hour":{"utilization":23.0,"resets_at":"2099-01-01T05:00:00.000+00:00"},"seven_day":{"utilization":9.0,"resets_at":"2099-01-04T23:00:00+00:00"},"limits":[]}',
    },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "limits_test", log: true }, { invoke: "tray_test", log: true },
      { invoke: "limits_test", args: { auto: true }, log: true },
      { invoke: "limits_test", args: { status: 401, auto: true }, log: true }, { invoke: "tray_test", log: true },
      { invoke: "limits_test", args: { status: 200, auto: true }, log: true },
      { invoke: "tray_click_test", args: { path: ["↻ 한도 새로 고침 — Claude는 눌러야 읽어요"] }, log: true }, { wait: 800 },
      { invoke: "limits_test", log: true }],
    check: ({ log, box }) => {
      const st = [...log.matchAll(/^lab-invoke limits_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const trays = [...log.matchAll(/^lab-invoke tray_test (.*)$/gm)].map((m) => (JSON.parse(m[1]).items || []).map((i) => i.label || ""));
      const [first, auto, expired, after, pressed] = st;
      const files = []; const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else files.push(p); } };
      try { walk(box.data); } catch {}
      const leaked = files.filter((f) => { try { return fs.readFileSync(f, "utf8").includes("LAB-SECRET-TOKEN-104"); } catch { return false; } });
      return [
        ok(/limits ask/.test(log) && first?.settings?.claude === true, `처음 한 번 묻고 켜짐 ${JSON.stringify(first?.settings)}`),
        ok(first?.keychainReads === 1 && first?.fetches === 1 && first?.token === true, `켤 때 로그인 정보 한 번 읽고 한 번 물음 ${JSON.stringify(first && { k: first.keychainReads, f: first.fetches, t: first.token })}`),
        ok(trays[0]?.some((l) => /Claude Code\s+5시간 23%.*주간 9%/.test(l)), `메뉴바 Claude 줄 ${JSON.stringify(trays[0]?.filter((l) => /%/.test(l)))}`),
        ok(auto?.keychainReads === 1 && auto?.fetches === 2, `자동 갱신은 메모리의 토큰으로 — 키체인 안 읽음 ${JSON.stringify(auto && { k: auto.keychainReads, f: auto.fetches })}`),
        ok(expired?.token === false && expired?.state?.claude?.error === "expired" && expired?.keychainReads === 2 && expired?.fetches === 4 && trays[1]?.includes("↻ 한도 새로 고침 — Claude는 눌러야 읽어요"), `만료면 버리고 저절로 한 번 더 읽음(그것도 만료) → '눌러야 읽어요' ${JSON.stringify(expired && { s: expired.state?.claude, k: expired.keychainReads, f: expired.fetches })} ${JSON.stringify(trays[1]?.filter((l) => /↻/.test(l)))}`),
        ok(after?.keychainReads === 2 && after?.fetches === 4 && after?.token === false, `그 뒤 자동 갱신은 로그인을 다시 읽지 않음 ${JSON.stringify(after && { k: after.keychainReads, f: after.fetches })}`),
        ok(/^lab-invoke tray_click_test true$/m.test(log) && pressed?.keychainReads === 3 && pressed?.token === true && !pressed?.state?.claude?.error, `누르면 다시 읽음 ${JSON.stringify(pressed && { k: pressed.keychainReads, t: pressed.token, s: pressed.state?.claude })}`),
        ok(!log.includes("LAB-SECRET-TOKEN-104") && !leaked.length, `토큰 값이 앱 기록·데이터에 없어야 ${JSON.stringify(leaked.map((f) => path.relative(box.data, f)))}`),
      ];
    },
  },
  {
    id: "limits-claude-start", tags: ["smoke", "agent"], what: "Claude 한도가 켜져 있으면 앱이 뜰 때 로그인을 저절로 한 번 읽어 5시간·주간을 채움(전엔 누를 때까지 비어 있었음) · 확인 창에서 '거부'(가짜)면 그 실행 동안 자동 갱신은 다시 묻지 않고, 누르면 다시 물음 (STA-21 규칙 2, POL-AGENT-02 1-3, #115 A1)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_TEST_LIMITS: (box) => path.join(box.dir, "limits") },
    files: {
      "limits/claude-cred.json": '{"claudeAiOauth":{"accessToken":"LAB-SECRET-TOKEN-115","expiresAt":4102444800000}}',
      "limits/claude-usage.json": '{"five_hour":{"utilization":31.0,"resets_at":"2099-01-01T05:00:00.000+00:00"},"seven_day":{"utilization":12.0,"resets_at":"2099-01-04T23:00:00+00:00"}}',
    },
    setup: (box) => { const f = path.join(box.data, "ui", "settings.json"); const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ ...cur, limits: { ...(cur.limits || {}), claude: true } })); },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "limits_test", log: true }, { invoke: "tray_test", log: true },
      { invoke: "limits_deny_test", args: { on: true } }, { invoke: "limits_test", args: { status: 401, auto: true }, log: true },
      { invoke: "limits_test", args: { status: 200, auto: true }, log: true },
      { invoke: "limits_refresh", args: { user: true } }, { invoke: "limits_test", log: true },
      { invoke: "limits_deny_test", args: { on: false } }, { invoke: "limits_refresh", args: { user: true } }, { invoke: "limits_test", log: true }],
    check: ({ log }) => {
      const [start, deny, quiet, pressDenied, pressOk] = [...log.matchAll(/^lab-invoke limits_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const tray = (JSON.parse(log.match(/^lab-invoke tray_test (.*)$/m)?.[1] || "{}").items || []).map((i) => i.label || "");
      return [
        ok(!/^limits ask$/m.test(log) && start?.keychainReads === 1 && start?.token === true && tray.some((l) => /Claude Code\s+5시간 31%.*주간 12%/.test(l)), `앱이 뜰 때 저절로 한 번 읽음 — 묻지 않음, 메뉴바에 5시간 31%·주간 12% ${JSON.stringify(start && { k: start.keychainReads, t: start.token })} ${JSON.stringify(tray.filter((l) => /%/.test(l)))}`),
        ok(deny?.state?.claude?.error === "denied" && deny?.keychainReads === 2, `만료 뒤 저절로 읽다 거부 ${JSON.stringify(deny && { s: deny.state?.claude, k: deny.keychainReads })}`),
        ok(quiet?.keychainReads === 2 && quiet?.state?.claude?.error === "denied", `거부 뒤 자동 갱신은 다시 묻지 않음 ${JSON.stringify(quiet && { s: quiet.state?.claude, k: quiet.keychainReads })}`),
        ok(pressDenied?.keychainReads === 3 && pressOk?.keychainReads === 4 && pressOk?.token === true && !pressOk?.state?.claude?.error, `누르면 다시 물음(거부 → 허용) ${JSON.stringify([pressDenied?.keychainReads, pressOk && { k: pressOk.keychainReads, t: pressOk.token, s: pressOk.state?.claude }])}`),
        ok(!log.includes("LAB-SECRET-TOKEN-115"), "토큰 값이 앱 기록에 없음"),
      ];
    },
  },
  {
    id: "limits-claude-press", tags: ["smoke", "agent"], what: "키체인 확인 창(#124): 앱이 뜰 때 처음 한 번만 묻고('항상 허용' 가짜) 그 뒤 새로 고침은 창 없이 · Claude Code가 항목을 다시 써 허용이 풀려도(가짜) 쓸 수 있는 토큰이 있으면 새로 고침에서 묻지 않음(keychain=kept) · 토큰이 만료돼 없을 때만 다시 물음 — 어떻게 얻었는지는 앱 기록에(값은 없음) (STA-21 규칙 2, POL-AGENT-02 1-3)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_TEST_LIMITS: (box) => path.join(box.dir, "limits") },
    files: {
      "limits/claude-cred.json": '{"claudeAiOauth":{"accessToken":"LAB-SECRET-TOKEN-124","expiresAt":4102444800000}}',
      "limits/claude-usage.json": '{"five_hour":{"utilization":31.0,"resets_at":"2099-01-01T05:00:00.000+00:00"},"seven_day":{"utilization":12.0,"resets_at":"2099-01-04T23:00:00+00:00"}}',
    },
    setup: (box) => { const f = path.join(box.data, "ui", "settings.json"); const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ ...cur, limits: { ...(cur.limits || {}), claude: true } })); },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "limits_test", log: true }, // the start: one prompt, "Always Allow"
      { invoke: "limits_refresh", args: { user: true } }, { invoke: "limits_test", log: true }, // a press: read again without a prompt
      { invoke: "limits_allow_test", args: { on: false } }, { invoke: "limits_refresh", args: { user: true } }, { invoke: "limits_test", log: true }, // allowance gone: the token kept
      { invoke: "limits_test", args: { status: 401, auto: true }, log: true }, // no longer accepted: read again — the prompt
      { invoke: "limits_test", args: { status: 200 } }, { invoke: "limits_refresh", args: { user: true } }, { invoke: "limits_test", log: true }],
    check: ({ log }) => {
      const [start, press, kept, expired, after] = [...log.matchAll(/^lab-invoke limits_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const how = [...log.matchAll(/^limits claude (\S+)(?: \(asked\))?(?: keychain=(\w+))?$/gm)].map((m) => `${m[1]}:${m[2] || "-"}`);
      return [
        ok(start?.prompts === 1 && start?.token === true && !start?.state?.claude?.error, `앱이 뜰 때 한 번 물음 ${JSON.stringify(start && { p: start.prompts, t: start.token })}`),
        ok(press?.prompts === 1 && press?.keychainReads === 2 && press?.token === true, `'항상 허용' 뒤 새로 고침은 창 없이 다시 읽음 ${JSON.stringify(press && { p: press.prompts, k: press.keychainReads })}`),
        ok(kept?.prompts === 1 && kept?.token === true && !kept?.state?.claude?.error, `허용이 풀려도 쓸 수 있는 토큰이면 새로 고침에서 안 물음 ${JSON.stringify(kept && { p: kept.prompts, t: kept.token, s: kept.state?.claude })}`),
        ok(expired?.prompts === 2 && after?.prompts === 2 && after?.token === true, `토큰을 못 쓰게 되면 그때만 다시 물음 — 그 뒤 새로 고침은 창 없이 ${JSON.stringify([expired?.prompts, after && { p: after.prompts, t: after.token }])}`),
        ok(how.includes("ok:prompt") && how.includes("ok:silent") && how.includes("ok:kept"), `앱 기록의 keychain= ${JSON.stringify(how)}`),
        ok(!log.includes("LAB-SECRET-TOKEN-124"), "토큰 값이 앱 기록에 없음"),
      ];
    },
  },
  {
    id: "limits-claude-declined", tags: ["smoke", "agent"], what: "채팅 없이 Claude 한도(켜지 않음): 처음 질문에 '켜지 않음'이면 꺼진 채 — 로그인 정보·주소 모두 안 씀, 다시 묻지 않음 · 설정에서 켜려 해도 설명 창에서 '켜지 않음'이면 그대로 꺼짐 (STA-21, POL-AGENT-02 1-2, #104)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_TEST_LIMITS: (box) => path.join(box.dir, "limits"), CVIM_TEST_LIMITS_CONSENT: "no" },
    files: { "limits/claude-cred.json": '{"claudeAiOauth":{"accessToken":"LAB-SECRET-TOKEN-104","expiresAt":4102444800000}}', "limits/claude-usage.json": '{"five_hour":{"utilization":23.0}}' },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "limits_test", log: true },
      { invoke: "settings_set", args: { patch: { limits: { claude: true } } } }, { wait: 500 },
      { invoke: "limits_test", log: true }],
    check: ({ log }) => {
      const [first, again] = [...log.matchAll(/^lab-invoke limits_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const asks = (log.match(/^limits ask$/gm) || []).length;
      return [
        ok(first?.settings?.claude === false && first?.keychainReads === 0 && first?.fetches === 0, `켜지 않음이면 아무것도 안 읽음 ${JSON.stringify(first && { s: first.settings, k: first.keychainReads, f: first.fetches })}`),
        ok(again?.settings?.claude === false && again?.keychainReads === 0 && again?.fetches === 0 && asks === 2, `설정에서 켜려 하면 다시 설명 창(2번째) — 켜지 않음이면 그대로 ${JSON.stringify(again && { s: again.settings, k: again.keychainReads })} 물음 ${asks}`),
      ];
    },
  },
  {
    id: "popover-dashboard", tags: ["smoke", "app"], what: "메뉴바 미니 대시보드: 왼쪽 클릭(시험 명령)으로 열면 홈 탭 — 사용 한도(Claude 5시간 세션 58% 남음·주간 82% 남음 — 남은 만큼, #115 A2), 작업 탭 — 오늘 완료·Tamer 탭(입력 필요가 맨 위) — 탭을 누르면 대시보드가 닫히고 그 탭으로 · 에이전트가 둘이면 칩으로 하나씩, 칩 점 = 가장 많이 쓴 창의 색(Codex 주간 85% → 빨강, #118) · 초기화가 지난 창은 '초기화됨'(A6), 초기화 시각이 있으면 남은 시간 눈금(A4) (STA-22, #105 #115 #118)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    steps: [{ until: "tabs.1" }, { wait: 1200 }, { call: "closeDex" }, { wait: 300 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "waiting" } }, { wait: 300 },
      { invoke: "usage_seen", args: { key: "claude", five_hour: { pct: 42, resets_at: 4102444800 }, seven_day: { pct: 18, resets_at: 4102444800 } } },
      { invoke: "usage_seen", args: { key: "codex", five_hour: { pct: 70, resets_at: LIM_PAST }, seven_day: { pct: 85, resets_at: LIM_HALF_WEEK } } },
      { invoke: "popover_test", args: { open: true }, log: true }, { wait: 1500 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: ".pop-chip[data-agent='codex']" } }, { wait: 300 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: "#pop-nav [data-page='work']" } }, { wait: 300 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: ".pop-tab" }, log: true }, { wait: 800 }, { invoke: "popover_test", log: true }, { probe: "after" }],
    check: ({ log, probe }) => {
      const opens = [...log.matchAll(/^lab-invoke popover_test (.*)$/gm)].map((m) => JSON.parse(m[1]).open);
      const [r, c, w] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const first = w?.tabs?.[0] || "";
      return [
        ok(opens[0] === true && /^popover open$/m.test(log), `열림 ${JSON.stringify(opens)}`),
        ok(r?.page === "home" && r?.dot === false && /사용 한도/.test(r?.text || "") && !/오늘 완료/.test(r?.text || "") && /Claude\s*Codex\s*5시간 세션\s+58% 남음[\s\S]*주간\s+82% 남음/.test(r?.text || "") && !/Codex\s*5시간 세션\s+100%/.test(r?.text || ""), `홈 탭·점 없음, 한도(남은 만큼) — Claude 칩만 보임 ${JSON.stringify([r?.page, r?.dot, r?.text?.match(/사용 한도[\s\S]{0,200}/)?.[0]])}`),
        ok(JSON.stringify(r?.chips) === '["claude*:lv-ok","codex:lv-bad"]' && JSON.stringify(c?.chips) === '["claude:lv-ok","codex*:lv-bad"]', `칩: 처음 Claude, 누르면 Codex · Codex 점 빨강(주간 85%) ${JSON.stringify([r?.chips, c?.chips])}`),
        ok(/5시간 세션\s+100% 남음\s+초기화됨 — 다음 요청부터 새 창\s+주간\s+15% 남음\s+3일 12시간/.test(c?.text || "") && !/58% 남음/.test(c?.text || "") && c?.look?.ticks?.length === 1 && Math.abs(c.look.ticks[0] - 50) < 1.5, `Codex 5시간은 초기화됨, 주간은 15% 남음·3일 12시간·눈금 50% ${JSON.stringify([c?.text?.match(/사용 한도[\s\S]{0,160}/)?.[0], c?.look?.ticks])}`),
        ok(w?.page === "work" && /오늘 완료/.test(w?.text || "") && !/사용 한도/.test(w?.text || "") && w?.tabs?.length === 2 && /입력 필요/.test(first), `작업 탭: 오늘 완료·탭 2개, 입력 필요가 맨 위 ${JSON.stringify([w?.page, w?.tabs])}`),
        ok(/^lab-invoke popover_click_test true$/m.test(log) && opens[1] === false && probe.after?.active && first.startsWith(probe.after.active), `탭을 누르면 닫히고 그 탭으로 ${JSON.stringify(opens)} 지금 탭 ${probe.after?.active}`),
      ];
    },
  },
  {
    id: "background-close", tags: ["smoke", "app"], what: "백그라운드: 메인 창을 닫으면 앱은 메뉴바에 남음 — 터미널은 끝나고 탭 기록은 그대로, 처음 한 번 안내, 대시보드는 계속 · 대시보드 ⚙는 설정 창만(터미널 창 없이, #113 P1) · 대시보드 파티는 포켓몬 창만(#113 P2) · 대시보드 [Tamer 열기]로 창이 다시 열리고 탭이 돌아옴 (APP-21, APP-22 규칙 8, #106)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], until: "bg-done", timeoutMs: 40000,
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { invoke: "party_test", args: { n: 2 } }, { invoke: "background_test" }, { wait: 15000 }],
    check: ({ log }) => {
      const closed = log.match(/^bg closed (.*)$/m)?.[1] || "", back = log.match(/^bg reopened (.*)$/m)?.[1] || "";
      return [
        ok(/^window closed: Tamer stays in the menu bar$/m.test(log) && !/^user quit/m.test(log), "창을 닫아도 끝나지 않아야"),
        ok(/^bg settings open=true movable=true win=false$/m.test(log), `창이 없을 때 대시보드 ⚙ → 설정 창만(터미널 창 안 생김, #113 P1 APP-22 규칙 8) ${log.match(/^bg settings .*$/m)?.[0]}`),
        ok(/^bg poke-party open=true view=box tabs=\["home","box","dex","shop","bag"\] win=false$/m.test(log), `창이 없을 때 대시보드 파티 → 포켓몬 창만(내 포켓몬 파티 줄, 탭 다섯 — #113 P2 · #121 · #122) ${log.match(/^bg poke-party .*$/m)?.[0]}`),
        ok(/win=false tabs=0 popover=\w+ saved=1 quit=false/.test(closed), `닫은 뒤: 창 없음·터미널 끝·탭 기록 1개 그대로(끝냄 표시 없음) — ${closed}`),
        ok((log.match(/^background notice$/gm) || []).length === 1, "처음 한 번 안내"),
        ok(/^bg overlay alive=true wants=true party=2$/m.test(log), `탭이 없을 때 오버레이에 파티 2마리(#107) — ${log.match(/^bg overlay .*$/m)?.[0]}`),
        ok(/click=true win=true tabs=1 overlay=true/.test(back) && (log.match(/^startup window created/gm) || []).length === 2 && !/overlay twice/.test(log), `[Tamer 열기]로 창·탭이 다시, 오버레이는 그대로 — ${back}`),
      ];
    },
  },
  {
    id: "background-overlay-look", tags: ["explore", "app"], what: "창이 없을 때 오버레이 모습(실제 사용자 설정: 최소 모드 늘·카드 배경 0%): 파티 카드, 그 위 야생 알림 — 사진 bg-overlay.png · bg-overlay-wild.png와 크기 기록 (#109 조사)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], until: "bg-done", timeoutMs: 50000, env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_COOLDOWN: "0" },
    // TAMER_TALL_GIF (a tall picture made for the run) stands in for the party lead's sprite, and the overlay sits where the user's does (#109)
    setup: (box) => {
      if (process.env.TAMER_TALL_GIF) fs.copyFileSync(process.env.TAMER_TALL_GIF, path.join(box.data, "pokemon", "134.gif"));
      fs.mkdirSync(path.join(box.data, "ui"), { recursive: true });
      fs.writeFileSync(path.join(box.data, "ui", "desktop_overlay.json"), JSON.stringify({ right: 1093, bottom: 480, collapsed: false }));
    },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { invoke: "settings_set", args: { patch: { overlay: { minimal: "always", alpha: 0, when: "always" } } } },
      { invoke: "party_test", args: { n: 3 } }, { invoke: "incubator_add_test", args: { kind: "egg", have: 4 } }, { invoke: "background_test" }, { wait: 25000 }],
    check: ({ log }) => {
      const fit = JSON.parse(log.match(/^bg overlay fit (\{.*?\}) bounds/m)?.[1] || "{}");
      return [ok(/^bg overlay wild /m.test(log), "야생 알림까지 찍음"),
        // with the tall picture: the card stays inside the 120 × 120 box — the window ~170 px, not ~350 (#109)
        ...(process.env.TAMER_TALL_GIF ? [ok(fit.stack?.[1] <= 200, `키 큰 그림도 상자 안 — 오버레이 높이 ${fit.stack?.[1]}`)] : [])];
    },
  },
  {
    id: "background-wild-catch", tags: ["smoke", "app", "poke"], what: "창을 닫아 메뉴바로만 쓸 때 바탕화면 야생 알림을 누르면 알림 옆 작은 잡기 창 — Tamer 창은 생기지 않음, 그 창에서 마스터볼로 던지면 잡히고 잠시 뒤 잡기 창이 닫힘 · 잡기 전엔 도감 버튼이 숨어 있음(잡으면 [📕 도감에서 보기] — #113 P2) (PKM-08 규칙 3, #119)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], until: "bg-done", timeoutMs: 60000, env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_COOLDOWN: "0" },
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 2000 }, { day: d, kind: "buy", item: "master", n: 1, amount: -1500 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
      fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } }));
    },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { invoke: "background_test" }, { wait: 40000 }],
    check: ({ log }) => {
      const c = JSON.parse(log.match(/^bg catch (\{.*\})$/m)?.[1] || "null"), after = log.match(/^bg catch after (.*)$/m)?.[1] || "";
      return [
        ok(/^window closed: Tamer stays in the menu bar$/m.test(log) && /^wild appeared 16 /m.test(log) && /^wild open from overlay$/m.test(log), "창을 닫은 뒤 밖 작업으로 야생 · 알림을 누름"),
        ok(c?.open && c.wild && c.win === false && c.beside && c.dex === false && c.balls?.includes("master"), `잡기 창: 야생 카드·마스터볼, 알림 옆, Tamer 창 없음, 잡기 전 도감 버튼 숨음 ${JSON.stringify(c && { open: c.open, wild: c.wild, win: c.win, beside: c.beside, dex: c.dex, balls: c.balls })}`),
        ok(/^wild throw caught/m.test(log) && /^thrown=true open=false win=false$/.test(after) && /^catch closed$/m.test(log), `잡기 창에서 잡힘 → 잡기 창 닫힘, Tamer 창은 여전히 없음 (${after})`),
        ok(/^bg poke dex=true open=true view=dex sel=\w+:16 movable=true win=false$/m.test(log), `잡은 뒤 [📕 도감에서 보기] → 포켓몬 창이 그 종(16)에, Tamer 창 없음 (#113 P2) — ${log.match(/^bg poke dex.*$/m)?.[0]}`),
      ];
    },
  },
  {
    id: "background-off-quits", tags: ["smoke", "app"], what: "백그라운드를 끄면 메인 창을 닫을 때 전처럼 앱이 끝남 — 대시보드를 한 번 열었어도(숨은 창이 앱을 붙잡지 않음) (APP-21 규칙 1, #105 미리보기에서 발견)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], until: "user quit", timeoutMs: 25000,
    steps: [{ until: "tabs.0" }, { wait: 1200 }, { call: "closeDex" }, { invoke: "settings_set", args: { patch: { background: false } } },
      { invoke: "popover_test", args: { open: true } }, { wait: 800 }, { invoke: "popover_test", args: { open: false } }, { wait: 300 }, { invoke: "win_close_test" }, { wait: 5000 }],
    check: ({ log }) => [ok(/^user quit: next launch starts clean$/m.test(log) && !/stays in the menu bar/.test(log), "메인 창을 닫으면 끝나야")], // not quitting = no line, and the run times out
  },
  {
    id: "wild-hover", tags: ["smoke", "poke"], what: "야생 카드 던지기 단추에 마우스를 올려도 제 색 그대로 고리만 — 메인 창 · 메뉴바 대시보드 · 잡기 창 모두, 글자 대비가 쉴 때보다 안 떨어짐(대시보드는 공통 단추 hover가 배경을 어둡게 바꿔 글자가 안 읽혔음) (#125, PKM-07 규칙 7)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } })),
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 },
      { invoke: "hover_test", args: { sel: "#wild .wild-throw" }, log: true },
      { invoke: "popover_test", args: { open: true } }, { wait: 1500 }, { invoke: "hover_test", args: { target: "popover", sel: "#pop-wild .wild-throw" }, log: true },
      { invoke: "popover_test", args: { open: false } }, { invoke: "catch_test", args: { open: true } }, { wait: 1500 }, { invoke: "hover_test", args: { target: "catch", sel: ".wild-throw" }, log: true }],
    check: ({ log }) => {
      const r = [...log.matchAll(/^lab-invoke hover_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      return ["메인 창", "대시보드", "잡기 창"].map((w, i) => {
        const x = r[i], same = x && x.hover.bg === x.rest.bg && x.hover.fg === x.rest.fg;
        return ok(x?.hover?.over && same && x.hover.outline === "solid" && x.hover.contrast >= x.rest.contrast - 0.01,
          `${w}: ${JSON.stringify(x && { rest: [x.rest.bg, x.rest.fg, x.rest.contrast], hover: [x.hover.bg, x.hover.fg, x.hover.contrast, x.hover.outline, x.hover.over] })}`);
      });
    },
  },
  {
    id: "popover-wild", tags: ["smoke", "poke"], what: "메뉴바 대시보드에서 야생 잡기: 야생이 나와 있으면 홈 맨 위에 야생 카드, 작업 탭을 보면 홈 탭에 점(#118) — 마스터볼을 골라 던지면 잡히고 가방에서 한 개 줄어듦 (STA-22 규칙 3·13, #105 #118)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 2000 }, { day: d, kind: "buy", item: "master", n: 1, amount: -1500 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
      fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } }));
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 },
      { invoke: "popover_test", args: { open: true } }, { wait: 1500 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: "#pop-nav [data-page='work']" } }, { wait: 300 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: "#pop-nav [data-page='home']" } }, { wait: 300 },
      { invoke: "popover_click_test", args: { sel: "#pop-wild .wild-balls [data-ball='master']" }, log: true }, { wait: 200 },
      { invoke: "popover_click_test", args: { sel: "#pop-wild .wild-throw" }, log: true }, { wait: 4500 }, { invoke: "shop_state", log: true }],
    check: ({ log }) => {
      const [h, r] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      const clicks = [...log.matchAll(/^lab-invoke popover_click_test (\w+)$/gm)].map((m) => m[1]);
      return [
        ok(h?.page === "home" && h?.dot === false && h?.wild === true, `홈에 야생 카드 ${JSON.stringify(h && { page: h.page, dot: h.dot, wild: h.wild })}`),
        ok(r?.page === "work" && r?.dot === true, `작업 탭을 보면 홈 탭에 점(저절로 넘어가지 않음, #118) ${JSON.stringify(r && { page: r.page, dot: r.dot })}`),
        ok(JSON.stringify(clicks) === '["true","true"]' && /^wild throw caught/m.test(log), `마스터볼로 던져 잡힘 ${JSON.stringify(clicks)} ${log.match(/^wild throw .*$/m)?.[0]}`),
        ok((st.bag?.master || 0) === 0, `마스터볼 한 개 줄어듦 ${JSON.stringify(st.bag)}`),
      ];
    },
  },
  {
    id: "outside-claude", tags: ["smoke", "poke"], what: "Tamer 밖 Claude 작업(STA-23, #107): 동의(가짜 '켜기') 뒤 다른 곳에서 끝난 Claude 작업 2번 → 코인·파티가 차례로 한 마리씩 +2 · 켜기 전부터 있던 줄·스크립트(sdk-cli)·하위 에이전트·Claude가 떠 있는 탭의 폴더는 안 셈 · 기록 본문은 앱 기록·데이터에 없음",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    env: { CVIM_DESKTOP_AUTOSTART: "1", CVIM_DESKTOP_AGENT_CMD: (box) => path.join(box.dir, "fakebin", "claude-idle"), CVIM_TEST_OUTSIDE_CONSENT: "yes" },
    files: { "fakebin/claude-idle": "#!/bin/sh\nsleep 60\n",
      // a log that was there before Tamer started: its finish must not count (POL-FUT-05 rule 8)
      "claudecfg/projects/-elsewhere/old.jsonl": '{"type":"system","subtype":"turn_duration","cwd":"/tmp/tamer-lab-outside","durationMs":60000,"entrypoint":"cli","isSidechain":false}\n' },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "party_test", args: { n: 2 }, log: true },
      { invoke: "outside_append_test", args: { agent: "claude", rel: "-elsewhere/new.jsonl", lines: [
        { type: "user", message: { content: "LAB-PRIVATE-107" }, cwd: "/tmp/tamer-lab-outside" },
        { type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 60000, entrypoint: "cli", isSidechain: false }] } },
      { wait: 1500 },
      { invoke: "outside_append_test", args: { agent: "claude", rel: "-elsewhere/new.jsonl", lines: [
        { type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 45000, entrypoint: "claude-desktop", isSidechain: false },
        { type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 45000, entrypoint: "sdk-cli", isSidechain: false },
        { type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 45000, entrypoint: "cli", isSidechain: true },
        { type: "system", subtype: "turn_duration", cwd: "$tab", durationMs: 45000, entrypoint: "cli", isSidechain: false }] } },
      { wait: 2000 }, { invoke: "party_state", log: true }],
    check: ({ log, box }) => {
      const party0 = JSON.parse(log.match(/^lab-invoke party_test (.*)$/m)?.[1] || "{}");
      const party1 = JSON.parse(log.match(/^lab-invoke party_state (.*)$/m)?.[1] || "{}");
      const done = (log.match(/^outside done claude/gm) || []).length, skip = (log.match(/^outside skip claude: a tab runs it there$/gm) || []).length;
      const grew = [...log.matchAll(/^exp outside via=party \{"uid":(\d+)\}/gm)].map((m) => Number(m[1]));
      const lv = (p, u) => p.list?.find((m) => m.uid === u)?.lv;
      const files = []; const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else files.push(p); } };
      try { walk(box.data); } catch {}
      const leaked = files.filter((f) => { try { return fs.readFileSync(f, "utf8").includes("LAB-PRIVATE-107"); } catch { return false; } });
      return [
        ok(/^outside ask$/m.test(log) && /^outside on: \d+ logs$/m.test(log), "처음 한 번 묻고 켜짐"),
        ok(party0.list?.length === 2, `파티 2마리 ${JSON.stringify(party0.list?.map((m) => m.uid))}`),
        ok(done === 2 && skip === 1, `센 것 2번(cli·claude-desktop), 탭이 있는 폴더 1번 건너뜀 — 센 ${done} 건너뜀 ${skip} (켜기 전 줄·sdk-cli·하위 에이전트는 아예 안 셈)`),
        ok(grew.length === 2 && grew[0] !== grew[1] && grew.every((u) => party0.list.some((m) => m.uid === u)), `파티가 차례로 한 마리씩 ${JSON.stringify(grew)}`),
        ok(party0.list?.every((m) => lv(party1, m.uid) === m.lv + 2 || (m.final && lv(party1, m.uid) === m.lv + 1)), `각각 +2 ${JSON.stringify(party0.list?.map((m) => [m.lv, lv(party1, m.uid)]))}`),
        ok((log.match(/^coins outside \+/gm) || []).length === 2, `코인 2번 ${(log.match(/^coins outside .*/gm) || []).join(" | ")}`),
        ok(!log.includes("LAB-PRIVATE-107") && !leaked.length, `기록 본문이 앱 기록·데이터에 없어야 ${JSON.stringify(leaked)}`),
      ];
    },
  },
  {
    id: "outside-claude-app", tags: ["smoke", "poke"], what: "Claude 앱의 Code(entrypoint claude-desktop)는 turn_duration을 안 써도 셈(#123): 응답의 end_turn — 여러 줄로 나뉜 한 응답은 한 번, 도구 사용 중·하위 에이전트는 안 셈, 걸린 시간 = 사용자 입력부터(45초 → +5 · 10초 → +1), 본문은 남지 않음 (STA-23 규칙 2)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_OUTSIDE_CONSENT: "yes" },
    files: { "claudecfg/projects/-app/s1.jsonl": "" }, // logs there at launch: asked, then on
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "outside_append_test", args: { agent: "claude", rel: "-app/s1.jsonl", lines: [0, 1].flatMap((k) => {
        const ep = { entrypoint: "claude-desktop", cwd: "/tmp/tamer-lab-app", isSidechain: false, sessionId: "s1" }, t = (s) => `2026-10-26T05:0${k}:${String(s).padStart(2, "0")}.000Z`;
        return [
          { type: "user", ...ep, timestamp: t(0), message: { role: "user", content: "LAB-PRIVATE-123 해 줘" } },
          ...(k ? [] : [{ type: "assistant", ...ep, timestamp: t(5), message: { id: "m-tool", stop_reason: "tool_use", content: [{ type: "tool_use" }] } },
            { type: "user", ...ep, timestamp: t(6), message: { role: "user", content: [{ type: "tool_result", content: "LAB-PRIVATE-123" }] } },
            { type: "assistant", ...ep, isSidechain: true, timestamp: t(20), message: { id: "m-side", stop_reason: "end_turn", content: [] } }]),
          { type: "assistant", ...ep, timestamp: t(k ? 10 : 45), message: { id: `m-end${k}`, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "LAB-PRIVATE-123" }] } },
          { type: "assistant", ...ep, timestamp: t(k ? 10 : 45), message: { id: `m-end${k}`, stop_reason: "end_turn", content: [{ type: "text", text: "LAB-PRIVATE-123 끝" }] } },
          { type: "system", subtype: "stop_hook_summary", ...ep, timestamp: t(k ? 10 : 45), hookCount: 0 }];
      }) } },
      { wait: 1500 }],
    check: ({ log, box }) => {
      const done = [...log.matchAll(/^outside done claude took=(\S+)$/gm)].map((m) => m[1]);
      const files = []; const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else files.push(p); } };
      try { walk(box.data); } catch {}
      const leaked = files.filter((f) => { try { return fs.readFileSync(f, "utf8").includes("LAB-PRIVATE-123"); } catch { return false; } });
      return [
        ok(JSON.stringify(done) === '["45000","10000"]', `센 것 ${JSON.stringify(done)} (턴 둘 — 45초 · 10초, 나뉜 응답·도구 중·하위 에이전트는 안 셈)`),
        ok(/^coins outside \+\d+ \(5/m.test(log) && /^coins outside \+1 \(1\)$/m.test(log), `코인 ${(log.match(/^coins outside .*/gm) || []).join(" | ")}`),
        ok(!log.includes("LAB-PRIVATE-123") && !leaked.length, `기록 본문이 앱 기록·데이터에 없어야 ${JSON.stringify(leaked)}`),
      ];
    },
  },
  {
    id: "outside-egg", tags: ["smoke", "poke"], what: "Tamer 밖 작업이 끝나도 부화기의 알이 한 칸 가까워짐 — 탭과 같은 공용 처리(finishGame) (PKM-25, #116)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_OUTSIDE_CONSENT: "yes" },
    files: { "claudecfg/projects/-elsewhere/.keep": "" },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "incubator_add_test", args: { kind: "egg", have: 2 } }, { invoke: "incubator_state", log: true },
      { invoke: "outside_append_test", args: { agent: "claude", rel: "-elsewhere/egg.jsonl", lines: [{ type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 60000, entrypoint: "cli", isSidechain: false }] } },
      { wait: 1500 }, { invoke: "incubator_state", log: true }],
    check: ({ log }) => {
      const [a, b] = [...log.matchAll(/^lab-invoke incubator_state (.*)$/gm)].map((m) => JSON.parse(m[1]));
      return [ok(/^outside done claude/m.test(log) && a?.active?.have === 2 && b?.active?.have === 3, `밖 작업 한 번에 알 2 → 3 ${JSON.stringify([a?.active?.have, b?.active?.have])}`)];
    },
  },
  {
    id: "popover-egg-in", tags: ["smoke", "poke"], what: "메뉴바 대시보드 부화기: 가방에 알이 있으면 [알 넣기]로 부화기에 — 빈 알 자리가 알 그림·'알 0/10'·'작업 10번 남음'으로(#117), 가방에서 한 개 줄어듦 · 진행 줄은 탭 파트너 줄과 따로(탭과 상관없이) (PKM-30 규칙 9, #116)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 1000 }, { day: d, kind: "buy", item: "egg", n: 2, amount: -100 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
    },
    steps: [{ until: "tabs.0" }, { wait: 1200 }, { call: "closeDex" }, { invoke: "popover_test", args: { open: true } }, { wait: 1500 },
      { invoke: "popover_click_test", args: { sel: "#pop-nav [data-page='work']" } }, { wait: 300 },
      { invoke: "popover_read_test", log: true }, { invoke: "popover_click_test", args: { sel: "#pop-egg-in" }, log: true }, { wait: 1000 },
      { invoke: "popover_read_test", log: true }, { invoke: "incubator_state", log: true }, { invoke: "shop_state", log: true }],
    check: ({ log }) => {
      const [a, b] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const inc = JSON.parse(log.match(/^lab-invoke incubator_state (.*)$/m)?.[1] || "null"), st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      return [
        ok(/알 넣기 가방 2/.test(a?.text || "") && /부화기가 비어 있어요/.test(a?.text || "") && /\bempty\b/.test(a?.look?.egg || "") && /⭐ 스탬프/.test(a?.text || ""), `처음: [알 넣기 가방 2], 빈 알 자리, 스탬프는 보임(탭이 없어도) ${JSON.stringify([a?.text?.match(/진행[\s\S]{0,60}/)?.[0], a?.look?.egg])}`),
        ok(/^lab-invoke popover_click_test true$/m.test(log) && inc?.active?.need === 10 && /알 0\/10/.test(b?.text || "") && /작업 10번 남음/.test(b?.text || "") && /pk-egg mid/.test(b?.look?.egg || "") && !/empty/.test(b?.look?.egg || ""), `넣은 뒤 부화기 알 그림·알 0/10·작업 10번 남음 ${JSON.stringify(inc?.active)} ${JSON.stringify([b?.text?.match(/진행[\s\S]{0,60}/)?.[0], b?.look?.egg])}`),
        ok((st.bag?.egg || 0) === 1, `가방 알 2 → 1 ${JSON.stringify(st.bag)}`),
      ];
    },
  },
  {
    id: "outside-spend", tags: ["smoke", "poke"], what: "오늘 사용량(STA-23 규칙 9, #115 A5): 밖 작업을 켜면 오늘 바뀐 기록을 처음부터 읽어 Claude 토큰(같은 메시지 한 번, 어제 줄 제외)·Codex 토큰(세션 합계의 오늘 늘어난 만큼)·≈$(가격표) — 대시보드 한도 칸 칩 줄(고른 에이전트, #118) · 기록 본문은 앱 기록·데이터에 없음",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_OUTSIDE_CONSENT: "yes", CVIM_PRICES_JSON: (box) => path.join(box.dir, "prices-litellm.json") },
    files: {
      "prices-litellm.json": JSON.stringify({ "claude-opus-4-5": { litellm_provider: "anthropic", input_cost_per_token: 1e-6, cache_creation_input_token_cost: 2e-6, cache_creation_input_token_cost_above_1hr: 3e-6, cache_read_input_token_cost: 1e-7, output_cost_per_token: 5e-6, max_input_tokens: 200000 },
        "gpt-5-codex": { litellm_provider: "openai", input_cost_per_token: 1e-6, cache_read_input_token_cost: 1e-7, output_cost_per_token: 1e-5, max_input_tokens: 272000 } }),
      // written today before Tamer started: its lines of today count (rule 9 — the finishes don't, rule 4)
      "claudecfg/projects/-elsewhere/today.jsonl": [[SPEND_NOW, "m1", { input_tokens: 10000, cache_creation_input_tokens: 100000, cache_creation: { ephemeral_1h_input_tokens: 40000 }, cache_read_input_tokens: 1000000, output_tokens: 5000 }],
        [SPEND_NOW, "m1", { input_tokens: 10000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 1000000, output_tokens: 5000 }], [SPEND_OLD, "m0", { input_tokens: 999999 }], [SPEND_NOW, "m2", { input_tokens: 1000, output_tokens: 2000 }]]
        .map(([ts, id, usage]) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-5-20251101", content: [{ type: "text", text: "LAB-PRIVATE-115" }], usage } })).join("\n") + "\n",
    },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 }, { invoke: "spend_test", log: true },
      { invoke: "outside_append_test", args: { agent: "codex", rel: "2026/10/21/rollout-spend.jsonl", lines: [
        { timestamp: SPEND_OLD, type: "session_meta", payload: { originator: "codex-tui", source: "cli", cwd: "/tmp/tamer-lab-outside" } },
        { timestamp: SPEND_OLD, type: "turn_context", payload: { model: "gpt-5-codex" } },
        { timestamp: SPEND_OLD, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000000, cached_input_tokens: 500000, output_tokens: 100000, total_tokens: 1100000 } } } },
        { timestamp: SPEND_NOW, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1600000, cached_input_tokens: 800000, output_tokens: 150000, total_tokens: 1750000 } } } }] } },
      { wait: 1500 }, { invoke: "spend_test", log: true },
      { invoke: "popover_test", args: { open: true } }, { wait: 1500 }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: ".pop-chip[data-agent='codex']" } }, { wait: 300 }, { invoke: "popover_read_test", log: true }, { invoke: "popover_test" }],
    check: ({ log, box }) => {
      const [a, b] = [...log.matchAll(/^lab-invoke spend_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const [r, c] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      return [
        ok(a?.claude?.tokens === 1118000 && !a?.codex, `시작 때 오늘 Claude 1,118,000 토큰(같은 메시지 한 번·어제 줄 빼고) ${JSON.stringify(a)}`),
        ok(b?.codex?.tokens === 650000 && Math.abs((b?.codex?.usd ?? 0) - 0.83) < 0.001 && Math.abs((b?.claude?.usd ?? 0) - 0.386) < 0.001, `Codex 오늘 늘어난 650,000 · ≈$ (Claude 0.386, Codex 0.83) ${JSON.stringify(b)}`),
        ok(/Claude\s*Codex\s*오늘 1\.1M 토큰 · ≈\$0\.39/.test(r?.text || "") && /Claude\s*Codex\s*오늘 650K 토큰 · ≈\$0\.83/.test(c?.text || ""), `대시보드 칩 줄 — Claude, 칩을 누르면 Codex (#118) ${JSON.stringify([r?.text?.match(/사용 한도[\s\S]{0,100}/)?.[0], c?.text?.match(/사용 한도[\s\S]{0,100}/)?.[0]])}`),
        ok(!log.includes("LAB-PRIVATE-115") && !filesWith(box.data, "LAB-PRIVATE-115").length, "기록 본문이 앱 기록·데이터에 없음"),
      ];
    },
  },
  {
    id: "outside-codex", tags: ["smoke", "poke"], what: "Tamer 밖 Codex 작업(STA-23, #107): 터미널(codex-tui)·Codex 앱(Codex Desktop)의 task_complete는 셈 · Claude Code가 띄운 Codex·codex_exec·하위 에이전트·실패한 턴은 안 셈",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_OUTSIDE_CONSENT: "yes" },
    files: { "codex/sessions/2026/10/20/.keep": "" },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 }, { invoke: "party_test", args: { n: 1 } },
      ...[["tui", { originator: "codex-tui", source: "cli" }, false], ["app", { originator: "Codex Desktop", source: "vscode" }, false], ["byclaude", { originator: "Claude Code", source: "vscode" }, false],
        ["exec", { originator: "codex_exec", source: "exec" }, false], ["sub", { originator: "Codex Desktop", source: { subagent: "review" } }, false], ["fail", { originator: "codex-tui", source: "cli" }, true]].map(([n, meta, fail]) => (
        { invoke: "outside_append_test", args: { agent: "codex", rel: `2026/10/20/rollout-${n}.jsonl`, lines: [
          { type: "session_meta", payload: { ...meta, cwd: "/tmp/tamer-lab-outside" } },
          { type: "event_msg", payload: { type: "task_complete", duration_ms: 50000, ...(fail ? { error: { message: "x" } } : {}) } }] } })),
      { wait: 1500 }],
    check: ({ log }) => {
      const done = (log.match(/^outside done codex/gm) || []).length;
      return [ok(/^outside on: \d+ logs$/m.test(log), "켜짐"), ok(done === 2 && /^exp outside via=party/m.test(log), `센 것 2번(codex-tui · Codex Desktop) — ${done}번`)];
    },
  },
  {
    id: "outside-declined", tags: ["smoke", "poke"], what: "Tamer 밖 작업(켜지 않음): 처음 질문에 '켜지 않음'이면 기록을 열지도 않고, 다른 곳에서 끝난 작업은 세지 않음 (STA-23 규칙 6, #107)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_OUTSIDE_CONSENT: "no" },
    files: { "claudecfg/projects/-elsewhere/.keep": "" },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 6000 },
      { invoke: "outside_append_test", args: { agent: "claude", rel: "-elsewhere/x.jsonl", lines: [{ type: "system", subtype: "turn_duration", cwd: "/tmp/tamer-lab-outside", durationMs: 60000, entrypoint: "cli", isSidechain: false }] } },
      { wait: 1500 }, { invoke: "settings_get", log: true }],
    check: ({ log }) => {
      const st = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}");
      return [ok(/^outside ask$/m.test(log) && st.outside === false && !/^outside on/m.test(log) && !/^outside done/m.test(log), `켜지 않음 → 안 읽음 ${JSON.stringify({ outside: st.outside })}`)];
    },
  },
  {
    id: "overlay-no-repop", tags: ["smoke", "app"], what: "오버레이 말풍선은 한 번만 튀어나옴 — 완료 말풍선이 떠 있는 동안 다른 일로 오버레이를 다시 그려도 다시 튀지 않음 (#114) · 진화 알림 \"✨ 파이리가 리자드로 진화했어요!\" (#111)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    steps: [{ until: "tabs.1" }, { wait: 1200 }, { call: "closeDex" }, { invoke: "overlay_show_test", args: { on: true } }, { wait: 600 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } }, { wait: 700 }, { invoke: "overlay_pop_test", log: true },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "done", to: "thinking", hold: true } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "coding", hold: true } }, { wait: 700 },
      { invoke: "overlay_pop_test", log: true },
      { invoke: "evolved_note_test" }, { invoke: "overlay_pop_test", log: true }, { invoke: "overlay_show_test", args: { on: false } }],
    check: ({ log }) => {
      const [a, b, c] = [...log.matchAll(/^lab-invoke overlay_pop_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      return [
        ok(a?.bubbles?.some((t) => /완료|✅/.test(t) && !/\[seen\]/.test(t)), `처음 그릴 때 완료 말풍선이 튀어나옴 ${JSON.stringify(a?.bubbles)}`),
        ok(b?.bubbles?.some((t) => /완료|✅/.test(t) && /\[seen\]/.test(t)), `다시 그려도 같은 말풍선은 다시 안 튐 ${JSON.stringify(b?.bubbles)}`),
        ok(/파이리가 리자드로 진화했어요!/.test(c?.evolve || "") && /Tamer 밖 작업 · 🪙 \+30/.test(c?.evolve || ""), `진화 알림 ${JSON.stringify(c?.evolve)}`),
      ];
    },
  },
  {
    id: "popover-tall", tags: ["smoke", "poke"], what: "메뉴바 대시보드 홈이 화면보다 길면(시험: 높이 420으로 줄인 화면) 창은 화면 끝까지만, 나머지는 스크롤 — 끝까지 내리면 ⏻·⚙·[Tamer 열기]가 보임 · 파티 그림 72px·부화기 알 그림 (#117 #118)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    steps: [{ until: "tabs.0" }, { wait: 1200 }, { call: "closeDex" }, { invoke: "party_test", args: { n: 5 }, log: true },
      { invoke: "popover_test", args: { open: true, maxH: 420 } }, { wait: 1500 }, { invoke: "popover_read_test", args: { scroll: true }, log: true }, { invoke: "popover_test" }],
    check: ({ log }) => {
      const n = JSON.parse(log.match(/^lab-invoke party_test (.*)$/m)?.[1] || "{}").list?.length || 0;
      const r = JSON.parse(log.match(/^lab-invoke popover_read_test (.*)$/m)?.[1] || "null");
      return [
        ok(r?.page === "home" && r?.height === 420 && r?.content > 420 && r?.footInView === true, `홈: 창 420에 내용 ${r?.content} — 끝까지 내리면 아래 버튼 보임 ${JSON.stringify(r && { page: r.page, height: r.height, content: r.content, foot: r.footInView })}`),
        ok(n === 5 && r?.look?.party === 72 && /pk-egg mid/.test(r?.look?.egg || ""), `파티 5마리(최대, #122) 그림 72px · 부화기 알 그림 ${JSON.stringify([n, r?.look])}`),
      ];
    },
  },
  {
    id: "popover-party-lead", tags: ["smoke", "poke"], what: "메뉴바 대시보드에서 파티 선두 바꾸기: 홈의 둘째 칸 그림을 누르면 선두가 됨 — Tamer 창을 열지 않음 (#112) · 작업 탭을 보고 닫았다 다시 열면 작업 탭 그대로(마지막 탭 기억, #118)",
    data: "owner", offline: true, mode: "direct", folders: ["a"],
    steps: [{ until: "tabs.0" }, { wait: 1200 }, { call: "closeDex" }, { invoke: "party_test", args: { n: 3 }, log: true },
      { invoke: "popover_test", args: { open: true } }, { wait: 1500 },
      { invoke: "popover_click_test", args: { sel: ".pop-mon:not(.lead)" }, log: true }, { wait: 800 }, { invoke: "party_state", log: true }, { invoke: "popover_read_test", log: true },
      { invoke: "popover_click_test", args: { sel: "#pop-nav [data-page='work']" } }, { wait: 300 }, { invoke: "popover_test" }, { wait: 500 }, { invoke: "popover_test", args: { open: true } }, { wait: 800 }, { invoke: "popover_read_test", log: true }],
    check: ({ log }) => {
      const before = JSON.parse(log.match(/^lab-invoke party_test (.*)$/m)?.[1] || "{}").list?.map((m) => m.uid) || [];
      const after = JSON.parse(log.match(/^lab-invoke party_state (.*)$/m)?.[1] || "{}").list?.map((m) => m.uid) || [];
      const [r, again] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1])), open = !!r; // read only while it's open
      return [
        ok(before.length === 3 && after.length === 3 && after[0] === before[1] && after.slice(1).join() === [before[0], before[2]].join(), `둘째가 선두로 ${JSON.stringify(before)} → ${JSON.stringify(after)}`),
        ok(open === true && !/^popover .*open-dex/m.test(log), "대시보드는 그대로 열려 있음"),
        ok(r?.page === "home" && r?.look?.party === 72 && again?.page === "work", `홈에서 바꾸고, 작업 탭을 본 뒤 다시 열면 작업 탭 ${JSON.stringify([r?.page, again?.page])}`),
      ];
    },
  },
  {
    id: "session-titles", tags: ["smoke", "agent"], what: "셸 이름·세션 제목: ⌘G Claude가 기록에 남긴 자동 제목이 칸 제목줄에, 기록에 아직 없으면 터미널 제목(✳·스피너 떼고, 'Claude Code'는 무시), 셸이 둘이면 레일에 마우스를 올려 펼친 목록에 · 펼쳐도 터미널 폭은 그대로 · 더블클릭으로 이름 바꾸기(저장) · 설정 '세션 제목'을 끄면 에이전트 제목은 사라지고 직접 붙인 이름은 남음 · 대화 줄은 해석 안 함 (TAB-13 규칙 4, TAB-20, #99)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    env: { CVIM_DESKTOP_AUTOSTART: "1", CVIM_DESKTOP_AGENT_CMD: (box) => path.join(box.dir, "fakebin", "claude-titled") },
    // a stand-in Claude: a conversation log with one private line and its own title, named by its status line
    files: { "fakebin/claude-titled": "#!/bin/sh\n# each shell its own conversation: the second shell's (…~s2) is another one\n# shell 1: its log has a title line · shell 2: like Claude Code at the start — a terminal title only (the bare name first)\ncase \"$CVIM_TAB_ID\" in *~s2) n=2;; *) n=1;; esac\nt=\"$PWD/../conv-$n.jsonl\"\nprintf '{\"type\":\"user\",\"message\":{\"content\":\"PRIVATE-PROMPT\"}}\\n' > \"$t\"\nif [ $n = 1 ]; then printf '{\"type\":\"ai-title\",\"aiTitle\":\"로그인 오류 고치기\",\"sessionId\":\"s1\"}\\n' >> \"$t\"; else printf '\\033]0;✳ Claude Code\\007'; sleep 1; printf '\\033]0;⠂ 테스트 정리\\007'; fi\nfor i in $(seq 60); do\n  printf '{\"transcript_path\":\"%s\",\"model\":{\"display_name\":\"Opus 5.5\"}}' \"$t\" | bash \"$CVIM_ROOT/claude/statusline.sh\" >/dev/null\n  sleep 1\ndone\n" },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 2500 }, { probe: "one" },
      { key: "t", mods: 12 }, { wait: 2500 }, { probe: "two" },
      { call: "railOver" }, { wait: 600 }, { probe: "open" },
      { click: ".rail.open .sess:nth-child(2)", count: 2 }, { wait: 400 }, { text: "api work" }, { key: "Enter" }, { wait: 600 }, { probe: "named" },
      { invoke: "settings_set", args: { patch: { titles: false } } }, { wait: 1500 }, { probe: "off" },
      { call: "railOut" }, { wait: 600 }, { probe: "closed" }],
    check: ({ probe, log, box }) => {
      let sess = null; try { sess = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "desktop_session.json"), "utf8")); } catch {}
      return [
        ok(/로그인 오류 고치기/.test(probe.one?.agentTitle || ""), `셸 하나: 칸 제목줄 ${probe.one?.agentTitle}`),
        ok(probe.two?.rail?.[0] === "로그인 오류 고치기" && probe.two?.rail?.[1] === "테스트 정리" && probe.two?.railOpen === false, `셸 둘(기록 제목 · 터미널 제목): 레일 ${JSON.stringify(probe.two?.rail)} · 접힘 ${probe.two?.railOpen === false}`),
        ok(probe.open?.railOpen === true && probe.open?.paneW === probe.two?.paneW, `마우스를 올리면 펼침 ${probe.open?.railOpen} · 에이전트 칸 폭 그대로 ${probe.two?.paneW} → ${probe.open?.paneW}`),
        ok(probe.named?.rail?.[1] === "api work" && sess?.names && Object.values(sess.names)[0]?.[1] === "api work", `이름 바꾸기 ${JSON.stringify(probe.named?.rail)} · 저장 ${JSON.stringify(sess?.names)}`),
        ok(probe.off?.rail?.[0] === "셸 1" && probe.off?.rail?.[1] === "api work", `세션 제목 끔: ${JSON.stringify(probe.off?.rail)} (에이전트 제목 없음, 직접 붙인 이름은 남음)`),
        ok(probe.closed?.railOpen === false, `벗어나면 접힘 ${probe.closed?.railOpen}`),
        ok(!/PRIVATE-PROMPT/.test(log), "대화 줄 내용이 기록에 나옴"),
      ];
    },
  },
  {
    id: "readme-tour", tags: ["readme"], what: "README 둘러보기 그림(포켓몬 없는 화면 — POL-ASSET): 오른쪽 칸을 접고 ⌘G 선택 창 · 셸 둘의 레일을 펼친 모습(대화 제목) · 설정 일반. 그림만 찍음, 시험 아님 — TAMER_LAB_WORK=/tmp/tamer-demo npm run lab -- --only readme-tour → runs/readme-tour/shots를 assets/tour-*.png로",
    data: "owner", offline: true, mode: "direct", folders: ["my-app"],
    env: { CVIM_DESKTOP_AUTOSTART: "1", CVIM_DESKTOP_AGENT_CMD: (box) => path.join(box.dir, "fakebin", "claude-tour") },
    // a stand-in Claude per shell: its conversation's title line and a status line (model · ctx · 5h · 7d)
    files: { "fakebin/claude-tour": "#!/bin/sh\ncase \"$CVIM_TAB_ID\" in *~s2) n=2; t2='테스트 정리';; *) n=1; t2='로그인 오류 고치기';; esac\nt=\"$PWD/../conv-$n.jsonl\"\nprintf '{\"type\":\"ai-title\",\"aiTitle\":\"%s\",\"sessionId\":\"s%s\"}\\n' \"$t2\" $n > \"$t\"\nfor i in $(seq 90); do\n  now=$(date +%s)\n  printf '{\"transcript_path\":\"%s\",\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":30,\"resets_at\":%s},\"seven_day\":{\"used_percentage\":12}},\"context_window\":{\"used_percentage\":21,\"context_window_size\":1000000}}' \"$t\" $((now+3600)) | bash \"$CVIM_ROOT/claude/statusline.sh\" >/dev/null\n  sleep 1\ndone\n" },
    steps: [{ until: "tabs.0" }, { invoke: "settings_set", args: { patch: { theme: "dark" } } }, { resize: [1100, 640] }, { wait: 1500 }, { call: "closeDex" }, { key: "\\", code: "Backslash", mods: 4 }, { wait: 2500 },
      { key: "g", mods: 4 }, { wait: 700 }, { shot: "tour-picker" }, { key: "Escape" }, { wait: 400 },
      { key: "t", mods: 12 }, { wait: 3000 }, { call: "railOver" }, { wait: 700 }, { probe: "open" }, { shot: "tour-shells" }, { call: "railOut" }, { wait: 500 },
      { call: "settingsGeneral" }, { wait: 1500 }, { shot: "tour-settings", target: "settings" }],
    check: ({ probe, box }) => [
      ok(probe.open?.railOpen === true && probe.open?.rail?.[0] === "로그인 오류 고치기" && probe.open?.rail?.[1] === "테스트 정리", `레일 ${JSON.stringify(probe.open?.rail)} 펼침 ${probe.open?.railOpen}`),
      ...["tour-picker", "tour-shells", "tour-settings"].map((n) => ok(fs.existsSync(path.join(box.dir, "shots", `${n}.png`)), `${n}.png 없음`)),
    ],
  },
  {
    id: "research-mew", tags: ["smoke", "poke", "data"], what: "환상 리서치(뮤) 1단계: 서로 다른 폴더 3곳에서 작업을 끝내면 다음 단계 — 폴더는 해시로만, 단계가 끝나면 지움 · 홈에 단계별 진행 (#86)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b", "c"],
    steps: [{ until: "tabs.2" }, { wait: 1200 }, { call: "closeDex" }, { wait: 300 },
      { key: "1", mods: 4 }, { wait: 300 }, ...DONE("$ws"), { key: "2", mods: 4 }, { wait: 300 }, ...DONE("$ws"), { wait: 300 }, { probe: "two" },
      { key: "p", mods: 4 }, { wait: 900 }, { probe: "home2" }, { key: "Escape" }, { wait: 300 },
      { key: "3", mods: 4 }, { wait: 300 }, ...DONE("$ws"), { wait: 500 }, { key: "p", mods: 4 }, { wait: 900 }, { probe: "home3" }],
    check: ({ probe, box }) => {
      let r = null; try { r = JSON.parse(fs.readFileSync(path.join(box.data, "economy", "research.json"), "utf8")); } catch {}
      return [
        ok(probe.home2?.research?.[0] === "▸ 서로 다른 폴더 3곳에서 작업 끝내기2/3" && /^▸ 20종 잡기[1-9]\d*\/20$/.test(probe.home2?.research?.[1] || ""), `두 곳 뒤 ${JSON.stringify(probe.home2?.research)} (20종은 지금 잡은 수부터)`),
        ok(probe.home3?.research?.[0] === "✔ 서로 다른 폴더 3곳에서 작업 끝내기3/3" && /^▸ 20종 잡기\d+\/20$/.test(probe.home3?.research?.[1] || ""), `세 곳 뒤 ${JSON.stringify(probe.home3?.research)}`),
        ok(r?.step === 1 && r.folders.length === 0 && !filesWith(path.join(box.data, "economy"), box.folder("a")).length, `research.json ${JSON.stringify(r)} (다음 단계에선 폴더 해시도 지움, 폴더 이름 없음)`),
      ];
    },
  },
  {
    id: "research-mew-encounter", tags: ["smoke", "poke"], what: "환상 리서치 마지막 단계(진화 3번째)를 끝내면 뮤와 확정 조우(✦ 리서치 금색 카드) + 마스터볼 1개 (#86)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      fakeSpecies(box, 5, "리자드", { reach: { kind: "level", level: 16 }, next: [] });
      fakeSpecies(box, 151, "뮤", { reach: null, next: [] });
      fs.writeFileSync(path.join(box.data, "pokemon", "151.json"), JSON.stringify({ id: 151, shiny: false, name_ko: "뮤", name_en: "Mew", legendary: true, capture_rate: 45, types: ["psychic"] }));
      evolvePartner(box);
      fs.mkdirSync(path.join(box.data, "economy"), { recursive: true });
      fs.writeFileSync(path.join(box.data, "economy", "research.json"), JSON.stringify({ id: 151, step: 2, folders: [], evolves: 2, ready: false, done: [] }));
      putEcon(box, { "state.json": { startSeen: true } });
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, ...DONE("$ws"), { wait: 3000 }, { probe: "after" }, { invoke: "shop_state", log: true }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      return [
        ok(/^research 151 done — encounter$/m.test(log) && probe.after?.wildBig && probe.after?.wildBadge === "✦ 리서치" && /환상의 뮤가 나타났다!/.test(probe.after?.wildText || ""), `조우 ${probe.after?.wildBadge} · ${probe.after?.wildText}`),
        ok(st.bag?.master === 1, `마스터볼 ${JSON.stringify(st.bag)}`),
      ];
    },
  },
  {
    id: "legend-again", tags: ["smoke", "poke"], what: "이미 가진 전설이 야생으로 다시 나와도 보통처럼 던져 잡음 — 두 마리 (#87, 전엔 코인으로 받기)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => {
      birds(box);
      const b = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8"));
      b.mons.push({ uid: b.next++, id: 144, shiny: false, xp: 0, lv: 50, mile: 50, how: "wild", at: 1, folder: null });
      fs.writeFileSync(path.join(box.data, "box.json"), JSON.stringify(b));
      fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 144, shiny: false } }));
      putEcon(box, { "state.json": { startSeen: true } });
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, { invoke: "wild_rig_test", args: { result: "caught" } }, ...DONE("$ws"), { wait: 1500 }, { probe: "card" },
      { key: "b", mods: 4 }, { wait: 4500 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]");
      return [
        ok(/야생의 프리저가 나타났다!/.test(probe.card?.wildText || "") && /몬스터볼/.test(probe.card?.wildBtn || ""), `카드 ${probe.card?.wildText} · ${probe.card?.wildBtn}`),
        ok(list.filter((m) => m.id === 144).length === 2, `프리저 ${list.filter((m) => m.id === 144).length}마리 (2여야)`),
      ];
    },
  },
  {
    id: "egg-hatch", tags: ["smoke", "poke"], what: "부화기: 가방에서 알을 넣으면 어느 폴더든 작업 10번째에 부화 — 박스로(새 종이면 +30, 알림), 그동안 파트너도 레벨이 오름, 두 번째 알은 대기 (#85, #84)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_TEST_EGG: "172" },
    setup: (box) => {
      fakeSpecies(box, 172, "피츄", { reach: null, next: [{ to: 25, kind: "friend" }] });
      evolvePartner(box);
      putEcon(box, { "ledger.jsonl": [{ day: todayLocal(), kind: "start", n: 0, amount: 1000 }, { day: todayLocal(), kind: "buy", item: "egg", n: 2, amount: -1000 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, { key: "p", mods: 4 }, { wait: 700 }, { key: "i" }, { wait: 800 }, { probe: "bag" },
      { key: "Enter" }, { wait: 600 }, { key: "Enter" }, { wait: 600 }, { probe: "in" }, { key: "Escape" }, { wait: 300 },
      ...Array.from({ length: 10 }, () => DONE("$ws")).flat(), { wait: 3500 }, { key: "p", mods: 4 }, { wait: 900 }, { probe: "home" },
      { invoke: "box_list", args: { ws: "$ws" }, log: true }, { invoke: "economy_state", log: true }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]");
      const pichu = list.find((m) => m.id === 172), me = list.find((m) => m.party === 0), eggs = list.filter((m) => m.egg);
      return [
        ok(probe.bag?.takeBtn === "부화기에 넣기", `가방 ${probe.bag?.takeBtn}`),
        // the bag's incubator section (#88): the egg in it, the second one in line; "켜진 효과" no longer lists it
        ok(/^알 0\/10 · 작업 10번 남음/.test(probe.in?.bagInc?.now || "") && JSON.stringify(probe.in?.bagInc?.line) === '["1알0/10"]' && !probe.in?.effects && /🥚/.test(probe.in?.bagTab || ""),
          `넣은 뒤 ${JSON.stringify(probe.in?.bagInc)} · 효과 ${probe.in?.effects} · 탭 ${probe.in?.bagTab}`),
        ok(/^incubator hatched 172 newdex$/m.test(log) && pichu?.lv === 5 && !pichu.folder && pichu.how === "egg", `부화 ${JSON.stringify(pichu && { lv: pichu.lv, folder: pichu.folder, how: pichu.how })}`),
        ok(me?.id === 4 && me.lv === 35, `파트너 ${JSON.stringify(me && { id: me.id, lv: me.lv })} (그동안 Lv 15 → 35)`),
        ok(eggs.length === 1 && eggs[0].inc === "active" && /^알0\/10$|^알.*0\/10/.test(probe.home?.incubator || ""), `남은 알 ${JSON.stringify(eggs.map((e) => e.inc))} · 홈 ${probe.home?.incubator}`),
      ];
    },
  },
  {
    id: "egg-migrate", tags: ["smoke", "poke", "data"], what: "beta.8에서 폴더에 품어 둔 알은 처음 켤 때 부화기로 — 진행 그대로, 파트너 칸은 메인 파트너 그대로 (#85, #122)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      const b = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8"));
      b.mons.push({ uid: b.next++, egg: { kind: "egg", need: 10, have: 4 }, how: "egg", at: 1, folder: box.folder("proj"), last_folder: box.folder("proj") });
      fs.writeFileSync(path.join(box.data, "box.json"), JSON.stringify(b));
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 500 }, { probe: "choose" }, { invoke: "incubator_state", log: true }],
    check: ({ probe, log }) => {
      const inc = JSON.parse(log.match(/^lab-invoke incubator_state (.*)$/m)?.[1] || "null");
      return [ok(inc?.active?.have === 4 && inc.active.need === 10 && probe.choose?.needPartner === false && probe.choose?.partner, `부화기 ${JSON.stringify(inc)} · 파트너 칸 ${probe.choose?.partner} [포켓몬 고르기] ${probe.choose?.needPartner}`)];
    },
  },
  {
    id: "stone-evolve", tags: ["smoke", "poke"], what: "진화의 돌: 가방에서 [쓸 포켓몬 고르기] → 쓸 수 있는 마리만(갈래 있는 이브이) → 갈래 버튼 셋 → 쥬피썬더로 바로 진화, 돌 1개 씀·+30 진화 +30 새 종, 진화한 마리는 고르기 목록에서 빠지고 오른쪽에 결과·[내 포켓몬에서 보기] (#93 #94 #95)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => stoneSetup(box, 1),
    steps: [...STONE_TO_135, { probe: "after" },
      { invoke: "box_list", args: { ws: "$ws" }, log: true }, { invoke: "economy_state", log: true },
      { click: "#dex-from [data-sd='box']" }, { wait: 900 }, { probe: "box" }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]"), me = list.find((m) => m.party === 0);
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      return [
        ok(probe.bag?.takeBtn === "쓸 포켓몬 고르기", `가방 진화의 돌 ${probe.bag?.takeBtn}`),
        // the list: stone-able ones only — the data's others that a stone evolves too, and the Eevee (no longer one after)
        ok(probe.pick?.cards === list.filter((m) => m.stone).length + 1 && probe.pick.cards < list.filter((m) => !m.egg).length && JSON.stringify(probe.pick?.fromBtns) === '["→ 샤미드","→ 쥬피썬더","→ 부스터"]',
          `쓸 마리만 ${probe.pick?.cards}/${list.length} · 갈래 ${JSON.stringify(probe.pick?.fromBtns)}`),
        // 쥬피썬더: not in the data's Pokédex (샤미드 is) — a new species
        ok(/^bag use stone uid=\d+ to=135$/m.test(log) && me?.id === 135 && me.evo?.at(-1)?.to === "쥬피썬더", `진화 ${JSON.stringify(me && { id: me.id, evo: me.evo })}`),
        ok(st.stones === 0 && st.balance === 760, `돌 다 씀 ${st.stones} · 코인 ${st.balance} (1000−300+30 진화+30 새 종, #94)`),
        ok(probe.after?.partner === "쥬피썬더", `파트너 칸 ${probe.after?.partner}`),
        // #95: it leaves the stone list (no card picked) and its result stays on the right with its coins and what next
        ok(probe.after?.cards === probe.pick?.cards - 1 && !probe.after?.justCard && !probe.after?.selCard && probe.after?.dexName === "#135 쥬피썬더" && /^– \//.test(probe.after?.dexPos || ""),
          `목록에서 빠지고 오른쪽에 ${JSON.stringify({ cards: [probe.pick?.cards, probe.after?.cards], just: probe.after?.justCard, sel: probe.after?.selCard, name: probe.after?.dexName, pos: probe.after?.dexPos })}`),
        ok(/^🎉 이브이가 쥬피썬더로 진화했어요!\+30코인 진화 · \+30코인 새 종/.test(probe.after?.preview || "") && JSON.stringify(probe.after?.fromBtns) === '["내 포켓몬에서 보기"]',
          `결과 ${probe.after?.preview} · ${JSON.stringify(probe.after?.fromBtns)}`),
        ok(probe.box?.poke === "box" && probe.box?.selCard === "쥬피썬더", `내 포켓몬에서 보기 → ${probe.box?.poke} ${probe.box?.selCard}`),
      ];
    },
  },
  {
    id: "stone-next", tags: ["smoke", "poke"], what: "진화의 돌을 쓴 뒤(돌이 남음): 오른쪽 결과가 떠 있는 동안 Enter는 아무것도 안 함, 방향키 → 빠진 자리의 카드가 골라지고 그 마리의 진화의 돌 미리보기 — 따로 [하나 더] 버튼 없음 (#95)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => stoneSetup(box, 2),
    steps: [...STONE_TO_135, { probe: "after" }, { key: "Enter" }, { wait: 800 }, { probe: "enter" }, { key: "ArrowRight" }, { wait: 1500 }, { probe: "next" },
      { invoke: "economy_state", log: true }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      return [
        ok(probe.after?.dexName === "#135 쥬피썬더" && JSON.stringify(probe.after?.fromBtns) === '["내 포켓몬에서 보기"]', `결과 ${probe.after?.dexName} ${JSON.stringify(probe.after?.fromBtns)}`),
        ok(probe.enter?.dexName === "#135 쥬피썬더" && !probe.enter?.selCard && st.stones === 1, `Enter 뒤 ${probe.enter?.dexName} sel=${probe.enter?.selCard} · 돌 ${st.stones}`),
        // the data's other stone-able ones are left; the first move picks the one now at the Eevee's place (the list's first)
        ok(probe.next?.cards === probe.after?.cards && probe.next?.selCard && probe.next.selCard !== "쥬피썬더" && probe.next?.dexPos === `1 / ${probe.next?.cards}` && probe.next?.dexName !== "#135 쥬피썬더"
          && !(probe.next?.fromBtns || []).some((b) => /하나 더|다른 포켓몬/.test(b)),
          `방향키 → ${JSON.stringify({ sel: probe.next?.selCard, name: probe.next?.dexName, pos: probe.next?.dexPos, btns: probe.next?.fromBtns })}`),
      ];
    },
  },
  {
    id: "shiny-charm", tags: ["smoke", "poke"], what: "빛나는부적: 5,000코인에 한 번 — 다시 사기 거부, 상점 카드 \"가짐 ✔\"·버튼 없음, 가방 켜진 효과 ✨·탭 수엔 안 셈, 이로치 1/32 (#93)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => putEcon(box, { "ledger.jsonl": JSON.stringify({ day: todayLocal(), kind: "start", n: 0, amount: 12000 }) + "\n", "state.json": { startSeen: true } }),
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, { invoke: "charm_test", log: true },
      { invoke: "shop_buy", args: { item: "charm", n: 1 }, log: true }, { invoke: "shop_buy", args: { item: "charm", n: 1 }, log: true }, { invoke: "charm_test", log: true },
      { key: "p", mods: 4 }, { wait: 700 }, { key: "s" }, { wait: 800 }, { probe: "shop" }, { key: "i" }, { wait: 800 }, { probe: "bag" }, { invoke: "economy_state", log: true }],
    check: ({ probe, log }) => {
      const charm = [...log.matchAll(/^lab-invoke charm_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const buys = [...log.matchAll(/^lab-invoke shop_buy (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      return [
        ok(charm[0]?.charm === false && charm[0]?.odds === 1 / 64 && charm[1]?.charm === true && charm[1]?.odds === 1 / 32, `이로치 확률 ${JSON.stringify(charm)}`),
        ok(buys[0]?.ok === true && buys[1]?.ok === false && buys[1]?.why === "once", `한 번만 ${JSON.stringify(buys.map((b) => b.ok ? "ok" : b.why))}`),
        ok((probe.shop?.items || []).includes("빛나는부적:가짐 ✔:off"), `상점 카드 ${JSON.stringify((probe.shop?.items || []).filter((x) => /부적/.test(x)))}`),
        ok(/✨ 빛나는부적/.test(probe.bag?.effects || "") && st.charm === true && st.bagN === 0 && !/가방 \d/.test(probe.bag?.bagTab || ""), `가방 효과 ${probe.bag?.effects} · 수 ${st.bagN} · 탭 ${probe.bag?.bagTab}`),
      ];
    },
  },
  {
    id: "incubator-first", tags: ["smoke", "poke"], what: "가방 안 부화기 섹션: 비었으면 가방의 알 [알 넣기], 넣으면 부화 칸·작업 n번 남음, 둘째 알은 차례 카드 — 고르면 [먼저 부화] 한 번에 바뀌고 진행은 알마다 그대로 (#88)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => putEcon(box, { "ledger.jsonl": [{ day: todayLocal(), kind: "start", n: 0, amount: 1000 }, { day: todayLocal(), kind: "buy", item: "egg", n: 1, amount: -500 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } }),
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, { key: "p", mods: 4 }, { wait: 700 }, { key: "i" }, { wait: 800 }, { probe: "empty" },
      { click: "#box-grid [data-incadd='egg']" }, { wait: 800 }, { probe: "one" },
      { invoke: "incubator_add_test", args: { kind: "egg2", have: 0 } }, { wait: 800 }, { probe: "two" },
      { click: "#box-grid .pk-incq" }, { wait: 400 }, { probe: "pick" }, { key: "Enter" }, { wait: 800 }, { probe: "first" }, { invoke: "incubator_state", log: true }],
    check: ({ probe, log }) => {
      const inc = JSON.parse(log.match(/^lab-invoke incubator_state (.*)$/m)?.[1] || "null");
      return [
        ok(/^부화기가 비었어요 — 가방에 알 1개 알 넣기$/.test(probe.empty?.bagInc?.empty || "") && !probe.empty?.bagInc?.now, `빈 부화기 ${JSON.stringify(probe.empty?.bagInc)}`),
        ok(/^알 0\/10 · 작업 10번 남음$/.test(probe.one?.bagInc?.now || "") && probe.one?.bagInc?.line.length === 0 && !probe.one?.bagInc?.soon, `넣은 뒤 ${JSON.stringify(probe.one?.bagInc)}`),
        ok(JSON.stringify(probe.two?.bagInc?.line) === '["1희귀알0/20"]', `둘째 알은 차례 카드 ${JSON.stringify(probe.two?.bagInc?.line)}`),
        ok(probe.pick?.takeBtn === "먼저 부화", `고르면 ${probe.pick?.takeBtn}`),
        ok(/^희귀 알 0\/20/.test(probe.first?.bagInc?.now || "") && JSON.stringify(probe.first?.bagInc?.line) === '["1알0/10"]' && inc?.active?.kind === "egg2" && inc.queue?.[0]?.kind === "egg",
          `먼저 부화 뒤 ${JSON.stringify(probe.first?.bagInc)} · ${JSON.stringify(inc && { a: inc.active.kind, q: inc.queue.map((e) => e.kind) })}`),
        ok(/^incubator first \d+ ok$/m.test(log), "로그에 incubator first … ok"),
      ];
    },
  },
  {
    id: "progress-chips", tags: ["smoke", "poke", "app"], what: "진행 표시: 파트너 칸 칩 🥚 ⭐ ✦(곧이면 금색), 오버레이 한 줄(부화기 알은 늘·나머지는 곧일 때, 최소 모드는 숫자 칩+마우스 올림 뜻 #90)·부화 알림(누르면 내 포켓몬), 메뉴바 한 줄, 설정 \"진행\" 끄면 오버레이에서 빠짐, 칩 누르면 그 화면 (#88)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_TEST_EGG: "172", CVIM_STAMPS: "2" },
    setup: (box) => {
      fakeSpecies(box, 172, "피츄", { reach: null, next: [{ to: 25, kind: "friend" }] });
      evolvePartner(box);
      putEcon(box, { "state.json": { startSeen: true, stampsSince: todayLocal() } }); // today (the data has finishes today): 1/2 from the start, no breakthrough
    },
    // the full cards (82 %): the line on the partner's card — the card background is 0 % (minimal) by default since #100
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, { invoke: "settings_set", args: { patch: { overlay: { alpha: 82 } } } }, { invoke: "incubator_add_test", args: { kind: "egg", have: 8 } }, { wait: 600 }, { probe: "a" },
      { invoke: "overlay_show_test", args: { on: true } }, { wait: 800 }, { invoke: "overlay_dom_test", log: true },
      ...DONE("$ws"), { wait: 1500 }, { probe: "b" }, { invoke: "overlay_dom_test", log: true }, { invoke: "tray_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "always" } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "auto" } } } }, { wait: 300 },
      ...DONE("$ws"), { wait: 1800 }, { invoke: "overlay_dom_test", log: true }, { probe: "c" },
      { invoke: "settings_set", args: { patch: { overlay: { progress: false } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "hatch_open_test" }, { wait: 900 }, { probe: "opened" }, { key: "Escape" }, { wait: 400 },
      { click: "main.grid:not([hidden]) .pk-chip-prog[data-prog='stamps']" }, { wait: 900 }, { probe: "home" }, { key: "Escape" },
      { invoke: "settings_get", log: true }, { invoke: "overlay_show_test", args: { on: false } }],
    check: ({ probe, log }) => {
      const dom = [...log.matchAll(/^lab-invoke overlay_dom_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const [stampsOnly, soon, dot, hatched, off] = dom;
      const tray = JSON.parse(log.match(/^lab-invoke tray_test (.*)$/m)?.[1] || "{}"), labels = (tray.items || []).map((i) => i.label || "—");
      const got = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}");
      return [
        ok(JSON.stringify(probe.a?.prog) === '["🥚 8/10","⭐ 곧 1/2!","✦ 0/3"]', `처음 칩 ${JSON.stringify(probe.a?.prog)}`),
        ok(dom.length === 5 && stampsOnly?.prog === "🥚 8/10 · ⭐ 곧 1/2" && !stampsOnly.progMini, `부화기 알은 늘, 스탬프는 곧일 때 (#90) ${JSON.stringify(stampsOnly && { p: stampsOnly.prog, m: stampsOnly.progMini })}`),
        ok(JSON.stringify(probe.b?.prog) === '["🥚 곧 9/10!","⭐ 곧 1/2!","✦ 0/3"]', `한 번 남으면 금색 곧 ${JSON.stringify(probe.b?.prog)}`),
        ok(soon?.prog === "🥚 곧 9/10 · ⭐ 곧 1/2" && !soon.minimal, `한 번 남으면 🥚도 곧 ${soon?.prog}`),
        ok(labels.includes("🥚 부화기 9/10 · ⭐ 스탬프 1/2 · ✦ 리서치 0/3"), `메뉴바 진행 줄 ${JSON.stringify(labels.filter((l) => /부화기|스탬프/.test(l)))}`),
        ok(labels.some((l) => l === "진행 — 곧 일어날 일") || JSON.stringify(tray.items || []).includes("진행 — 곧 일어날 일"), "메뉴바 보일 것에 진행"),
        ok(dot?.minimal && dot.progMini === "🥚9/10⭐1/2" && dot.progTip === "🥚 부화기 알 9/10 · 곧 태어나요 — 작업 1번 · ⭐ 연구 스탬프 1/2 · 대발견까지 1개" && !dot.prog,
          `최소 모드는 아이콘+숫자 칩, 마우스 올리면 뜻 (#90) ${JSON.stringify(dot && { m: dot.minimal, c: dot.progMini, t: dot.progTip, p: dot.prog })}`),
        ok(/^incubator hatched 172/m.test(log) && /^🐣 알에서 피츄 태어났어요/.test(hatched?.hatch || "") && hatched?.prog === "⭐ 곧 1/2", `부화 알림 ${hatched?.hatch} · 알이 없으면 🥚 빠짐 ${hatched?.prog}`),
        ok(JSON.stringify(probe.c?.prog) === '["⭐ 곧 1/2!","✦ 0/3"]', `부화 뒤 칩(🥚 빠짐) ${JSON.stringify(probe.c?.prog)}`),
        ok(off && !off.prog && !off.hatch && got.overlay?.progress === false, `진행 끄면 줄·알림 없음 ${JSON.stringify(off && { p: off.prog, h: off.hatch })} 설정 ${got.overlay?.progress}`),
        ok(/^hatch open from overlay$/m.test(log) && probe.opened?.poke === "box", `부화 알림 누르면 내 포켓몬 ${probe.opened?.poke}`),
        ok(probe.home?.poke === "home", `⭐ 칩 누르면 홈 ${probe.home?.poke}`),
      ];
    },
  },
  {
    id: "graduate", tags: ["smoke", "poke"], what: "졸업: Lv 99 최종 진화형인 메인 파트너가 한 번 더 끝내면 Lv 100 🎓 — 300코인·알 하나, 띠 [계속 함께]/[다른 포켓몬을 메인으로] → 파티에 그대로 둔 채 내 포켓몬 파티 줄 (#84, #122 J1)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => { fakeSpecies(box, 6, "리자몽", { reach: { kind: "level", level: 36 }, next: [] }); evolvePartner(box, { id: 6, lv: 99, mile: 90, final: true }); putEcon(box, { "state.json": { startSeen: true } }); },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, ...DONE("$ws"), { wait: 1500 }, { probe: "grad" },
      { click: "main.grid:not([hidden]) [data-grad='new']" }, { until: "poke", timeout: 5000 }, { wait: 600 }, { probe: "after" }, { invoke: "box_list", args: { ws: "$ws" }, log: true }, { invoke: "economy_state", log: true }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]"), m = list.find((x) => x.id === 6);
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      return [
        ok(/졸업했어요!.*\+300코인 · 🥚 알 \+1.*계속 함께.*다른 포켓몬을 메인으로/.test(probe.grad?.gradBand || "") && /^🎓 리자몽/.test(probe.grad?.pokeLabel || "") && probe.grad?.pokeExp === "Lv 100 · 졸업", `졸업 띠 ${probe.grad?.gradBand} · ${probe.grad?.pokeLabel} · ${probe.grad?.pokeExp}`),
        ok(m?.grad && m.party === 0 && probe.after?.poke === "box" && !probe.after?.gradBand, `다른 포켓몬을 메인으로 ${JSON.stringify(m && { grad: !!m.grad, party: m.party })} · 창 ${probe.after?.poke} · 띠 ${probe.after?.gradBand}`),
        ok(st.eggs?.egg === 1 && st.today?.earned >= 300, `알 ${JSON.stringify(st.eggs)} · 오늘 ${st.today?.earned}`),
      ];
    },
  },
  // ── ⭐ 연구 스탬프 · 주간 대발견 E4 (#82, PKM-24) ──
  {
    id: "breakthrough", tags: ["smoke", "poke"], what: "대발견: 스탬프가 다 차는 완료에 전설(1세대 새) 확정 조우 + 100코인 — 금색 카드, 놓쳐도 도망 없음·×1.2, 남아 있는 동안 보통 야생 없음, 잡으면 끝 (#82)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_STAMPS: "2", CVIM_WILD_CHANCE: "1" },
    setup: (box) => { birds(box); putEcon(box, { "state.json": { startSeen: true, stampsSince: dayAgo(1) } }); fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } })); },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { probe: "big" },
      { invoke: "wild_rig_test", args: { result: "broke" } }, { key: "b", mods: 4 }, { wait: 3500 }, { probe: "missed" },
      ...DONE("$ws"), { wait: 1200 }, { key: "p", mods: 4 }, { wait: 800 }, { probe: "home" }, { key: "Escape" }, { wait: 300 },
      { invoke: "wild_rig_test", args: { result: "caught" } }, { key: "b", mods: 4 }, { wait: 5000 }, { invoke: "economy_state", log: true }],
    check: ({ probe, log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      const w = JSON.parse(fs.readFileSync(path.join(box.data, "wild.json"), "utf8"));
      const big = (ledgerRows(box) || []).find((x) => x.kind === "big");
      return [
        ok(/^breakthrough 14[4-6]$/m.test(log), `대발견 ${log.match(/^breakthrough[^\n]*/m)?.[0]}`),
        ok(probe.big?.wildBig && /전설의 .+ 나타났다!/.test(probe.big?.wildText || ""), `금색 카드 ${probe.big?.wildBig} · ${probe.big?.wildText}`),
        ok(probe.missed?.wildBig && /도망가지 않아요 · 다음엔 ×1\.2/.test(probe.missed?.wildText || ""), `놓친 뒤 ${probe.missed?.wildText}`),
        ok(!/^wild appeared/m.test(log), "대발견이 남아 있는데 보통 야생이 나옴"),
        ok(/^\d 2개 남음$|^2개 남음$/.test(probe.home?.stamps || "") || /2개 남음/.test(probe.home?.stamps || ""), `홈 스탬프 ${probe.home?.stamps} (대발견 뒤 다음 날부터 — 오늘은 0)`),
        ok(/^wild throw caught/m.test(log) && !w.big, `잡은 뒤 wild.json big ${JSON.stringify(w.big)}`),
        ok(big?.amount === 100 && st.today?.earned >= 100, `대발견 100코인 ${JSON.stringify(big)}`),
      ];
    },
  },
  {
    id: "breakthrough-legend", tags: ["smoke", "poke"], what: "전설의 향: 가방에서 파이어에 걸면 다음 대발견은 파이어, 향은 하나 씀 — 열린 전설이 아닌 종엔 못 걺 (#82)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_STAMPS: "2" },
    setup: (box) => {
      birds(box);
      putEcon(box, { "ledger.jsonl": [{ day: todayLocal(), kind: "start", n: 0, amount: 1000 }, { day: todayLocal(), kind: "buy", item: "legend", n: 1, amount: -800 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true, stampsSince: dayAgo(1) } });
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      { invoke: "bag_use", args: { item: "legend", id: 999 }, log: true }, { invoke: "bag_use", args: { item: "legend", id: 146 }, log: true },
      { key: "p", mods: 4 }, { wait: 800 }, { probe: "home" }, { key: "Escape" }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { invoke: "shop_state", log: true }],
    check: ({ probe, log }) => {
      const uses = [...log.matchAll(/^lab-invoke bag_use (.*)$/gm)].map((m) => JSON.parse(m[1]).ok);
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      return [
        ok(JSON.stringify(uses) === "[false,true]", `걸기 ${JSON.stringify(uses)} (열린 전설이 아닌 999는 거부)`),
        ok(/파이어 \(전설의 향\)/.test(probe.home?.nextBig || ""), `홈 다음 대발견 ${probe.home?.nextBig}`),
        ok(/^breakthrough 146 \(전설의 향\)$/m.test(log), `대발견 ${log.match(/^breakthrough[^\n]*/m)?.[0]}`),
        ok(!st.bag?.legend, `가방 ${JSON.stringify(st.bag)} (향 하나 씀)`),
      ];
    },
  },
  {
    id: "breakthrough-owned", tags: ["smoke", "poke"], what: "열린 전설(1세대 새 셋)을 다 가졌어도 대발견은 그중 하나 — 두 번째 마리(+100) (#87, 전엔 200코인)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_STAMPS: "2" },
    setup: (box) => {
      birds(box);
      const b = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8"));
      for (const id of [144, 145, 146]) b.mons.push({ uid: b.next++, id, shiny: false, xp: 0, lv: 50, mile: 50, how: "wild", at: 1, folder: null });
      fs.writeFileSync(path.join(box.data, "box.json"), JSON.stringify(b));
      putEcon(box, { "state.json": { startSeen: true, stampsSince: dayAgo(1) } });
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { probe: "after" }],
    check: ({ probe, log, box }) => {
      const rows = ledgerRows(box) || [];
      return [
        ok(/^breakthrough 14[4-6]$/m.test(log) && probe.after?.wildBig, `두 번째 마리 조우 ${log.match(/^breakthrough[^\n]*/m)?.[0]} · 카드 ${probe.after?.wildBig}`),
        ok(rows.find((x) => x.kind === "big")?.amount === 100 && !rows.some((x) => x.kind === "legend"), `원장 ${JSON.stringify(rows.filter((x) => ["big", "legend"].includes(x.kind)))} (200코인 없음)`),
      ];
    },
  },
  {
    id: "breakthrough-restart", tags: ["smoke", "poke"], what: "잡지 않은 대발견은 앱을 다시 켜도 그대로 — 놓친 횟수(×1.44)까지 (#82)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => { birds(box); fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ big: { id: 145, shiny: false, misses: 2, seen: true } })); },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 1500 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.wildBig && /전설의 썬더가 나타났다!.*×1\.44/.test(probe.after?.wildText || ""), `다시 켠 뒤 ${probe.after?.wildBig} · ${probe.after?.wildText}`)],
  },
  {
    id: "shell-hook-finish", tags: ["explore", "poke"], what: "시험 앱 셸에서 훅 스크립트로 UserPromptSubmit → Stop을 보내면 완료로 잡혀 대발견까지 — 사용자가 직접 확인하는 시험 빌드의 '작업 끝내기' (#82)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_STAMPS: "6" },
    setup: (box) => { birds(box); putEcon(box, { "state.json": { startSeen: true, stampsSince: dayAgo(6) } }); },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: `printf '{}' | bash "$CVIM_ROOT/claude/hooks/event.sh" UserPromptSubmit; sleep 2; printf '{}' | bash "$CVIM_ROOT/claude/hooks/event.sh" Stop` }, { wait: 200 }, { key: "Enter" }, { wait: 5000 }, { probe: "after" }],
    check: ({ probe, log }) => [ok(/^breakthrough 14[4-6]/m.test(log) && probe.after?.wildBig, `대발견 ${log.match(/^breakthrough[^\n]*/m)?.[0]} · 카드 ${probe.after?.wildBig} · 전환 ${(log.match(/^transition [^\n]*/gm) || []).slice(-3).join(" | ")}`)],
  },
  // ── 🛒 상점 · 👜 가방 E3 (#76, PKM-22·23) ──
  {
    id: "poke-keys-hangul", tags: ["smoke", "poke"], what: "한글 입력 상태에서도 포켓몬 창 글자 키: S(ㄴ) 상점 · I(ㅑ) 가방 · M(ㅡ) 내 포켓몬 — 터미널엔 아무 글자도 안 들어감 (#77)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" }, { wait: 300 },
      { key: "p", mods: 4 }, { wait: 700 }, { key: "ㄴ", code: "KeyS" }, { wait: 600 }, { probe: "s" }, { key: "ㅑ", code: "KeyI" }, { wait: 600 }, { probe: "i" },
      { key: "ㅡ", code: "KeyM" }, { wait: 600 }, { probe: "m" }, { key: "Escape" }, { wait: 400 },
      { text: "echo LABKEYS" }, { wait: 200 }, { key: "Enter" }, { wait: 800 }, { grep: "LABKEYS" }],
    check: ({ probe, log }) => [
      ok(probe.s?.pokeTab === "shop", `ㄴ(S) → ${probe.s?.pokeTab}`),
      ok(!/xterm/.test(probe.s?.focus || ""), `포켓몬 창이 열려도 터미널 입력칸에 포커스 ${probe.s?.focus} — 한글이 셸로 조합됨 (#77)`),
      ok(probe.i?.pokeTab === "bag", `ㅑ(I) → ${probe.i?.pokeTab}`),
      ok(probe.m?.pokeTab === "box", `ㅡ(M) → ${probe.m?.pokeTab}`),
      ok(/lab-grep LABKEYS rows=\[\d[^\n]*text="[^"]*\$ echo LABKEYS/.test(log) && !/[ㄴㅑㅡ]/.test(log.match(/lab-grep LABKEYS[^\n]*/)?.[0] || ""), `터미널 줄 ${log.match(/lab-grep LABKEYS[^\n]*/)?.[0]}`),
    ],
  },
  {
    id: "shop-buy", tags: ["smoke", "poke"], what: "상점: S로 열기, 슈퍼볼 3개(− + 수), 마스터볼은 두 번 눌러 사기·주 1개, 메인이 잔액·제한·수를 다시 검사 — 원장엔 산 것 하루 합계 (#76)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => putEcon(box, { "ledger.jsonl": JSON.stringify({ day: todayLocal(), kind: "start", n: 1000, amount: 2000 }) + "\n", "state.json": { startSeen: true } }),
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      { key: "p", mods: 4 }, { wait: 700 }, { key: "s" }, { wait: 700 }, { probe: "shop" },
      { click: "#box-grid .pk-item[data-i='0']" }, { wait: 150 }, { key: "+" }, { wait: 200 }, { probe: "three" }, { key: "Enter" }, { wait: 1200 },
      { key: "ArrowRight" }, { key: "ArrowRight" }, { wait: 300 }, { key: "Enter" }, { wait: 300 }, { probe: "ask" }, { key: "Enter" }, { wait: 1200 }, { probe: "bought" },
      { invoke: "shop_buy", args: { item: "master", n: 1 }, log: true }, { invoke: "shop_buy", args: { item: "ultra", n: 99 }, log: true }, { invoke: "shop_buy", args: { item: "great", n: 0 }, log: true },
      { invoke: "shop_buy", args: { item: "bogus", n: 1 }, log: true }, { invoke: "shop_state", log: true }],
    check: ({ probe, log, box }) => {
      const r = [...log.matchAll(/^lab-invoke shop_buy (.*)$/gm)].map((m) => JSON.parse(m[1]).why);
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      const buys = (ledgerRows(box) || []).filter((x) => x.kind === "buy");
      return [
        ok(probe.shop?.pokeTab === "shop" && probe.shop?.coin === "🪙 2,000", `S → 상점 ${probe.shop?.pokeTab} 칩 ${probe.shop?.coin}`),
        ok(JSON.stringify(probe.shop?.items) === '["슈퍼볼:40코인","하이퍼볼:100코인","마스터볼:1,500코인","이상한사탕:30코인","진화의 돌:300코인","연결의끈:300코인","향:80코인","전설의 향:800코인","알:500코인","희귀 알:2,000코인","빛나는부적:5,000코인:off"]', `진열 ${JSON.stringify(probe.shop?.items)} (E7 진화의 돌·빛나는부적 #93 · 연결의끈 #122)`),
        ok(probe.three?.takeBtn === "사기 · 120코인", `고른 카드 한 번 더 누르기 + "+" → 수 3이어야 ${probe.three?.takeBtn} (#81)`),
        ok(probe.ask?.takeBtn === "한 번 더 눌러 사기 · 1,500코인 (확인)", `마스터볼 첫 누름 ${probe.ask?.takeBtn}`),
        ok(/이번 주 샀음/.test(probe.bought?.takeBtn || "") && probe.bought?.coin === "🪙 380", `산 뒤 ${probe.bought?.takeBtn} · 칩 ${probe.bought?.coin} (2,000 − 120 − 1,500)`),
        ok(JSON.stringify(r) === '["weekly","coins","count","unknown"]', `메인 검사 ${JSON.stringify(r)} (주간 제한·코인 부족·수 0·없는 아이템)`),
        ok(st.balance === 380 && st.bag?.great === 3 && st.bag?.master === 1, `잔액·가방 ${JSON.stringify({ b: st.balance, bag: st.bag })}`),
        ok(buys.length === 2 && buys.every((x) => JSON.stringify(Object.keys(x)) === '["day","kind","item","n","amount"]') && buys.find((x) => x.item === "great")?.amount === -120, `원장 ${JSON.stringify(buys)}`),
      ];
    },
  },
  {
    id: "bag-candy-incense", tags: ["smoke", "poke"], what: "가방: I로 열기, 이상한사탕을 메인 파트너에게(Lv 15 → 16, #122)·다른 포켓몬 고르기로 한 번 더, 향 피우기(1시간) — 쓴 것은 원장에 (#76)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 500 }, { day: d, kind: "buy", item: "candy", n: 3, amount: -90 }, { day: d, kind: "buy", item: "incense", n: 1, amount: -80 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
      evolvePartner(box);
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, { key: "p", mods: 4 }, { wait: 700 }, { key: "i" }, { wait: 900 }, { probe: "bag" },
      { key: "Enter" }, { wait: 600 }, { probe: "given" },
      { click: "#dex-from [data-a='pick']" }, { wait: 900 }, { probe: "pick" }, { key: "Enter" }, { wait: 600 }, { probe: "picked" },
      { key: "Enter" }, { wait: 600 }, { probe: "out" }, { key: "Enter" }, { wait: 600 }, { probe: "out2" }, { key: "Escape" }, { wait: 500 },
      { key: "ArrowRight" }, { wait: 200 }, { key: "Enter" }, { wait: 900 }, { probe: "incense" }, { key: "Escape" }, { wait: 500 }, { probe: "pane" },
      { invoke: "shop_state", log: true }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ probe, log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      const me = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((m) => m.party === 0);
      const uses = (ledgerRows(box) || []).filter((x) => x.kind === "use");
      const mins = (st.incenseUntil - Date.now()) / 60000;
      return [
        ok(probe.bag?.pokeTab === "bag" && JSON.stringify(probe.bag?.items) === '["이상한사탕:×3","향:×1"]' && probe.bag?.takeBtn === "메인 파트너에게 (Lv 15 → 16)", `가방 ${JSON.stringify(probe.bag?.items)} · ${probe.bag?.takeBtn}`),
        ok(probe.given?.takeBtn === "메인 파트너에게 (Lv 16 → 17)" && /^🆙 Lv 15 → 16!/.test(probe.given?.preview || ""), `사탕 뒤 가방 그대로 ${probe.given?.takeBtn} · ${probe.given?.preview} (#78)`),
        ok(probe.out?.takeBtn === "이상한사탕을 다 썼어요 (꺼짐)" && /^🆙 Lv 17 → 18!/.test(probe.out?.preview || "") && probe.out2?.pos === probe.picked?.pos, `다 쓴 뒤 ${probe.out?.takeBtn} · ${probe.out?.preview} · 선택 ${probe.picked?.pos} → ${probe.out2?.pos} (그대로여야, #78)`),
        ok(probe.picked?.pokeTab === "bag" && probe.picked?.takeBtn === "사탕 주기 (Lv 17 → 18) · 남은 1개" && /^🆙 Lv 16 → 17!/.test(probe.picked?.preview || ""), `고른 포켓몬에게 준 뒤 그 자리 ${probe.picked?.takeBtn} · ${probe.picked?.preview} (#78)`),
        ok(/^🪔 (59|60)분$/.test(probe.incense?.incense || "") && /^🪔 향 (59|60)분 · 야생 ×2$/.test(probe.pane?.pokeIncense || ""), `향 칩 ${probe.incense?.incense} · 파트너 칸 ${probe.pane?.pokeIncense} (#79)`),
        ok(probe.pick?.takeBtn === "사탕 주기 (Lv 16 → 17) · 남은 2개", `고르기 ${probe.pick?.takeBtn}`),
        ok(me?.lv === 18 && me?.id === 4, `파트너 ${JSON.stringify(me && { id: me.id, lv: me.lv })} (오프라인이라 Lv 16에서 진화는 다음에)`),
        ok(!st.bag?.candy && !st.bag?.incense && mins > 58 && mins <= 60, `가방 ${JSON.stringify(st.bag)} · 향 ${mins.toFixed(1)}분`),
        ok(/^켜진 효과: 🪔 향 (59|60)분 남음$/.test(probe.incense?.effects || "") && JSON.stringify(probe.incense?.items) === "[]", `향 켜짐 ${probe.incense?.effects} · ${JSON.stringify(probe.incense?.items)} (다 쓴 것은 가방에서 빠짐)`),
        ok(uses.find((x) => x.item === "candy")?.n === 3 && uses.find((x) => x.item === "incense")?.n === 1, `원장 쓰기 ${JSON.stringify(uses)}`),
      ];
    },
  },
  {
    id: "wild-balls", tags: ["smoke", "poke"], what: "야생 카드 볼 고르기: 가진 볼만 칩(몬스터볼 ∞), 마스터볼을 고르면 금색 \"확정\" — ⌘B로 던지면 반드시 잡히고 가방에서 한 개 줄어듦 (#76)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 2000 }, { day: d, kind: "buy", item: "great", n: 1, amount: -40 }, { day: d, kind: "buy", item: "master", n: 1, amount: -1500 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
      fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } }));
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 }, ...DONE("$ws"), { wait: 1500 }, { probe: "card" },
      { click: "#wild .wild-balls [data-ball='master']" }, { wait: 200 }, { probe: "master" }, { key: "b", mods: 4 }, { wait: 4000 }, { invoke: "shop_state", log: true }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke shop_state (.*)$/m)?.[1] || "{}");
      return [
        ok(JSON.stringify(probe.card?.wildBalls) === '["몬스터볼 ∞*","슈퍼볼 1","마스터볼 1"]', `볼 칩 ${JSON.stringify(probe.card?.wildBalls)} (가진 볼만, 하이퍼볼 없음)`),
        ok(/확정 — 마스터볼/.test(probe.master?.wildBtn || ""), `마스터볼 고른 버튼 ${probe.master?.wildBtn}`),
        ok(/^wild throw caught .*$/m.test(log), `던지기 ${log.match(/^wild throw [^\n]*/m)?.[0]}`),
        ok(!st.bag?.master && st.bag?.great === 1, `가방 ${JSON.stringify(st.bag)} (마스터볼 0)`),
      ];
    },
  },
  // ── 🆙 레벨 E2 (#74, PKM-21) ──
  {
    id: "levels-migrate", tags: ["smoke", "poke", "data"], what: "EXP → 레벨 이전(한 번): Lv = 5 + 2 × EXP, 그 모습이 되는 레벨(돌·친밀도 = 30)보다 낮으면 그 레벨 — 지난 이정표엔 ₽ 없음, 이전 전 box.json 사본 (#74)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { wait: 800 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }, { invoke: "economy_state", log: true }],
    check: ({ log, box }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]");
      const lv = Object.fromEntries(list.map((m) => [m.uid, m.lv]));
      const backups = fs.readdirSync(path.join(box.data, "backup")).filter((d) => d.startsWith("box-levels-"));
      const copy = backups[0] && JSON.parse(fs.readFileSync(path.join(box.data, "backup", backups[0], "box.json"), "utf8"));
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      return [
        ok(JSON.stringify(lv) === JSON.stringify({ 1: 30, 2: 5, 3: 11, 4: 5, 5: 5, 6: 30 }), `레벨 ${JSON.stringify(lv)} (샤미드 EXP 12 → 29지만 돌 진화형이라 30 · 식스테일 5 · 코산호 EXP 3 → 11 · 브이젤·깝질무 5 · 피카츄 EXP 7 → 19지만 친밀도 진화형이라 30)`),
        ok(backups.length === 1 && copy?.mons?.every((m) => m.lv == null && m.xp != null), `이전 전 사본 ${backups.join()}`),
        ok(st.balance === 54, `잔액 ${st.balance} (시작 코인 54뿐 — 이전된 레벨의 이정표는 ₽ 없음)`),
        ok(list.find((m) => m.uid === 3)?.final === true && list.find((m) => m.uid === 2)?.next?.level === 30, `코산호 최종(5세대까지 진화 없음) ${list.find((m) => m.uid === 3)?.final} · 식스테일 다음 ${JSON.stringify(list.find((m) => m.uid === 2)?.next)} (불꽃의 돌 → 돌 전엔 Lv 30)`),
      ];
    },
  },
  {
    id: "evolve-trade", tags: ["smoke", "poke"], what: "교환 진화는 연결의끈으로만(#122 — 폴더를 옮겨 일으키던 교환 없음): 근육몬 메인 파트너는 완료 두 번에도 괴력몬이 되지 않고 레벨만 (#74, PKM-21 규칙 3)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      fakeSpecies(box, 67, "근육몬", { reach: { kind: "level", level: 28 }, next: [{ to: 68, kind: "trade" }] });
      fakeSpecies(box, 68, "괴력몬", { reach: { kind: "trade" }, next: [] });
      evolvePartner(box, { id: 67, lv: 28, mile: 20 });
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, ...DONE("$ws"), { wait: 1500 }, ...DONE("$ws"), { wait: 1000 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ log }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.party === 0);
      return [
        ok(m?.id === 67 && m.lv > 28 && m.cord, `파트너 ${JSON.stringify(m && { id: m.id, lv: m.lv, cord: m.cord })} (근육몬 그대로, 연결의끈을 쓸 수 있음)`),
        ok(!/evolved=68/.test(log), "완료로 교환 진화함"),
      ];
    },
  },
  {
    id: "cord-evolve", tags: ["smoke", "poke"], what: "연결의끈: 가방 [쓸 포켓몬 고르기] → 교환으로 진화하는 마리만(근육몬) → Enter로 괴력몬, 끈 1개 씀 · +30 진화 +30 새 종, 파트너 칸도 괴력몬 (#122, PKM-23 규칙 7)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      fakeSpecies(box, 67, "근육몬", { reach: { kind: "level", level: 28 }, next: [{ to: 68, kind: "trade" }] });
      fakeSpecies(box, 68, "괴력몬", { reach: { kind: "trade" }, next: [] });
      evolvePartner(box, { id: 67, lv: 28, mile: 20 });
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 1000 }, { day: d, kind: "buy", item: "cord", n: 1, amount: -300 }].map((x) => JSON.stringify(x)).join("\n") + "\n", "state.json": { startSeen: true } });
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, { key: "p", mods: 4 }, { wait: 700 }, { key: "i" }, { wait: 900 }, { probe: "bag" },
      { key: "Enter" }, { wait: 1200 }, { probe: "pick" }, { key: "Enter" }, { wait: 3500 }, { probe: "after" },
      { invoke: "box_list", args: { ws: "$ws" }, log: true }, { invoke: "economy_state", log: true }],
    check: ({ probe, log, box }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.party === 0), st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      const rows = ledgerRows(box) || [];
      return [
        ok(/연결의끈/.test(probe.bag?.preview || "") || /연결의끈/.test(probe.bag?.dexName || ""), `가방 ${probe.bag?.dexName} · ${probe.bag?.preview}`),
        ok(probe.pick?.cards === 1, `고르기 목록 ${probe.pick?.cards}마리 (근육몬만)`),
        ok(m?.id === 68 && /^bag use cord uid=1 to=68$/m.test(log), `진화 ${JSON.stringify(m && { id: m.id })} · ${log.match(/^bag use cord .*$/m)?.[0]}`),
        ok(st.cords === 0 && rows.some((x) => x.kind === "evolve" && x.amount === 30) && rows.some((x) => x.kind === "newdex" && x.amount === 30), `끈 ${st.cords} · 원장 ${JSON.stringify(rows.filter((x) => ["evolve", "newdex"].includes(x.kind)))}`),
        ok(probe.after?.partner === "괴력몬", `파트너 칸 ${probe.after?.partner}`),
      ];
    },
  },
  {
    id: "evolve-friend", tags: ["smoke", "poke"], what: "친밀도 진화: 함께한 완료 20번째에 피츄 → 피카츄, 그 전엔 \"친밀도 19/20\" (#74, PKM-21 규칙 3)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => {
      fakeSpecies(box, 172, "피츄", { reach: null, next: [{ to: 25, kind: "friend" }] });
      evolvePartner(box, { id: 172, lv: 9, mile: 0, friend: 18 });
    },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 }, ...DONE("$ws"), { wait: 800 }, { probe: "before" }, ...DONE("$ws"), { wait: 1500 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ probe, log }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.party === 0);
      return [
        ok(probe.before?.pokeExp === "Lv 11 · 친밀도 19/20", `한 번 전 ${probe.before?.pokeExp}`),
        ok(m?.id === 25 && m.lv === 13, `파트너 ${JSON.stringify(m && { id: m.id, lv: m.lv })} (피카츄 Lv 13)`),
        ok(/^exp ws=.* miles=10 /m.test(log), `Lv 10 이정표 ${log.match(/^exp ws=[^\n]*/m)?.[0]}`),
      ];
    },
  },
  // ── 🪙 포켓코인 E1 (#72, PKM-18, POL-FUT-01) ──
  {
    id: "economy-earn", tags: ["smoke", "poke", "data"], what: "포켓코인: 처음 켤 때 시작 코인(지난 완료 27 × 2 = ₽54), 완료 +5 · 하루 첫 +20 · 30초 미만 턴 +1, 같은 턴이 두 번 와도 한 번 — 칩·홈·띠·메뉴바, 원장엔 하루·종류별 합계만 (#72)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      ...DONE("$ws", { turn_at: 1700000000000, took: 120000 }), ...DONE("$ws", { turn_at: 1700000000000, took: 120000 }), // the same turn twice
      ...DONE("$ws", { turn_at: 1700000100000, took: 5000 }), { wait: 400 }, // a 5-second turn
      { key: "p", mods: 4 }, { wait: 900 }, { probe: "home" }, { click: "#box-grid .pk-band-x" }, { wait: 600 }, { probe: "closed" },
      { invoke: "economy_state", log: true }, { invoke: "tray_test", log: true }],
    check: ({ probe, log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      const tray = JSON.parse(log.match(/^lab-invoke tray_test (.*)$/m)?.[1] || "{}");
      const rows = ledgerRows(box) || [], d = todayLocal();
      const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
      let seen = null, wallet = null, state = null;
      try { seen = JSON.parse(fs.readFileSync(econ(box, "today.json"), "utf8")); wallet = JSON.parse(fs.readFileSync(econ(box, "wallet.json"), "utf8")); state = JSON.parse(fs.readFileSync(econ(box, "state.json"), "utf8")); } catch {}
      return [
        ok(/^economy balance=54 start=54$/m.test(log), `시작 코인 ${log.match(/^economy [^\n]*/m)?.[0]} (stats 27번 × 2 = 54)`),
        ok(st.balance === 80 && st.today?.earned === 26 && st.today?.capLeft === 294, `잔액·오늘 ${JSON.stringify(st)} (54 + 5 + 20 + 1 = 80, 오늘 26, 상한까지 294)`),
        ok((log.match(/^coins ws=/gm) || []).length === 2, `적립 ${(log.match(/^coins ws=/gm) || []).length}번 — 같은 턴은 한 번만(2번이어야)`),
        ok(probe.home?.coin === "🪙 80", `제목 줄 칩 ${probe.home?.coin}`),
        ok(/26코인오늘 번 코인 · 상한까지 294코인/.test(probe.home?.coinToday || ""), `홈 코인 칸 ${probe.home?.coinToday}`),
        ok(/지난 완료 27번으로 54코인 받았어요/.test(probe.home?.coinBand || "") && probe.closed?.coinBand === null && state?.startSeen === true, `시작 코인 띠 ${probe.home?.coinBand} → 닫은 뒤 ${probe.closed?.coinBand} ${JSON.stringify(state)}`),
        ok((tray.items || []).some((i) => i.label === "🪙 포켓코인 80 · 오늘 +26"), `메뉴바 코인 줄 ${JSON.stringify((tray.items || []).filter((i) => /포켓코인/.test(i.label || "")))}`),
        ok(rows.length === 4 && rows.every((r) => JSON.stringify(Object.keys(r)) === '["day","kind","n","amount"]' && r.day === d)
          && by.start?.n === 27 && by.start?.amount === 54 && by.done?.amount === 5 && by.first?.amount === 20 && by.fast?.n === 1 && by.fast?.amount === 1, `원장 ${JSON.stringify(rows)}`),
        ok(!filesWith(path.join(box.data, "economy"), "proj").length && !filesWith(path.join(box.data, "economy"), box.dir).length, "원장·캐시에 폴더 이름·경로가 남음"),
        ok(seen?.day === d && JSON.stringify(seen?.seen) === "[1700000000000,1700000100000]" && wallet?.balance === 80, `확인 표시 ${JSON.stringify(seen)} · 지갑 ${JSON.stringify(wallet)}`),
      ];
    },
  },
  {
    id: "economy-cap", tags: ["smoke", "poke"], what: "포켓코인 하루 상한: 완료 적립은 ₽300에서 멈춤(마지막은 남은 만큼), 홈 \"오늘 상한 · 보너스만\" — 새 종을 잡은 +₽30은 상한 밖 (#72)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => {
      const d = todayLocal();
      putEcon(box, { "ledger.jsonl": [{ day: d, kind: "start", n: 0, amount: 0 }, { day: d, kind: "done", n: 60, amount: 298 }, { day: d, kind: "first", n: 1, amount: 20 }].map((r) => JSON.stringify(r)).join("\n") + "\n", "state.json": { startSeen: true } });
      fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } })); // 구구: seen, never caught (owner data)
    },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      { invoke: "wild_rig_test", args: { result: "caught" } }, ...DONE("$ws"), { wait: 600 }, ...DONE("$ws"), { wait: 400 },
      { key: "b", mods: 4 }, { wait: 3500 }, { key: "p", mods: 4 }, { wait: 900 }, { probe: "home" }, { invoke: "economy_state", log: true }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      const coins = [...log.matchAll(/^coins ws=\S+ (.*)$/gm)].map((m) => m[1]);
      return [
        ok(JSON.stringify(coins) === '["+2 (2 capped)","+0 (0 capped)"]', `완료 적립 ${JSON.stringify(coins)} (298 → 300에 2, 그다음은 0)`),
        ok(/^wild throw caught .*coins=30$/m.test(log), `새 종 포획 ${log.match(/^wild throw [^\n]*/m)?.[0]}`),
        ok(st.balance === 350 && st.today?.capLeft === 0 && st.today?.earned === 350, `잔액·오늘 ${JSON.stringify(st)} (298 + 20 + 2 + 30 = 350)`),
        ok(/오늘 상한 · 보너스만/.test(probe.home?.coinToday || "") && probe.home?.coinBand === null, `홈 ${probe.home?.coinToday} · 띠 ${probe.home?.coinBand}`),
      ];
    },
  },
  {
    id: "economy-corrupt", tags: ["smoke", "poke", "data"], what: "포켓코인 원장에 못 읽는 줄 → 사본(backup/corrupt) 뒤 읽은 줄로 다시 쓰고, 다른 지갑 캐시는 원장으로 다시 만듦 (#72, POL-DATA-05)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => putEcon(box, { "ledger.jsonl": JSON.stringify({ day: "2026-10-01", kind: "start", n: 50, amount: 100 }) + "\n{\"day\":\"2026-10-0\n", "wallet.json": { balance: 999 } }),
    steps: [{ until: "tabs.0" }, { wait: 800 }, { invoke: "economy_state", log: true }],
    check: ({ log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke economy_state (.*)$/m)?.[1] || "{}");
      const corrupt = path.join(box.data, "backup", "corrupt");
      const copies = fs.existsSync(corrupt) ? fs.readdirSync(corrupt).filter((f) => f.startsWith("ledger.jsonl.")) : [];
      let wallet = null; try { wallet = JSON.parse(fs.readFileSync(econ(box, "wallet.json"), "utf8")); } catch {}
      return [
        ok(st.balance === 100 && st.start === null, `잔액 ${JSON.stringify(st)} (읽은 줄 ₽100, 시작 코인을 다시 주지 않음)`),
        ok(copies.length === 1, `깨진 원장 사본 ${copies.length}개`),
        ok(ledgerRows(box)?.length === 1 && wallet?.balance === 100, `다시 쓴 원장 ${JSON.stringify(ledgerRows(box))} · 지갑 ${JSON.stringify(wallet)}`),
      ];
    },
  },
  // ── 🏠 홈 · 포획 기록 (#44) ──
  {
    id: "home", tags: ["smoke", "poke"], what: "⌘P → 홈: 오늘 끝낸 작업·연속 일수, 끝낼 때마다 오늘 수가 늘고 stats.json엔 날짜별 수만 (#44)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } }, { wait: 300 },
      { key: "p", mods: 4 }, { wait: 800 }, { probe: "home" }, { invoke: "home_state", log: true }, { key: "m" }, { wait: 500 }, { probe: "box" }],
    check: ({ probe, log, box }) => {
      const st = JSON.parse(log.match(/^lab-invoke home_state (.*)$/m)?.[1] || "{}");
      const file = JSON.parse(fs.readFileSync(path.join(box.data, "stats.json"), "utf8"));
      return [
        ok(probe.home?.poke === "home", `⌘P에 홈이 안 열림 (${probe.home?.poke})`),
        ok(probe.home?.pokeTab === "home", `강조된 탭이 ${probe.home?.pokeTab} (홈이어야)`),
        ok(st.today === 7, `오늘 ${st.today} (심은 6 + 끝낸 1 = 7)`),
        ok(st.streak === 5, `연속 ${st.streak}일 (심은 값 6일 전부터 3·0·5·2·7·4·6 → 오늘부터 0을 만나기 전까지 5)`),
        ok(Object.keys(file).join() === "days" && Object.values(file.days).every((n) => Number.isInteger(n)), "stats.json에 날짜별 수 말고 다른 것이 있음"),
        ok(probe.box?.poke === "box", "M으로 내 포켓몬에 안 감"),
      ];
    },
  },
  {
    id: "box-no-eggs", tags: ["smoke", "poke"], what: "내 포켓몬: 부화기 알은 카드·수에서 빠지고 맨 위 한 줄 \"🥚 알 n개는 👜 가방의 부화기에\" — [가방 열기]로 가방 (#91)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 300 },
      { invoke: "incubator_add_test", args: { kind: "egg", have: 2 } }, { invoke: "incubator_add_test", args: { kind: "egg2", have: 0 } },
      { call: "openDex" }, { call: "box" }, { wait: 800 }, { probe: "box" }, { invoke: "box_list", args: { ws: "$ws" }, log: true },
      { click: "#box-grid .pk-box-eggs button" }, { wait: 800 }, { probe: "bag" }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]"), mons = list.filter((m) => !m.egg).length, eggs = list.filter((m) => m.egg).length;
      return [
        ok(eggs === 2 && probe.box?.cards === mons, `카드 ${probe.box?.cards}개 = 알 뺀 ${mons}마리 (알 ${eggs})`),
        ok(probe.box?.boxEggs === "🥚 알 2개는 👜 가방의 부화기에 있어요 가방 열기", `안내 줄 ${probe.box?.boxEggs}`),
        ok(new RegExp(`내 포켓몬 ${mons}$`).test(probe.box?.boxTab || ""), `탭 수 ${probe.box?.boxTab} (알 빼고 ${mons})`),
        ok(probe.bag?.poke === "bag" && /^알 2\/10/.test(probe.bag?.bagInc?.now || ""), `가방 열기 → ${probe.bag?.poke} ${probe.bag?.bagInc?.now}`),
      ];
    },
  },
  {
    id: "catch-log", tags: ["smoke", "poke"], what: "내 포켓몬 상세: 잡은 폴더·에이전트·진화 이력, 기록 없는 옛 개체는 그 줄 없음 (#44)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { call: "box" }, { wait: 300 }, { call: "openDex" }, { call: "box" }, { wait: 800 },
      { probe: "first" }, { key: "ArrowRight" }, { wait: 300 }, { probe: "second" }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ probe, log }) => {
      const list = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]");
      const vz = list.find((m) => m.id === 418), sh = list.find((m) => m.id === 134), pk = list.find((m) => m.id === 25);
      return [
        ok(vz?.caughtIn === "proj" && vz?.caughtBy === "Codex", `418 기록 ${JSON.stringify({ i: vz?.caughtIn, b: vz?.caughtBy })} (폴더 이름만·에이전트 이름)`),
        ok(sh?.evo?.length === 1 && sh.evo[0].to === "샤미드", `134 진화 이력 ${JSON.stringify(sh?.evo)}`),
        ok(pk && !pk.caughtIn && !pk.evo?.length, "기록 없는 개체에 기록이 생김"),
        ok(/proj에서 Codex 작업 중/.test(probe.first?.preview || ""), `첫 카드(최근 잡은 브이젤) 상세 ${JSON.stringify(probe.first?.preview)}`),
      ];
    },
  },
  // ── a Claude typed in the shell: the opt-in line (#45) — fake claude, sandbox ZDOTDIR, never ~/.zshrc ──
  {
    id: "codex-escalation-waiting", tags: ["smoke", "agents"], what: "셸에서 친 Codex가 샌드박스 밖 명령(require_escalated)을 부르면 결과가 올 때까지 입력 필요, 결과 뒤 생각 중 (#50)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    // a fake Codex writing its session log the way codex-cli 0.159 does: the `exec` tool, then the output once approved
    files: { "fakebin/codex": `#!/bin/sh
[ "$1" = "--version" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }
d="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"; mkdir -p "$d"; f="$d/rollout-lab.jsonl"
sleep 2
printf '{"type":"session_meta","payload":{"cwd":"%s"}}\n' "$(pwd -P)" > "$f"
echo '{"type":"event_msg","payload":{"type":"task_started"}}' >> "$f"
echo '{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"text(await exec_command({cmd:\\"npm view x version\\", sandbox_permissions:\\"require_escalated\\"}))"}}' >> "$f"
sleep 10
echo '{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"1.0.0"}}' >> "$f"
sleep 30
` },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { until: "astate", timeout: 9000 }, { wait: 5000 }, { probe: "asking" },
      { wait: 9000 }, { probe: "answered" }],
    check: ({ probe, log }) => [
      ok(/host-agent \S+ codex kind=codex_log/.test(log), "셸 Codex가 세션 로그 방식으로 안 잡힘"),
      ok(probe.asking?.astate === "waiting", `승인 대기 중 상태 ${probe.asking?.astate} (입력 필요여야)`),
      ok(/^❓ 승인 요청 npm view x version/.test((probe.asking?.activity || [])[0]?.trim() || ""), `활동 기록 첫 줄 "${(probe.asking?.activity || [])[0]}" (❓ 승인 요청이어야, #56)`),
      ok(probe.answered?.astate === "thinking", `결과 뒤 상태 ${probe.answered?.astate} (생각 중이어야)`),
    ],
  },
  {
    id: "start-keys", tags: ["smoke", "tabs"], what: "시작 화면 키: 꼭 필요한 시작 화면은 Esc로 안 닫힘, ↑↓·Enter·숫자·h·o로 열기, ⌘T로 연 시작 화면은 Esc로 닫힘 (TAB-03)",
    data: "owner", mode: "direct", folders: [], make: ["a", "b", "c", "home", "picked"],
    env: { CVIM_DESKTOP_TEST_HOME: (box) => box.folder("home"), CVIM_DESKTOP_TEST_CHOOSE: (box) => box.folder("picked") },
    setup: (box) => fs.writeFileSync(path.join(box.data, "recent_dirs"), [box.folder("c"), box.folder("b"), path.join(box.dir, "gone"), box.folder("a")].join("\n") + "\n"),
    steps: [{ until: "start" }, { wait: 400 }, { probe: "first" }, { key: "Escape" }, { wait: 300 }, { probe: "esc0" },
      { key: "ArrowDown" }, { key: "ArrowDown" }, { wait: 100 }, { probe: "sel" }, { key: "ArrowUp" }, { key: "j" }, { wait: 100 }, { probe: "selj" }, { key: "Enter" },
      { until: "partnerKnown", timeout: 8000 }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { probe: "t1" }, { key: "Escape" }, { wait: 300 }, { probe: "esc1" },
      { key: "t", mods: 4 }, { wait: 400 }, { probe: "t2" }, { key: "2" }, { until: "partnerKnown", timeout: 8000 }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { key: "h" }, { until: "partnerKnown", timeout: 8000 }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { key: "o" }, { until: "partnerKnown", timeout: 8000 }, { wait: 800 }, { probe: "end" }],
    check: ({ probe }) => [
      ok(JSON.stringify(probe.first?.recent) === JSON.stringify(["c", "b", "a"]), `최근 폴더 ${JSON.stringify(probe.first?.recent)} (없는 폴더는 빠져야)`),
      ok(probe.esc0?.start === true, "꼭 필요한 시작 화면이 Esc로 닫힘"),
      ok(probe.sel?.startSel === 2 && probe.selj?.startSel === 2, `↓↓ ${probe.sel?.startSel} (2여야), ↑j ${probe.selj?.startSel} (2여야)`),
      ok(probe.t1?.start === true && probe.esc1?.start === false && JSON.stringify(probe.esc1?.tabs) === '["a"]', `⌘T 시작 화면 ${probe.t1?.start}, Esc 뒤 ${probe.esc1?.start} 탭 ${JSON.stringify(probe.esc1?.tabs)}`),
      ok(JSON.stringify(probe.t2?.recent) === JSON.stringify(["a", "c", "b"]), `연 폴더가 맨 앞으로 안 옴 ${JSON.stringify(probe.t2?.recent)}`),
      ok(JSON.stringify(probe.end?.tabs) === JSON.stringify(["a", "c", "home", "picked"]), `탭 ${JSON.stringify(probe.end?.tabs)} (Enter→a, 2→c, h→홈, o→고른 폴더)`),
      ok(probe.end?.start === false, "마지막에 시작 화면이 남음"),
    ],
  },
  {
    id: "recent-dirs", tags: ["smoke", "tabs", "data"], what: "최근 폴더: 10개까지, 없는 폴더 빠짐, 연 폴더는 맨 앞에 한 번만, last_dir (TAB-04)",
    data: "owner", mode: "direct", folders: [], make: Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`),
    setup: (box) => fs.writeFileSync(path.join(box.data, "recent_dirs"), [...Array.from({ length: 11 }, (_, i) => box.folder(`f${String(i + 1).padStart(2, "0")}`)), path.join(box.dir, "gone")].join("\n") + "\n"),
    steps: [{ until: "start" }, { wait: 400 }, { probe: "first" }, { key: "3" }, { until: "partnerKnown", timeout: 8000 }, { wait: 800 }],
    check: ({ probe, box }) => {
      const list = fs.readFileSync(path.join(box.data, "recent_dirs"), "utf8").split("\n").filter(Boolean).map((d) => path.basename(d));
      const last = path.basename(fs.readFileSync(path.join(box.data, "last_dir"), "utf8").trim());
      return [
        ok(probe.first?.recent?.length === 10 && probe.first.recent[0] === "f01", `시작 화면 목록 ${JSON.stringify(probe.first?.recent)} (f01부터 10개)`),
        ok(list[0] === "f03" && list.length === 10 && new Set(list).size === 10 && !list.includes("gone"), `recent_dirs ${JSON.stringify(list)}`),
        ok(last === "f03", `last_dir ${last}`),
      ];
    },
  },
  {
    id: "tab-keys", tags: ["smoke", "tabs"], what: "탭 키: ⌘1·⌘9(마지막)·⌘[ ⌘](끝에서 돌아감)·⌘W(같은 자리 탭으로, 마지막이면 시작 화면) (TAB-05)",
    data: "owner", mode: "direct", folders: ["a", "b", "c"],
    steps: [{ until: "tabs.2" }, { wait: 1500 }, { call: "closeDex" }, { wait: 300 },
      { key: "1", mods: 4 }, { wait: 200 }, { probe: "k1" }, { key: "9", mods: 4 }, { wait: 200 }, { probe: "k9" },
      { key: "[", mods: 4 }, { wait: 200 }, { probe: "prev" }, { key: "]", mods: 4 }, { key: "]", mods: 4 }, { wait: 200 }, { probe: "wrap" },
      { call: "closeDex" }, { key: "w", mods: 4 }, { wait: 600 }, { probe: "w1" }, { call: "closeDex" }, { key: "w", mods: 4 }, { wait: 600 }, { call: "closeDex" }, { key: "w", mods: 4 }, { wait: 800 }, { probe: "w3" }],
    check: ({ probe }) => [
      ok(probe.k1?.active === "a" && probe.k9?.active === "c", `⌘1 ${probe.k1?.active} ⌘9 ${probe.k9?.active}`),
      ok(probe.prev?.active === "b", `⌘[ ${probe.prev?.active}`),
      ok(probe.wrap?.active === "a", `⌘] ⌘] ${probe.wrap?.active} (끝에서 처음으로)`),
      ok(JSON.stringify(probe.w1?.tabs) === '["b","c"]' && probe.w1?.active === "b", `⌘W 뒤 탭 ${JSON.stringify(probe.w1?.tabs)} 현재 ${probe.w1?.active}`),
      ok(probe.w3?.tabs?.length === 0 && probe.w3?.start === true, `마지막 탭을 닫은 뒤 ${JSON.stringify(probe.w3?.tabs)} 시작 화면 ${probe.w3?.start}`),
    ],
  },
  {
    id: "select-copy", tags: ["smoke", "terminal"], what: "터미널 글을 마우스로 끌어 고르면 복사·'복사됨' 알림 — 시험은 시스템 클립보드를 건드리지 않음 (TRM-04)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "echo lab-pick-4821" }, { wait: 200 }, { key: "Enter" }, { wait: 1000 }, { select: "lab-pick-4821" }, { wait: 300 }, { probe: "picked" }],
    check: ({ probe, log }) => [
      ok(/^copy_text "lab-pick-4821"$/m.test(log), `복사한 글 ${log.match(/^copy_text (.*)$/m)?.[1]}`),
      ok(/복사됨 \(13자\)/.test(probe.picked?.toast || ""), `알림 ${probe.picked?.toast}`),
    ],
  },
  {
    id: "hand-pick", tags: ["smoke", "terminal"], what: "셸 1에서 고른 글을 레일에서 셸 2 우클릭 → 보내기: 출처 한 줄과 함께 셸 2에 입력·실행 (TRM-11)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 },
      { key: "t", mods: 12 }, { wait: 2500 }, { key: "1", mods: 6 }, { wait: 500 }, { call: "focusShell" }, // ⌃⌘1: back to shell 1
      { text: "echo lab-hand-7390" }, { wait: 200 }, { key: "Enter" }, { wait: 1000 }, { select: "lab-hand-7390" }, { wait: 300 },
      { click: ".rail .sess:nth-of-type(2)", button: "right" }, { wait: 300 }, { probe: "menu" },
      { key: "2" }, { wait: 1200 }, { probe: "sent" }, { key: "2", mods: 6 }, { wait: 500 }, { grep: "가져온 내용]" }, { grep: "lab-hand-7390" }],
    check: ({ probe, log }) => [
      ok((probe.menu?.menuItems || []).some((t) => /선택한 글 보내기 \(셸 1.*13자\)/.test(t)), `메뉴 ${JSON.stringify(probe.menu?.menuItems)}`),
      ok(/셸 1.*→ 셸 2.*13자 보냄/.test(probe.sent?.toast || ""), `알림 ${probe.sent?.toast}`),
      ok(/lab-grep 가져온 내용\] rows=\[\d.*text=".*\[셸 1/.test(log), "셸 2에 출처 줄이 없음"),
      ok(/lab-grep lab-hand-7390 rows=\[\d/.test(log), "셸 2에 넘긴 글이 없음"),
    ],
  },
  {
    id: "activity-log", tags: ["smoke", "status"], what: "활동 기록: 새것부터, 이벤트마다 아이콘·이름·짧은 내용, 도구 뒤 줄(PostToolUse)은 없음 (STA-14)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    files: { "fakebin/codex": `#!/bin/sh
[ "$1" = "--version" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }
d="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"; mkdir -p "$d"; f="$d/rollout-lab.jsonl"
sleep 2
printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n' "$(pwd -P)" > "$f"
for l in '{"type":"event_msg","payload":{"type":"task_started"}}' \\
  '{"type":"response_item","payload":{"type":"function_call","call_id":"a","name":"exec_command","arguments":"{\\"cmd\\":\\"rg needle src\\"}"}}' \\
  '{"type":"response_item","payload":{"type":"reasoning"}}' \\
  '{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"b","name":"apply_patch","input":"*** Begin Patch\\n*** Update File: src/app.js\\n"}}' \\
  '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"all good"}}'; do printf '%s\\n' "$l" >> "$f"; done
sleep 30
` },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { wait: 7000 }, { probe: "log" }],
    check: ({ probe }) => {
      const a = (probe.log?.activity || []).map((x) => x.trim());
      return [
        ok(a.length === 4, `줄 수 ${a.length} ${JSON.stringify(a)} (PostToolUse 없이 4줄)`),
        ok(/^✅ Stop\s*$/.test(a[0] || ""), `첫 줄(가장 새것) ${a[0]} — 응답 본문 없이 (#53)`),
        ok(/^✏️ Edit app\.js/.test(a[1] || "") || /^✏️ Edit src\/app\.js/.test(a[1] || ""), `둘째 줄 ${a[1]}`),
        ok(/^📖 Grep rg needle src/.test(a[2] || ""), `셋째 줄 ${a[2]}`),
        ok(/^💬 UserPromptSubmit/.test(a[3] || ""), `넷째 줄 ${a[3]}`),
      ];
    },
  },
  {
    id: "agent-swap", tags: ["smoke", "agents"], what: "⌘G: 실행 중인 것과 같은 에이전트는 그대로(포커스만), 다른 것은 확인 — 취소면 그대로, 확인이면 교체 (AGT-03)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    files: { "fakebin/claude": "#!/bin/sh\necho \"fake-claude args: $*\"\nsleep 60\n", "fakebin/codex": "#!/bin/sh\n[ \"$1\" = \"--version\" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }\necho \"fake-codex args: $*\"\nsleep 60\n" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 },
      { key: "g", mods: 4 }, { wait: 500 }, { probe: "menu0" }, { key: "1" }, { wait: 2500 }, { probe: "claude" },
      { key: "g", mods: 4 }, { wait: 500 }, { probe: "menu1" }, { key: "1" }, { wait: 800 }, { probe: "stay" },
      { confirm: false }, { key: "g", mods: 4 }, { wait: 500 }, { key: "2" }, { wait: 1500 }, { probe: "cancel" },
      { confirm: true }, { key: "g", mods: 4 }, { wait: 500 }, { key: "2" }, { wait: 2500 }, { probe: "swapped" }],
    check: ({ probe, log }) => {
      const starts = log.split("\n").filter((l) => /^agent-start /.test(l));
      return [
        ok(/Claude/.test(probe.menu0?.menuItems?.[0] || "") && /Codex/.test(probe.menu0?.menuItems?.[1] || ""), `⌘G 목록 ${JSON.stringify(probe.menu0?.menuItems)}`),
        ok(probe.claude?.agent === "claude", `처음 고른 에이전트 ${probe.claude?.agent}`),
        ok(/실행 중/.test(probe.menu1?.menuItems?.[0] || ""), `실행 중 표시 없음 ${probe.menu1?.menuItems?.[0]}`),
        ok(/Claude[^\n]*은\(는\) 이미 실행 중이에요/.test(probe.stay?.toast || ""), `같은 에이전트 알림 ${probe.stay?.toast}`),
        ok(/^lab-confirm false 지금 에이전트를 끝내고 Codex\(으\)로 바꿀까요\?$/m.test(log), "취소한 확인 문구가 다름/없음"),
        ok(probe.cancel?.agent === "claude", `취소 뒤 에이전트 ${probe.cancel?.agent}`),
        ok(probe.swapped?.agent === "codex", `확인 뒤 에이전트 ${probe.swapped?.agent}`),
        ok(starts.length === 2 && /claude/.test(starts[0]) && /codex/.test(starts[1]), `에이전트 시작 ${starts.length}번 (claude 1 → codex 1 이어야): ${starts.join(" | ")}`),
      ];
    },
  },
  {
    id: "agent-registered", tags: ["smoke", "agents"], what: "등록한 에이전트(agents.json): ⌘G 목록·연결 창에 나오고, 셸에서 치면 출력 기준(activity)으로 따라감 (AGT-12)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    files: { "agents-user.json": JSON.stringify({ labagent: { name: "LabAgent", icon: "⌘", cmd: ["labagent"], state: "activity" }, plain: { cmd: "plainagent" } }),
      "fakebin/labagent": "#!/bin/sh\necho lab agent running\nsleep 30\n", "fakebin/plainagent": "#!/bin/sh\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 },
      { invoke: "agents_status", log: true }, { key: "g", mods: 4 }, { wait: 500 }, { probe: "menu" }, { key: "Escape" }, { wait: 300 },
      { call: "focusShell" }, { text: "labagent" }, { wait: 200 }, { key: "Enter" }, { wait: 3500 }, { probe: "typed" }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke agents_status (.*)$/m)?.[1] || "{}");
      const lab = st.list?.find((a) => a.key === "labagent"), plain = st.list?.find((a) => a.key === "plain");
      return [
        ok(lab?.name === "LabAgent" && lab?.level === "basic", `연결 창 ${JSON.stringify(lab)}`),
        ok(plain?.name === "plain", `기본값(이름 = 키) ${JSON.stringify(plain)}`),
        ok((probe.menu?.menuItems || []).some((t) => /LabAgent/.test(t)), `⌘G 목록 ${JSON.stringify(probe.menu?.menuItems)}`),
        ok(/host-agent \S+ labagent kind=activity/.test(log) || /shell-agent \S+ labagent kind=activity/.test(log), `셸에서 친 등록 에이전트가 activity로 안 잡힘 (${log.match(/^(host|shell)-agent .*/m)?.[0]})`),
        ok(probe.typed?.agent === "labagent", `큰 칸 에이전트 ${probe.typed?.agent}`),
      ];
    },
  },
  {
    id: "guessed-done", tags: ["agents", "poke"], what: "이벤트 없는 에이전트: 오래 출력하다 조용해지면 완료 추정 — EXP는 두 번에 한 번, 야생 없음 (AGT-13, STA-06)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], timeoutMs: 110000, env: { CVIM_WILD_CHANCE: "1" },
    files: { "agents-user.json": JSON.stringify({ labagent: { name: "LabAgent", cmd: ["labagent"], state: "activity" } }),
      "fakebin/labagent": "#!/bin/sh\nfor round in 1 2; do i=0; while [ $i -lt 46 ]; do echo \"working $round.$i\"; i=$((i+1)); sleep 0.5; done; sleep 8; done\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "labagent" }, { wait: 200 }, { key: "Enter" }, { wait: 12000 }, { probe: "working" }, { wait: 50000 }, { probe: "end" }],
    check: ({ probe, log }) => {
      const lines = log.split("\n");
      const g1 = lines.findIndex((l) => /^guessed done ws=\S+ n=1$/.test(l)), g2 = lines.findIndex((l) => /^guessed done ws=\S+ n=2$/.test(l));
      const exps = lines.map((l, i) => (/^exp ws=/.test(l) ? i : -1)).filter((i) => i >= 0);
      return [
        ok(probe.working?.astate === "thinking", `출력 중 상태 ${probe.working?.astate} (생각 중이어야)`),
        ok(g1 >= 0 && g2 > g1, `추정 완료 기록 n=1 ${g1}, n=2 ${g2}`),
        ok(exps.length === 1 && exps[0] > g2, `EXP ${exps.length}번 (두 번째 추정 완료 뒤 한 번이어야)`),
        ok(!/^wild appeared/m.test(log), "추정 완료에 야생이 나옴"),
      ];
    },
  },
  {
    id: "restore-resume-codex", tags: ["smoke", "restore", "agents"], what: "복원: Codex는 resume --last로 잇고, 5초 안에 끝나면(이을 대화 없음) 새로 시작·알림 (AGT-15)",
    data: "owner", mode: "direct", folders: [], make: ["a"], session: { tabs: ["a"], active: "a", shell: [] }, pathFirst: ["fakebin"],
    setup: (box) => fs.writeFileSync(path.join(box.data, "agents.json"), JSON.stringify({ [box.folder("a")]: "codex" })),
    files: { "fakebin/codex": "#!/bin/sh\n[ \"$1\" = \"--version\" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }\necho \"fake-codex args: [$*]\"\n[ \"$1\" = resume ] && exit 0\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "toast", match: "이어 할 대화", timeout: 8000 }, { probe: "after" }, { wait: 1500 }, { grep: "fake-codex args" }],
    check: ({ probe, log }) => [
      ok(/agent-start \S+ codex resume=true/.test(log), "복원한 탭에 Codex가 이어서 모드로 안 뜸"),
      ok(/^agent-resume-failed /m.test(log) && /agent-start \S+ codex resume=false/.test(log), "이어 할 대화가 없을 때 새로 시작 안 함"),
      ok(/이어 할 대화가 없어 새로 시작했어요/.test(probe.after?.toast || ""), `알림 ${probe.after?.toast}`),
      ok(/lab-grep fake-codex args rows=\[\d[^\n]*text="fake-codex args: \[\]"/.test(log), `새로 시작한 Codex 인자 ${log.match(/lab-grep fake-codex[^\n]*/)?.[0]}`),
    ],
  },
  {
    id: "about-feedback", tags: ["smoke", "app"], what: "Tamer 정보·피드백 메일 초안: 같은 버전(package.json), 권리 고지·피드백 주소, 메일 본문 틀과 버전·macOS (APP-07, APP-09)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { wait: 500 }, { invoke: "about_test", log: true }],
    check: ({ log }) => {
      const a = JSON.parse(log.match(/^lab-invoke about_test (.*)$/m)?.[1] || "{}");
      const pkg = require("../package.json").version, mail = decodeURIComponent(a.feedback || "");
      return [
        ok(a.pkg === pkg && a.version?.startsWith(pkg) && a.about?.applicationVersion === a.version, `버전 ${a.version} / 정보 창 ${a.about?.applicationVersion} / package.json ${pkg}`),
        ok(a.build?.kind === "release" ? a.version === pkg : /\+[0-9a-f]{7,}$/.test(a.version || "") || !a.build?.commit, `개발 빌드 표시 ${a.version} (${JSON.stringify(a.build)})`),
        ok(/Nintendo \/ Creatures \/ GAME FREAK \/ The Pokémon Company/.test(a.about?.credits || "") && /yeomjae5766@gmail\.com/.test(a.about?.credits || ""), "정보 창에 권리 고지·피드백 주소 없음"),
        ok(/^mailto:yeomjae5766@gmail\.com\?/.test(a.feedback || "") && mail.includes(`subject=Tamer ${a.version} 피드백`), `메일 주소·제목 ${mail.slice(0, 80)}`),
        ok(/무엇을 했고:/.test(mail) && /진단 정보 복사/.test(mail) && new RegExp(`Tamer ${a.version?.replace(/[+.]/g, "\\$&")} · macOS \\d`).test(mail), "메일 본문 틀·버전·macOS 없음"),
        ok((a.menu || []).includes("피드백 보내기…") && (a.menu || []).includes("오픈소스 고지"), `메뉴 ${JSON.stringify(a.menu)}`),
      ];
    },
  },
  {
    id: "partner-click-menu", tags: ["smoke", "poke"], what: "파트너 클릭 → 공격/애교 이모지, 우클릭 → 메뉴(바꾸기·공격·애교·도감·야생), 숫자로 고름, EXP 줄 (PKM-03)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => evolvePartner(box),
    steps: [{ until: "partner", timeout: 10000 }, { wait: 800 }, { probe: "start" },
      { click: "main.grid:not([hidden]) .poke" }, { wait: 150 }, { probe: "clicked" }, { wait: 1200 },
      { click: "main.grid:not([hidden]) .pane-avatar", button: "right" }, { wait: 300 }, { probe: "menu" },
      { key: "3" }, { wait: 150 }, { probe: "cute" }, { wait: 1200 },
      { click: "main.grid:not([hidden]) .pane-avatar", button: "right" }, { wait: 300 }, { key: "2" }, { wait: 150 }, { probe: "attack" }],
    check: ({ probe }) => [
      ok(probe.start?.pokeExp === "Lv 15 · 진화 Lv 16", `레벨 줄 ${probe.start?.pokeExp}`),
      ok((probe.clicked?.fx || []).length >= 5 && ["💕", "🔥"].includes(probe.clicked?.fx?.[0]), `클릭 반응 ${JSON.stringify(probe.clicked?.fx)} (애교 💕 또는 불꽃 타입 공격 🔥)`),
      ok(["1🔄메인 파트너 바꾸기", "2⚔️공격", "3💕애교", "4📕도감", "5🌿야생 포켓몬"].every((w, i) => (probe.menu?.menuItems?.[i] || "").startsWith(w)) && probe.menu.menuItems.length === 5, `메뉴 ${JSON.stringify(probe.menu?.menuItems)}`),
      ok(probe.cute?.fx?.length === 5 && probe.cute.fx.every((g) => g === "💕") && probe.cute?.menu === false, `3(애교) ${JSON.stringify(probe.cute?.fx)} 메뉴 닫힘 ${probe.cute?.menu === false}`),
      ok(probe.attack?.fx?.length === 8 && probe.attack.fx.every((g) => g === "🔥"), `2(공격) ${JSON.stringify(probe.attack?.fx)} (파이리 = 불꽃 🔥 8개)`),
    ],
  },
  {
    id: "drop-folders", tags: ["smoke", "tabs"], what: "Finder 폴더를 시작 화면·탭 줄에 끌어 놓으면 새 탭(여러 개는 차례로), 파일은 '폴더만' 알림, 터미널 칸에 놓으면 경로 입력 (TAB-07)",
    data: "owner", mode: "direct", folders: [], make: ["a", "b", "c"], files: { "note.txt": "x" },
    steps: (box) => [{ until: "start" }, { wait: 400 },
      { drop: "#start", files: [box.folder("a")] }, { until: "partnerKnown", timeout: 8000 }, { wait: 600 }, { probe: "start" },
      { drop: "#tabs", files: [box.folder("b"), box.folder("c")] }, { wait: 2500 }, { call: "closeDex" }, { wait: 400 }, { probe: "bar" },
      { drop: "#tabs", files: [path.join(box.dir, "note.txt")] }, { wait: 200 }, { probe: "file" },
      { call: "focusShell" }, { drop: "main.grid:not([hidden]) .pane-agent .term", files: [path.join(box.dir, "note.txt")] }, { wait: 600 }, { grep: "note.txt" }, { probe: "pane" }],
    check: ({ probe, log }) => [
      ok(JSON.stringify(probe.start?.tabs) === '["a"]' && probe.start?.start === false, `시작 화면에 놓은 뒤 ${JSON.stringify(probe.start?.tabs)}`),
      ok(JSON.stringify(probe.bar?.tabs) === '["a","b","c"]', `탭 줄에 둘 놓은 뒤 ${JSON.stringify(probe.bar?.tabs)}`),
      ok(/폴더만 새 탭으로 열 수 있어요/.test(probe.file?.toast || "") && probe.file?.tabs?.length === 3, `파일을 놓았을 때 ${probe.file?.toast} 탭 ${probe.file?.tabs?.length}`),
      ok(/lab-grep note\.txt rows=\[\d/.test(log) && probe.pane?.tabs?.length === 3, "터미널 칸에 놓은 경로가 입력되지 않음(또는 탭이 생김)"),
    ],
  },
  {
    id: "unattended-stall", tags: ["smoke", "status"], what: "무인 실행: 새 이벤트 없이 기준 시간이 지나면 '⏳ 변화 없음'(탭·상단 바·오버레이), 새 이벤트면 사라짐, 실행(Bash) 중엔 안 뜸 (STA-20)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], timeoutMs: 90000, env: { CVIM_STALL_SECS: "8" },
    files: { "fakebin/codex": `#!/bin/sh
[ "$1" = "--version" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }
d="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"; mkdir -p "$d"; f="$d/rollout-lab.jsonl"
w() { printf '%s\\n' "$1" >> "$f"; }
sleep 2
printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n' "$(pwd -P)" > "$f"
w '{"type":"event_msg","payload":{"type":"task_started"}}'
w '{"type":"response_item","payload":{"type":"function_call","call_id":"a","name":"exec_command","arguments":"{\\"cmd\\":\\"rg needle\\"}"}}'
sleep 20
w '{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"b","name":"apply_patch","input":"*** Begin Patch\\n*** Update File: src/a.ts\\n"}}'
sleep 1
w '{"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"exec_command","arguments":"{\\"cmd\\":\\"npm test\\"}"}}'
sleep 16
w '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"ok"}}'
sleep 30
` },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { wait: 6000 }, { probe: "early" },
      { wait: 11000 }, { probe: "stall" }, { invoke: "overlay_payload_test", log: true },
      { wait: 17000 }, { probe: "bash" }, { wait: 9000 }, { probe: "done" }],
    check: ({ probe, log }) => {
      const ov = JSON.parse(log.match(/^lab-invoke overlay_payload_test (.*)$/m)?.[1] || "{}");
      return [
        ok(probe.early?.astate === "reading" && !/변화 없음/.test(probe.early?.doing || ""), `처음 ${probe.early?.astate} "${probe.early?.doing}"`),
        ok(probe.early?.tabWorking === true && probe.stall?.tabWorking === false && probe.bash?.tabWorking === true && probe.done?.tabWorking === false, `탭 테두리 효과 일하는 중 ${probe.early?.tabWorking} · 멈춤 의심 ${probe.stall?.tabWorking} · 실행 ${probe.bash?.tabWorking} · 끝 ${probe.done?.tabWorking} (#61)`),
        ok(/⏳ 변화 없음 0분 · 마지막 읽기 rg needle/.test(probe.stall?.doing || "") || /⏳ 변화 없음/.test(probe.stall?.doing || ""), `멈춤 의심 상단 바 "${probe.stall?.doing}"`),
        ok(/새 이벤트 없음/.test(probe.stall?.tabTitle || ""), `탭 말풍선 "${probe.stall?.tabTitle}"`),
        ok(ov.current?.times?.watch === true && ov.current?.times?.event_at > 0 && ov.stallMs === 8000, `오버레이 시각 ${JSON.stringify(ov.current?.times)} stallMs ${ov.stallMs}`),
        ok(probe.bash?.astate === "bash" && !/변화 없음/.test(probe.bash?.doing || ""), `실행 중 ${probe.bash?.astate} "${probe.bash?.doing}" (멈춤 표시가 없어야)`),
        ok(probe.done?.astate === "done" || probe.done?.astate === "idle", `끝 ${probe.done?.astate}`),
      ];
    },
  },
  {
    id: "changes-branch", tags: ["smoke", "terminal"], what: "변경 사항 칸 제목에 브랜치: ⎇ 이름 ↑올릴 ↓받을(원격 기준), 첫 커밋 전, 브랜치 아닌 커밋, git 아님 (TRM-18)",
    data: "owner", mode: "direct", folders: ["proj", "fresh", "loose", "plain"],
    setup: (box) => {
      const w = (f, t) => (d) => fs.writeFileSync(path.join(d, f), t);
      gitRepo(box.folder("proj"), [["init", "-q"], w("a.txt", "1\n"), ["add", "."], ["commit", "-qm", "one"],
        ["checkout", "-qb", "feat/lab", "--track", "main"], w("a.txt", "2\n"), ["commit", "-qam", "two"], w("b.txt", "new\n")]);
      gitRepo(box.folder("fresh"), [["init", "-q"], w("x.txt", "x\n")]);
      gitRepo(box.folder("loose"), [["init", "-q"], w("a.txt", "1\n"), ["add", "."], ["commit", "-qm", "one"], ["checkout", "-q", "--detach"]]);
    },
    steps: [{ until: "tabs.3" }, { wait: 1500 }, { call: "closeDex" },
      ...[1, 2, 3, 4].flatMap((n) => [{ key: String(n), mods: 4 }, { wait: 1500 }, { call: "closeDex" }, { probe: `t${n}` }])],
    check: ({ probe }) => [
      ok(probe.t1?.branch?.text === "⎇ feat/lab↑1" && /feat\/lab → main · 올릴 커밋 1 · 받을 커밋 0/.test(probe.t1?.branch?.title || ""), `브랜치 ${JSON.stringify(probe.t1?.branch)}`),
      ok(probe.t2?.branch?.text === "⎇ main (첫 커밋 전)", `첫 커밋 전 ${JSON.stringify(probe.t2?.branch)}`),
      ok(/^⎇ [0-9a-f]{7,}$/.test(probe.t3?.branch?.text || "") && /브랜치가 아닌 커밋/.test(probe.t3?.branch?.title || ""), `detached ${JSON.stringify(probe.t3?.branch)}`),
      ok(probe.t4?.branch?.text === "", `git 아닌 폴더 ${JSON.stringify(probe.t4?.branch)}`),
    ],
  },
  {
    id: "codex-failed-turn", tags: ["smoke", "agents", "poke"], what: "Codex 실패한 턴(task_complete.error): 💥 실패 · 종류 한글, EXP·야생 없음, 응답 본문은 안 보임 (#53)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], timeoutMs: 70000, env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => evolvePartner(box),
    files: { "fakebin/codex": `#!/bin/sh
[ "$1" = "--version" ] && { echo 'codex-cli 9.9.9-lab'; exit 0; }
d="$CODEX_HOME/sessions/$(date +%Y/%m/%d)"; mkdir -p "$d"; f="$d/rollout-lab.jsonl"
w() { printf '%s\\n' "$1" >> "$f"; }
sleep 2
printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n' "$(pwd -P)" > "$f"
w '{"type":"event_msg","payload":{"type":"task_started"}}'
w '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"SECRET-REPLY-TEXT"}}'
sleep 9
w '{"type":"event_msg","payload":{"type":"task_started"}}'
w '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,"error":{"message":"stream error url: https://api.example/v1 req_LABSECRET","codex_error_info":"server_overloaded"}}}'
sleep 40
` },
    steps: [{ until: "partner", timeout: 10000 }, { wait: 800 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { wait: 6000 }, { probe: "ok" },
      { until: "astate", match: "error", timeout: 15000 }, { probe: "failed" }, { invoke: "overlay_payload_test", log: true }, { wait: 2500 }, { probe: "after" }],
    check: ({ probe, log }) => {
      const ov = JSON.parse(log.match(/^lab-invoke overlay_payload_test (.*)$/m)?.[1] || "{}");
      const exps = log.split("\n").filter((l) => /^exp ws=/.test(l));
      const act = (probe.failed?.activity || []).map((x) => x.trim());
      return [
        ok(/💥 실패 · 서버 과부하/.test(probe.failed?.doing || ""), `상단 바 "${probe.failed?.doing}"`),
        ok(/^💥 StopFailure 서버 과부하/.test(act[0] || ""), `활동 기록 첫 줄 "${act[0]}"`),
        ok(!JSON.stringify(probe.failed || {}).includes("SECRET-REPLY-TEXT") && !JSON.stringify(probe.failed || {}).includes("LABSECRET"), "응답 본문이나 오류 문장이 화면에 나옴"),
        ok(ov.current?.ended === "error" && ov.current?.endedKind === "server_overloaded", `오버레이 ${ov.current?.ended} ${ov.current?.endedKind}`),
        ok(exps.length === 1, `EXP ${exps.length}번 (성공 1번만이어야)`),
        ok(!/^wild appeared/m.test(log.split("\n").slice(log.split("\n").findIndex((l) => /-> error/.test(l))).join("\n")), "실패 뒤에 야생이 나옴"),
      ];
    },
  },
  {
    id: "quit-waits-terminals", tags: ["smoke", "app"], what: "끌 때 모든 터미널이 끝난 것(종료 알림)을 확인한 뒤 종료 — 늦게 끝나는 셸도 (#54)",
    data: "owner", mode: "direct", folders: ["proj"], until: "quit: terminals ended",
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 3500 }, { call: "focusShell" },
      { text: "trap 'sleep 0.4; exit 0' HUP" }, { wait: 200 }, { key: "Enter" }, { wait: 500 }, { invoke: "quit_test" }, { wait: 5000 }],
    check: ({ log }) => {
      const m = log.match(/^quit: terminals ended in (\d+)ms(.*)$/m);
      const lines = log.split("\n"), hid = lines.findIndex((l) => /^quit: windows hidden/.test(l)), ended = lines.findIndex((l) => /^quit: terminals ended/.test(l));
      return [
        ok(hid >= 0 && hid < ended, "창을 먼저 숨기지 않음 (#54 보완)"),
        ok(m, "끄기 전에 터미널을 기다린 기록이 없음"),
        ok(m && Number(m[1]) >= 300 && !m[2], `기다린 시간 ${m?.[1]}ms${m?.[2] || ""} (늦게 끝나는 셸 0.4초를 기다려야, 남은 것 없이)`),
      ];
    },
  },
  {
    id: "changes-git-live", tags: ["smoke", "terminal"], what: "셸에서 git 브랜치를 바꾸면 변경 사항 칸 제목이 바로(10초 틱 없이) 바뀜 (#52)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => gitRepo(box.folder("proj"), [["init", "-q"], (d) => fs.writeFileSync(path.join(d, "a.txt"), "1\n"), ["add", "."], ["commit", "-qm", "one"]]),
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2000 }, { probe: "before" }, { call: "focusShell" },
      { text: "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git checkout -qb live-branch" }, { wait: 200 }, { key: "Enter" },
      { until: "branch.text", match: "live-branch", timeout: 5000 }, { probe: "after" }],
    check: ({ probe }) => [
      ok(probe.before?.branch?.text === "⎇ main", `처음 ${JSON.stringify(probe.before?.branch)}`),
      ok(probe.after?.branch?.text === "⎇ live-branch", `바꾼 뒤 ${JSON.stringify(probe.after?.branch)}`),
      ok(probe.after && probe.after._ms - probe.before._ms < 4500, `바뀌기까지 ${probe.after && probe.after._ms - probe.before._ms}ms (10초 틱 아님 — 시험 창은 포커스가 없어 틱이 돌지 않음)`),
    ],
  },
  {
    id: "open-file-kinds", tags: ["smoke", "terminal"], what: "⌘-클릭한 파일: index.html·그림은 기본 앱(브라우저 등), 코드는 편집기 그 줄로 (#57, TRM-08)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => { const d = box.folder("proj"); fs.mkdirSync(path.join(d, "src"), { recursive: true }); fs.writeFileSync(path.join(d, "index.html"), "<p>x</p>\n"); fs.writeFileSync(path.join(d, "src", "a.ts"), "1\n2\n3\n"); fs.writeFileSync(path.join(d, "shot.png"), ""); },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "clear; printf 'see index.html and src/a.ts:3 and shot.png\\n'" }, { wait: 200 }, { key: "Enter" }, { wait: 1200 },
      { clickText: "index.html", mods: 4 }, { clickText: "src/a.ts:3", mods: 4 }, { clickText: "shot.png", mods: 4 }, { invoke: "links_opened_test", log: true }],
    check: ({ log, box }) => {
      const got = JSON.parse(log.match(/^lab-invoke links_opened_test (.*)$/m)?.[1] || "[]");
      const d = fs.realpathSync(box.folder("proj"));
      return [
        ok(got.length === 3, `열린 것 ${got.length}개 ${JSON.stringify(got)}`),
        ok(got[0]?.startsWith("default:") && got[0].includes("index.html"), `index.html → ${got[0]} (기본 앱이어야)`),
        ok(!/^default:|^finder:/.test(got[1] || "") && /src\/a\.ts:3:1$/.test(got[1] || ""), `a.ts:3 → ${got[1]} (편집기 그 줄이어야)`),
        ok(got[2]?.startsWith("default:") && got[2].includes("shot.png"), `shot.png → ${got[2]}`),
        ok(got.every((g) => g.includes(d) || g.includes(box.folder("proj"))), "다른 곳의 파일을 엶"),
      ];
    },
  },
  {
    id: "side-resize", tags: ["smoke", "tabs"], what: "오른쪽 칸 경계를 끌면 너비가 바뀌고(20~60%, 최소 폭), 두 번 누르면 40%로, 다른 탭도 같은 너비 (#58)",
    data: "owner", mode: "direct", folders: ["a", "b"],
    steps: [{ until: "tabs.1" }, { wait: 1500 }, { call: "closeDex" }, { wait: 300 }, { probe: "start" },
      { dragSplit: 0.5 }, { wait: 300 }, { probe: "half" },
      { dragSplit: 0.05 }, { wait: 300 }, { probe: "wide" },
      { key: "1", mods: 4 }, { wait: 400 }, { probe: "other" }, { call: "closeDex" }, { wait: 300 },
      { click: "main.grid:not([hidden]) .side-split", count: 2 }, { wait: 300 }, { probe: "reset" }],
    check: ({ probe }) => [
      ok(probe.start?.side === null || probe.start?.side === 40, `처음 ${probe.start?.side}`),
      ok(Math.abs((probe.half?.side || 0) - 50) <= 1.5, `절반 위치로 끈 뒤 ${probe.half?.side}% (50 근처여야)`),
      ok(probe.wide?.side === 60, `왼쪽 끝까지 끈 뒤 ${probe.wide?.side}% (최대 60이어야)`),
      ok(probe.other?.sideW === probe.wide?.sideW, `다른 탭 너비 ${probe.other?.sideW}px vs ${probe.wide?.sideW}px (같아야)`),
      ok(probe.reset?.side === 40, `두 번 누른 뒤 ${probe.reset?.side}%`),
    ],
  },
  {
    id: "settings-overlay", tags: ["smoke", "app"], what: "설정 창(따로 창, #113 P1 — 제목 줄로 옮김, 터미널 창 덮개 아님): 처음엔 일반, 왼쪽 사이드바로 오버레이·일반 범주 바꾸기(#101) · 오버레이 켜기·보일 것·빠른 선택, 탭 효과, 세그먼트 단추(테마) — 바로 적용되고 settings.json에 남음, Esc 닫기 · 닫았다 열면 지난 범주 (APP-19, APP-22 규칙 7·9, #59)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 800 },
      { invoke: "overlay_show_test", args: { on: true } }, { wait: 600 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_open_test", args: { name: "settings" } }, { wait: 1500 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: ".set-nav [data-page='overlay']" } }, { wait: 400 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: "[data-set='overlay.alerts']" } }, { wait: 500 }, { invoke: "overlay_payload_test", log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: "[data-preset='off']" } }, { wait: 500 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: "[data-preset='wild']" } }, { wait: 500 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: "[data-preset='all']" } }, { wait: 500 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: ".set-nav [data-page='general']" } }, { wait: 400 },
      { invoke: "own_click_test", args: { name: "settings", sel: "[data-set='tabGlow']" } }, { wait: 400 }, { probe: "glow" },
      { invoke: "own_click_test", args: { name: "settings", sel: ".seg[data-set='theme'] [data-v='light']" } }, { wait: 500 }, { invoke: "settings_get", log: true },
      { invoke: "own_click_test", args: { name: "settings", sel: ".seg[data-set='theme'] [data-v='system']" } }, { wait: 300 },
      { invoke: "own_click_test", args: { name: "settings", sel: ".set-nav [data-page='overlay']" } }, { wait: 300 },
      { invoke: "own_key_test", args: { name: "settings", key: "Escape" } }, { wait: 500 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { invoke: "own_open_test", args: { name: "settings" } }, { wait: 1500 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { invoke: "own_key_test", args: { name: "settings", key: "w", meta: true } }, { wait: 500 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { probe: "closed" }, { invoke: "overlay_show_test", args: { on: false } }],
    check: ({ probe, log, box }) => {
      const vis = [...log.matchAll(/^lab-invoke overlay_visible_test (\w+)$/gm)].map((m) => m[1]);
      const pay = JSON.parse(log.match(/^lab-invoke overlay_payload_test (.*)$/m)?.[1] || "{}");
      const [open, ov, esc, again, cmdW] = [...log.matchAll(/^lab-invoke own_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const theme = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}").theme;
      let saved = null; try { saved = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      return [
        ok(open?.open && open.movable && open.title === "설정" && open.win === true && probe.glow?.top === "main", `설정 창은 따로 창(제목 줄로 옮김), 메인 창 위 덮개 아님 ${JSON.stringify(open && { open: open.open, movable: open.movable, title: open.title, top: probe.glow?.top })}`),
        ok(open?.page === "general" && ov?.page === "overlay" && /미리보기/.test(ov?.text || ""), `범주: 처음 ${open?.page} → ${ov?.page} (#101), 오버레이 범주에 미리보기`),
        ok(pay.show?.alerts === false && pay.show?.partner === true, `알림 끈 뒤 오버레이 ${JSON.stringify(pay.show)}`),
        ok(JSON.stringify(vis) === '["true","false","false","true"]', `오버레이 보임 처음·끄기·야생만(야생 없음)·전부 ${JSON.stringify(vis)} (true,false,false,true여야)`),
        ok(probe.glow?.noTabGlow === true, "탭 효과를 끄면 메인 창에 바로 반영"),
        ok(theme === "light" && saved?.theme === "system", `테마 세그먼트 단추: 라이트 → 시스템 ${theme} → ${saved?.theme}`),
        ok(esc?.open === false && again?.open && again.page === "overlay" && cmdW?.open === false && /^settings closed$/m.test(log), `Esc로 닫힘, 다시 열면 지난 범주(오버레이), ⌘W로 닫힘 ${JSON.stringify([esc?.open, again?.page, cmdW?.open])}`),
        ok(saved?.overlay?.on === true && saved?.overlay?.partner === true && saved?.tabGlow === false, `settings.json ${JSON.stringify(saved)}`),
      ];
    },
  },
  {
    id: "side-fold", tags: ["smoke", "app"], what: "오른쪽 칸 접기: ⌘\\ → 칸이 사라지고 큰 칸이 창 전체, settings.json side=false, 접힌 동안 Tamer가 앞이어도 오버레이 · ⌘⌥3이면 펴고 셸로 · 버튼으로 다시 접고 펴기 · 보일 때 '늘'이면 펴져 있어도 오버레이 (TAB-19 #97, STA-15 #98)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { call: "closeDex" }, { wait: 300 }, { probe: "open" },
      { invoke: "overlay_want_test", args: { focused: true }, log: true },
      { key: "\\", code: "Backslash", mods: 4 }, { wait: 600 }, { probe: "folded" },
      { invoke: "overlay_want_test", args: { focused: true }, log: true }, { invoke: "settings_get", log: true },
      { key: "3", mods: 5 }, { wait: 600 }, { probe: "shell" },
      { click: "#side-toggle" }, { wait: 600 }, { probe: "btnFold" }, { click: "#side-toggle" }, { wait: 600 }, { probe: "btnOpen" },
      { invoke: "settings_set", args: { patch: { overlay: { when: "always" } } } }, { wait: 300 },
      { invoke: "overlay_want_test", args: { focused: true }, log: true }, { invoke: "settings_set", args: { patch: { overlay: { when: "bogus" } } } }, { invoke: "settings_get", log: true }],
    check: ({ probe, log, box }) => {
      const want = [...log.matchAll(/^lab-invoke overlay_want_test (.*)$/gm)].map((m) => m[1]);
      const gets = [...log.matchAll(/^lab-invoke settings_get (.*)$/gm)].map((m) => JSON.parse(m[1]));
      let saved = null; try { saved = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      const full = (p) => p?.width && p.paneW >= p.width - 80;
      return [
        ok(probe.open?.sideW > 200 && probe.open?.sideBtn === "▸" && want[0] === "false", `처음: 오른쪽 칸 ${probe.open?.sideW}px · 버튼 ${probe.open?.sideBtn} · 앞일 때 오버레이 ${want[0]}`),
        ok(probe.folded?.sideW === 0 && probe.folded?.sideBtn === "◂" && full(probe.folded), `⌘\\ 접힘: 오른쪽 ${probe.folded?.sideW}px · 큰 칸 ${probe.folded?.paneW}/${probe.folded?.width} · 버튼 ${probe.folded?.sideBtn}`),
        ok(want[1] === "true" && gets[0]?.side === false, `접힌 동안 Tamer가 앞이어도 오버레이 ${want[1]} · side=${gets[0]?.side}`),
        ok(probe.shell?.sideW > 200 && probe.shell?.focusPane === "shell", `⌘⌥3: 펴고 셸로 — 오른쪽 ${probe.shell?.sideW}px · 포커스 ${probe.shell?.focusPane}`),
        ok(probe.btnFold?.sideW === 0 && probe.btnOpen?.sideW > 200, `버튼: 접기 ${probe.btnFold?.sideW}px → 펴기 ${probe.btnOpen?.sideW}px`),
        ok(want[2] === "true", `보일 때 '늘'이면 펴져 있어도 오버레이 ${want[2]} (#98)`),
        ok(gets[1]?.overlay?.when === "away" && saved?.side === true, `모르는 값은 기본(away) ${gets[1]?.overlay?.when} · 저장 side=${saved?.side}`),
      ];
    },
  },
  {
    id: "side-fold-launch", tags: ["smoke", "app"], what: "오른쪽 칸을 접어 둔 채 켜면: 처음부터 접혀 있고(◂), 첫 탭이 열리자마자 Tamer가 앞이어도 오버레이가 뜸 — 포커스가 바뀔 때까지 기다리지 않음 (TAB-19 규칙 2, #97 0.8.0-beta.1에서 발견)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => { fs.mkdirSync(path.join(box.data, "ui"), { recursive: true }); fs.writeFileSync(path.join(box.data, "ui", "settings.json"), JSON.stringify({ side: false })); },
    steps: [{ until: "tabs.0" }, { wait: 1500 }, { probe: "start" }],
    check: ({ probe, log }) => {
      const ws = log.search(/^workspace id=/m), front = [...log.matchAll(/^overlay front=(\w+)$/gm)];
      // the value in force once the tab is open: the last line before the probe (with a party the overlay already shows
      // before any tab — the party card, #107 · #122 — so the line may come before the workspace and not change after)
      const probeAt = log.search(/^lab-probe start /m), now = front.filter((m) => m.index < probeAt).at(-1)?.[1];
      return [
        ok(probe.start?.sideW === 0 && probe.start?.sideBtn === "◂", `처음부터 접힘 — 오른쪽 ${probe.start?.sideW}px · 버튼 ${probe.start?.sideBtn}`),
        ok(ws >= 0 && now === "true", `첫 탭이 열린 뒤 Tamer가 앞이어도 오버레이가 떠야 — ${JSON.stringify(front.map((m) => m[1]))}`),
      ];
    },
  },
  {
    id: "overlay-size", tags: ["smoke", "app", "poke"], what: "포켓몬 크기(#127, STA-15 규칙 20): 48·120·384px — 메인 파트너 그림 상자가 따라가고 카드·창이 넓어짐, 이름 글자·몬스터볼은 그대로, 최소 모드도 같은 크기, 범위 밖·숫자 아닌 값은 끝값·기본",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"],
    steps: [{ until: "tabs.1" }, { wait: 1200 }, { call: "closeDex" }, { wait: 300 }, { invoke: "settings_get", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 82, minimal: "never" } } } }, { invoke: "overlay_show_test", args: { on: true } }, { wait: 1000 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { size: 48 } } } }, { wait: 800 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { size: 384 } } } }, { wait: 800 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "always" } } } }, { wait: 800 }, { invoke: "overlay_dom_test", log: true },
      // the 설정 창: the slider's value, and the 미리보기 drawn smaller when the big partner doesn't fit (APP-19 rule 14)
      { invoke: "own_open_test", args: { name: "settings" } }, { wait: 1500 }, { invoke: "own_click_test", args: { name: "settings", sel: ".set-nav [data-page='overlay']" } }, { wait: 1200 },
      { invoke: "own_read_test", args: { name: "settings" }, log: true },
      { invoke: "settings_set", args: { patch: { overlay: { size: 120 } } } }, { wait: 1200 }, { invoke: "own_read_test", args: { name: "settings" }, log: true },
      // dragging the slider: the desktop overlay follows before it's saved, shown with the 설정 창 in front, 2 s after the last move it hides again
      { invoke: "overlay_show_test", args: { on: false } }, { wait: 600 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_range_test", args: { name: "settings", sel: "[data-set='overlay.size']", values: [160, 200, 240] } }, { wait: 500 },
      { invoke: "overlay_visible_test", log: true }, { invoke: "overlay_dom_test", log: true }, { invoke: "settings_get", log: true },
      { invoke: "own_range_test", args: { name: "settings", sel: "[data-set='overlay.size']", values: [240], commit: true } }, { wait: 600 }, { invoke: "settings_get", log: true },
      { wait: 2600 }, { invoke: "overlay_visible_test", log: true },
      { invoke: "own_key_test", args: { name: "settings", key: "Escape" } },
      { invoke: "settings_set", args: { patch: { overlay: { size: 999 } } } }, { invoke: "settings_get", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { size: 101 } } } }, { invoke: "settings_get", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { size: "big" } } } }, { invoke: "settings_get", log: true },
      { invoke: "overlay_show_test", args: { on: false } }],
    check: ({ log }) => {
      const dom = [...log.matchAll(/^lab-invoke overlay_dom_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const gets = [...log.matchAll(/^lab-invoke settings_get (.*)$/gm)].map((m) => JSON.parse(m[1])?.overlay?.size);
      const [mid, small, big, bigMin, drag] = dom, side = (d) => Math.max(...(d?.poke || [0]));
      const fits = (d) => d && d.win[0] >= d.stackW && d.win[0] <= 640;
      return [
        ok(dom.length === 5 && dom.every((d) => d.poke), `그림이 5번 다 보여야 ${JSON.stringify(dom.map((d) => d.poke))}`),
        ok(gets[0] === 120, `기본 120이어야 — ${gets[0]}`),
        ok(side(mid) > 0 && side(mid) <= 120 && side(small) <= 48 && side(small) < side(mid), `48이면 그림이 48 안, 120보다 작아야 — ${side(small)} · ${side(mid)}`),
        ok(side(big) <= 384 && side(big) >= 3 * side(mid), `384면 120의 3배 넘게(크기/60배까지) — ${side(big)} · ${side(mid)}`),
        ok(big?.cardW > mid?.cardW && fits(mid) && fits(big) && fits(small), `카드·창이 따라 넓어지고 창 안에 들어가야(640 한도) — 카드 ${mid?.cardW}→${big?.cardW} · 창 ${dom.map((d) => d?.win.join("x"))}`),
        ok(mid?.nameFont && mid.nameFont === big?.nameFont && mid.ballW === big?.ballW && mid.ballW === small?.ballW, `이름 글자·몬스터볼은 그대로 — ${mid?.nameFont}/${big?.nameFont} · 공 ${mid?.ballW}/${small?.ballW}/${big?.ballW}`),
        ok(bigMin?.minimal && side(bigMin) === side(big), `최소 모드도 같은 크기 — ${side(bigMin)} · ${side(big)}`),
        ok(JSON.stringify(gets.slice(3)) === JSON.stringify([384, 104, 120]), `999 → 384, 101 → 104(8 단위), 숫자 아님 → 120 — ${JSON.stringify(gets.slice(3))}`),
        (() => { const vis = [...log.matchAll(/^lab-invoke overlay_visible_test (.*)$/gm)].map((m) => m[1]);
          return ok(JSON.stringify(vis) === JSON.stringify(["false", "true", "false"]) && side(drag) <= 240 && side(drag) > side(mid) && gets[1] === 120 && gets[2] === 240,
            `끄는 동안: 숨었던 오버레이가 보이고 240 크기로, 저장은 손 뗄 때, 2초 뒤 다시 숨음 — 보임 ${vis} · 그림 ${side(drag)} · 저장 ${gets[1]}→${gets[2]}`); })(),
        (() => { const [b, m] = [...log.matchAll(/^lab-invoke own_read_test (.*)$/gm)].map((x) => JSON.parse(x[1])?.text || "");
          return ok(/포켓몬 크기/.test(b) && /384px/.test(b) && /줄여서/.test(b) && /120px/.test(m) && !/줄여서/.test(m), `설정 창: 384px면 "미리보기 · 줄여서", 120px면 그대로 — ${JSON.stringify([b.match(/미리보기[^\n]*/)?.[0], m.match(/미리보기[^\n]*/)?.[0]])}`); })(),
      ];
    },
  },
  {
    id: "overlay-minimal", tags: ["smoke", "app", "poke"], what: "오버레이 최소 모드(배경 30% 이하·항상·안 씀): 기본 배경 0%라 처음부터 최소 모드(#100), 글자 없이 파트너+몬스터볼, 그림자는 투명도를 따르고 끌 수 있음, 야생은 작은 알림 → 누르면 알림 옆 잡기 창(#119, 끌어서 옮김), 마우스 한 줄이 생겨도 파트너가 안 밀림 (#63 #65 #66 #68)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ enabled: true, next: { id: 16, shiny: false } })),
    steps: [{ until: "tabs.1" }, { wait: 1200 }, { call: "closeDex" }, { wait: 300 },
      { invoke: "settings_get", log: true }, { invoke: "overlay_show_test", args: { on: true } }, { wait: 800 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 82 } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 20 } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "never" } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 82, shadow: false } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "always" } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true },
      { invoke: "overlay_tip_test", log: true },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } }, { wait: 1500 },
      { invoke: "overlay_dom_test", log: true },
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 0 } } } }, { wait: 600 }, { invoke: "overlay_dom_test", log: true }, // #92
      { invoke: "settings_set", args: { patch: { overlay: { alpha: 82 } } } },
      { invoke: "wild_open_test" }, { wait: 1500 }, { invoke: "catch_read_test", log: true }, { invoke: "catch_move_test", args: { dx: -60, dy: -40 }, log: true }, { invoke: "catch_test", args: { open: false } },
      { invoke: "settings_set", args: { patch: { overlay: { minimal: "bogus" } } } }, { invoke: "settings_get", log: true },
      { invoke: "overlay_show_test", args: { on: false } }],
    check: ({ probe, log, box }) => {
      const dom = [...log.matchAll(/^lab-invoke overlay_dom_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const [deflt, first, clear, never, flat, always, wild, zero] = dom;
      const alphaOf = (c) => { const m = /rgba?\(([^)]*)\)/.exec(c || ""); const p = m ? m[1].split(",").map(Number) : []; return p.length === 4 ? p[3] : p.length === 3 ? 1 : null; };
      const gets = [...log.matchAll(/^lab-invoke settings_get (.*)$/gm)].map((m) => JSON.parse(m[1])), got = gets.at(-1) || {};
      let saved = null; try { saved = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      const none = (sh) => !sh || sh === "none" || /rgba\(0, 0, 0, 0\)/.test(sh);
      return [
        ok(dom.length === 8, `오버레이 확인 ${dom.length}번 (8이어야)`),
        // #100: no settings.json yet → card background 0 % → the Pokémon only (minimal mode), no shadow
        ok(gets[0]?.overlay?.alpha === 0 && deflt?.minimal && !deflt.meta && none(deflt.shadow), `기본 배경 0%·최소 모드여야 — ${gets[0]?.overlay?.alpha}% ${JSON.stringify(deflt)}`),
        ok(zero?.note && alphaOf(zero.noteBg) >= 0.74 && alphaOf(zero.bg) === 0, `카드 배경 0%여도 알림 바탕은 75% (#92) — 알림 ${zero?.noteBg} · 카드 ${zero?.bg}`),
        ok(first && !first.minimal && first.meta && first.balls.length === 1 && first.minis === 0 && !none(first.shadow), `처음(82%) 보통 카드여야 — 다른 탭은 몬스터볼(#122) ${JSON.stringify(first)}`),
        ok(clear && clear.minimal && !clear.meta && !clear.counts && clear.balls.length === 1 && clear.minis === 0 && none(clear.shadow), `20%면 최소 모드(글자 없음·몬스터볼 1·그림자 없음)여야 ${JSON.stringify(clear)}`),
        ok(never && !never.minimal && never.meta, `안 씀이면 20%여도 보통 카드여야 ${JSON.stringify(never)}`),
        ok(flat && !flat.minimal && none(flat.shadow), `그림자 끔이면 82%여도 그림자 없어야 ${JSON.stringify(flat)}`),
        ok(always && always.minimal && !always.meta, `항상이면 82%여도 최소 모드여야 ${JSON.stringify(always)}`),
        (() => { const t = JSON.parse(log.match(/^lab-invoke overlay_tip_test (.*)$/m)?.[1] || "null");
          return ok(t?.tip && t.same && JSON.stringify(t.partner[0]) === JSON.stringify(t.partner[1]), `마우스를 올려 한 줄이 떠도 창 크기·위치와 파트너가 그대로여야 (#68) ${JSON.stringify(t)}`); })(),
        ok(/^wild appeared 16 /m.test(log) && wild?.note && /야생의/.test(wild.note) && /등장/.test(wild.note) && none(wild.noteShadow), `야생 알림(글·그림자 없음)이 떠야 ${JSON.stringify(wild?.note)} ${wild?.noteShadow}`),
        (() => { const c = JSON.parse(log.match(/^lab-invoke catch_read_test (.*)$/m)?.[1] || "null");
          return ok(/^wild open from overlay$/m.test(log) && /^catch open$/m.test(log) && c?.open && c.wild && c.beside && c.dex === false && /야생의/.test(c.text || ""), `알림 누르면 알림 옆 잡기 창의 야생 카드여야(#119) ${JSON.stringify(c && { open: c.open, wild: c.wild, beside: c.beside, dex: c.dex, text: c.text?.slice(0, 40) })}`); })(),
        (() => { const m = JSON.parse(log.match(/^lab-invoke catch_move_test (.*)$/m)?.[1] || "null");
          return ok(m?.movable && m.region?.[0] === "drag" && m.region?.[1] === "no-drag" && m.after?.x === m.moved?.x && m.after?.y === m.moved?.y && m.after?.height === m.moved?.height + 20, `잡기 창은 카드를 끌어 옮김(단추는 단추), 옮긴 뒤 높이가 바뀌어도 그 자리 (APP-22 규칙 7) ${JSON.stringify(m)}`); })(),
        ok(got.overlay?.minimal === "auto" && got.overlay?.shadow === false, `모르는 최소 모드 값은 기본값(auto)이어야 ${JSON.stringify(got.overlay)}`),
        ok(saved?.overlay?.minimal === "auto" && saved?.overlay?.shadow === false && saved?.overlay?.alpha === 82, `settings.json ${JSON.stringify(saved?.overlay)}`),
      ];
    },
  },
  {
    id: "menubar-lead", tags: ["smoke", "app", "poke"], what: "메뉴바 아이콘 = 파티 선두(STA-24, #108): 기본은 몬스터볼 + 대시보드 한 번 안내, [데려가기]면 선두 그림 — 늘 재생(쉼 초당 5장 · 작업 중 10장, 일하는 탭 2개면 2배) · 입력 필요 ! · 완료 코인 +n·야생 풀숲 + 남은 초 · CPU 기준 · \"5시간 한도\"는 글자 한 줄 \"58 · 14%\"(낮은 숫자만 색, 막대 없음) · 다시 몬스터볼(글자는 그대로)",
    data: "owner", offline: true, mode: "direct", folders: ["a", "b"], env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_COOLDOWN: "0" },
    setup: (box) => { putEcon(box, { "state.json": { startSeen: true } }); fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ next: { id: 16, shiny: false } })); },
    steps: [{ until: "tabs.1" }, { until: "partnerKnown", timeout: 8000 }, { invoke: "party_test", args: { n: 3 } }, { wait: 300 },
      { invoke: "lead_test", log: true }, // 1 ball + ask
      { invoke: "popover_test", args: { open: true } }, { wait: 1500 }, { invoke: "popover_read_test", log: true }, // the dashboard asks once
      { invoke: "popover_click_test", args: { sel: "#pop-lead-yes" } }, { wait: 600 }, { invoke: "lead_test", log: true }, // 2 rest
      { invoke: "lead_cpu_test", args: { ms: 2000 }, log: true }, // resting: still plays, slower
      { invoke: "popover_read_test", log: true }, { invoke: "popover_test", args: { open: false } },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "coding", hold: true } }, { wait: 300 }, { invoke: "lead_test", log: true }, { wait: 700 }, { invoke: "lead_test", log: true }, // 3·4 working
      { invoke: "lead_cpu_test", args: { ms: 3000 }, log: true },
      { key: "1", mods: 4 }, { wait: 400 }, { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "coding", hold: true } }, { wait: 300 }, { invoke: "lead_test", log: true }, // the other tab working too (the last folder handed in is in front at start)
      { invoke: "agent_state_test", args: { ws: "$ws", from: "coding", to: "waiting", hold: true } }, { wait: 300 }, { invoke: "lead_test", log: true }, { wait: 600 }, { invoke: "lead_test", log: true }, // 5·6 waiting
      { invoke: "agent_state_test", args: { ws: "$ws", from: "waiting", to: "idle" } }, { wait: 300 },
      ...DONE("$ws"), { wait: 800 }, { invoke: "lead_test", log: true }, // 7 wild + coins
      { invoke: "usage_seen", args: { key: "claude", five_hour: { pct: 42, resets_at: 4102444800 }, seven_day: { pct: 86 } } },
      { invoke: "usage_seen", args: { key: "codex", five_hour: { pct: 30 }, seven_day: { pct: 10 } } },
      { invoke: "settings_set", args: { patch: { menubar: { text: "limit" } } } }, { wait: 300 }, { invoke: "lead_test", log: true }, // 8 the gauge
      { invoke: "settings_set", args: { patch: { menubar: { icon: "ball" } } } }, { wait: 300 }, { invoke: "lead_test", log: true }, { invoke: "settings_get", log: true }], // 9 ball (+ gauge)
    check: ({ log }) => {
      const L = [...log.matchAll(/^lab-invoke lead_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const [restCpu, cpu] = [...log.matchAll(/^lab-invoke lead_cpu_test (.*)$/gm)].map((m) => JSON.parse(m[1])), st = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}");
      const [ball, rest, w1, w2, two, wait1, wait2, done, gauge, back] = L;
      const [asked, after] = [...log.matchAll(/^lab-invoke popover_read_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      return [
        ok(ball?.kind === "ball" && ball?.ask?.name, `처음은 몬스터볼 + 대시보드 한 번 안내(선두 이름) ${JSON.stringify(ball)}`),
        ok(/메뉴바에 데려갈까요\?/.test(asked?.text || "") && !/데려갈까요/.test(after?.text || ""), `대시보드 홈 "○○를 메뉴바에 데려갈까요?" → [데려가기] 뒤 사라짐 ${JSON.stringify([asked?.text?.match(/🐾[^\n]*/)?.[0], /데려갈까요/.test(after?.text || "")])}`),
        ok(two?.state === "working" && two.step === 2, `일하는 탭 2개 = 2배 ${JSON.stringify(two)}`),
        ok(rest?.kind === "poke" && rest.state === "rest" && rest.marks === "" && rest.fps === 5 && rest.h === 22 && rest.frames > 10 && rest.ask === null, `파티 선두 — 쉼: 표시 없이 초당 5장, 높이 22pt(44px), 안내는 다시 안 뜸 ${JSON.stringify(rest)}`),
        ok(restCpu && restCpu.ticks >= 7 && restCpu.ticks <= 13 && restCpu.cpu < 5, `쉬어도 재생(2초에 10장쯤)·CPU 5% 밑 ${JSON.stringify(restCpu)}`),
        ok(w1?.state === "working" && w1.step === 1 && w2?.state === "working" && w2.frame !== w1.frame && !w1.marks, `작업 중: 재생(프레임이 바뀜) ${JSON.stringify([w1?.frame, w2?.frame, w1?.marks])}`),
        ok(cpu && cpu.ticks >= 20 && cpu.ticks <= 40 && cpu.made <= (w1?.frames || 0) + 5 && cpu.cpu < 5, `재생 중 틱 초당 10번쯤·그림은 한 번씩만 만듦·메인 프로세스 CPU 5% 밑 ${JSON.stringify(cpu)}`),
        ok(wait1?.state === "waiting" && wait1.marks === "badge" && wait2?.marks === "badge" && wait2.frame !== wait1.frame, `입력 필요: 빨간 ! (그림은 계속 재생) ${JSON.stringify([wait1, wait2?.frame])}`),
        ok(done?.state === "wild" && /grass/.test(done.marks || "") && /🌿\d+/.test(done.title || "") && /\+\d+/.test(done.title || ""), `완료: 코인 +n · 야생이 나와 풀숲 + 남은 초 ${JSON.stringify(done)}`),
        ok((gauge?.title ?? "x").replace(/🌿\d*|\+\d+/g, "").trim() === "58 · \u001b[31m14%\u001b[0m" && gauge?.gauge?.agent === "claude" && gauge.gauge.five?.left === 58 && gauge.gauge.week?.left === 14 && gauge.w === rest.w, `"5시간 한도": 글자 한 줄 "58 · 14%"(20% 이하 14만 빨강), 그림엔 막대 없음(폭 그대로) — 5시간을 더 쓴 Claude ${JSON.stringify(gauge && { title: gauge.title, g: gauge.gauge, w: [rest?.w, gauge.w] })}`),
        ok(back?.kind === "ball" && back?.ask === null && back?.gauge?.five?.left === 58 && back.title === "58 · \u001b[31m14%\u001b[0m" && back.w > 10 && st.menubar?.icon === "ball" && st.menubar?.iconAsked === true, `다시 몬스터볼(글자는 그대로), 고른 뒤엔 안 물음 ${JSON.stringify([back, st.menubar])}`),
      ];
    },
  },
  {
    id: "menubar-lead-reduced", tags: ["smoke", "app"], what: "메뉴바 아이콘 = 파티 선두, macOS 동작 줄이기(시험: CVIM_TEST_REDUCED_MOTION): 작업 중에도 재생·틱 없이 첫 프레임, 표시는 그대로(!) (STA-24 규칙 6, #108)",
    data: "owner", offline: true, mode: "direct", folders: ["a"], env: { CVIM_TEST_REDUCED_MOTION: "1" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { invoke: "party_test", args: { n: 2 } },
      { invoke: "settings_set", args: { patch: { menubar: { icon: "poke" } } } },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "coding", hold: true } }, { wait: 300 }, { invoke: "lead_test", log: true },
      { invoke: "lead_cpu_test", args: { ms: 1500 }, log: true }, { invoke: "lead_test", log: true },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "coding", to: "waiting", hold: true } }, { wait: 300 }, { invoke: "lead_test", log: true }],
    check: ({ log }) => {
      const [a, b, w] = [...log.matchAll(/^lab-invoke lead_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const cpu = JSON.parse(log.match(/^lab-invoke lead_cpu_test (.*)$/m)?.[1] || "null");
      return [
        ok(a?.state === "working" && a.reduced === true && a.frame === 0 && b?.frame === 0, `동작 줄이기: 작업 중에도 첫 프레임 ${JSON.stringify([a, b?.frame])}`),
        ok(cpu && cpu.ticks <= 1, `틱 없음(그림 한 장) ${JSON.stringify(cpu)}`),
        ok(w?.state === "waiting" && w.marks === "badge", `입력 필요 ! 는 그대로 ${JSON.stringify(w)}`),
      ];
    },
  },
  {
    id: "menubar", tags: ["smoke", "app"], what: "메뉴바: 기다리는 탭 수 글자·5시간 한도 글자 \"58 · 82%\"(#108), 탭 상태 줄·한도 줄, 메뉴로 설정 바꾸기·아이콘 숨기기, 시험 앱은 아이콘을 안 띄움 (STA-19, #64)",
    data: "owner", mode: "direct", folders: ["a", "b"],
    steps: [{ until: "tabs.1" }, { wait: 1200 }, { call: "closeDex" }, { wait: 300 },
      { invoke: "tray_test", log: true },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "waiting" } }, { wait: 500 }, { invoke: "tray_test", log: true },
      { invoke: "usage_seen", args: { key: "claude", five_hour: { pct: 42, resets_at: 4102444800 }, seven_day: { pct: 18 } } },
      { invoke: "usage_seen", args: { key: "codex", five_hour: { pct: 90, resets_at: 1000 } } },
      { invoke: "usage_seen", args: { key: "nope", five_hour: { pct: 77 } } },
      { invoke: "settings_set", args: { patch: { menubar: { text: "limit" } } } }, { wait: 300 }, { invoke: "tray_test", log: true },
      { invoke: "tray_click_test", args: { path: ["오버레이 보일 것", "파트너"] }, log: true },
      { invoke: "tray_click_test", args: { path: ["최소 모드", "항상"] }, log: true },
      { invoke: "tray_click_test", args: { path: ["메뉴바 아이콘 숨기기"] }, log: true }, { wait: 300 },
      { invoke: "settings_get", log: true },
      { invoke: "own_open_test", args: { name: "settings", page: "menubar" } }, { wait: 1500 }, { invoke: "own_click_test", args: { name: "settings", sel: "[data-set='menubar.on']" } }, { wait: 400 }, { invoke: "own_close_test", args: { name: "settings" } }, // #101: on the 메뉴바 page — its own window (#113 P1)
      { invoke: "settings_set", args: { patch: { menubar: { text: "bogus" } } } }, { invoke: "tray_test", log: true }],
    check: ({ log, box }) => {
      const t = [...log.matchAll(/^lab-invoke tray_test (.*)$/gm)].map((m) => JSON.parse(m[1]));
      const [idle, waiting, limit, last] = t;
      const got = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}");
      const clicks = [...log.matchAll(/^lab-invoke tray_click_test (\w+)$/gm)].map((m) => m[1]);
      let saved = null; try { saved = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      const labels = (m) => (m?.items || []).map((i) => i.label || "—");
      return [
        ok(t.length === 4 && t.every((x) => x.shown === false), `시험 앱은 메뉴바 아이콘을 안 띄워야 ${JSON.stringify(t.map((x) => x.shown))}`),
        ok(labels(idle).includes("🪙 포켓코인 54 · 오늘 +0") && !/54/.test(idle?.title || ""), `코인 한 줄(시작 코인 27 × 2)이 메뉴에, 아이콘 글자엔 없음 ${JSON.stringify(labels(idle).filter((l) => /포켓코인/.test(l)))}`),
        ok(idle?.title === "" && labels(idle).filter((l) => / — /.test(l)).length === 2, `처음: 글자 없음, 탭 줄 2개 ${JSON.stringify(idle?.title)} ${JSON.stringify(labels(idle).slice(0, 3))}`),
        ok(waiting?.title === "1" && /^❗ /.test(labels(waiting)[0]), `입력 필요 1개면 "1"·첫 줄 ❗ ${JSON.stringify(waiting?.title)} ${labels(waiting)[0]}`),
        ok(limit?.title === "58 · 82%" && limit?.gauge?.agent === "claude" && limit.gauge.five?.left === 58 && limit.gauge.week?.left === 82 && labels(limit).some((l) => /Claude Code\s+5시간 42%.*주간 18%/.test(l)) && !labels(limit).some((l) => /Codex|77/.test(l)), `"5시간 한도" = 글자 "58 · 82%"(Claude 남은 %, 넉넉해 색 없음 — #108)·Claude 줄, 지난 Codex·모르는 에이전트는 없음 ${JSON.stringify(limit?.title)} ${JSON.stringify(labels(limit).filter((l) => /%/.test(l)))}`),
        ok(JSON.stringify(clicks) === '["true","true","true"]' && got.overlay?.partner === false && got.overlay?.minimal === "always" && got.menubar?.on === false, `메뉴로 바꾼 설정 ${JSON.stringify(clicks)} ${JSON.stringify(got.overlay)} ${JSON.stringify(got.menubar)}`),
        ok(saved?.menubar?.on === true && saved?.menubar?.text === "waiting", `설정 창에서 다시 켜고, 모르는 글자 값은 기본(waiting)이어야 ${JSON.stringify(saved?.menubar)}`),
        ok(last?.title === "1", `기본으로 돌아간 글자 ${JSON.stringify(last?.title)}`),
      ];
    },
  },
  {
    id: "typed-agent-low-pid", tags: ["smoke", "agents"], what: "셸에서 친 에이전트의 앞 그룹에 pid가 더 작은 프로세스가 있어도(pid가 한 바퀴 돈 맥의 caffeinate 같은) 에이전트로 계속 잡힘 (#69)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"],
    // labhelper starts first (smaller pid), then joins labagent's process group — it lists before
    // the agent in `ps`, the way Claude Code's caffeinate does once pids have wrapped
    files: { "agents-user.json": JSON.stringify({ labagent: { name: "LabAgent", cmd: ["labagent"], state: "activity" } }),
      "fakebin/labagent": "#!/bin/sh\necho $$ > .agentpid\necho lab agent running\nsleep 30\n",
      "fakebin/labhelper": "#!/usr/bin/perl\nfor (1..80) { last if -s '.agentpid'; select(undef, undef, undef, 0.1); }\nopen(my $f, '<', '.agentpid') or exit 1; my $l = <$f>; chomp $l;\nsetpgrp(0, $l) or die \"setpgrp: $!\";\nopen(my $o, '>', '.joined'); print $o \"$$ $l\\n\"; close $o;\nsleep 30;\n" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "labhelper & labagent" }, { wait: 200 }, { key: "Enter" }, { wait: 5000 }, { probe: "typed" }],
    check: ({ probe, log, box }) => {
      let joined = null; try { joined = fs.readFileSync(path.join(box.folder("proj"), ".joined"), "utf8").trim().split(" ").map(Number); } catch {}
      return [
        ok(joined && joined[0] < joined[1], `도우미가 더 작은 pid로 에이전트 그룹에 들어가지 못함 (${joined}) — 시험 준비 실패`),
        ok(/host-agent \S+ labagent kind=activity/.test(log), "셸에서 친 에이전트가 안 잡힘"),
        ok(!/^host-agent \S+ -$/m.test(log.slice(log.search(/host-agent \S+ labagent/))), `잡힌 뒤 놓침 (${log.match(/^host-agent \S+ -$/m)?.[0]})`),
        ok(probe.typed?.agent === "labagent", `큰 칸 에이전트 ${probe.typed?.agent} (labagent여야)`),
      ];
    },
  },
  {
    id: "theme-switch", tags: ["smoke", "app"], what: "테마: 라이트·다크를 고르면 화면·터미널 색이 바로 바뀌고 settings.json에 남음 (APP-20, #60)",
    data: "owner", mode: "direct", folders: ["proj"],
    // #70: a dark-theme agent's light grey (RGB) and dim text, printed in the shell
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 1500 }, { call: "focusShell" },
      { text: "printf '\\033[38;2;215;215;215mLABFAINT\\033[0m \\033[2;38;2;200;200;200mLABDIM\\033[0m\\n'" }, { key: "Enter" }, { wait: 800 },
      { invoke: "settings_set", args: { patch: { theme: "light" } } }, { wait: 700 }, { probe: "light" },
      { invoke: "settings_set", args: { patch: { theme: "dark" } } }, { wait: 700 }, { probe: "dark" },
      { invoke: "settings_set", args: { patch: { theme: "nonsense" } } }, { wait: 400 }, { invoke: "settings_get", log: true }],
    check: ({ probe, log, box }) => {
      const got = JSON.parse(log.match(/^lab-invoke settings_get (.*)$/m)?.[1] || "{}");
      let saved = null; try { saved = JSON.parse(fs.readFileSync(path.join(box.data, "ui", "settings.json"), "utf8")); } catch {}
      return [
        ok(probe.light?.theme === "light" && probe.light?.termBg === "#ffffff" && probe.light?.bodyBg === "rgb(244, 244, 246)", `라이트 ${probe.light?.theme} 터미널 ${probe.light?.termBg} 바탕 ${probe.light?.bodyBg}`),
        ok(probe.dark?.theme === "dark" && probe.dark?.termBg === "#1b1b22" && probe.dark?.bodyBg === "rgb(22, 22, 28)", `다크 ${probe.dark?.theme} 터미널 ${probe.dark?.termBg} 바탕 ${probe.dark?.bodyBg}`),
        ok(contrast(probe.light?.drawn?.LABFAINT) >= 4.4, `라이트: 옅은 회색 글자 ${probe.light?.drawn?.LABFAINT} 대비 ${contrast(probe.light?.drawn?.LABFAINT)?.toFixed(2)} (4.5 이상이어야, #70)`),
        ok(contrast(probe.light?.drawn?.LABDIM) >= 2, `라이트: 흐린 글자 ${probe.light?.drawn?.LABDIM} 대비 ${contrast(probe.light?.drawn?.LABDIM)?.toFixed(2)} (2 이상이어야, #70)`),
        ok(probe.dark?.drawn?.LABFAINT === "rgb(215, 215, 215)", `다크: 글자색은 그대로여야 — ${probe.dark?.drawn?.LABFAINT}`),
        ok(got.theme === "system", `모르는 값은 기본값(system)이어야 — ${got.theme}`),
        ok(saved?.theme === "system", `settings.json ${saved?.theme}`),
      ];
    },
  },
  {
    id: "claude-typed-unlinked", tags: ["smoke", "agents"], what: "연결 안 한 셸에서 친 Claude: 대화 기록 방식, 상단 바에 \"5h·7d ?\" 안내 (#45)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], files: { "fakebin/claude": "#!/bin/sh\n# an unlinked Claude never runs Tamer's status line\necho \"fake-claude args: $*\"\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "claude" }, { wait: 200 }, { key: "Enter" }, { wait: 3500 }, { probe: "running" }, { invoke: "agents_status", log: true }],
    check: ({ probe, log }) => {
      const st = JSON.parse(log.match(/^lab-invoke agents_status (.*)$/m)?.[1] || "{}");
      return [
        ok(/host-agent \S+ claude kind=claude_log/.test(log), "셸 Claude가 대화 기록 방식으로 안 잡힘"),
        ok(/5h·7d \?/.test(probe.running?.usage || ""), `상단 바에 안내 없음 (${probe.running?.usage})`),
        ok(st.list?.find((a) => a.key === "claude")?.fix === "claude_link", "연결 창에 '셸에서 친 Claude도 연결'이 없음"),
        ok(/^hint: shell claude not linked$/m.test(log), "연결 안내 알림이 안 뜸 (#49)"),
        ok(/🔗 연결 안 됨/.test(probe.running?.usage || ""), `상단 바에 '🔗 연결 안 됨' 없음 (${probe.running?.usage})`),
      ];
    },
  },
  {
    id: "claude-typed-linked", tags: ["smoke", "agents"], what: "연결한 뒤 새 셸에서 친 Claude: --settings가 붙고 hooks 방식, 상단 바에 5h·7d, 해제하면 블록만 빠짐 (#45)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], files: { "fakebin/claude": FAKE_CLAUDE },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 800 },
      { invoke: "claude_link_test", args: { on: true }, log: true }, { invoke: "agents_status", log: true },
      { key: "t", mods: 12 }, { wait: 3500 }, // ⌘⇧T: a new shell reads the line
      { text: "claude" }, { wait: 200 }, { key: "Enter" }, { wait: 4000 }, { probe: "running" },
      { invoke: "claude_link_test", args: { on: false }, log: true }],
    check: ({ probe, log, box }) => {
      const rc = path.join(box.dir, "zdot", ".zshrc"), text = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
      return [
        ok(/claude_link_test \{"file":"[^"]*zdot\/\.zshrc"/.test(log), "연결 파일이 시험 폴더의 .zshrc가 아님"),
        ok(/"key":"claude"[^}]*"fix":"claude_linked"/.test(log), "연결 뒤 상태가 claude_linked가 아님"),
        ok(/fake-claude args: --settings \S*claude\/settings\.json/.test(log) || /host-agent \S+ claude kind=hooks/.test(log), "새 셸의 claude에 --settings가 안 붙음"),
        ok(/host-agent \S+ claude kind=hooks/.test(log), "연결한 셸의 Claude가 hooks 방식으로 안 잡힘"),
        ok(!/^hint: shell claude not linked$/m.test(log), "연결했는데 연결 안내 알림이 뜸"),
        ok(!/🔗/.test(probe.running?.usage || ""), "연결했는데 상단 바에 🔗 표시"),
        ok(/ctx\D*21%/.test(probe.running?.usage || "") && /5h\D*30%/.test(probe.running?.usage || "") && !/5h·7d \?/.test(probe.running?.usage || ""), `상단 바 ${probe.running?.usage} (ctx 21% · 5h 30% · 7d 12% — 실시간 값)`),
        ok(/five_hour/.test(probe.running?.usageRaw || ""), `실시간 사용량이 아님(지난 값) — ${probe.running?.usageRaw}`),
        ok(!text.includes("Tamer: Claude 연결") && /PS1='lab\$ '/.test(text), "해제 뒤 블록이 남았거나 원래 줄이 사라짐"),
      ];
    },
  },
  // ── test debt, group A (docs/spec: PKM-04, APP-04, AGT-15, PKM-16) and the hook log (STA-02, POL-DATA-02) ──
  {
    id: "evolve-offline", tags: ["smoke", "poke"], what: "진화 차례에 오프라인: 최종 진화로 굳지 않고 레벨은 그대로 — 다음에 다시 시도, Lv 20 이정표는 ₽20 (PKM-04, PKM-21, #74)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => evolvePartner(box, { lv: 19 }),
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } },
      { wait: 2500 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ log, box }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.party === 0);
      const raw = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8")).mons.find((x) => x.uid === 1);
      return [
        ok(m?.id === 4 && m.lv === 21 && m.xp === 8, `파트너 ${JSON.stringify(m && { id: m.id, lv: m.lv, xp: m.xp })} (파이리 Lv 19 + 2 = 21이어야)`),
        ok(!raw?.final, "오프라인인데 최종 진화로 굳음 — 다시는 진화하지 않게 됨"),
        ok(m?.next?.kind === "level" && m.next.level === 16, `다음 진화 ${JSON.stringify(m?.next)} (Lv 16 레벨 진화 — 다음 완료 때 다시 시도)`),
        ok(/^exp ws=.* miles=20 /m.test(log) && raw?.mile === 20, `Lv 20 이정표 ${log.match(/^exp ws=[^\n]*/m)?.[0]} mile=${raw?.mile}`),
      ];
    },
  },
  {
    id: "evolve-online", tags: ["net", "poke"], what: "진화 차례(온라인): 다음 단계로 진화하고 진화 이력이 남음 (PKM-04, PKM-15)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => evolvePartner(box),
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } },
      { wait: 12000 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ log }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.party === 0);
      return [ok(m?.id === 5, `진화 안 함 (${m?.id}) — 파이리 → 리자드`), ok(m?.evo?.length === 1, `진화 이력 ${JSON.stringify(m?.evo)}`)];
    },
  },
  {
    id: "data-perms-prune", tags: ["smoke", "data"], what: "시작할 때 데이터 폴더는 소유자만(700/600)으로, 8일 된 훅 기록은 지움 (APP-04, POL-DATA-03·04)",
    data: "owner", mode: "direct", folders: ["proj"],
    setup: (box) => {
      const tabs = path.join(box.dir, "state", "tabs"); fs.mkdirSync(tabs, { recursive: true });
      for (const [n, days] of [["old", 8], ["fresh", 1]]) { const f = path.join(tabs, `${n}.log`); fs.writeFileSync(f, "{}\n", { mode: 0o644 }); const t = Date.now() / 1000 - days * 86400; fs.utimesSync(f, t, t); }
      fs.chmodSync(path.join(box.data, "box.json"), 0o644);
    },
    steps: [{ until: "tabs.0" }, { wait: 800 }, { probe: "after" }],
    check: ({ box }) => {
      const tabs = path.join(box.dir, "state", "tabs"), loose = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), m = fs.statSync(p).mode & 0o777; if (e.isDirectory()) { if (m !== 0o700) loose.push(`${path.relative(box.dir, p)} ${m.toString(8)}`); walk(p); } else if (m !== 0o600) loose.push(`${path.relative(box.dir, p)} ${m.toString(8)}`); } };
      walk(box.data);
      return [
        ok(!fs.existsSync(path.join(tabs, "old.log")), "8일 된 훅 기록이 남음"),
        ok(fs.existsSync(path.join(tabs, "fresh.log")), "하루 된 훅 기록이 지워짐"),
        ok(!loose.length, `소유자만이 아닌 것: ${loose.slice(0, 4).join(", ")}`),
      ];
    },
  },
  {
    id: "restore-resume", tags: ["smoke", "restore", "agents"], what: "갑자기 꺼진 뒤 복원: 에이전트가 켜져 있던 탭은 대화를 이어서(claude --continue) 띄움 (AGT-15, TAB-10)",
    data: "owner", mode: "direct", folders: [], make: ["a"], session: { tabs: ["a"], active: "a", shell: [] },
    pathFirst: ["fakebin"], files: { "fakebin/claude": "#!/bin/sh\necho \"fake-claude args: $*\"\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { wait: 4000 }, { grep: "fake-claude args" }, { probe: "after" }],
    check: ({ log }) => [ok(/agent-start \S+ claude resume=true/.test(log), "복원한 탭에 에이전트가 이어서 모드로 안 뜸"), ok(/lab-grep fake-claude args rows=\[\d[^\n]*text="fake-claude args: --continue/.test(log), `claude에 --continue가 안 붙음 (${log.match(/lab-grep fake-claude[^\n]*/)?.[0]})`)],
  },
  {
    id: "wild-toggle", tags: ["smoke", "poke"], what: "야생 끄면 작업을 끝내도 안 나옴, 켜면 나옴 (PKM-16)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1" },
    setup: (box) => fs.writeFileSync(path.join(box.data, "wild.json"), JSON.stringify({ enabled: false, next: { id: 16, shiny: false } })),
    steps: [{ until: "tabs.0" }, { wait: 500 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } }, { wait: 800 },
      { invoke: "wild_toggle", log: true },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "done", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } }, { wait: 800 }, { probe: "after" }],
    check: ({ log }) => {
      const appeared = log.split("\n").filter((l) => /^wild appeared/.test(l));
      return [ok(/^lab-invoke wild_toggle true$/m.test(log), "켜기가 안 됨"), ok(appeared.length === 1 && /wild appeared 16 /.test(appeared[0]), `야생 등장 ${appeared.length}번 (끈 동안 0, 켠 뒤 1이어야)`)];
    },
  },
  {
    id: "hook-log-minimal", tags: ["smoke", "agents", "data"], what: "훅 기록엔 이벤트·도구 이름·종류만 — 명령·경로·메시지 글은 안 남음 (STA-02, POL-DATA-02)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: `L="$CVIM_STATE_DIR/tabs/$CVIM_TAB_ID.log"; printf '{"tool_name":"Bash","tool_input":{"command":"curl -H Bearer LABSECRET9 https://x"}}' | bash "$CVIM_ROOT/claude/hooks/event.sh" PreToolUse; printf '{"message":"needs permission for /Users/x/LABPATH9"}' | bash "$CVIM_ROOT/claude/hooks/event.sh" Notification; echo "LEAK=$(grep -c 'LABSECRET9\\|LABPATH9' "$L") LINES=$(wc -l < "$L" | tr -d ' ')"` },
      { wait: 200 }, { key: "Enter" }, { wait: 1500 }, { grep: "LEAK=0 LINES=2" }],
    check: ({ log }) => [ok(/lab-grep LEAK=0 LINES=2 rows=\[\d/.test(log), "훅 기록에 명령·경로가 남았거나 줄이 안 써짐")],
  },
  {
    id: "claude-typed-stale", tags: ["smoke", "agents"], what: "Claude가 떠 있는 동안 연결을 켜고 끄면 상단 바 표시가 바로 따라감: 연결 안 됨 → 새 셸에서 다시 → 연결 안 됨 (#49)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], files: { "fakebin/claude": FAKE_CLAUDE },
    steps: [{ until: "tabs.0" }, { until: "partnerKnown", timeout: 8000 }, { wait: 2500 }, { call: "focusShell" },
      { text: "claude" }, { wait: 200 }, { key: "Enter" }, { wait: 3500 }, { probe: "before" }, // not linked yet
      { invoke: "claude_link_test", args: { on: true } }, { wait: 500 }, { probe: "running" }, // linked while it runs: the alias isn't in this shell
      { invoke: "claude_link_test", args: { on: false } }, { wait: 500 }, { probe: "unlinked" }],
    check: ({ probe, log }) => [
      ok(/host-agent \S+ claude kind=claude_log/.test(log), "이전 셸인데 hooks로 잡힘(alias가 있을 리 없음)"),
      ok(/🔗 연결 안 됨/.test(probe.before?.usage || ""), `연결 전 상단 바 ${probe.before?.usage}`),
      ok(/🔗 새 셸에서 다시/.test(probe.running?.usage || ""), `연결 직후(같은 셸) 상단 바 ${probe.running?.usage} — '새 셸에서 다시'로 바뀌어야`),
      ok(/🔗 연결 안 됨/.test(probe.unlinked?.usage || ""), `해제 뒤 상단 바 ${probe.unlinked?.usage}`),
    ],
  },
];
