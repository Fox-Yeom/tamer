// Rust dependencies (core-rs/Cargo.lock) checked against OSV.dev (the advisory database cargo-audit
// also feeds from), so no extra tool needs installing. Sends only crate names and versions.
// npm run audit = npm audit + this. Exit 1 when something is found.
const fs = require("node:fs");
const path = require("node:path");

const lock = fs.readFileSync(path.join(__dirname, "..", "core-rs", "Cargo.lock"), "utf8");
const pkgs = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)]
  .filter((m) => m[3]?.startsWith("registry+")) // crates.io only (not our own crate)
  .map((m) => ({ name: m[1], version: m[2] }));

(async () => {
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: pkgs.map((p) => ({ package: { name: p.name, ecosystem: "crates.io" }, version: p.version })) }),
  });
  if (!res.ok) { console.error(`OSV query failed: ${res.status}`); process.exit(2); }
  const { results } = await res.json();
  const hits = results.flatMap((r, i) => (r.vulns || []).map((v) => `${pkgs[i].name} ${pkgs[i].version}: ${v.id}`));
  console.log(`crates checked: ${pkgs.length}, advisories: ${hits.length}`);
  for (const h of hits) console.log("  " + h);
  process.exit(hits.length ? 1 : 0);
})();
