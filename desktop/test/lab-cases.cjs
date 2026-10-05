// Test lab cases (npm run lab, docs/TESTING.md). A case: what it checks, the data it starts from,
// how the app is launched, optional twists (a slow shell, offline, a folder handed in late), the
// steps (src/main.js labRun) and the check. `vary` multiplies a case over values (timings …).
//   data: "empty" | "newuser" | "owner"      mode: "direct" | "open" (dropped on the app) | "late"
//   slowShell: seconds · offline: true · env: { … } · vary: { lateMs: [ … ] }
//   steps: { wait } { until: "path" } { key } { click } { probe: "name" } { shot } { call }
//   check({ probe, log, v }) → a list: true = ok, a string = what went wrong
// Tags: smoke = must pass before every release · net = needs PokéAPI · explore = records how
// things are (an edge being looked at), not a release gate.
const startup = (log, what) => { const m = log.match(new RegExp(`startup ${what} \\+(\\d+)ms`)); return m ? Number(m[1]) : null; };
// ok(condition, what went wrong): true when it holds, else the message (a value is never a message)
const ok = (cond, msg) => (cond ? true : msg);
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
    id: "slow-shell-env", tags: ["explore", "slow-shell"], what: "셸 시작이 3초 넘게 걸리면 에이전트가 받는 환경 변수(PATH·API 키 …)가 온전한가",
    data: "empty", slowShell: 4, mode: "direct", folders: [],
    steps: [{ wait: 8000 }, { probe: "later" }],
    check: ({ log }) => { const n = Number(log.match(/env ready \((\d+) vars\)/)?.[1] || 0); return [ok(n > 10, `환경 변수 ${n}개만 받음 (셸 환경 읽기 시간 초과)`)]; },
  },
  {
    id: "slow-shell-folder", tags: ["explore", "slow-shell"], what: "셸 시작이 3초 걸리는 맥에 폴더를 넘겨 실행 — 기다리는 동안 무엇이 보이나",
    data: "owner", slowShell: 3, mode: "direct", folders: ["proj"],
    steps: [{ wait: 1000 }, { probe: "at1s" }, { until: "tabs.0", timeout: 20000 }, { wait: 500 }, { probe: "tab" }],
    check: ({ probe }) => [
      ok(probe.at1s?.start === false, "기다리는 동안 시작 화면이 깜박임"),
      ok(probe.tab?.tabs?.[0] === "proj", "탭이 안 열림"),
      ok(probe.at1s?.tabs?.length > 0, "기다리는 동안 빈 창(탭도 안내도 없음)"),
    ],
  },
  {
    id: "slow-shell-late-drop", tags: ["explore", "slow-shell", "timing"], what: "느린 셸 + 켜지는 중에 폴더",
    data: "owner", slowShell: 3, mode: "late", folders: ["my folder"], vary: { lateMs: [300, 1500] },
    steps: [{ until: "tabs.0", timeout: 20000 }, { wait: 1200 }, { probe: "after" }],
    check: ({ probe }) => [ok(probe.after?.tabs?.[0] === "my folder", "탭이 안 열림"), ok(probe.after?.start === false, "시작 화면이 탭을 가림")],
  },
];
