// Wild encounter card (main window and desktop overlay): "야생의 ○○이(가) 나타났다!", throw a
// Poké Ball (click / ⌘B), shakes, caught / broke free / fled. The main process decides the
// outcome (electron/core/wild.cjs) and tells both windows; this only plays it.

// Korean particles after a name: 이/가, 을/를, 은/는, (으)로
export function josa(name, withFinal, without) {
  const c = String(name ?? "").charCodeAt(String(name ?? "").length - 1);
  if (c < 0xac00 || c > 0xd7a3) return `${name}${withFinal}(${without})`;
  return name + ((c - 0xac00) % 28 ? withFinal : without);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the balls (#76, PKM-23 rule 1, SCREENS_P3 S7): Poké Ball free and endless, the rest bought in the shop
const BALLS = [["poke", "몬스터볼"], ["great", "슈퍼볼"], ["ultra", "하이퍼볼"], ["master", "마스터볼"]];
const BALL_NAME = Object.fromEntries(BALLS);
let lastBall = "poke"; // ⌘B throws the ball picked last (back to the Poké Ball when it runs out)

export function createWild(root, { invoke, partnerButton, dexButton, log = () => {} }) {
  root.innerHTML = `
    <div class="wild-card" hidden>
      <span class="wild-badge" hidden>⭐ 대발견</span>
      <div class="wild-stage"><div class="grass"><span>🌿</span><span>🌿</span><span>🌿</span></div>
        <img class="wild-poke" alt="" /><div class="wild-ball pokeball-static"></div><div class="fx"></div></div>
      <div class="wild-text"></div>
      <div class="wild-balls" hidden></div>
      <div class="wild-actions"><button class="wild-throw" tabindex="-1">⚾ 몬스터볼 <span class="k">⌘B</span></button>
        <button class="wild-partner" tabindex="-1" hidden>이 탭의 파트너로</button>
        <button class="wild-dex" tabindex="-1" hidden>📕 도감에서 보기</button><span class="wild-timer dim"></span></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const card = $(".wild-card"), img = $(".wild-poke"), ball = $(".wild-ball"), text = $(".wild-text");
  const btn = $(".wild-throw"), adopt = $(".wild-partner"), dexBtn = $(".wild-dex"), timer = $(".wild-timer"), chips = $(".wild-balls");
  let enc = null, busy = false, hideTimer = null, tick = null, balls = {};

  // the ball chips: only the balls you have (none bought = the card as it always was, one button)
  function drawBalls() {
    const have = (k) => k === "poke" || (balls[k] || 0) > 0;
    if (!have(lastBall)) lastBall = "poke";
    const any = BALLS.some(([k]) => k !== "poke" && have(k));
    chips.hidden = !any || btn.hidden;
    chips.innerHTML = any ? BALLS.filter(([k]) => have(k)).map(([k, n]) => `<button class="bc${k === lastBall ? " on" : ""}" data-ball="${k}" tabindex="-1" title="${n}"><span class="wb ${k}"></span>${n} ${k === "poke" ? "∞" : balls[k]}</button>`).join("") : "";
    btn.classList.toggle("gold", lastBall === "master");
    btn.innerHTML = lastBall === "poke" ? '⚾ 몬스터볼 <span class="k">⌘B</span>' : lastBall === "master" ? '확정 — 마스터볼 <span class="k">⌘B</span>' : `${BALL_NAME[lastBall]} 던지기 <span class="k">⌘B</span>`;
  }
  chips.addEventListener("mousedown", (e) => e.preventDefault());
  chips.addEventListener("click", (e) => { const b = e.target.closest("[data-ball]"); if (b && !busy) { lastBall = b.dataset.ball; drawBalls(); } });

  // buttons must not take the keyboard away from the terminal
  for (const b of [btn, adopt, dexBtn]) b.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => throwBall());
  adopt.addEventListener("click", () => { const e = adopt.enc; hide(); if (e && partnerButton) partnerButton(e); });
  dexBtn.addEventListener("click", () => { const e = adopt.enc; hide(); if (e && dexButton) dexButton(e); });

  function say(html) { text.innerHTML = html; }
  const name = (e) => `${e.shiny ? "✨" : ""}<b>${String(e.name).replace(/[&<>"]/g, "")}</b>`;
  const nm = (e, a, b) => name(e) + josa(e.name, a, b).slice(String(e.name ?? "").length);

  function hide() {
    clearTimeout(hideTimer); clearInterval(tick); hideAt = 0;
    card.hidden = true; enc = null; busy = false; adopt.hidden = true; dexBtn.hidden = true;
  }
  // the card goes after ms — also when the window comes back after that (a window behind other apps may
  // have its timers held back, and the caught card was still there on return, #80)
  let hideAt = 0;
  function hideLater(ms) { clearTimeout(hideTimer); hideAt = Date.now() + ms; hideTimer = setTimeout(hide, ms); }
  const late = () => { if (hideAt && !card.hidden && Date.now() >= hideAt) hide(); };
  window.addEventListener("focus", late);
  document.addEventListener("visibilitychange", late);

  function countdown() {
    clearInterval(tick);
    if (enc?.big) { timer.textContent = "도망가지 않아요"; return; } // ⭐ a breakthrough waits (#82)
    const draw = () => { if (enc?.until) timer.textContent = `${Math.max(0, Math.ceil((enc.until - Date.now()) / 1000))}초`; };
    draw();
    tick = setInterval(draw, 500);
  }

  async function show(e) {
    clearTimeout(hideTimer); hideAt = 0;
    enc = e; busy = false;
    if (e.balls) balls = e.balls;
    card.hidden = false;
    card.className = `wild-card appearing${e.big ? " legend" : ""}`;
    $(".wild-badge").hidden = !e.big;
    $(".wild-badge").textContent = e.research ? "✦ 리서치" : "⭐ 대발견"; // #86
    img.className = "wild-poke";
    ball.className = "wild-ball pokeball-static";
    btn.hidden = false; btn.disabled = false; adopt.hidden = true; dexBtn.hidden = true;
    try {
      img.src = `data:image/gif;base64,${await invoke("sprite_b64", { path: e.gif })}`;
      await img.decode().catch(() => {});
      img.style.width = `${img.naturalWidth * (img.naturalWidth < 60 ? 2 : 1)}px`;
    } catch { img.removeAttribute("src"); }
    say(e.big ? `${e.research ? "환상의" : "전설의"} ${nm(e, "이", "가")} 나타났다!${e.pity > 1 ? `<br><span class="dim">놓칠수록 잡기 쉬워져요 ×${e.pity}</span>` : ""}` : `앗! 야생의 ${nm(e, "이", "가")} 나타났다!`);
    drawBalls();
    countdown();
    setTimeout(() => card.classList.remove("appearing"), 1200);
  }

  // false = nothing to throw at (a ball already in the air counts as handled)
  function throwBall() {
    if (!enc) return false;
    if (busy) return true;
    busy = true;
    btn.disabled = true;
    // not thrown (previous ball still shaking / error): the button comes back
    const back = () => { if (enc && !btn.hidden) { busy = false; btn.disabled = false; } };
    invoke("wild_throw", { token: enc.token, ball: lastBall }).then((r) => {
      if (r.balls) { balls = r.balls; drawBalls(); }
      if (r.result === "busy" || r.result === "noball") back(); // no such ball any more: the chips now say so
    }).catch(back);
    return true;
  }

  // the outcome (to every window): ball flies, Pokémon goes in, shakes, then the result
  async function play(r) {
    if (!enc || r.token !== enc.token) return;
    busy = true; btn.disabled = true;
    clearInterval(tick); // the clock stops while the ball plays out (#11)
    if (r.balls) { balls = r.balls; drawBalls(); }
    chips.hidden = true;
    say(`가랏! ${BALL_NAME[r.ball] || "몬스터볼"}!`);
    ball.className = "wild-ball pokeball-static fly";
    await wait(500);
    img.classList.add("absorbed");
    ball.className = "wild-ball pokeball-static landed";
    await wait(300);
    for (let i = 0; i < r.shakes; i++) {
      ball.classList.add("shake");
      await wait(500);
      ball.classList.remove("shake");
      await wait(100);
    }
    await wait(300);
    if (r.result === "caught") {
      ball.classList.add("caught");
      burst("✨", 8);
      say(`신난다! ${nm(enc, "을", "를")} 잡았다!${r.coins ? ` +${r.coins}코인 · 새 종` : ""}`); // a species never caught before (#72, 표기 #75)
      btn.hidden = true;
      clearInterval(tick); timer.textContent = "";
      adopt.enc = { ...enc };
      if (partnerButton) adopt.hidden = false;
      if (dexButton) dexBtn.hidden = false;
      log(`wild caught ${enc.id}`);
      hideLater(partnerButton ? 10000 : 4000);
    } else {
      ball.className = "wild-ball pokeball-static";
      img.classList.remove("absorbed");
      if (r.result === "fled") {
        say(`앗! 볼에서 나와버렸다!<br>${nm(enc, "은", "는")} 도망쳐 버렸다…`);
        img.classList.add("flee");
        btn.hidden = true;
        clearInterval(tick); timer.textContent = "";
        hideLater(3000);
      } else {
        if (r.big) enc.pity = r.pity;
        say((r.shakes >= 2 ? "아깝다! 조금만 더 하면 잡을 수 있었는데!" : "앗! 볼에서 나와버렸다!") + (r.big ? `<br><span class="dim">도망가지 않아요 · 다음엔 ×${r.pity}</span>` : ""));
        if (r.left) enc.until = Date.now() + r.left;
        countdown();
        busy = false; btn.disabled = false;
        drawBalls();
      }
    }
  }

  function burst(glyph, n) {
    const fx = root.querySelector(".fx");
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      const a = (Math.PI * 2 * i) / n;
      s.textContent = glyph;
      s.style.setProperty("--dx", `${Math.cos(a) * 50}px`);
      s.style.setProperty("--dy", `${Math.sin(a) * 50}px`);
      fx.appendChild(s);
      setTimeout(() => s.remove(), 800);
    }
  }

  // it went away (no throw in time / switched off); caught / fled endings already played
  function end(e) {
    if (!enc || e.token !== enc.token) return;
    if (e.reason === "left" || e.reason === "off") {
      say(`${nm(enc, "은", "는")} 풀숲으로 돌아갔다…`);
      img.classList.add("flee");
      btn.hidden = true;
      clearInterval(tick); timer.textContent = "";
      hideLater(2500);
    }
  }

  return { show, play, end, throwBall, hide, active: () => !!enc && !card.hidden, token: () => enc?.token };
}
