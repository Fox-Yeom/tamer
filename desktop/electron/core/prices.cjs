// Model prices for an estimated cost (#23): an agent that gives no cost of its own (Claude typed in
// the shell, Codex) shows "≈$" = its tokens × these prices. Source: LiteLLM's public price list (the
// one ccusage uses), fetched only when such an agent reports tokens, at most once a day; only the
// Anthropic / OpenAI models are kept. Nothing is sent but the request itself (POLICY 2.2).
//   $CVIM_CACHE_DIR/prices.json  { at, models: { id: [input, cache write 5 min, cache write 1 h, cache read, output] } } (USD per token)
const path = require("node:path");
const { CACHE, readJson, writeJson } = require("./paths.cjs");

const URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const FILE = path.join(CACHE, "prices.json");
const DAY = 24 * 3600 * 1000;
let loading = null;

function pick(all) {
  const models = {};
  for (const [id, v] of Object.entries(all || {})) {
    if (id.includes("/") || !["anthropic", "openai"].includes(v?.litellm_provider)) continue; // plain ids, not cloud resellers
    const input = v.input_cost_per_token, output = v.output_cost_per_token;
    if (typeof input !== "number" || typeof output !== "number") continue;
    const write = v.cache_creation_input_token_cost ?? input;
    models[id] = [input, write, v.cache_creation_input_token_cost_above_1hr ?? write, v.cache_read_input_token_cost ?? input, output];
  }
  return models;
}

// { at, models } — the cached list while it's fresh; else fetched (the old one if offline)
function get() {
  const cur = readJson(FILE, null);
  if (cur?.models && Date.now() - cur.at < DAY) return Promise.resolve(cur);
  if (!loading) {
    // tests: a local copy of the list instead of the network
    const source = process.env.CVIM_PRICES_JSON
      ? Promise.resolve(readJson(process.env.CVIM_PRICES_JSON, null))
      : process.env.CVIM_DESKTOP_TEST === "1" && process.env.CVIM_TEST_OFFLINE ? Promise.reject(new Error("offline (test)"))
      : fetch(URL, { headers: { "User-Agent": "tamer" }, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null));
    loading = source.then((all) => {
      const models = pick(all);
      if (!Object.keys(models).length) return cur;
      const t = { at: Date.now(), models };
      writeJson(FILE, t);
      return t;
    }).catch(() => cur).finally(() => { loading = null; });
  }
  return loading;
}

module.exports = { get, pick };
