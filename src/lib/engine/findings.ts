import { fmtBps, fmtDuration, fmtUnits, explorerAddress, explorerTx, shortAddr } from "@/lib/format";
import type { EscrowReport, Finding, OvernightTokenFlow, ParityReport, PoolSnapshot, ThreatBand, WalletReport, XrayReport } from "./types";

/**
 * Deterministic, documented scoring. Each finding carries the points it adds;
 * the score is the clamped sum. Bands: NOMINAL 0–29 · ELEVATED 30–64 · CRITICAL 65–100.
 */
export function bandFor(score: number): ThreatBand {
  if (score >= 65) return "CRITICAL";
  if (score >= 30) return "ELEVATED";
  return "NOMINAL";
}

export function totalScore(findings: Finding[]): number {
  return Math.max(0, Math.min(100, findings.reduce((s, f) => s + f.points, 0)));
}

export function xrayFindings(x: XrayReport): Finding[] {
  const out: Finding[] = [];
  const link = { label: "Bytecode ↗", href: explorerAddress(x.chainId, x.analyzedCodeAddress ?? x.address) + (x.chainId === 8453 ? "#code" : "?tab=contract") };
  const adminCtl = x.controllers.find((c) => c.role === "EIP-1967 admin slot");
  if (x.implementation) {
    const pts = !adminCtl || adminCtl.kind === "eoa" || adminCtl.kind === "eip7702" ? 25 : adminCtl.kind === "safe" ? 8 : adminCtl.kind === "renounced" ? 3 : 12;
    out.push({
      id: "proxy-mutable", severity: pts >= 20 ? "critical" : "warn", points: pts,
      title: "Mutable EIP-1967 proxy",
      detail: `Implementation ${shortAddr(x.implementation)} is swappable. Upgrade authority: ${adminCtl ? describeCtl(adminCtl) : "not readable from admin slot (likely UUPS — authority lives in implementation)"}.`,
      link: { label: "Implementation ↗", href: explorerAddress(x.chainId, x.implementation) },
    });
  }
  const owner = x.controllers.find((c) => c.role === "owner()") ?? x.controllers.find((c) => c.role === "admin()");
  const hasPrivileged = x.matchedSelectors.some((s) => s.severity === "high");
  if (owner) {
    if (owner.kind === "eoa" || owner.kind === "eip7702") {
      out.push({ id: "owner-eoa", severity: hasPrivileged ? "critical" : "warn", points: hasPrivileged ? 18 : 10, title: "Single-key owner", detail: `${owner.role} is an externally-owned account ${shortAddr(owner.address)} — one compromised key controls privileged functions.`, link: { label: "Owner ↗", href: explorerAddress(x.chainId, owner.address!) } });
    } else if (owner.kind === "safe") {
      out.push({ id: "owner-safe", severity: "info", points: owner.safeThreshold && owner.safeThreshold >= 2 ? 2 : 8, title: `Owner is a ${owner.safeThreshold}-of-${owner.safeOwners} Safe`, detail: `${owner.role} ${shortAddr(owner.address)} is a Safe multisig.`, link: { label: "Safe ↗", href: explorerAddress(x.chainId, owner.address!) } });
    } else if (owner.kind === "renounced") {
      out.push({ id: "owner-renounced", severity: "info", points: 0, title: "Ownership renounced", detail: `${owner.role} returns the zero/burn address — owner-gated functions are inert.` });
    } else {
      out.push({ id: "owner-contract", severity: "info", points: 5, title: "Owner is a contract", detail: `${owner.role} ${shortAddr(owner.address)} is a non-Safe contract (timelock, governor or factory) — review its own controls.`, link: { label: "Owner ↗", href: explorerAddress(x.chainId, owner.address!) } });
    }
  }
  const ownerInert = owner?.kind === "renounced";
  for (const s of x.matchedSelectors) {
    if (s.severity === "info") continue;
    const pts = ownerInert ? 1 : s.severity === "high" ? 8 : 4;
    out.push({ id: `sel-${s.selector}`, severity: s.severity === "high" && !ownerInert ? "warn" : "info", points: pts, title: s.label, detail: `${s.signature} (0x${s.selector}) found as a PUSH4 operand. ${s.explanation}${ownerInert ? " Owner renounced — likely inert." : ""}`, link });
  }
  if (x.isContract && !x.matchedSelectors.some((s) => s.severity !== "info") && !x.implementation) {
    out.push({ id: "xray-clean", severity: "info", points: 0, title: "No privileged selectors", detail: `Scanned ${x.push4Count} PUSH4 selectors in ${x.byteSize.toLocaleString("en-US")} bytes — no mint, blacklist, pause, tax or upgrade entry points.`, link });
  }
  if (x.hasSelfdestruct) out.push({ id: "selfdestruct", severity: "warn", points: 8, title: "SELFDESTRUCT opcode", detail: "Executable code contains SELFDESTRUCT (0xff). Post-Dencun it only clears balance unless in the creation tx, but it signals legacy kill-switch logic.", link });
  if (x.eip1167CloneTarget) out.push({ id: "clone", severity: "info", points: 0, title: "EIP-1167 minimal clone", detail: `Immutable clone of ${shortAddr(x.eip1167CloneTarget)} — logic cannot be upgraded.`, link: { label: "Logic ↗", href: explorerAddress(x.chainId, x.eip1167CloneTarget) } });
  return out;
}

function describeCtl(c: { kind: string; address: string | null; safeThreshold?: number; safeOwners?: number }) {
  if (c.kind === "safe") return `${c.safeThreshold}-of-${c.safeOwners} Safe ${shortAddr(c.address)}`;
  if (c.kind === "eoa") return `single EOA ${shortAddr(c.address)}`;
  if (c.kind === "renounced") return "renounced";
  return `${c.kind} ${shortAddr(c.address)}`;
}

export function poolFindings(p: PoolSnapshot): Finding[] {
  const out: Finding[] = [];
  const wethSide = p.token0.symbol.toUpperCase().includes("WETH") ? 0 : p.token1.symbol.toUpperCase().includes("WETH") ? 1 : null;
  const link = { label: "Pool ↗", href: explorerAddress(p.chainId, p.address) };
  if (wethSide !== null) {
    const r = BigInt(wethSide === 0 ? p.reserve0 : p.reserve1);
    const eth = r / 10n ** 18n;
    const label = p.reservesAreVirtual ? "active-range virtual WETH depth" : "WETH reserve";
    if (eth < 5n) out.push({ id: "depth-thin", severity: "critical", points: 15, title: "Thin exit liquidity", detail: `Only ${fmtUnits(r, 18, 3)} WETH ${label} — a single mid-size sell moves price sharply.`, link });
    else if (eth < 20n) out.push({ id: "depth-modest", severity: "warn", points: 8, title: "Modest exit liquidity", detail: `${fmtUnits(r, 18, 3)} WETH ${label}.`, link });
    else out.push({ id: "depth-ok", severity: "info", points: 0, title: "Healthy exit liquidity", detail: `${fmtUnits(r, 18, 2)} WETH ${label}.`, link });
  }
  const o = p.overnight;
  if (o.reserve0ChangeBps !== null && o.reserve0ChangeBps <= -1500) out.push({ id: "lp-drop", severity: "critical", points: 15, title: `LP depth ${fmtBps(o.reserve0ChangeBps)} overnight`, detail: `${p.token0.symbol} side of the pool fell ${fmtBps(o.reserve0ChangeBps)} over ${o.hours}h (${o.note})`, link });
  else if (o.reserve0ChangeBps !== null && o.reserve0ChangeBps <= -500) out.push({ id: "lp-dip", severity: "warn", points: 7, title: `LP depth ${fmtBps(o.reserve0ChangeBps)} overnight`, detail: o.note, link });
  if (o.priceChangeBps !== null && Math.abs(o.priceChangeBps) >= 2000) out.push({ id: "px-move", severity: "warn", points: 10, title: `Price ${fmtBps(o.priceChangeBps)} overnight`, detail: `${p.token1.symbol} priced in ${p.token0.symbol} moved ${fmtBps(o.priceChangeBps)} in ${o.hours}h.`, link });
  if (p.feeBps >= 100) out.push({ id: "fee-high", severity: "info", points: 2, title: `${(p.feeBps / 100).toFixed(2)}% pool fee`, detail: "High fee tier adds exit drag on every round trip.", link });
  return out;
}

export function flowFindings(f: OvernightTokenFlow, symbol: string, decimals: number, chainId: number): Finding[] {
  if (!f.available || !f.topHolder) return [];
  const h = f.topHolder;
  const link = { label: "Holder ↗", href: explorerAddress(chainId, h.address) };
  if (h.shareBps >= 1000) return [{ id: "whale-10", severity: "critical", points: 12, title: `Whale holds ${fmtBps(h.shareBps, false)} of supply`, detail: `Overnight-active ${h.isContract ? "contract" : "wallet"} ${shortAddr(h.address)} holds ${fmtUnits(h.balance, decimals, 0)} ${symbol}.`, link }];
  if (h.shareBps >= 500) return [{ id: "whale-5", severity: "warn", points: 6, title: `Whale holds ${fmtBps(h.shareBps, false)} of supply`, detail: `Overnight-active ${shortAddr(h.address)} holds ${fmtUnits(h.balance, decimals, 0)} ${symbol}.`, link }];
  return [{ id: "whale-ok", severity: "info", points: 0, title: "No dominant overnight whale", detail: `Largest overnight-active holder ${shortAddr(h.address)} has ${fmtBps(h.shareBps, false)} of supply. ${f.transferCount} transfers in ${f.hours}h.`, link }];
}

export function parityFindings(p: ParityReport): Finding[] {
  const out: Finding[] = [];
  if (!p.verified) {
    out.push({ id: "parity-drift", severity: "critical", points: 30, title: "OFT 1:1 invariant drift", detail: `Base locked ≠ Robinhood circulating by ${fmtUnits(p.delta, 18, 4)} VIBES. Could be an in-flight bridge message — re-check in a few blocks; persistent drift implies unbacked supply.`, link: { label: "Base adapter ↗", href: explorerAddress(8453, "0x408021Cb4ef1033675C70CF97788F3E03f45A381") } });
  } else {
    out.push({ id: "parity-ok", severity: "info", points: 0, title: "OFT 1:1 parity exact", detail: `${fmtUnits(p.lockedOnBase, 18, 2)} VIBES locked on Base = Robinhood circulating supply (Δ 0).` });
  }
  if (p.spreadBps !== null && Math.abs(p.spreadBps) >= 300) out.push({ id: "spread-wide", severity: "warn", points: 8, title: `Cross-venue spread ${fmtBps(p.spreadBps)}`, detail: `VIBES is cheaper on ${p.cheaperVenue === "robinhood" ? "Robinhood Chain" : "Base"}; net of ${p.feeDragBps} bps pool fees the edge is ${p.netEdgeBps} bps before gas & bridge fees.` });
  return out;
}

export function walletFindings(w: WalletReport): Finding[] {
  const out: Finding[] = [];
  const unlimited = w.approvals.filter((a) => a.unlimited);
  const fresh = w.approvals.filter((a) => a.discoveredOvernight);
  if (unlimited.length) out.push({ id: "approvals-unlimited", severity: unlimited.length >= 3 ? "critical" : "warn", points: Math.min(40, unlimited.length * 10), title: `${unlimited.length} unlimited approval${unlimited.length > 1 ? "s" : ""}`, detail: unlimited.map((a) => `${a.tokenSymbol} → ${a.spenderName}`).join(" · ") });
  const limited = w.approvals.length - unlimited.length;
  if (limited > 0) out.push({ id: "approvals-limited", severity: "info", points: Math.min(10, limited * 3), title: `${limited} bounded approval${limited > 1 ? "s" : ""}`, detail: "Non-zero but capped allowances — still revocable in the Panic Bunker." });
  if (fresh.length) out.push({ id: "approvals-overnight", severity: "critical", points: 15, title: `${fresh.length} approval${fresh.length > 1 ? "s" : ""} granted overnight`, detail: fresh.map((a) => `${a.tokenSymbol} → ${shortAddr(a.spender)}`).join(" · ") });
  if (w.eip7702Delegate) out.push({ id: "eip7702", severity: "warn", points: 10, title: "EIP-7702 delegated EOA", detail: `This EOA delegates execution to ${shortAddr(w.eip7702Delegate)} — verify that delegate is a wallet you trust.`, link: { label: "Delegate ↗", href: explorerAddress(w.chainId, w.eip7702Delegate) } });
  if (!w.approvals.length) out.push({ id: "approvals-clean", severity: "info", points: 0, title: "No live approvals to known spenders", detail: `${w.spendersChecked} spenders × tracked tokens checked, plus Permit2 sub-allowances.` });
  return out;
}

export function escrowFindings(e: EscrowReport): Finding[] {
  const out: Finding[] = [];
  const link = { label: "Escrow ↗", href: explorerAddress(e.chainId, e.address) };
  if (e.activeChallenge && e.activeChallenge.state === 1) out.push({ id: "challenge-active", severity: "critical", points: 30, title: `Backer challenge pending on tranche ${e.activeChallenge.tranche}`, detail: `Challenger ${shortAddr(e.activeChallenge.challenger)}: "${e.activeChallenge.reason}"`, link });
  if ([4, 5, 6].includes(e.state)) out.push({ id: "escrow-halted", severity: "critical", points: 40, title: `Campaign ${e.stateLabel}`, detail: e.state === 6 ? "Refund merkle root set — holders can claim refunds." : e.state === 5 ? "Admin froze the campaign after funding." : "Raise failed; contributor refunds available.", link });
  const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
  if (win) {
    const left = win.windowEndsAt - e.oracleTime;
    out.push({ id: "window-open", severity: "warn", points: 15, title: `72h challenge window open · ${win.label}`, detail: `Founder requested ${fmtUnits(win.amount, 18, 3)} ETH; backers holding ≥ ${e.challengeThresholdBps !== null ? (e.challengeThresholdBps / 100).toFixed(2) + "%" : "the threshold"} of supply can challenge for another ${fmtDuration(left)}.`, link });
  }
  if (e.state === 3 && !e.lpCreated) out.push({ id: "lp-missing", severity: "warn", points: 10, title: "LP not created", detail: "Funded escrow has not created its permanent liquidity position yet.", link });
  if (e.state === 3 && e.lpCreated) out.push({ id: "lp-ok", severity: "info", points: 0, title: "Permanent LP created", detail: e.lpLockTxHash ? "LP lock transaction verified via Vibestarter API." : "lpCreated() == true.", link: e.lpLockTxHash ? { label: "LP lock tx ↗", href: explorerTx(e.chainId, e.lpLockTxHash) } : link });
  if (e.capsule && !e.capsule.registered && e.chainId === 8453) out.push({ id: "no-capsule", severity: "info", points: 5, title: "No Origin Capsule", detail: "Token not registered in VibesRegistry (no onchain AI provenance attestation)." });
  if (e.appHealth && !e.appHealth.ok) out.push({ id: "app-down", severity: "warn", points: 8, title: "Founder app unreachable", detail: `${e.appHealth.url} returned ${e.appHealth.status ?? "no response"}.` });
  return out;
}
