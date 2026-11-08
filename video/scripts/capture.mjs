// Records the real, live Kestrel app (https://usekestrel.vercel.app) and Basescan for the demo film. READ-ONLY:
// no wallet, no transactions, no Pager desk or watch, no x402 payment, no Telegram. The only clicks are tabs,
// scenario presets, the pager's dry-run "Evaluate" (it says "Nothing is sent") and the x402 playground's steps
// 1 and 2 (plain GETs: a free verdict and the HTTP 402 challenge).
//   ONLY=bell,heist node scripts/capture.mjs  re-records just those (marks/meta are merged)
// Output: .cache/frames/<clip>/ (JPEG screencast + frames.json), .cache/marks.json (event times),
// .cache/meta.json (per clip: element rects in CSS px) and stills in public/stills/.
// scripts/encode.mjs turns the frames into public/footage/<clip>.mp4.
//
// The window is 1600x900 CSS px at device scale 2 (frames 3200x1800).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = process.env.BASE || "https://usekestrel.vercel.app";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
const ONLY = process.env.ONLY?.split(",");
const want = (clip) => !ONLY || ONLY.includes(clip);
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const mark = (k) => { marks[k] = Date.now() / 1000; log("mark", k); };
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};

// A visible pointer (headless Chrome draws none), a click ring and an eased scroll helper.
const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = 'html{scroll-behavior:auto!important}#__cur{position:fixed;left:-40px;top:-40px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,255,255,.96);box-shadow:0 0 0 2px rgba(145,217,130,.85),0 4px 16px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:2px solid rgba(145,217,130,.95);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;

let b;
const js = (e) => b.js(e);
async function overlay() { await js(OVERLAY); }
async function glide(x, y, settle = 900) {
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function cursorAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); if (!k) return; const t = k.style.transition; k.style.transition = 'opacity .3s ease'; k.style.left = '${x}px'; k.style.top = '${y}px'; k.offsetWidth; k.style.transition = t; k.style.opacity = '1'; })()`);
}
async function cursorHide() { await js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`); }
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const centerOf = (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const rectOf = async (finder) => { const r = await b.rectOf(finder); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; };
/** Absolute document y of an element's top. */
const docY = (finder) => js(`(() => { const e = ${finder}; return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })()`);
const scrollTo = (y, ms) => js(`window.__ease(document.scrollingElement, 'scrollTop', ${y}, ${ms})`);
const parkMouse = () => b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEW.w - 4, y: VIEW.h - 4 });
/** Glide to an element and click it (real mouse events). */
async function press(finder, settle = 700) {
  const p = await centerOf(finder);
  if (!p) throw new Error("press: not found " + finder.slice(0, 90));
  await glide(p.x, p.y, 1000);
  await clickAt(p.x, p.y);
  await sleep(settle);
  return p;
}
/** Types text into the focused field, a key at a time, like a person. */
async function typeText(text, cps = 16) {
  for (const ch of text) {
    await b.send("Input.insertText", { text: ch });
    await sleep(1000 / cps + Math.random() * 30);
  }
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().replace(/\\s+/g, ' ').startsWith(${JSON.stringify(text)}))`;
const byAria = (sel, label) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)}))`;
const heading = (text) => byText("h1,h2,h3", text);
async function waitFor(cond, ms = 30000, what = cond) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${cond})`).catch(() => false)) return true; await sleep(400); }
  throw new Error("timed out waiting for " + String(what).slice(0, 120));
}

let stopRec = null;
async function rec(name) {
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  stopRec = await b.screencast(dir);
  if (meta[name]) meta[name].rects = {};
  mark(`${name}:start`);
}
async function endRec(name) {
  if (!stopRec) return;
  mark(`${name}:end`);
  const frames = await stopRec();
  stopRec = null;
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  log(`${name}: ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / Math.max(span, 0.001)).toFixed(1)} fps)`);
}
function setMeta(clip, data) {
  const prev = meta[clip] || {};
  meta[clip] = { deviceScale: SCALE, viewport: VIEW, ...prev, ...data, rects: { ...(prev.rects || {}), ...(data.rects || {}) } };
}
async function still(name, finder) { await b.shot(join(STILLS, `${name}.png`), finder); log("still", name); }

/** Opens a route with the guide already marked seen, waits for it to settle, adds the pointer. */
async function open(route, { settle = 6000 } = {}) {
  await b.goto(BASE + route, settle);
  await overlay();
  await parkMouse();
  const errs = await js(`/Application error|Something went wrong|500|This page could not be found/.test(document.title + ' ' + document.body.innerText.slice(0, 400))`);
  if (errs) log("WARN: page shows an error?", route);
}

// ---------------------------------------------------------------- clips
const CLIPS = {};
const V = "0xefFC8815487084a97edfdfF968b56Ea123421Acb"; // $VIBES on Base
const E = "0x0e9bf34baed84a80d7647dafe4db52169147c911"; // Genesis tranche escrow
const W = "0xCd0a2370F2dC12c1802707B7d9aB3fec891E3c02"; // the demo wallet (clean since 07:07 UTC)
const tabBtn = (t) => `[...document.querySelectorAll('a,button,[role=tab]')].find((e) => e.textContent.trim() === ${JSON.stringify(t)})`;
const sectionOf = (finder) => `((${finder}) && ((${finder}).closest('section') || (${finder}).parentElement.parentElement))`;
const smallest = (re, max = 3000) => `[...document.querySelectorAll('section, article, div')].filter((e) => ${re}.test(e.innerText) && e.innerText.length < ${max}).sort((a, b) => a.innerText.length - b.innerText.length)[0]`;

/** Landing: the live Sentinel Watch, then paste the $VIBES address and run a scan (no wallet). */
CLIPS.hero = async () => {
  await open("/", { settle: 9000 });
  const watch = smallest(`/SENTINEL WATCH/`, 4000);
  setMeta("hero", { url: "usekestrel.vercel.app", rects: { watch: await rectOf(watch), headline: await rectOf(`document.querySelector('h1')`) } });
  await rec("hero");
  await sleep(7000);
  mark("hero.input");
  const input = `document.querySelector('input')`;
  setMeta("hero", { rects: { input: await rectOf(`(${input}).closest('form') || (${input}).parentElement.parentElement`) } });
  await press(input, 500);
  await b.send("Input.insertText", { text: V });
  mark("hero.pasted");
  await sleep(1200);
  mark("hero.run");
  await press(byText("button", "RUN SCAN"), 200);
  await cursorHide();
  await waitFor(`document.body.innerText.includes('/ 100') && location.pathname === '/app'`, 30000, "scan result").catch((e) => log(e.message));
  await overlay();
  mark("hero.result");
  await sleep(1200);
  setMeta("hero", { rects: { score: await rectOf(smallest(`/OVERNIGHT THREAT/`, 200)), head: await rectOf(`document.querySelector('h1').parentElement.parentElement`) } });
  await sleep(5000);
  await endRec("hero");
  await still("hero_result");
};

/** The Pager tab on the demo wallet: the public proof-of-watch log, then a dry-run evaluation (nothing is sent). */
CLIPS.pager = async () => {
  await open(`/app?target=${W}&chain=8453&tab=pager`, { settle: 9000 });
  const logBox = sectionOf(byText("h3", "Night-shift log"));
  const y = await docY(byText("h3", "[ Your desk ]"));
  await scrollTo(Math.max(0, (y ?? 500) - 120), 10);
  await sleep(800);
  setMeta("pager", { url: "usekestrel.vercel.app/app?tab=pager", rects: { log: await rectOf(logBox), desk: await rectOf(sectionOf(byText("h3", "[ Your desk ]"))) } });
  await rec("pager");
  await sleep(4000);
  mark("pager.eval");
  const ev = `[...document.querySelectorAll('button')].find((e) => /^EVALUATE/i.test(e.textContent.trim()))`;
  const ey = await docY(ev);
  if (ey != null && ey - (await js("scrollY")) > 760) { await scrollTo(ey - 560, 1600); await sleep(600); }
  await press(ev, 300);
  await cursorHide();
  await sleep(3500);
  mark("pager.result");
  setMeta("pager", { rects: { evalBox: await rectOf(sectionOf(byText("h3", "[ Live evaluation & message ]"))) } });
  await sleep(4500);
  await endRec("pager");
  await still("pager_eval");
  console.log("EVAL:", await js(`(${sectionOf(byText("h3", "[ Live evaluation & message ]"))})?.innerText`));
};

/** The Panic Bunker on the demo wallet now: nothing left to revoke, score 0. */
CLIPS.after = async () => {
  await open(`/rescue?target=${W}&chain=8453`, { settle: 10000 });
  const y = await docY(byText("h1", "EOA"));
  await scrollTo(Math.max(0, (y ?? 300) - 60), 10);
  await sleep(1000);
  setMeta("after", { url: "usekestrel.vercel.app/rescue?target=0xCd0a…3c02", rects: {
    head: await rectOf(`(${byText("h1", "EOA")}).parentElement.parentElement`),
    none: await rectOf(sectionOf(byText("h3", "Step 2"))),
  } });
  await rec("after");
  await sleep(3000);
  mark("after.scroll");
  const s2 = await docY(byText("h3", "Step 2"));
  await scrollTo(Math.max(0, (s2 ?? 900) - 300), 2200);
  await sleep(800);
  setMeta("after", { rects: { none2: await rectOf(sectionOf(byText("h3", "Step 2"))), rail: await rectOf(smallest(`/LIVE . RESCUE|LIVE.{0,4}RESCUE/`, 600)) } });
  await sleep(4000);
  await endRec("after");
  await still("after");
  console.log(await js(`(${sectionOf(byText("h3", "Step 2"))})?.innerText`));
};

/** Rug Lab on $VIBES (a simulation on live reserves), then the Parity tab. */
CLIPS.lab = async () => {
  await open(`/app?target=${V}&chain=8453&tab=chaos`, { settle: 9000 });
  const ty = await docY(tabBtn("Rug Lab"));
  await scrollTo(Math.max(0, (ty ?? 500) - 30), 10);
  await sleep(1200);
  setMeta("lab", { url: "usekestrel.vercel.app/app?tab=chaos", rects: {
    outcome: await rectOf(sectionOf(byText("h2", "Exit outcome"))),
    scen: await rectOf(`(${byText("button", "Top whale dumps 100%")}).parentElement.parentElement`),
  } });
  await rec("lab");
  await sleep(2500);
  mark("lab.whale");
  await press(byText("button", "Top whale dumps 100%"), 300);
  await sleep(3500);
  mark("lab.lp");
  await press(byText("button", "50% liquidity pulled"), 300);
  await cursorHide();
  await sleep(3500);
  console.log("LAB:", await js(`(${sectionOf(byText("h2", "Exit outcome"))})?.innerText.slice(0, 600)`));
  mark("lab.parity");
  await press(tabBtn("Parity"), 300);
  await cursorHide();
  await waitFor(`/Not one wei apart/.test(document.body.innerText)`, 20000, "parity").catch((e) => log(e.message));
  await sleep(1500);
  mark("lab.delta");
  setMeta("lab", { rects: { parity: await rectOf(sectionOf(byText("h2", "Not one wei apart."))) } });
  await sleep(5500);
  await endRec("lab");
  await still("parity");
  console.log("PARITY:", await js(`(${sectionOf(byText("h2", "Not one wei apart."))})?.innerText.slice(0, 900)`));
};

/** Parity tab on $VIBES: locked on Base equals circulating on Robinhood Chain. */
CLIPS.parity = async () => {
  await open(`/app?target=${V}&chain=8453&tab=parity`, { settle: 10000 });
  await waitFor(`/Not one wei apart/.test(document.body.innerText)`, 20000, "parity");
  const ty = await docY(tabBtn("Parity"));
  await scrollTo(Math.max(0, (ty ?? 500) - 30), 10);
  await sleep(1200);
  const sec = sectionOf(byText("h2", "Not one wei apart."));
  setMeta("parity", { url: "usekestrel.vercel.app/app?tab=parity", rects: { parity: await rectOf(sec), delta: await rectOf(`(${byText("h2", "Not one wei apart.")}).parentElement`) } });
  await rec("parity");
  await sleep(4000);
  mark("parity.table");
  const y = await docY(byText("h2", "Base vs Robinhood Chain"));
  await scrollTo(Math.max(0, (y ?? 900) - 380), 2400);
  await sleep(1000);
  setMeta("parity", { rects: { table: await rectOf(sectionOf(byText("h2", "Base vs Robinhood Chain"))) } });
  await sleep(3500);
  await endRec("parity");
  await still("parity");
  console.log("PARITY:", await js(`(${sec})?.innerText.slice(0, 900)`));
};

/** Backer Shield on the Genesis escrow: raise, next unlock countdown, tranches. */
CLIPS.shield = async () => {
  await open(`/app?target=${E}&chain=8453&tab=shield`, { settle: 10000 });
  const ty = await docY(tabBtn("Backer Shield"));
  await scrollTo(Math.max(0, (ty ?? 500) - 30), 10);
  await sleep(1200);
  setMeta("shield", { url: "usekestrel.vercel.app/app?tab=shield", rects: {
    main: await rectOf(`(${byText("h2", "Vibestarter")}).parentElement`),
    tranches: await rectOf(`(${byText("h3", "Tranches")}).parentElement`),
  } });
  await rec("shield");
  await sleep(4500);
  mark("shield.scroll");
  const y = await docY(byText("h3", "Tranches"));
  await scrollTo(Math.max(0, (y ?? 1200) - 420), 2600);
  await sleep(1000);
  setMeta("shield", { rects: { tranches2: await rectOf(`(${byText("h3", "Tranches")}).parentElement`), copilot: await rectOf(sectionOf(byText("h2", "Live // Backer Challenge Co-pilot"))) } });
  await sleep(4500);
  await endRec("shield");
  await still("shield");
  console.log(await js(`(${byText("h2", "Vibestarter")})?.parentElement?.innerText.slice(0, 900)`));
};

/** /agents: the x402 playground steps 1 and 2 (free verdict, then the 402 challenge), the revenue ledger, MCP. */
CLIPS.agents = async () => {
  await open("/agents", { settle: 9000 });
  await rec("agents");
  await sleep(3000);
  setMeta("agents", { url: "usekestrel.vercel.app/agents", rects: { top: await rectOf(`document.querySelector('h1').parentElement`) } });
  mark("agents.play");
  const py = await docY(byText("h2", "Run the handshake yourself."));
  await scrollTo(Math.max(0, (py ?? 2000) - 90), 2400);
  await sleep(800);
  const play = sectionOf(byText("h2", "Run the handshake yourself."));
  setMeta("agents", { rects: { play: await rectOf(play) } });
  await press(byText("button", "1 · FREE PREVIEW"), 300);
  mark("agents.free");
  await sleep(3000);
  await press(byText("button", "2 · REQUEST FULL"), 300);
  mark("agents.402");
  await cursorHide();
  await sleep(3500);
  setMeta("agents", { rects: { play2: await rectOf(play) } });
  console.log("PLAY:", await js(`(${play})?.innerText.slice(0, 1200)`));
  mark("agents.ledger");
  const ly = await docY(byText("h2", "Revenue, proven onchain"));
  await scrollTo(Math.max(0, (ly ?? 3000) - 90), 2400);
  await sleep(1000);
  setMeta("agents", { rects: { ledger: await rectOf(sectionOf(byText("h2", "Revenue, proven onchain"))) } });
  await sleep(3500);
  mark("agents.mcp");
  const my = await docY(byText("h2", "An MCP server with 11 tools"));
  await scrollTo(Math.max(0, (my ?? 4000) - 90), 2400);
  await sleep(1000);
  setMeta("agents", { rects: { mcp: await rectOf(sectionOf(byText("h2", "An MCP server with 11 tools"))) } });
  await sleep(4000);
  await endRec("agents");
  await still("agents_mcp");
  console.log("LEDGER:", await js(`(${sectionOf(byText("h2", "Revenue, proven onchain"))})?.innerText.slice(0, 900)`));
};

/** Basescan: the key transactions, read back in data/onchain.json. */
const TXS = JSON.parse(readFileSync(join(ROOT, "data/onchain.json"), "utf8")).txs;
const KEY = { scan_approve: "0xea2c13aa", scan_revoke: "0xa3ca5b37", scan_swap: "0x5d1a02b4", scan_x402: "0xe79c92c1" };
CLIPS.scan = async () => {
  for (const [clip, pre] of Object.entries(KEY)) {
    if (ONLY && ONLY.includes("scan") === false && !ONLY.includes(clip)) continue;
    const tx = TXS.find((t) => t.hash.startsWith(pre));
    await b.goto(`https://basescan.org/tx/${tx.hash}`, 6000);
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 10 && /moment|attention/i.test(await js("document.title")); i++) await sleep(2500);
      if (await js(`/Transaction Details|Transaction Hash/i.test(document.body.innerText)`)) break;
      log("scan: retry", clip); await sleep(5000); await b.goto(`https://basescan.org/tx/${tx.hash}`, 8000);
    }
    await sleep(1500);
    await js(`(${byText("button,a", "Got it!")})?.click()`).catch(() => {});
    await sleep(500);
    await overlay();
    if (!(await js(`/Transaction Details|Transaction Hash/i.test(document.body.innerText)`))) { log("scan: explorer page did not load for", clip, await js("document.title")); await still(`fail_${clip}`); continue; }
    await rec(clip);
    await sleep(4000);
    await scrollTo(320, 2400);
    await sleep(3000);
    await endRec(clip);
    await still(clip);
    setMeta(clip, { url: `basescan.org/tx/${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`, hash: tx.hash });
  }
};

// ---------------------------------------------------------------- run
const order = Object.keys(CLIPS).filter(want);
// A plain desktop Chrome profile (the explorer's bot check refuses an obvious headless one).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
b = await launch({ width: VIEW.w, height: VIEW.h, extraArgs: [`--force-device-scale-factor=${SCALE}`, "--disable-blink-features=AutomationControlled", `--user-agent=${UA}`] });
await b.send("Network.enable");
await b.send("Network.setUserAgentOverride", { userAgent: UA, platform: "MacIntel" });
await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })" });
await b.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: SCALE, mobile: false });
const hardStop = setTimeout(() => { log("HARD TIMEOUT"); b.close(); process.exit(2); }, 1_800_000);
try {
  await b.goto(BASE + "/how-it-works", 3000);
  for (const name of order) {
    log("clip", name);
    try { await CLIPS[name](); } catch (e) { log(`CLIP ${name} FAILED`, e.message); if (stopRec) await endRec(name); }
    save();
  }
} finally {
  save();
  if (b.consoleLines.length) log("console:", b.consoleLines.slice(0, 12).join("\n"));
  clearTimeout(hardStop);
  b.close();
}
