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
// a partner one task away from evolving (Charmander, EXP 7 of 8) in the case's "proj" folder (PKM-04)
function evolvePartner(box) {
  const C = box.data, proj = box.folder("proj"), now = Math.floor(Date.now() / 1000);
  const b = JSON.parse(fs.readFileSync(path.join(C, "box.json"), "utf8"));
  b.mons.push({ uid: 99, id: 4, shiny: false, xp: 7, since_evo: 7, how: "starter", at: now - 3600, folder: proj });
  b.mons = b.mons.map((m) => (m.uid === 99 ? { ...m, uid: 1 } : m.uid === 1 ? { ...m, uid: 98 } : m));
  fs.writeFileSync(path.join(C, "box.json"), JSON.stringify(b));
  const f = JSON.parse(fs.readFileSync(path.join(C, "folders.json"), "utf8"));
  f[proj] = { id: 4, uid: 1, pinned: true };
  fs.writeFileSync(path.join(C, "folders.json"), JSON.stringify(f));
}
const envMs = (log) => { const m = log.match(/env ready .*?\+(\d+)ms/); return m ? Number(m[1]) : null; };

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
    id: "launch-folder", tags: ["smoke", "launch"], what: "폴더를 넘겨 실행 → 그 탭, 파트너가 없으면 파트너 고르기",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { probe: "tab" }],
    check: ({ probe }) => [ok(probe.tab?.tabs?.[0] === "proj", `탭 ${JSON.stringify(probe.tab?.tabs)}`), ok(probe.tab?.start === false, "시작 화면이 떠 있음"), ok(probe.tab?.choose, "파트너 고르기가 안 열림")],
  },
  {
    id: "first-launch-dialogs", tags: ["smoke", "first-run"], what: "첫 실행: 에이전트 연결 창이 파트너 고르기 위, Esc는 위 창만 닫음 (#30)",
    data: "empty", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_DESKTOP_FIRST_LAUNCH: "1" },
    steps: [{ until: "agents" }, { until: "choose" }, { wait: 300 }, { probe: "both" }, { key: "Escape" }, { wait: 400 }, { probe: "esc" }],
    check: ({ probe }) => [
      ok(probe.both?.top === "agents", `맨 위가 ${probe.both?.top}`),
      ok(probe.esc?.agents === false, "Esc 후 에이전트 연결 창이 남음"),
      ok(probe.esc?.choose === true, "Esc가 파트너 고르기를 닫음"),
      ok(probe.esc?.top === "poke", `Esc 후 맨 위가 ${probe.esc?.top}`),
    ],
  },
  {
    id: "first-partner-offline", tags: ["smoke", "first-run"], what: "첫 실행인데 오프라인: 첫 파트너를 못 받아도 창이 멈추지 않고 닫힘",
    data: "empty", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "choose" }, { wait: 3000 }, { probe: "waiting" }, { key: "Escape" }, { wait: 400 }, { probe: "closed" }],
    check: ({ probe, log }) => [
      ok(probe.waiting?.choose === true, "파트너 고르기가 안 열림"),
      ok(probe.waiting?.starters?.ready === false, "오프라인인데 후보가 준비됨"),
      ok(probe.closed?.choose === false, "Esc로 안 닫힘"),
      ok(!/lab-error/.test(log), "오류"),
    ],
  },
  {
    id: "first-partner-keys", tags: ["smoke", "first-run"], what: "새 사용자: 방향키 + Enter로 첫 파트너",
    data: "newuser", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "starters.ready" }, { key: "ArrowRight" }, { key: "Enter" }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe }) => [ok(probe.picked?.partner, "파트너가 안 생김"), ok(probe.picked?.poke === null, "창이 안 닫힘")],
  },
  {
    id: "first-partner-net", tags: ["net", "first-run"], what: "첫 실행: PokéAPI에서 후보를 받아 1·2·3 키로 고르기",
    data: "empty", mode: "direct", folders: ["proj"],
    steps: [{ until: "starters.ready", timeout: 40000 }, { probe: "ready" }, { key: "2" }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe }) => [ok(probe.ready?.starters?.n === 3, "후보 3마리가 안 옴"), ok(probe.picked?.partner, "파트너가 안 생김")],
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
    id: "legacy-cvim", tags: ["smoke", "data"], what: "이전 CVIM(~/.cache/cvim) 데이터만 있는 맥: 처음 켤 때 옮겨 와 그 폴더의 파트너가 그대로, CVIM 쪽은 그대로",
    data: "legacy", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "partner", timeout: 10000 }, { probe: "after" }],
    check: ({ probe, box }) => {
      const home = path.join(box.dir, "home"), read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, f), "utf8")); } catch { return null; } };
      const b = read("tamer/box.json");
      return [
        ok(probe.after?.partner === "피카츄", `파트너 ${probe.after?.partner}`),
        ok(fs.existsSync(path.join(home, "tamer/.from-cvim.json")), "옮긴 기록이 없음"),
        ok(b?.mons?.some((m) => m.id === 25 && m.xp === 30), "박스에 이전 파트너(EXP 30)가 없음"),
        ok(b?.mons?.some((m) => m.id === 16), "도감에서 잡은 포켓몬이 박스에 없음"),
        ok(!b?.mons?.some((m) => m.id === 7), "못 잡은(만난) 포켓몬이 박스에 들어감"),
        ok(!fs.existsSync(path.join(home, "cvim/box.json")) && read("cvim/folders.json")?.[box.folder("proj")]?.uid === undefined, "CVIM 쪽 데이터가 바뀜"),
      ];
    },
  },
  {
    id: "corrupt-data", tags: ["smoke", "data"], what: "데이터 파일이 중간에 잘린 맥: 앱은 뜨고, 파트너를 고른 뒤에도 잘린 원본은 backup/corrupt에 남음",
    data: "corrupt", offline: true, mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "starters.ready", timeout: 10000 }, { probe: "open" }, { key: "1" }, { wait: 1500 }, { probe: "picked" }],
    check: ({ probe, log, box }) => [
      ok(probe.open?.tabs?.[0] === "proj", "탭이 안 열림"),
      ok(!/lab-error|Uncaught/.test(log), "오류"),
      ok(probe.picked?.partner, "파트너를 못 고름"),
      ok(filesWith(path.join(box.data, "backup", "corrupt"), '"how":"starter","at":1,').length > 0, "잘린 box.json(피카츄 EXP 40 등)이 덮어써져 사라짐 — 복구할 원본이 없음"),
      ok(["pokedex.json", "folders.json"].every((f) => fs.readdirSync(path.join(box.data, "backup", "corrupt")).some((n) => n.startsWith(f + "."))), "잘린 pokedex·folders 사본이 없음"),
    ],
  },
  // ── input ──
  {
    id: "hangul-in-shell", tags: ["smoke", "input"], what: "셸에서 한글 조합 → 확정, 이어서 영문 — 글자가 겹치거나 빠지지 않음",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 3000 }, { text: "echo " }, { ime: "ㅎ" }, { ime: "하" }, { ime: "한" }, { text: "한" }, { ime: "ㄱ" }, { ime: "그" }, { ime: "글" }, { text: "글" }, { text: "ab" }, { wait: 600 }, { probe: "typed" }],
    check: ({ probe }) => [ok(/echo 한글ab$/.test(probe.typed?.line || ""), `셸 줄 ${JSON.stringify(probe.typed?.line)}`)],
  },
  {
    id: "hangul-cmd-arrow", tags: ["smoke", "input"], what: "한글 조합 중 ⌘← → 조합만 끝내고 글자는 제자리 (#15, iTerm2와 같음)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 3000 }, { text: "echo ab" }, { ime: "ㅎ" }, { ime: "하" }, { key: "ArrowLeft", mods: 4, commands: ["moveToBeginningOfLine"] }, { wait: 300 }, { text: "하" }, { wait: 600 }, { probe: "after" }],
    check: ({ probe }) => [ok(/echo ab하$/.test(probe.after?.line || ""), `셸 줄 ${JSON.stringify(probe.after?.line)}`)],
  },
  // ── window size ──
  {
    id: "narrow-window", tags: ["smoke", "layout"], what: "좁은 창(1100·900·720): 상단 바·단축키 줄이 한 줄로 들어감, 가로 넘침 없음, 포켓몬 창이 창 안에 (#38)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { call: "fakeUsage" },
      { resize: [1100, 600] }, { probe: "w1100" }, { resize: [900, 600] }, { probe: "w900" }, { shot: "narrow-900" }, { resize: [720, 520] }, { probe: "main" }, { shot: "narrow-720" },
      { call: "openDex" }, { wait: 500 }, { probe: "dex" }, { call: "box" }, { wait: 400 }, { probe: "box" }, { shot: "narrow-box" }],
    check: ({ probe }) => [
      ok(probe.main?.width <= 730, `창 폭 ${probe.main?.width} (크기 바꾸기가 안 됨)`),
      ok(probe.main?.overflow === false, "메인 화면이 가로로 넘침"),
      ...["w1100", "w900", "main"].flatMap((k) => [ok(probe[k]?.barFits === true, `${k}: 상단 바가 넘치거나 두 줄`), ok(probe[k]?.hintFits === true, `${k}: 단축키 줄이 두 줄`)]),
      ok(probe.dex?.pokeFits === true, "도감 창이 창 밖으로 나감"),
      ok(probe.box?.pokeFits === true, "내 포켓몬 창이 창 밖으로 나감"),
    ],
  },
  // ── find in the terminal (#40) ──
  {
    id: "term-search", tags: ["smoke", "input"], what: "터미널 ⌘F: 결과 수·다음·이전, 한글도, Esc로 닫고 터미널로, 포켓몬 창이 열려 있으면 도감 검색 (#40)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "echo TOPMARK; seq 1 300" }, { wait: 200 }, { key: "Enter" }, { wait: 1200 },
      { key: "f", mods: 4 }, { wait: 300 }, { text: "TOPMARK" }, { wait: 500 }, { probe: "found" }, { grep: "TOPMARK" }, { grep: "lab$" }, { grep: "299" }],
    check: ({ probe }) => [ok(/^\d\/2$/.test(probe.found?.tsearch?.n || ""), `300줄 위 단어 결과 ${probe.found?.tsearch?.n} (명령 줄 + 출력 = 2)`), ok(probe.found?.tsearch?.alt === false, "일반 화면인데 \"보이는 화면만\" 안내")],
  },
  {
    id: "term-search-alt", tags: ["smoke", "input"], what: "전체 화면 프로그램(대체 화면)에서 ⌘F: \"보이는 화면만\" 안내, 일반 화면에선 안내 없음 (#40)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "env | sort > env.txt" }, { wait: 200 }, { key: "Enter" }, { wait: 800 }, { probe: "done" }],
    check: ({ box }) => [ok(fs.existsSync(path.join(box.folder("proj"), "env.txt")), "env.txt가 안 생김")],
  },
  // ── 🏠 홈 · 포획 기록 (#44) ──
  {
    id: "home", tags: ["smoke", "poke"], what: "⌘P → 홈: 오늘 끝낸 작업·연속 일수, 끝낼 때마다 오늘 수가 늘고 stats.json엔 날짜별 수만 (#44)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 300 },
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
    id: "catch-log", tags: ["smoke", "poke"], what: "내 포켓몬 상세: 잡은 폴더·에이전트·진화 이력, 기록 없는 옛 개체는 그 줄 없음 (#44)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { call: "box" }, { wait: 300 }, { call: "openDex" }, { call: "box" }, { wait: 800 },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { until: "astate", timeout: 9000 }, { wait: 5000 }, { probe: "asking" },
      { wait: 9000 }, { probe: "answered" }],
    check: ({ probe, log }) => [
      ok(/host-agent \S+ codex kind=codex_log/.test(log), "셸 Codex가 세션 로그 방식으로 안 잡힘"),
      ok(probe.asking?.astate === "waiting", `승인 대기 중 상태 ${probe.asking?.astate} (입력 필요여야)`),
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
      { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { probe: "t1" }, { key: "Escape" }, { wait: 300 }, { probe: "esc1" },
      { key: "t", mods: 4 }, { wait: 400 }, { probe: "t2" }, { key: "2" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { key: "h" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 500 },
      { key: "t", mods: 4 }, { wait: 400 }, { key: "o" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 800 }, { probe: "end" }],
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
    steps: [{ until: "start" }, { wait: 400 }, { probe: "first" }, { key: "3" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 800 }],
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "echo lab-pick-4821" }, { wait: 200 }, { key: "Enter" }, { wait: 1000 }, { select: "lab-pick-4821" }, { wait: 300 }, { probe: "picked" }],
    check: ({ probe, log }) => [
      ok(/^copy_text "lab-pick-4821"$/m.test(log), `복사한 글 ${log.match(/^copy_text (.*)$/m)?.[1]}`),
      ok(/복사됨 \(13자\)/.test(probe.picked?.toast || ""), `알림 ${probe.picked?.toast}`),
    ],
  },
  {
    id: "hand-pick", tags: ["smoke", "terminal"], what: "셸 1에서 고른 글을 레일에서 셸 2 우클릭 → 보내기: 출처 한 줄과 함께 셸 2에 입력·실행 (TRM-11)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { wait: 7000 }, { probe: "log" }],
    check: ({ probe }) => {
      const a = (probe.log?.activity || []).map((x) => x.trim());
      return [
        ok(a.length === 4, `줄 수 ${a.length} ${JSON.stringify(a)} (PostToolUse 없이 4줄)`),
        ok(/^✅ Stop all good/.test(a[0] || ""), `첫 줄(가장 새것) ${a[0]}`),
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 },
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
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], timeoutMs: 110000, env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_CHANCE_EMPTY: "1" },
    files: { "agents-user.json": JSON.stringify({ labagent: { name: "LabAgent", cmd: ["labagent"], state: "activity" } }),
      "fakebin/labagent": "#!/bin/sh\nfor round in 1 2; do i=0; while [ $i -lt 46 ]; do echo \"working $round.$i\"; i=$((i+1)); sleep 0.5; done; sleep 8; done\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
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
      ok(probe.start?.pokeExp === "EXP 7 · 진화까지 1", `EXP 줄 ${probe.start?.pokeExp}`),
      ok((probe.clicked?.fx || []).length >= 5 && ["💕", "🔥"].includes(probe.clicked?.fx?.[0]), `클릭 반응 ${JSON.stringify(probe.clicked?.fx)} (애교 💕 또는 불꽃 타입 공격 🔥)`),
      ok(["1🔄파트너 바꾸기", "2⚔️공격", "3💕애교", "4📕도감", "5🌿야생 포켓몬"].every((w, i) => (probe.menu?.menuItems?.[i] || "").startsWith(w)) && probe.menu.menuItems.length === 5, `메뉴 ${JSON.stringify(probe.menu?.menuItems)}`),
      ok(probe.cute?.fx?.length === 5 && probe.cute.fx.every((g) => g === "💕") && probe.cute?.menu === false, `3(애교) ${JSON.stringify(probe.cute?.fx)} 메뉴 닫힘 ${probe.cute?.menu === false}`),
      ok(probe.attack?.fx?.length === 8 && probe.attack.fx.every((g) => g === "🔥"), `2(공격) ${JSON.stringify(probe.attack?.fx)} (파이리 = 불꽃 🔥 8개)`),
    ],
  },
  {
    id: "drop-folders", tags: ["smoke", "tabs"], what: "Finder 폴더를 시작 화면·탭 줄에 끌어 놓으면 새 탭(여러 개는 차례로), 파일은 '폴더만' 알림, 터미널 칸에 놓으면 경로 입력 (TAB-07)",
    data: "owner", mode: "direct", folders: [], make: ["a", "b", "c"], files: { "note.txt": "x" },
    steps: (box) => [{ until: "start" }, { wait: 400 },
      { drop: "#start", files: [box.folder("a")] }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 600 }, { probe: "start" },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: "codex" }, { wait: 200 }, { key: "Enter" }, { wait: 6000 }, { probe: "early" },
      { wait: 11000 }, { probe: "stall" }, { invoke: "overlay_payload_test", log: true },
      { wait: 17000 }, { probe: "bash" }, { wait: 9000 }, { probe: "done" }],
    check: ({ probe, log }) => {
      const ov = JSON.parse(log.match(/^lab-invoke overlay_payload_test (.*)$/m)?.[1] || "{}");
      return [
        ok(probe.early?.astate === "reading" && !/변화 없음/.test(probe.early?.doing || ""), `처음 ${probe.early?.astate} "${probe.early?.doing}"`),
        ok(/⏳ 변화 없음 0분 · 마지막 읽기 rg needle/.test(probe.stall?.doing || "") || /⏳ 변화 없음/.test(probe.stall?.doing || ""), `멈춤 의심 상단 바 "${probe.stall?.doing}"`),
        ok(/새 이벤트 없음/.test(probe.stall?.tabTitle || ""), `탭 말풍선 "${probe.stall?.tabTitle}"`),
        ok(ov.current?.times?.watch === true && ov.current?.times?.event_at > 0 && ov.stallMs === 8000, `오버레이 시각 ${JSON.stringify(ov.current?.times)} stallMs ${ov.stallMs}`),
        ok(probe.bash?.astate === "bash" && !/변화 없음/.test(probe.bash?.doing || ""), `실행 중 ${probe.bash?.astate} "${probe.bash?.doing}" (멈춤 표시가 없어야)`),
        ok(probe.done?.astate === "done" || probe.done?.astate === "idle", `끝 ${probe.done?.astate}`),
      ];
    },
  },
  {
    id: "claude-typed-unlinked", tags: ["smoke", "agents"], what: "연결 안 한 셸에서 친 Claude: 대화 기록 방식, 상단 바에 \"5h·7d ?\" 안내 (#45)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], files: { "fakebin/claude": "#!/bin/sh\n# an unlinked Claude never runs Tamer's status line\necho \"fake-claude args: $*\"\nsleep 30\n" },
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 800 },
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
    id: "evolve-offline", tags: ["smoke", "poke"], what: "진화 차례에 오프라인: 최종 진화로 굳지 않고 EXP는 그대로 — 다음에 다시 시도 (PKM-04)",
    data: "owner", offline: true, mode: "direct", folders: ["proj"],
    setup: (box) => evolvePartner(box),
    steps: [{ until: "partner", timeout: 10000 }, { wait: 500 },
      { invoke: "agent_state_test", args: { ws: "$ws", from: "idle", to: "thinking" } }, { invoke: "agent_state_test", args: { ws: "$ws", from: "thinking", to: "done" } },
      { wait: 2500 }, { invoke: "box_list", args: { ws: "$ws" }, log: true }],
    check: ({ log, box }) => {
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.folder === "here");
      const raw = JSON.parse(fs.readFileSync(path.join(box.data, "box.json"), "utf8")).mons.find((x) => x.uid === 1);
      return [
        ok(m?.id === 4 && m.xp === 8, `파트너 ${JSON.stringify(m && { id: m.id, xp: m.xp })} (파이리 EXP 8이어야)`),
        ok(!raw?.final, "오프라인인데 최종 진화로 굳음 — 다시는 진화하지 않게 됨"),
        ok(m?.toEvolve === 0, `진화까지 ${m?.toEvolve} (다음 완료 때 다시 시도 = 0)`),
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
      const m = JSON.parse(log.match(/^lab-invoke box_list (.*)$/m)?.[1] || "[]").find((x) => x.folder === "here");
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
    data: "owner", offline: true, mode: "direct", folders: ["proj"], env: { CVIM_WILD_CHANCE: "1", CVIM_WILD_CHANCE_EMPTY: "1" },
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
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
      { text: `L="$CVIM_STATE_DIR/tabs/$CVIM_TAB_ID.log"; printf '{"tool_name":"Bash","tool_input":{"command":"curl -H Bearer LABSECRET9 https://x"}}' | bash "$CVIM_ROOT/claude/hooks/event.sh" PreToolUse; printf '{"message":"needs permission for /Users/x/LABPATH9"}' | bash "$CVIM_ROOT/claude/hooks/event.sh" Notification; echo "LEAK=$(grep -c 'LABSECRET9\\|LABPATH9' "$L") LINES=$(wc -l < "$L" | tr -d ' ')"` },
      { wait: 200 }, { key: "Enter" }, { wait: 1500 }, { grep: "LEAK=0 LINES=2" }],
    check: ({ log }) => [ok(/lab-grep LEAK=0 LINES=2 rows=\[\d/.test(log), "훅 기록에 명령·경로가 남았거나 줄이 안 써짐")],
  },
  {
    id: "claude-typed-stale", tags: ["smoke", "agents"], what: "Claude가 떠 있는 동안 연결을 켜고 끄면 상단 바 표시가 바로 따라감: 연결 안 됨 → 새 셸에서 다시 → 연결 안 됨 (#49)",
    data: "owner", mode: "direct", folders: ["proj"], pathFirst: ["fakebin"], files: { "fakebin/claude": FAKE_CLAUDE },
    steps: [{ until: "tabs.0" }, { until: "choose", timeout: 8000 }, { call: "closeDex" }, { wait: 2500 }, { call: "focusShell" },
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
