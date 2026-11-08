// Live product facts the film quotes (from the production API, which reads Base + Robinhood Chain over RPC).
import fs from "node:fs";
const U = "https://usekestrel.vercel.app";
const j = async (p) => (await fetch(U + p, { headers: { "user-agent": "Kestrel-Film/1.0" } })).json();
const [parity, escrow, guard, status] = await Promise.all([
  j("/api/parity"),
  j("/api/scan?address=0x0e9bf34baed84a80d7647dafe4db52169147c911&chainId=8453"),
  j("/api/v1/guard?address=0xefFC8815487084a97edfdfF968b56Ea123421Acb&chainId=8453"),
  j("/api/pager/status"),
]);
const e = escrow.escrow ?? {};
const out = {
  readAtUtc: new Date().toISOString(),
  source: U,
  parity: { verdict: parity.verdict, delta: parity.delta, lockedOnBase: parity.lockedOnBase, rhCirculating: parity.rhCirculating, spreadBps: parity.spreadBps, baseBlock: parity.base?.number, rhBlock: parity.robinhood?.number },
  genesisEscrow: { address: "0x0e9bf34baed84a80d7647dafe4db52169147c911", title: e.title ?? null, raisedWei: e.raised ?? e.raisedWei ?? e.totalRaised ?? null, tranches: (e.tranches ?? []).map((t) => ({ label: t.label, status: t.status, amount: t.amount })), score: escrow.score, band: escrow.band, keys: Object.keys(e).slice(0, 30) },
  guardVibes: { verdict: guard.verdict, riskScore: guard.riskScore, band: guard.band },
  pager: { healthy: status.healthy, cadenceSec: status.cadenceSec, scheduler: status.scheduler?.kind, checks: status.checks },
};
fs.writeFileSync(new URL("../data/live.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
