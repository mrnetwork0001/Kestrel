// Reads every on-chain fact the film quotes back from Base mainnet (read-only RPC) into data/onchain.json.
// Demo wallet approvals (the risk), the Panic Bunker rescue txs, and the first x402 settlement.
import fs from "node:fs";
const RPC = "https://base-rpc.publicnode.com";
const WALLET = "0xCd0a2370F2dC12c1802707B7d9aB3fec891E3c02";
const X402_TX = "0xe79c92c1a29ccb3ef6efa848fffd34650b732941699c68f54d818f490a3522ee";
const TOK = { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ["USDC", 6], "0xeffc8815487084a97edfdff968b56ea123421acb": ["VIBES", 18], "0x4200000000000000000000000000000000000006": ["WETH", 18] };
const SPENDER = { "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2", "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "Aerodrome Router", "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router" };
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let id = 0;
async function rpc(method, params) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json();
    if (!j.error) return j.result;
    await new Promise((s) => setTimeout(s, 800 * (i + 1)));
  }
  throw new Error(method + " failed");
}
const hex = (n) => "0x" + n.toString(16);
const topicAddr = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const head = BigInt(await rpc("eth_blockNumber", []));
const FROM = head - 120_000n; // ~6.7 h of 200 ms blocks
const logs = [];
for (let lo = FROM; lo <= head; lo += 45_000n) {
  const hi = lo + 44_999n > head ? head : lo + 44_999n;
  for (const [topics] of [[[APPROVAL, topicAddr(WALLET)]], [[TRANSFER, topicAddr(WALLET)]], [[TRANSFER, null, topicAddr(WALLET)]]]) {
    const r = await rpc("eth_getLogs", [{ fromBlock: hex(lo), toBlock: hex(hi), address: Object.keys(TOK), topics }]);
    logs.push(...r);
  }
}
const byTx = new Map();
for (const l of logs) { if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, []); byTx.get(l.transactionHash).push(l); }
byTx.set(X402_TX, byTx.get(X402_TX) ?? []);
const blockTime = new Map();
async function timeOf(bn) { if (!blockTime.has(bn)) { const b = await rpc("eth_getBlockByNumber", [bn, false]); blockTime.set(bn, Number(BigInt(b.timestamp))); } return blockTime.get(bn); }
const fmt = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, "0"); const i = s.slice(0, -d), f = s.slice(-d).replace(/0+$/, ""); return f ? `${i}.${f}` : i; };
const MAX = 2n ** 256n - 1n;
const txs = [];
for (const hash of byTx.keys()) {
  const rc = await rpc("eth_getTransactionReceipt", [hash]);
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  const t = await timeOf(rc.blockNumber);
  const events = rc.logs.filter((l) => TOK[l.address.toLowerCase()] && (l.topics[0] === APPROVAL || l.topics[0] === TRANSFER)).map((l) => {
    const [sym, dec] = TOK[l.address.toLowerCase()];
    const a = "0x" + l.topics[1].slice(26), b = "0x" + l.topics[2].slice(26);
    const v = BigInt(l.data);
    if (l.topics[0] === APPROVAL) return { type: "Approval", token: sym, owner: a, spender: b, spenderName: SPENDER[b.toLowerCase()] ?? null, amount: v === MAX ? "unlimited" : fmt(v, dec), raw: v.toString() };
    return { type: "Transfer", token: sym, from: a, to: b, amount: fmt(v, dec), raw: v.toString() };
  });
  txs.push({ hash, block: Number(BigInt(rc.blockNumber)), utc: new Date(t * 1000).toISOString(), from: tx.from, to: tx.to, nonce: Number(BigInt(tx.nonce)), status: rc.status === "0x1" ? "success" : "reverted", gasUsed: Number(BigInt(rc.gasUsed)), feeWei: (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + BigInt(rc.l1Fee ?? "0x0")).toString(), events, explorer: `https://basescan.org/tx/${hash}` });
}
txs.sort((a, b) => a.block - b.block);
const out = { chain: "Base mainnet (8453)", wallet: WALLET, readAtUtc: new Date().toISOString(), headBlock: Number(head), scannedFromBlock: Number(FROM), txs };
fs.writeFileSync(new URL("../data/onchain.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
for (const t of txs) console.log(t.nonce, t.utc.slice(11, 19), t.hash.slice(0, 12), t.status, t.events.map((e) => e.type === "Approval" ? `APPROVE ${e.token}->${e.spenderName ?? e.spender.slice(0, 8)} ${e.amount}` : `${e.token} ${e.amount} ${e.from.slice(0, 6)}->${e.to.slice(0, 6)}`).join(" | "));
