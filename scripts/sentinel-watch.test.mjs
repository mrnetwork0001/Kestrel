// Sentinel Watch (landing hero) unit suite: node --test scripts/sentinel-watch.test.mjs
// Node ≥ 22.18 / 23.6 strips TypeScript types natively, so the pure .ts modules are imported directly.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { ReplayBuffer, ReplayClock, minuteSweep, lagLabel, D_MIN, D_MAX } = await import(join(ROOT, "src/components/hero-sentinel/replay.ts"));
const { bearing, barLen } = await import(join(ROOT, "src/components/hero-sentinel/geometry.ts"));
const { classifyLogs, rhPerBlockGas, RH_GAS_PER_SEC } = await import(join(ROOT, "src/lib/engine/pulse-decode.ts"));

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
function chain(from, to, { anchorBlock = to, anchorT = 1_000_000, cad = 200, exact = true, ok = true, gas } = {}) {
  const len = to - from + 1;
  return {
    chainId: 8453,
    ok,
    logsOk: true,
    error: ok ? null : "down",
    from: ok ? String(from) : null,
    to: ok ? String(to) : null,
    gas: ok ? (gas ?? Array.from({ length: len }, (_, i) => ((i * 7) % 10) / 10)) : [],
    baseFeeWei: "5000000",
    anchor: ok ? { block: String(anchorBlock), timeMs: anchorT, exact } : null,
    cadenceMs: cad,
    logsTo: ok ? String(to - 3) : null,
  };
}
const off = { ...chain(0, 0, { ok: false }), chainId: 4663 };
const pulse = (base, rh = off, events = []) => ({ chains: { base, rh }, events });

// ── B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B1 merge dedupes overlapping windows", () => {
  const b = new ReplayBuffer();
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 })));
  b.merge(pulse(chain(130, 190, { anchorT: 190 * 200 })));
  const c = b.chains.base;
  assert.equal(c.n.length, 91);
  assert.deepEqual(c.n, Array.from({ length: 91 }, (_, i) => 100 + i));
  assert.equal(c.gaps.length, 0);
});

// ── B2 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B2 spacing stays in [0.5c, 1.5c] and monotonic under ±600 ms anchor jitter", () => {
  const b = new ReplayBuffer();
  const jitter = [0, 600, -600, 450, -300, 600, -600, 0, 200, -450, 600, -600];
  let to = 163;
  b.merge(pulse(chain(100, to, { anchorT: to * 200 })));
  for (const j of jitter) {
    const nt = to + 8;
    b.merge(pulse(chain(nt - 63, nt, { anchorT: nt * 200 + j })));
    to = nt;
  }
  const t = b.chains.base.t;
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    assert.ok(d >= 100 - 1e-9 && d <= 300 + 1e-9, `spacing ${d} at ${i}`);
  }
});

// ── B3 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B3 nothing beyond the newest received block; isDry after newest + 1500", () => {
  const b = new ReplayBuffer();
  b.merge(pulse(chain(100, 163, { anchorT: 50_000 })));
  const newest = b.newestTime("base");
  const [i0, i1] = b.range("base", newest - 60_000, newest + 10_000);
  assert.equal(b.chains.base.t[i1 - 1], newest);
  assert.ok(i1 - i0 === 64);
  assert.equal(b.replayedHead("base", newest + 5_000).n, 163);
  assert.equal(b.isDry("base", newest + 1_500), false);
  assert.equal(b.isDry("base", newest + 1_501), true);
});

// ── B4 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B4 [100..163] then [200..263] records a gap and never fills it", () => {
  const b = new ReplayBuffer();
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 })));
  b.merge(pulse(chain(200, 263, { anchorT: 263 * 200 })));
  const c = b.chains.base;
  assert.deepEqual(c.gaps, [[164, 199]]);
  assert.equal(c.n.length, 128);
  assert.ok(!c.n.some((n) => n > 163 && n < 200));
  const notes = b.drainNotices();
  assert.deepEqual(notes, [{ type: "GAP", chain: "base", from: 164, to: 199 }]);
  assert.equal(b.gapsIn("base", 150, 210), 36);
});

// ── B5 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B5 eventsDue fires exactly when replayNow ≥ t(block), once", () => {
  const b = new ReplayBuffer();
  const ev = { id: "8453:0xaa:3", chainId: 8453, block: "150", tx: "0xaa", logIndex: 3, kind: "P2_MAX", contact: false, summary: "x", spender: null };
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 }), off, [ev]));
  const t = b.blockTime("base", 150);
  assert.equal(t, b.chains.base.t[50]);
  assert.equal(b.eventsDue(t - 0.001).length, 0);
  assert.equal(b.eventsDue(t).length, 1);
  assert.equal(b.eventsDue(t + 10_000).length, 0);
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 }), off, [ev]));
  assert.equal(b.events.length, 1);
});

// ── B6 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B6 D stays in [1500, 8000], |ΔD| ≤ 0.04·dt, replayNow monotonic", () => {
  const c = new ReplayClock();
  let now = 10_000_000;
  let prevRn = -Infinity;
  let prevD = null;
  const leads = [-1800, -900, -2600, -400, -3100, -1200, -700, -5000, -200, -1500];
  for (let k = 0; k < 400; k++) {
    if (k % 90 === 0) c.sample(now + leads[(k / 90) % leads.length], now);
    if (k === 200) c.underrun();
    const dt = k % 7 === 0 ? 120 : 16.7; // includes stalls > 50 ms
    now += dt;
    const rn = c.tick(now, dt);
    assert.ok(rn >= prevRn, "monotonic");
    prevRn = rn;
    assert.ok(c.D >= D_MIN && c.D <= D_MAX, `D=${c.D}`);
    if (prevD !== null) assert.ok(Math.abs(c.D - prevD) <= 0.04 * Math.min(dt, 50) + 1e-9, "slew");
    prevD = c.D;
  }
});

// ── B7 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B7 geometry", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
  close(bearing(0), 0);
  close(bearing(15_000), Math.PI / 2);
  close(bearing(45_000), (3 * Math.PI) / 2);
  close(bearing(60_000), 0);
  close(bearing(-15_000), (3 * Math.PI) / 2);
  close(barLen(-1), 0.05);
  close(barLen(0), 0.05);
  close(barLen(0.25), 0.5);
  close(barLen(4), 1);
});

// ── B8 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("B8 identical inputs give deep-equal outputs", () => {
  const run = () => {
    const b = new ReplayBuffer();
    b.merge(pulse(chain(100, 163, { anchorT: 32_600 }), { ...chain(500, 627, { anchorT: 32_650, cad: 104, exact: false }), chainId: 4663 }));
    b.merge(pulse(chain(110, 171, { anchorT: 34_300 })));
    return { base: b.chains.base, rh: b.chains.rh, sweep: minuteSweep(b, 60_000) };
  };
  assert.deepEqual(run(), run());
});

// ── B9 ─────────────────────────────────────────────────────────────────────────────────────────────────────
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
test("B9 no Math.random in the sentinel watch, pulse engine or route", () => {
  const files = [
    ...walk(join(ROOT, "src/components/hero-sentinel")),
    ...readdirSync(join(ROOT, "src/lib/engine")).filter((f) => /^pulse.*\.ts$/.test(f)).map((f) => join(ROOT, "src/lib/engine", f)),
    ...walk(join(ROOT, "src/app/api/pulse")),
  ];
  assert.ok(files.length >= 9, `found ${files.length} files`);
  for (const f of files) assert.ok(!readFileSync(f, "utf8").includes("Math" + ".random"), f);
});

// ── B10: decode fixtures recorded from mainnet on 2026-11-07 ───────────────────────────────────────────────
const P2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const BASE_CTX = {
  chainId: 8453,
  permit2: P2,
  contact: new Set(["0xeffc8815487084a97edfdff968b56ea123421acb", "0x07f78058685b75f89288f025a0a154a96021ac45", "0x408021cb4ef1033675c70cf97788f3e03f45a381", "0x0e9bf34baed84a80d7647dafe4db52169147c911", "0x36c7e2d87f4e2d33b70304ebaa81ee88cb04bf86"]),
  vibestarter: new Set(["0x0e9bf34baed84a80d7647dafe4db52169147c911", "0x36c7e2d87f4e2d33b70304ebaa81ee88cb04bf86"]),
  symbols: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC", "0xeffc8815487084a97edfdff968b56ea123421acb": "VIBES" },
  spenders: { "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router v2 (v4)" },
  swapLabel: "AERODROME SWAP",
};
const RH_CTX = { ...BASE_CTX, chainId: 4663, contact: new Set(["0x9a73d60b9c8c2d330eb6d885e69fcc1399c33c18"]), vibestarter: new Set(), symbols: {}, spenders: {}, swapLabel: "UNISWAP V3 SWAP" };

// Base tx 0x86f506cb…9b3c, block 54,268,168, logIndex 7 — Permit2 Approval USDC → Universal Router v2 (v4).
const FIX_BASE_P2 = {
  address: P2,
  topics: [
    "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b",
    "0x00000000000000000000000009ad820aac5779683b481c4674208a4e1b024afa",
    "0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x0000000000000000000000006ff5693b99212da76ad316178a184ab56d299b43",
  ],
  data: "0x0000000000000000000000000000000000000000000000000000000004e0ce71000000000000000000000000000000000000000000000000000000006aeef192",
  blockNumber: "0x33c1108",
  transactionHash: "0x86f506cbafb729b1a0dff554c69e49049e65c6e21eeafc7132ef0062b6869b3c",
  logIndex: "0x7",
  removed: false,
};
// Robinhood tx 0x7fc9685a…6cdd, block 108,307,214, logIndex 0 — Permit2 Approval MAX uint160 → 0x8876…0904.
const FIX_RH_MAX = {
  address: P2,
  topics: [
    "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b",
    "0x0000000000000000000000004fbc61d50dce9daefc97f047ce8641c747b43cf0",
    "0x000000000000000000000000b0049eb3c0a51ce3679a18b61b893b23d5fded45",
    "0x0000000000000000000000008876789976decbfcbbbe364623c63652db8c0904",
  ],
  data: "0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff0000000000000000000000000000000000000000000000000000ffffffffffff",
  blockNumber: "0x674a30e",
  transactionHash: "0x7fc9685ab701d4115c64570d403d4b196afecebaa6c7dfdbc3f853a5463a6cdd",
  logIndex: "0x0",
  removed: false,
};
// Base tx 0xed966760…0e70, block 54,066,338 — $VIBES Transfer (pool → router), logIndex 85; same tx has the
// Aerodrome Sync (88) and Swap (89) on the VIBES/WETH pool.
const VIBES_TX = "0xed9667609b093c4da0ebc1dbcbc76188c7ab100e56fd835ca2dc27da3e210e70";
const FIX_VIBES_TRANSFER = {
  address: "0xeffc8815487084a97edfdff968b56ea123421acb",
  topics: [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "0x00000000000000000000000007f78058685b75f89288f025a0a154a96021ac45",
    "0x00000000000000000000000009ad820aac5779683b481c4674208a4e1b024afa",
  ],
  data: "0x00000000000000000000000000000000000000000000001a62b897ad0adb7c5d",
  blockNumber: "0x338fca2",
  transactionHash: VIBES_TX,
  logIndex: "0x55",
  removed: false,
};
const FIX_POOL_SYNC = {
  address: "0x07f78058685b75f89288f025a0a154a96021ac45",
  topics: ["0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a"],
  data: "0x0000000000000000000000000000000000000000000000008fc6100f09985370000000000000000000000000000000000000000000771713ffd7b65322db8c02",
  blockNumber: "0x338fca2",
  transactionHash: VIBES_TX,
  logIndex: "0x58",
  removed: false,
};
const FIX_POOL_SWAP = {
  address: "0x07f78058685b75f89288f025a0a154a96021ac45",
  topics: [
    "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b",
    "0x00000000000000000000000009ad820aac5779683b481c4674208a4e1b024afa",
    "0x00000000000000000000000009ad820aac5779683b481c4674208a4e1b024afa",
  ],
  data: "0x0000000000000000000000000000000000000000000000000000202d197c8f500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a62b897ad0adb7c5d",
  blockNumber: "0x338fca2",
  transactionHash: VIBES_TX,
  logIndex: "0x59",
  removed: false,
};

test("B10a Base Permit2 log to 0x6ff5… is labelled Uniswap Universal Router v2 (v4)", () => {
  const [e] = classifyLogs([FIX_BASE_P2], BASE_CTX);
  assert.equal(e.kind, "P2_GRANT");
  assert.equal(e.spenderLabel, "Uniswap Universal Router v2 (v4)");
  assert.equal(e.block, "54268168");
  assert.equal(e.id, "8453:0x86f506cbafb729b1a0dff554c69e49049e65c6e21eeafc7132ef0062b6869b3c:7");
  assert.equal(e.summary, "PERMIT2 GRANT USDC → Uniswap Universal Router v2 (v4)");
  assert.ok(!("owner" in e));
  assert.ok(!JSON.stringify(e).includes("09ad820aac5779683b481c4674208a4e1b024afa"), "owner never emitted");
});

test("B10b Robinhood MAX log decodes as P2_MAX with spenderLabel null", () => {
  const [e] = classifyLogs([FIX_RH_MAX], RH_CTX);
  assert.equal(e.kind, "P2_MAX");
  assert.equal(e.spenderLabel, null);
  assert.equal(e.summary, "PERMIT2 MAX 0xb004…ed45 → 0x8876…0904");
  assert.ok(!JSON.stringify(e).includes("4fbc61d50dce9daefc97f047ce8641c747b43cf0"), "owner never emitted");
});

test("B10c Base Transfer at #54,066,338 decodes as VIBES_TRANSFER contact; with the pool Swap it collapses to AERODROME SWAP", () => {
  const [e] = classifyLogs([FIX_VIBES_TRANSFER], BASE_CTX);
  assert.equal(e.kind, "VIBES_TRANSFER");
  assert.equal(e.contact, true);
  assert.equal(e.block, "54066338");
  const all = classifyLogs([FIX_VIBES_TRANSFER, FIX_POOL_SYNC, FIX_POOL_SWAP], BASE_CTX);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "VIBES_SWAP");
  assert.equal(all[0].summary, "AERODROME SWAP");
  assert.equal(all[0].logIndex, 85);
});

test("B10d a log with removed: true is skipped", () => {
  assert.equal(classifyLogs([{ ...FIX_BASE_P2, removed: true }], BASE_CTX).length, 0);
  assert.equal(classifyLogs([{ ...FIX_BASE_P2, blockNumber: null }], BASE_CTX).length, 0);
});

test("REVOKE: amount 0 → P2_REVOKE", () => {
  const zero = { ...FIX_BASE_P2, data: "0x" + "0".repeat(64) + FIX_BASE_P2.data.slice(66) };
  assert.equal(classifyLogs([zero], BASE_CTX)[0].kind, "P2_REVOKE");
});

// ── B6b: stale first sample → no stall after start, real lag disclosed, caught up within 10 s ─────────────────
test("B6b stale first lead (−7000) then fresh (−400): no stall > 250 ms, T− = now − rn, lag ≤ D + |L| + 1 s at 10 s", () => {
  const c = new ReplayClock();
  let now = 50_000_000;
  // before any sample: nothing is recorded, so the pre-start value can never hold the arm
  c.tick(now, 16);
  assert.equal(c.prev, -Infinity);
  const leads = [-7000, -400, -400, -400, -400, -400, -400, -400, -400, -400];
  let k = 0;
  let nextSample = now;
  let prevRn = null;
  let stallFrom = null;
  let maxStall = 0;
  let startedAt = null;
  const dt = 16.7;
  while (now < 50_000_000 + 15_000) {
    if (now >= nextSample) {
      c.sample(now + leads[Math.min(k, leads.length - 1)], now);
      k++;
      nextSample += 1_500;
      if (k === 2) c.lock(); // the component goes live (and locks) after two fresh samples
    }
    now += dt;
    const rn = c.tick(now, dt);
    if (c.locked) {
      startedAt ??= now;
      if (prevRn !== null && rn <= prevRn) stallFrom ??= now - dt;
      else stallFrom = null;
      if (stallFrom !== null) maxStall = Math.max(maxStall, now - stallFrom);
      // the chip text is the real lag of the replayed instant
      const shown = Number(lagLabel(now, rn).replace(/[^0-9.]/g, "")) * 1000;
      assert.ok(Math.abs(shown - (now - rn)) <= 100, `shown ${shown} vs lag ${now - rn}`);
      if (now - startedAt >= 10_000) {
        assert.ok(Math.abs(c.Le - c.L) < 1, `Le ${c.Le} caught up to L ${c.L}`);
        assert.ok(now - rn <= c.D + Math.abs(c.L) + 1_000, `lag ${now - rn} vs D ${c.D} + |L| ${Math.abs(c.L)}`);
        assert.ok(now - rn < 5_000, `lag ${now - rn} (was ~11 s before the fix)`);
      }
      prevRn = rn;
    }
  }
  assert.ok(maxStall <= 250, `stall ${maxStall} ms`);
});

test("B6c locked clock catches up at ≤ 1.25× and never freezes when L jumps forward", () => {
  const c = new ReplayClock();
  let now = 1_000_000;
  c.sample(now - 6_000, now);
  c.lock();
  c.sample(now - 400, now); // L jumps +5.6 s after lock
  let prev = c.tick(now, 16);
  for (let i = 0; i < 600; i++) {
    now += 16;
    const rn = c.tick(now, 16);
    const rate = (rn - prev) / 16;
    assert.ok(rate > 0.95 && rate <= 1.25 + 1e-9, `rate ${rate}`);
    prev = rn;
  }
});

test("B6d underrun boost decays with every fresh sample", () => {
  const c = new ReplayClock();
  c.sample(-500, 0);
  c.underrun();
  c.underrun();
  assert.equal(c.boost, 800);
  for (let i = 1; i <= 8; i++) c.sample(i * 1_500 - 500, i * 1_500);
  assert.equal(c.boost, 0);
  assert.ok(c.Dstar < 2_500, `D* ${c.Dstar} back near its base`);
});

// ── B11: Robinhood gas — Nitro's per-second running sum → per-block gas (live sample, 2026-11-07) ────────────
// eth_feeHistory(40) gasUsedRatio + eth_getBlockByNumber gasUsed for #108,344,284–#108,344,323 (rhgas sample).
const RH_SAMPLE = {"oldest": 108344284, "ratios": [1, 1, 1, 0.02699714285714286, 0.028497142857142856, 0.05170742857142857, 0.05398842857142857, 0.08009064285714286, 0.10578307142857143, 0.11816928571428571, 0.13392335714285714, 0.15094907142857142, 0.1991797857142857, 0.03844578571428572, 0.0505685, 0.06429285714285714, 0.07867014285714286, 0.10061192857142857, 0.120804, 0.125063, 0.22971557142857144, 0.30839464285714285, 0.32295035714285714, 0.0053153571428571425, 0.043335, 0.06988664285714286, 0.09243842857142857, 0.11098771428571429, 0.12369578571428572, 0.12560392857142857, 0.1462587142857143, 0.14959292857142859, 0.21265435714285713, 0.008819214285714286, 0.011501, 0.031228071428571428, 0.04958714285714286, 0.061403928571428575, 0.07358928571428572, 0.07549742857142858], "gasUsed": [286021, 198521, 241979, 377960, 21000, 324944, 31934, 365431, 359694, 173407, 220557, 238360, 675230, 538241, 169718, 192141, 201282, 307185, 282689, 59626, 1465136, 1101507, 203780, 74415, 532275, 371723, 315725, 259690, 177913, 26714, 289167, 46679, 882860, 123469, 37545, 276179, 257027, 165435, 170595, 26714], "ts": [1794047905, 1794047905, 1794047905, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047906, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047907, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047908, 1794047909, 1794047909, 1794047909, 1794047909, 1794047909, 1794047909, 1794047909]};
test("B11 rhPerBlockGas recovers each Robinhood block's own gasUsed; window start / saturated readings are null", () => {
  const cad = 100;
  const out = rhPerBlockGas(RH_SAMPLE.ratios, cad);
  assert.equal(out.length, RH_SAMPLE.ratios.length);
  let checked = 0;
  for (let i = 0; i < out.length; i++) {
    const r = RH_SAMPLE.ratios[i];
    const p = RH_SAMPLE.ratios[i - 1];
    if (i === 0 || r >= 1 || p >= 1) {
      assert.equal(out[i], null, `block ${RH_SAMPLE.oldest + i} unknown`);
      continue;
    }
    const used = out[i] * RH_GAS_PER_SEC * (cad / 1000);
    assert.ok(Math.abs(used - RH_SAMPLE.gasUsed[i]) <= 20, `#${RH_SAMPLE.oldest + i}: ${used} vs ${RH_SAMPLE.gasUsed[i]}`);
    checked++;
  }
  assert.ok(checked >= 30, `checked ${checked}`);
  // the running sum's sawtooth is gone: no per-block value equals the raw cumulative ratio mid-second
  assert.ok(out.filter((x) => x !== null && x >= 1).length <= 2, "no false 100% blocks");
});

// ── B12: sweep only grows over successful log reads; failed windows are gaps ────────────────────────────────
test("B12 logsOk=false windows never extend the sweep; gaps are counted", () => {
  const b = new ReplayBuffer();
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 })));
  assert.deepEqual(b.chains.base.logSegs, [[100, 160]]);
  b.merge(pulse({ ...chain(140, 203, { anchorT: 203 * 200 }), logsOk: false, error: "getLogs failed" }));
  assert.equal(b.chains.base.logsTo, 160, "failed window does not extend the sweep");
  assert.equal(b.chains.base.logsOk, false);
  b.merge(pulse(chain(200, 263, { anchorT: 263 * 200 })));
  assert.deepEqual(b.chains.base.logSegs, [[100, 160], [200, 260]]);
  assert.equal(b.logCoverage("base", 150, 170), "partial");
  assert.equal(b.logCoverage("base", 165, 195), "none");
  assert.equal(b.logCoverage("base", 200, 260), "full");
});

// ── B13: go-live marks history as shown ─────────────────────────────────────────────────────────────────────
test("B13 markEmittedUpTo: events up to the go-live instant are never re-streamed", () => {
  const b = new ReplayBuffer();
  const mk = (blk, li) => ({ id: `8453:0x${blk}:${li}`, chainId: 8453, block: String(blk), tx: `0x${blk}`, logIndex: li, kind: "P2_GRANT", contact: false, summary: "x", spender: null });
  b.merge(pulse(chain(100, 163, { anchorT: 163 * 200 }), off, [mk(110, 0), mk(120, 1), mk(150, 0)]));
  const t = b.blockTime("base", 130);
  b.markEmittedUpTo(t);
  const due = b.eventsDue(b.newestTime("base"));
  assert.deepEqual(due.map((e) => e.bn), [150]);
});
