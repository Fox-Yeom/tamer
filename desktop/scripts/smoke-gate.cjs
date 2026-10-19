// Did the test lab pass on exactly this commit (docs/TESTING.md)? Every smoke case, real data
// untouched — on this commit, or on its desktop/ content before it was committed (the run records
// the tree it built). Used by npm run preview (develop) and npm run release (main).
//   bump: npm run bump after the run changes only package.json's "version" line — allowed (release)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function smokePassed(git, { bump = false } = {}) {
  const lab = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cache/tamer-dev/lab-last.json"), "utf8")); } catch { return null; } })();
  const commitTree = git(["rev-parse", "HEAD:desktop"]);
  const onlyBump = (() => {
    if (!bump || !lab?.tree || lab.tree === commitTree) return false;
    try {
      if (git(["diff", "--name-only", lab.tree, commitTree]) !== "package.json") return false;
      // ":(top)": the trees are desktop/'s own, so the path is from their root — not from this folder
      const lines = git(["diff", "-U0", lab.tree, commitTree, "--", ":(top)package.json"]).split("\n").filter((l) => /^[+-](?![+-])/.test(l));
      return lines.length === 2 && lines.every((l) => /^[+-]\s*"version": "[^"]+",?$/.test(l));
    } catch { return false; }
  })();
  const ok = !!lab?.smoke && ((lab.head === git(["rev-parse", "HEAD"]) && !lab.dirty) || (lab.tree && lab.tree === commitTree) || onlyBump);
  const why = ok ? "" : `the test lab hasn't passed on this commit's content — cd desktop && npm run lab -- --tag smoke (last: ${lab ? `${lab.head.slice(0, 7)}${lab.dirty ? " with uncommitted changes" : ""}, content ${lab.tree?.slice(0, 10) || "?"} vs commit ${commitTree.slice(0, 10)}, smoke ${lab.smoke ? "pass" : "not met"}` : "none"})`;
  return { ok, why, lab, commitTree };
}

module.exports = { smokePassed };
