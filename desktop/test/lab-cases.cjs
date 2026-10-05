// Test lab cases (npm run lab, docs/TESTING.md). A case: what it checks, the data it starts from,
// how the app is launched, optional twists (a slow shell, offline, a folder handed in late), the
// steps (src/main.js labRun) and the check. `vary` multiplies a case over values (timings …).
//   data: "empty" | "newuser" | "owner"      mode: "direct" | "open" (dropped on the app) | "late"
//   slowShell: seconds · offline: true · env: { … } · vary: { lateMs: [ … ] }
//   steps: { wait } { until: "path" } { key } { click } { probe: "name" } { shot } { call }
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
    steps: [{ until: "tabs.0" }, { call: "closeDex" }, { wait: 3000 }, { text: "echo " }, { ime: "ㅎ" }, { ime: "하" }, { ime: "한" }, { text: "한" }, { ime: "ㄱ" }, { ime: "그" }, { ime: "글" }, { text: "글" }, { text: "ab" }, { wait: 600 }, { probe: "typed" }],
    check: ({ probe }) => [ok(/echo 한글ab$/.test(probe.typed?.line || ""), `셸 줄 ${JSON.stringify(probe.typed?.line)}`)],
  },
  {
    id: "hangul-cmd-arrow", tags: ["smoke", "input"], what: "한글 조합 중 ⌘← → 조합만 끝내고 글자는 제자리 (#15, iTerm2와 같음)",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { call: "closeDex" }, { wait: 3000 }, { text: "echo ab" }, { ime: "ㅎ" }, { ime: "하" }, { key: "ArrowLeft", mods: 4, commands: ["moveToBeginningOfLine"] }, { wait: 300 }, { text: "하" }, { wait: 600 }, { probe: "after" }],
    check: ({ probe }) => [ok(/echo ab하$/.test(probe.after?.line || ""), `셸 줄 ${JSON.stringify(probe.after?.line)}`)],
  },
  // ── window size ──
  {
    id: "narrow-window", tags: ["explore", "layout"], what: "좁은 창(720×520): 가로로 넘치지 않고 포켓몬 창이 창 안에",
    data: "owner", mode: "direct", folders: ["proj"],
    steps: [{ until: "tabs.0" }, { call: "closeDex" }, { resize: [720, 520] }, { probe: "main" }, { call: "openDex" }, { wait: 500 }, { probe: "dex" }, { call: "box" }, { wait: 400 }, { probe: "box" }, { shot: "narrow-box" }],
    check: ({ probe }) => [
      ok(probe.main?.width <= 730, `창 폭 ${probe.main?.width} (크기 바꾸기가 안 됨)`),
      ok(probe.main?.overflow === false, "메인 화면이 가로로 넘침"),
      ok(probe.dex?.pokeFits === true, "도감 창이 창 밖으로 나감"),
      ok(probe.box?.pokeFits === true, "내 포켓몬 창이 창 밖으로 나감"),
    ],
  },
];
