// The feature spec and policy as one graph (docs/spec/README.md, docs/policy/README.md):
// cards (APP-01 …) → policies, tests (lab cases, UI scenes, TEST_SCENARIOS, old test flags, core
// tests), code (files, names), related cards, issues. Policies → how they're checked.
//   npm run spec:check                    format and references (exit 1 when broken), test debt as warnings
//   npm run spec:impact -- <target>       what's linked to a card / policy / file / name / lab case / scene / #issue, both ways
//   npm run spec:impact -- --diff [base]  the delta: changed files (uncommitted, or since <base>) → cards → policies,
//                                         related cards, tests to run, docs to look at
//   node scripts/spec.cjs gate <A..B> [version] [ids]  release gate: cards hit directly must name an issue
//                                         of the range (or the version) in **이력** — release.cjs runs it
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");            // desktop/
const REPO = path.resolve(ROOT, "..");
const DOCS = path.join(REPO, "docs");
const SPEC = path.join(DOCS, "spec"), POLICY = path.join(DOCS, "policy");

// ── parsing ───────────────────────────────────────────────────────────────────
// a card: "## AGT-07 이름", then "- **필드**: …" lines (a field runs until the next "- **")
function cards(dir, idRe) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    let cur = null, field = null;
    lines.forEach((l, i) => {
      const h = l.match(/^## (\S+) (.+)$/);
      if (l.startsWith("## ") || l.startsWith("# ")) {
        cur = h && idRe.test(h[1]) ? { id: h[1], title: h[2].trim(), file: f, line: i + 1, fields: {} } : null;
        if (cur) out.push(cur);
        field = null;
        return;
      }
      if (!cur) return;
      const m = l.match(/^- \*\*(.+?)\*\*:\s?(.*)$/);
      if (m) { field = m[1]; cur.fields[field] = m[2]; return; }
      if (field && /^\s+\S/.test(l)) cur.fields[field] += "\n" + l.trim();
    });
  }
  return out;
}
const CARD_ID = /^(APP|TAB|AGT|STA|TRM|PKM)-\d{2}$/, POL_ID = /^POL-[A-Z]+-\d{2}$/;
const all = (re, s) => [...String(s || "").matchAll(re)].map((m) => m[1]);
function refs(c) {
  const f = c.fields, t = f["시험"] || "";
  return {
    status: ((f["상태"] || "").trim().match(/^(✅|🔜|💡|⏸|✖)/) || [""])[0], // whole emoji (🔜 is two UTF-16 units)
    policies: all(/\b(POL-[A-Z]+-\d{2})\b/g, f["정책"]),
    related: all(/\b((?:APP|TAB|AGT|STA|TRM|PKM)-\d{2})\b/g, f["관련"]),
    labs: all(/lab `([^`]+)`/g, t), scenes: all(/장면 `([^`]+)`/g, t),
    ts: [...all(/TS #(\d+)/g, t).map((n) => `#${n}`), ...all(/TS (?!#)([^,·\n]+)/g, t).map((s) => s.trim())],
    oldTests: all(/구 시험 `([^`]+)`/g, t), coreTests: all(/코어 시험 `([^`]+)`/g, t),
    gap: /(^|\n)\s*-?\s*부족:/.test(t) ? t.split(/\n/).find((l) => /부족:/.test(l)).replace(/^.*부족:\s*/, "") : null,
    // what can't be tested automatically by its nature (a system dialog, a real reboot, a real agent's
    // account): checked by hand in TEST_SCENARIOS — not debt, but it must have a 수동 step
    manualOnly: /(^|\n)\s*-?\s*수동만:/.test(t) ? t.split(/\n/).find((l) => /수동만:/.test(l)).replace(/^.*수동만:\s*/, "") : null,
    none: /해당 없음/.test(t),
    code: String(f["코드"] || "").split(" · ").map((seg) => {
      const m = seg.match(/`([^`]+)`\s*(.*)/);
      return m ? { file: m[1], names: m[2].split(/[\s,]+/).filter(Boolean) } : null;
    }).filter(Boolean),
    issues: all(/#(\d+)/g, f["이력"]).map((n) => `#${n}`),
  };
}

// what exists
const labIds = () => require(path.join(ROOT, "test/lab-cases.cjs")).map((c) => c.id);
const sceneIds = () => Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "src/poke/ui-map.json"), "utf8")).screens).flatMap((s) => s.scenes);
const scenarios = () => { try { return fs.readFileSync(path.join(DOCS, "TEST_SCENARIOS.md"), "utf8"); } catch { return ""; } };
const oldFlags = () => new Set(all(/\b([a-z0-9_]+):\s*(?:!!)?process\.env\.CVIM_DESKTOP_/g, fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8")));
const coreFns = () => {
  const dir = path.join(ROOT, "core-rs/src");
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".rs")).flatMap((f) => all(/fn ([a-z0-9_]+)\s*\(/g, fs.readFileSync(path.join(dir, f), "utf8"))));
};
// a code path in a card: relative to desktop/, or ../agents/…, ../claude/…
const codePath = (p) => path.resolve(ROOT, p);

function load() {
  const cs = cards(SPEC, CARD_ID).map((c) => ({ ...c, r: refs(c) }));
  const ps = cards(POLICY, POL_ID).map((p) => ({ ...p, checks: { labs: all(/lab `([^`]+)`/g, p.fields["확인"]) } }));
  return { cs, ps };
}

// ── check ─────────────────────────────────────────────────────────────────────
function check() {
  const { cs, ps } = load();
  const errors = [], warns = [], debt = [], manual = [];
  const err = (c, m) => errors.push(`${c.file}:${c.line} ${c.id} — ${m}`);
  const labs = new Set(labIds()), scenes = new Set(sceneIds()), ts = scenarios(), flags = oldFlags(), fns = coreFns();
  const polIds = new Set(ps.map((p) => p.id)), cardIds = new Set();
  const usedLabs = new Set(), usedPols = new Set(), usedFiles = new Set();
  for (const p of ps) {
    for (const k of ["규칙", "이유", "확인"]) if (!p.fields[k]?.trim()) err(p, `정책에 **${k}** 없음`);
    for (const l of p.checks.labs) { if (!labs.has(l)) err(p, `확인의 lab \`${l}\` 없음`); usedLabs.add(l); }
  }
  for (const c of cs) {
    if (cardIds.has(c.id)) err(c, "ID 중복");
    cardIds.add(c.id);
  }
  for (const c of cs) {
    const r = c.r;
    for (const k of ["상태", "기능", "의도", "시험"]) if (!c.fields[k]?.trim() && !(k === "시험" && c.fields[k] !== undefined)) err(c, `**${k}** 없음`);
    if (!r.status) err(c, `상태 "${c.fields["상태"]}" — ✅ 🔜 ⏸ ✖ 중 하나로 시작`);
    for (const p of r.policies) { if (!polIds.has(p)) err(c, `정책 ${p} 없음`); usedPols.add(p); }
    for (const x of r.related) if (!cardIds.has(x)) err(c, `관련 ${x} 없음`);
    for (const l of r.labs) { if (!labs.has(l)) err(c, `lab \`${l}\` 없음`); usedLabs.add(l); }
    for (const s of r.scenes) if (!scenes.has(s)) err(c, `장면 \`${s}\` 없음`);
    for (const t of r.ts) if (!ts.includes(t)) err(c, `TS ${t} — TEST_SCENARIOS.md에 없음`);
    for (const f of r.oldTests) if (!flags.has(f)) err(c, `구 시험 \`${f}\` — main.cjs 시험 플래그에 없음`);
    for (const f of r.coreTests) if (!fns.has(f)) err(c, `코어 시험 \`${f}\` — core-rs에 없음`);
    for (const { file, names } of r.code) {
      const p = codePath(file);
      if (!fs.existsSync(p)) { err(c, `코드 ${file} 없음`); continue; }
      usedFiles.add(path.relative(REPO, p));
      if (fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, "utf8");
        const missing = names.filter((n) => !text.includes(n.replace(/\(\)$/, "")));
        if (missing.length) warns.push(`${c.file}:${c.line} ${c.id} — 코드 ${file}에 이름 없음: ${missing.join(" ")}`);
      }
    }
    const tests = r.labs.length + r.scenes.length + r.ts.length + r.oldTests.length + r.coreTests.length;
    if (r.status === "✅" && !tests && !r.gap) err(c, "✅인데 시험이 없음 — 시험을 넣거나 **부족:**에 적기");
    if (r.status === "✅" && r.gap) debt.push(`${c.id} ${c.title} — ${r.gap}`);
    if (r.manualOnly && !r.ts.length) err(c, "**수동만:**인데 수동 시험(TS …)이 없음");
    if (r.status === "✅" && r.manualOnly) manual.push(`${c.id} ${c.title} — ${r.manualOnly}`);
    if (r.status === "✅" && !r.code.length) warns.push(`${c.file}:${c.line} ${c.id} — **코드** 없음(델타가 이 카드를 못 찾음)`);
  }
  for (const l of labs) if (!usedLabs.has(l)) warns.push(`lab \`${l}\` — 어느 카드·정책에도 없음`);
  for (const p of ps) if (!usedPols.has(p.id) && !p.fields["범위"]) warns.push(`${p.id} ${p.title} — 이 정책을 가리키는 카드 없음`);
  // app code files no card points to (the spec's blind spots for a delta)
  const appFiles = ["electron", "src", "core-rs/src"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.(c?js|rs|css|html)$/.test(f) && !/lab|test/.test(path.basename(f)));
  for (const f of appFiles) { const rel = path.relative(REPO, f); if (!usedFiles.has(rel)) warns.push(`코드 ${path.relative(ROOT, f)} — 어느 카드에도 없음`); }
  console.log(`카드 ${cs.length} (${["✅", "🔜", "💡", "⏸", "✖"].map((s) => `${s} ${cs.filter((c) => c.r.status === s).length}`).join(" · ")}) · 정책 ${ps.length}`);
  if (debt.length) { console.log(`\n시험 부족 ${debt.length}:`); for (const d of debt) console.log(`  · ${d}`); }
  if (manual.length) { console.log(`\n수동만 ${manual.length} (자동 시험이 성격상 불가 — TEST_SCENARIOS로 확인):`); for (const d of manual) console.log(`  · ${d}`); }
  if (warns.length) { console.log(`\n경고 ${warns.length}:`); for (const w of warns) console.log(`  · ${w}`); }
  if (errors.length) { console.log(`\n오류 ${errors.length}:`); for (const e of errors) console.log(`  ✗ ${e}`); process.exit(1); }
  console.log("\n참조 오류 없음");
}
function walk(d) { if (!fs.existsSync(d)) return []; return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }

// ── impact ────────────────────────────────────────────────────────────────────
function show(c, why) {
  const r = c.r;
  const tests = [...r.labs.map((l) => `lab ${l}`), ...r.scenes.map((s) => `장면 ${s}`), ...r.ts.map((t) => `TS ${t}`), ...r.oldTests.map((t) => `구 시험 ${t}`), ...r.coreTests.map((t) => `코어 ${t}`)];
  console.log(`\n${c.id} ${c.title}  [${c.fields["상태"]}]  ${why ? `← ${why}` : ""}`);
  if (r.policies.length) console.log(`  정책: ${r.policies.join(", ")}`);
  if (tests.length) console.log(`  시험: ${tests.join(", ")}`);
  if (r.gap) console.log(`  부족: ${r.gap}`);
  if (r.code.length) console.log(`  코드: ${r.code.map((x) => `${x.file}${x.names.length ? ` (${x.names.join(" ")})` : ""}`).join(" · ")}`);
  console.log(`  문서: docs/spec/${c.file}:${c.line}`);
}
function relatedOf(cs, c) { // both ways
  return cs.filter((x) => x !== c && (c.r.related.includes(x.id) || x.r.related.includes(c.id)));
}
function impact(target) {
  const { cs, ps } = load();
  const norm = (f) => path.relative(ROOT, path.resolve(ROOT, f));
  let hit = [], why = target;
  if (CARD_ID.test(target)) hit = cs.filter((c) => c.id === target);
  else if (POL_ID.test(target)) {
    const p = ps.find((x) => x.id === target);
    if (p) console.log(`${p.id} ${p.title}\n  규칙: ${p.fields["규칙"]}\n  확인: ${p.fields["확인"]}\n  문서: docs/policy/${p.file}:${p.line}`);
    hit = cs.filter((c) => c.r.policies.includes(target)); why = `정책 ${target}`;
  } else if (/^#\d+$/.test(target)) hit = cs.filter((c) => c.r.issues.includes(target) || c.r.ts.includes(target));
  else if (fs.existsSync(path.resolve(ROOT, target)) || fs.existsSync(path.resolve(REPO, target))) {
    const rel = fs.existsSync(path.resolve(ROOT, target)) ? norm(target) : norm(path.relative(ROOT, path.resolve(REPO, target)));
    hit = cs.filter((c) => c.r.code.some((x) => norm(x.file) === rel || rel.startsWith(norm(x.file) + "/"))); why = `코드 ${rel}`;
  } else hit = cs.filter((c) => c.r.labs.includes(target) || c.r.scenes.includes(target) || c.r.oldTests.includes(target) || c.r.code.some((x) => x.names.includes(target)));
  if (!hit.length) { console.log(`"${target}"에 연결된 카드 없음`); return; }
  const seen = new Set();
  for (const c of hit) { show(c, why); seen.add(c.id); }
  const rel = hit.flatMap((c) => relatedOf(cs, c)).filter((c) => !seen.has(c.id));
  const viaPol = hit.flatMap((c) => c.r.policies.map((p) => [p, cs.filter((x) => x !== c && x.r.policies.includes(p))]));
  if (rel.length) { console.log("\n── 관련 카드"); for (const c of [...new Map(rel.map((c) => [c.id, c])).values()]) show(c, "관련"); }
  const pol = viaPol.filter(([, l]) => l.length);
  if (pol.length) { console.log("\n── 같은 정책이 걸린 다른 카드"); for (const [p, l] of pol) console.log(`  ${p}: ${[...new Set(l.map((c) => c.id))].join(", ")}`); }
}

// the delta: changed files → cards → what to run and look at again
// A card is hit directly when a name it owns is *changed*: the function a hunk sits in (git's hunk
// header), a definition on a changed line, or any other mention (a CSS class, a key). A changed line
// that only *calls* the name (renderBar(t), logLine(…)) is a weak hit: those cards are listed apart
// (a common helper otherwise pulls in every card that owns it — 2026-10-05: 12 cards for 2 fixes).
function delta(base) {
  const { cs } = load();
  const git = (a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
  // base: "v0.3.0-beta.28" (since then, plus uncommitted) or "A..B" (that range only)
  const range = base && base.includes("..") ? base : null;
  const files = new Set((range ? git(["diff", "--name-only", range]).split("\n") : [
    ...(base ? git(["diff", "--name-only", base, "HEAD"]) : "").split("\n"),
    ...git(["diff", "--name-only", "HEAD"]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]).filter(Boolean));
  // what changed in a file: hunk headers (the function each hunk sits in) and the changed lines
  const changed = (f) => {
    let text = "";
    try { text = git(["diff", "-U0", ...(range ? [range] : base ? [base] : ["HEAD"]), "--", f]); } catch {}
    if (!text) { try { return { heads: [], lines: fs.readFileSync(path.resolve(REPO, f), "utf8").split("\n") }; } catch { return { heads: [], lines: [] }; } } // new file: all of it
    // hunks inside the app's own test code (lab, UI scenes, *Test functions) don't count: they name many
    // features at once and would pull every card in
    const TEST_CODE = /function (lab\w*|uiScenes|fakeUsage|\w+Test)\b|LAB_CALLS|testCommands|lab-cases/;
    const hunks = text.split(/\n(?=@@)/).filter((h) => h.startsWith("@@") && !TEST_CODE.test(h.split("\n")[0]) && !/^\+.*(labState|labRun|LAB_CALLS)/m.test(h));
    return {
      heads: hunks.map((h) => h.split("\n")[0].replace(/^@@[^@]*@@/, "")),
      lines: hunks.flatMap((h) => h.split("\n").filter((l) => /^[+-](?![+-])/.test(l)).map((l) => l.slice(1))),
    };
  };
  const esc = (n) => n.replace(/\(\)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // a name counts only as a whole word (`status` in "statusLine" is not a hit)
  const word = (n) => new RegExp(`(^|[^\\w$])${esc(n)}([^\\w$]|$)`);
  const how = (n, d) => {
    if (d.heads.some((h) => word(n).test(h))) return "direct";
    const ls = d.lines.filter((l) => word(n).test(l));
    if (!ls.length) return null;
    const def = new RegExp(`(function\\*?\\s+|fn\\s+|class\\s+)${esc(n)}\\b|^\\s*(async\\s+)?${esc(n)}\\s*\\([^)]*\\)\\s*\\{|(const|let|var)\\s+${esc(n)}\\b|^\\s*${esc(n)}\\s*:`);
    const callOnly = (l) => [...l.matchAll(new RegExp(`(^|[^\\w$.])${esc(n)}(?=[^\\w$]|$)`, "g"))].every((m) => /^\s*\(/.test(l.slice(m.index + m[0].length)));
    return ls.some((l) => def.test(l) || !callOnly(l)) ? "direct" : "call";
  };
  const direct = new Map(), weak = new Map(), sameFile = new Map(), orphan = [];
  const add = (m, id, v) => m.set(id, [...(m.get(id) || []), v]);
  for (const f of files) {
    const abs = path.resolve(REPO, f), rel = path.relative(ROOT, abs);
    const inFile = cs.filter((c) => c.r.code.some((x) => { const p = path.relative(ROOT, path.resolve(ROOT, x.file)); return p === rel || rel.startsWith(p + "/"); }));
    if (!inFile.length) { orphan.push(f); continue; }
    const d = changed(f);
    if (!d.heads.length && !d.lines.length) continue;
    for (const c of inFile) {
      const names = c.r.code.filter((x) => path.relative(ROOT, path.resolve(ROOT, x.file)) === rel).flatMap((x) => x.names);
      if (!names.length) { add(direct, c.id, `${f} (이름 없음)`); continue; }
      const hits = names.map((n) => [n, how(n, d)]);
      const dn = hits.filter(([, h]) => h === "direct").map(([n]) => n), cn = hits.filter(([, h]) => h === "call").map(([n]) => n);
      if (dn.length) add(direct, c.id, `${f} (${dn.join(" ")})`);
      else if (cn.length) add(weak, c.id, `${f} (${cn.join(" ")} 부름)`);
      else add(sameFile, c.id, f);
    }
  }
  return { cs, files, direct, weak, sameFile, orphan, range };
}

function diff(base) {
  const { ps } = load();
  const { cs, files, direct, weak, sameFile, orphan, range } = delta(base);
  console.log(`변경 파일 ${files.size}${range ? ` (${range})` : base ? ` (${base} 이후 + 커밋 전)` : " (커밋 전)"}`);
  const hitCards = cs.filter((c) => direct.has(c.id));
  console.log(`\n── 직접 닿은 카드 ${hitCards.length} — 기능·규칙·이력을 볼 것`);
  for (const c of hitCards) show(c, direct.get(c.id).join(", "));
  const weakCards = cs.filter((c) => weak.has(c.id) && !direct.has(c.id));
  if (weakCards.length) { console.log(`\n── 부른 곳만 바뀜 (그 함수 자체는 그대로 — 대개 무관)`); for (const c of weakCards) console.log(`  ${c.id} ${c.title} ← ${weak.get(c.id).join(", ")}`); }
  const near = cs.filter((c) => sameFile.has(c.id) && !direct.has(c.id) && !weak.has(c.id));
  if (near.length) console.log(`\n── 같은 파일, 이름 안 닿음 (무관): ${near.length}개`);
  const rel = [...new Map(hitCards.flatMap((c) => relatedOf(cs, c)).filter((c) => !direct.has(c.id)).map((c) => [c.id, c])).values()];
  if (rel.length) console.log(`\n── 관련 카드 (규칙이 서로 맞는지만): ${rel.map((c) => c.id).join(", ")}`);
  const pols = [...new Set(hitCards.flatMap((c) => c.r.policies))];
  const labs = [...new Set(hitCards.flatMap((c) => c.r.labs))], scenes = [...new Set(hitCards.flatMap((c) => c.r.scenes))];
  const tsl = [...new Set(hitCards.flatMap((c) => c.r.ts))];
  console.log("\n── 다시 확인할 것");
  if (labs.length) console.log(`  랩: npm run lab -- ${labs.map((l) => `--only ${l}`).join(" ")}  (또는 --tag smoke)`);
  if (scenes.length) console.log(`  장면: npm run ui:shots  (${scenes.join(", ")})`);
  if (tsl.length) console.log(`  수동: TEST_SCENARIOS ${tsl.join(", ")}`);
  if (pols.length) console.log(`  정책: ${pols.map((p) => `${p} ${ps.find((x) => x.id === p)?.title || ""}`).join(" · ")}`);
  if (hitCards.length) console.log(`  카드 내용(기능·규칙·이력): ${hitCards.map((c) => c.id).join(", ")}`);
  const code = orphan.filter((f) => /^desktop\/(electron|src|core-rs\/src)\//.test(f));
  if (code.length) console.log(`\n── 명세에 없는 코드 변경 (카드의 **코드**에 넣거나 새 카드): ${code.join(", ")}`);
}

// release gate (scripts/release.cjs): every card the release's code changes hit directly must show
// it was looked at — its **이력** names an issue from the release's commits or the version. A card that
// was checked and needs nothing goes in --ok (ids, comma-separated). docs/ isn't in git, so this is
// the only place that ties a code change to its card.
function gate(range, version, ok = []) {
  const git = (a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
  const { cs, direct } = delta(range);
  if (!cs.length) { console.error("docs/spec 카드가 없음 — 이 맥의 docs/가 있어야 함"); process.exit(1); }
  const issues = [...new Set(all(/#(\d+)/g, git(["log", "--format=%B", range])).map((n) => `#${n}`))];
  const short = version ? version.replace(/^\d+\.\d+\.\d+-/, "") : null; // 0.3.0-beta.33 → beta.33
  const missing = cs.filter((c) => direct.has(c.id) && !ok.includes(c.id)
    && !c.r.issues.some((i) => issues.includes(i)) && !(short && (c.fields["이력"] || "").includes(short)));
  const bad = ok.filter((id) => !CARD_ID.test(id) || !cs.some((c) => c.id === id));
  if (bad.length) { console.error(`--spec-ok에 없는 카드: ${bad.join(", ")}`); process.exit(1); }
  if (!missing.length) { console.log(`명세: 닿은 카드 ${direct.size}개 모두 이력 있음${ok.length ? ` (확인만: ${ok.join(", ")})` : ""}`); return; }
  console.error(`명세: 이번 코드가 닿은 카드 중 이력에 ${issues.join(" ") || "이슈"}${short ? `·${short}` : ""}가 없는 카드 ${missing.length}개:`);
  for (const c of missing) console.error(`  ${c.id} ${c.title} ← ${direct.get(c.id).join(", ")}  (docs/spec/${c.file}:${c.line})`);
  console.error(`→ 카드의 기능·규칙을 보고 **이력**에 이슈 번호를 넣거나, 바꿀 게 없으면 --spec-ok ${missing.map((c) => c.id).join(",")}`);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "check") check();
else if (cmd === "impact" && args[0] === "--diff") diff(args[1]);
else if (cmd === "impact" && args[0]) impact(args.join(" "));
else if (cmd === "gate" && args[0]) gate(args[0], args[1], (args[2] || "").split(",").filter(Boolean));
else { console.error("usage: node scripts/spec.cjs check | impact <target> | impact --diff [base] | gate <A..B> [version] [ok-ids]"); process.exit(1); }
