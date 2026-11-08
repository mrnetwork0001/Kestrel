import { fmtBps, fmtDuration, fmtUnits, explorerAddress, explorerTx, shortAddr } from "@/lib/format";
import { known7702Delegate } from "./eip7702";
import { poolSides } from "./sides";
import type { ControllerPosture, EscrowReport, Finding, OvernightTokenFlow, ParityReport, PoolSnapshot, ThreatBand, WalletReport, XrayReport } from "./types";

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

/** Follow a non-Safe contract controller (ProxyAdmin, beacon…) to the key behind it, when resolved. */
function effectiveCtl(c: ControllerPosture): ControllerPosture {
  return c.kind === "contract" && c.resolvedOwner ? effectiveCtl(c.resolvedOwner) : c;
}

function describeCtl(c: ControllerPosture): string {
  const base =
    c.kind === "safe" ? `${c.safeThreshold}-of-${c.safeOwners} Safe ${shortAddr(c.address)}`
    : c.kind === "eoa" ? `single EOA ${shortAddr(c.address)}`
    : c.kind === "eip7702" ? `EIP-7702 EOA ${shortAddr(c.address)}${c.label ? ` (${c.label})` : ""}`
    : c.kind === "renounced" ? "renounced (zero/burn address)"
    : c.kind === "unknown" ? `UNKNOWN${c.address ? ` ${shortAddr(c.address)}` : ""}${c.label ? ` — ${c.label}` : ""}`
    : `contract ${shortAddr(c.address)}`;
  return c.kind === "contract" && c.resolvedOwner ? `${base} owned by ${describeCtl(c.resolvedOwner)}` : base;
}

/** Points for whoever can change the code / privileged config, by the key that really decides. */
function authorityPoints(c: ControllerPosture | null): number {
  if (!c) return 15;
  const e = effectiveCtl(c);
  if (e.kind === "eoa" || e.kind === "eip7702") return 25;
  if (e.kind === "safe") return e.safeThreshold && e.safeThreshold >= 2 ? 8 : 18;
  if (e.kind === "renounced") return 3;
  if (e.kind === "unknown") return 15;
  return 12; // unresolved contract: timelock / governor / factory
}

const PROXY_TITLES: Record<string, string> = {
  "eip1967-transparent": "Mutable proxy (EIP-1967 transparent)",
  "eip1967-uups": "Mutable proxy (UUPS)",
  "eip1967-beacon": "Mutable proxy (beacon)",
  "zeppelinos-legacy": "Mutable proxy (legacy ZeppelinOS)",
  eip897: "Mutable proxy (EIP-897)",
};

/** Max points all selector capabilities together can add (owner/proxy posture is scored separately). */
const SELECTOR_POINTS_CAP = 24;

export function xrayFindings(x: XrayReport): Finding[] {
  const out: Finding[] = [];
  const link = { label: "Bytecode ↗", href: explorerAddress(x.chainId, x.analyzedCodeAddress ?? x.address) + (x.chainId === 8453 ? "#code" : "?tab=contract") };
  const degraded = x.degraded === true;
  if (degraded) {
    out.push({ id: "xray-degraded", severity: "warn", points: 10, title: "X-Ray incomplete — RPC read failed", detail: `Results are UNKNOWN, not clean: ${(x.degradedReasons ?? []).slice(0, 3).join("; ") || "an RPC read failed"}. Re-scan to complete the inspection.` });
  }

  // 1 · Upgradeability: one finding, scored by the key that can actually swap the logic.
  const auth = x.upgradeAuthority ?? null;
  const isProxy = !!x.implementation && x.proxyKind !== "eip1167-clone" && x.proxyKind !== "none";
  if (isProxy && x.implementation) {
    const pts = authorityPoints(auth);
    const via = x.proxyKind === "eip1967-beacon" && x.beacon ? ` (via beacon ${shortAddr(x.beacon)})` : "";
    const authText = auth
      ? describeCtl(auth)
      : x.proxyKind === "eip1967-uups"
        ? "not readable — UUPS keeps it in the implementation, and no owner()/DEFAULT_ADMIN_ROLE holder answered"
        : "not readable";
    out.push({
      id: "proxy-mutable", severity: pts >= 20 ? "critical" : "warn", points: pts,
      title: PROXY_TITLES[x.proxyKind] ?? "Mutable proxy",
      detail: `Implementation ${shortAddr(x.implementation)}${via} is swappable. Upgrade authority: ${authText}.`,
      link: { label: "Implementation ↗", href: explorerAddress(x.chainId, x.implementation) },
    });
  }

  // 2 · Owner posture. Not raised by selector hits (those score on their own), and not re-scored
  //     when the owner IS the upgrade key already scored above.
  const owner = x.controllers.find((c) => c.role === "owner()") ?? x.controllers.find((c) => c.role === "admin()");
  const hasPrivileged = x.matchedSelectors.some((s) => s.severity === "high" && s.capability !== "upgrade");
  if (owner) {
    const e = effectiveCtl(owner);
    const sameKeyAsUpgrade = isProxy && !!auth && !!effectiveCtl(auth).address && effectiveCtl(auth).address?.toLowerCase() === e.address?.toLowerCase();
    const ownerLink = owner.address ? { label: "Owner ↗", href: explorerAddress(x.chainId, owner.address) } : undefined;
    const scoredNote = sameKeyAsUpgrade ? " Same key as the upgrade authority — scored once above." : "";
    if (e.kind === "eoa" || e.kind === "eip7702") {
      out.push({ id: "owner-eoa", severity: hasPrivileged ? "critical" : "warn", points: sameKeyAsUpgrade ? 0 : 10, title: "Single-key owner", detail: `${owner.role} resolves to ${describeCtl(owner)} — one compromised key controls privileged functions.${scoredNote}`, link: ownerLink });
    } else if (e.kind === "safe") {
      out.push({ id: "owner-safe", severity: "info", points: sameKeyAsUpgrade ? 0 : e.safeThreshold && e.safeThreshold >= 2 ? 2 : 8, title: `Owner is a ${e.safeThreshold}-of-${e.safeOwners} Safe`, detail: `${owner.role} resolves to ${describeCtl(owner)}.${scoredNote}`, link: ownerLink });
    } else if (e.kind === "renounced") {
      out.push({ id: "owner-renounced", severity: "info", points: 0, title: "Ownership renounced", detail: `${owner.role} ${owner.kind === "renounced" ? "returns" : `resolves via ${describeCtl(owner)} to`} the zero/burn address — owner-gated functions are inert.` });
    } else if (e.kind === "unknown") {
      out.push({ id: "owner-unknown", severity: "warn", points: sameKeyAsUpgrade ? 0 : 8, title: "Owner posture unknown", detail: `${owner.role}: ${describeCtl(owner)}. Treat as an unverified key until a re-scan succeeds.${scoredNote}`, link: ownerLink });
    } else {
      out.push({ id: "owner-contract", severity: "info", points: sameKeyAsUpgrade ? 0 : 5, title: "Owner is a contract", detail: `${owner.role} ${describeCtl(owner)} is a non-Safe contract (timelock, governor or factory) — review its own controls.${scoredNote}`, link: ownerLink });
    }
  }

  // 3 · Privileged entry points, one finding per CAPABILITY (blacklist/addToBlacklist/setBlacklist score once).
  const ownerInert = owner ? effectiveCtl(owner).kind === "renounced" : false;
  const caps = new Map<string, typeof x.matchedSelectors>();
  for (const s of x.matchedSelectors) {
    if (s.severity === "info") continue;
    const cap = s.capability ?? s.label;
    if (cap === "upgrade" && isProxy) continue; // already the proxy-mutable finding
    caps.set(cap, [...(caps.get(cap) ?? []), s]);
  }
  let selectorBudget = SELECTOR_POINTS_CAP;
  for (const [cap, sels] of caps) {
    const top = sels.find((s) => s.severity === "high") ?? sels[0];
    const want = ownerInert ? 1 : top.severity === "high" ? 8 : 4;
    const pts = Math.min(want, selectorBudget);
    selectorBudget -= pts;
    const list = sels.map((s) => `${s.signature} (0x${s.selector})`).join(", ");
    out.push({
      id: `cap-${cap}`,
      severity: top.severity === "high" && !ownerInert ? "warn" : "info",
      points: pts,
      title: top.label,
      detail: `Dispatcher entry point${sels.length > 1 ? "s" : ""} ${list}. ${top.explanation}${ownerInert ? " Owner renounced — likely inert." : ""}${pts < want ? " (selector points capped)" : ""}`,
      link,
    });
  }
  if (x.unresolvedDelegatecall) {
    out.push({ id: "xray-unresolved-proxy", severity: "warn", points: 8, title: "Unresolved delegatecall proxy — real logic not scanned", detail: `This ${x.byteSize.toLocaleString("en-US")}-byte contract forwards calls with DELEGATECALL, but no EIP-1967 / ZeppelinOS slot, EIP-897 implementation() or known clone pattern names the logic it runs (Diamond, slot-0 singleton or custom proxy). Mint, blacklist, pause, tax or upgrade entry points in that logic are UNKNOWN.`, link });
  }
  if (x.isContract && !degraded && caps.size === 0 && !isProxy && !x.unresolvedDelegatecall) {
    out.push({ id: "xray-clean", severity: "info", points: 0, title: "No privileged selectors", detail: `Scanned ${x.push4Count} dispatcher selectors in ${x.byteSize.toLocaleString("en-US")} bytes — no mint, blacklist, pause, tax or upgrade entry points.`, link });
  }
  if (x.hasSelfdestruct) out.push({ id: "selfdestruct", severity: "warn", points: 8, title: "SELFDESTRUCT opcode", detail: "Executable code contains SELFDESTRUCT (0xff). Post-Dencun it only clears balance unless in the creation tx, but it signals legacy kill-switch logic.", link });
  if (x.eip1167CloneTarget) out.push({ id: "clone", severity: "info", points: 0, title: "EIP-1167 minimal clone", detail: `Immutable clone of ${shortAddr(x.eip1167CloneTarget)} — logic cannot be upgraded.`, link: { label: "Logic ↗", href: explorerAddress(x.chainId, x.eip1167CloneTarget) } });
  if (x.eip7702Delegate) {
    const dl = { label: "Delegate ↗", href: explorerAddress(x.chainId, x.eip7702Delegate) };
    if (x.eip7702DelegateLabel) out.push({ id: "eip7702-known", severity: "info", points: 0, title: `EIP-7702 delegate: ${x.eip7702DelegateLabel}`, detail: `This EOA runs the code of ${shortAddr(x.eip7702Delegate)}, a known wallet delegator.`, link: dl });
    else out.push({ id: "eip7702-unknown", severity: "warn", points: 10, title: "Unknown EIP-7702 delegate", detail: `This EOA runs the code of ${shortAddr(x.eip7702Delegate)}, which is not a known wallet delegator — its selectors are X-Rayed above; verify it before signing anything.`, link: dl });
  }
  return out;
}

export function poolFindings(p: PoolSnapshot): Finding[] {
  const out: Finding[] = [];
  const s = poolSides(p);
  const link = { label: "Pool ↗", href: explorerAddress(p.chainId, p.address) };
  if (s.quote && s.quoteAsset && s.reserveQuote !== null) {
    const r = s.reserveQuote;
    const sym = s.quoteAsset.symbol;
    const dec = s.quote.decimals;
    const label = p.reservesAreVirtual ? `${sym} active-range virtual depth` : `${sym} reserve`;
    if (r < s.quoteAsset.thin) out.push({ id: "depth-thin", severity: "critical", points: 15, title: "Thin exit liquidity", detail: `Only ${fmtUnits(r, dec, 3)} ${label} — a single mid-size sell moves price sharply.`, link });
    else if (r < s.quoteAsset.modest) out.push({ id: "depth-modest", severity: "warn", points: 8, title: "Modest exit liquidity", detail: `${fmtUnits(r, dec, 3)} ${label}.`, link });
    else out.push({ id: "depth-ok", severity: "info", points: 0, title: "Healthy exit liquidity", detail: `${fmtUnits(r, dec, 2)} ${label}.`, link });
  } else {
    out.push({ id: "depth-unscored", severity: "info", points: 0, title: "No known quote asset", detail: `Neither ${p.token0.symbol} nor ${p.token1.symbol} is WETH/USDC (matched by address), so exit depth is not scored.`, link });
  }
  const o = p.overnight;
  const lp = o.lpChangeBps ?? null;
  const how = o.lpMethod ? ` Measured by ${o.lpMethod}.` : "";
  if (lp !== null && lp <= -1500) out.push({ id: "lp-drop", severity: "critical", points: 15, title: `LP liquidity ${fmtBps(lp)} overnight`, detail: `Liquidity providers withdrew ${fmtBps(lp, false)} of pool liquidity over ${o.hours}h.${how} ${o.note}`, link });
  else if (lp !== null && lp <= -500) out.push({ id: "lp-dip", severity: "warn", points: 7, title: `LP liquidity ${fmtBps(lp)} overnight`, detail: `Liquidity providers withdrew ${fmtBps(lp, false)} over ${o.hours}h.${how} ${o.note}`, link });
  if (o.priceChangeBps !== null && Math.abs(o.priceChangeBps) >= 2000) out.push({ id: "px-move", severity: "warn", points: 10, title: `Price ${fmtBps(o.priceChangeBps)} overnight`, detail: `${o.priceOrientation ?? `${s.risky.symbol} price`} moved ${fmtBps(o.priceChangeBps)} in ${o.hours}h.`, link });
  const feePips = p.feePips ?? p.feeBps * 100;
  if (feePips >= 10_000) out.push({ id: "fee-high", severity: "info", points: 2, title: `${(feePips / 10_000).toFixed(2)}% pool fee`, detail: "High fee tier adds exit drag on every round trip.", link });
  return out;
}

export function flowFindings(f: OvernightTokenFlow, symbol: string, decimals: number, chainId: number): Finding[] {
  if (!f.topHolder) return [];
  const h = f.topHolder;
  const link = { label: "Holder ↗", href: explorerAddress(chainId, h.address) };
  const who = `${h.activeOvernight ? "Overnight-active" : "Dormant"} ${h.isContract ? "contract" : "wallet"} ${shortAddr(h.address)}`;
  const hs = f.holderScan;
  const basis = hs
    ? hs.complete
      ? ` Ranked by live balanceOf over ${hs.candidates} holders seen in ${hs.windowDays === null ? "the token's full" : `${hs.windowDays}d of`} Transfer logs (pools, vaults, bridges, escrows excluded).`
      : ` Ranked by live balanceOf over ${hs.candidates} holders seen so far (${hs.note})`
    : " Ranked among overnight-active addresses only.";
  const top10 = f.holders && f.holders.length > 1 && f.topHoldersShareBps !== undefined ? ` Top ${f.holders.length} found hold ${fmtBps(f.topHoldersShareBps, false)} combined.` : "";
  if (h.shareBps >= 1000) return [{ id: "whale-10", severity: "critical", points: 12, title: `Whale holds ${fmtBps(h.shareBps, false)} of supply`, detail: `${who} holds ${fmtUnits(h.balance, decimals, 0)} ${symbol}.${top10}${basis}`, link }];
  if (h.shareBps >= 500) return [{ id: "whale-5", severity: "warn", points: 6, title: `Whale holds ${fmtBps(h.shareBps, false)} of supply`, detail: `${who} holds ${fmtUnits(h.balance, decimals, 0)} ${symbol}.${top10}${basis}`, link }];
  return [{ id: "whale-ok", severity: "info", points: 0, title: "No dominant whale found", detail: `Largest holder found, ${who}, has ${fmtBps(h.shareBps, false)} of supply.${top10} ${f.available ? `${f.transferCount} transfers in ${f.hours}h.` : "Overnight transfer read unavailable."}${basis}`, link }];
}

export function parityFindings(p: ParityReport): Finding[] {
  const out: Finding[] = [];
  const baseAdapterLink = { label: "Base adapter ↗", href: explorerAddress(8453, "0x408021Cb4ef1033675C70CF97788F3E03f45A381") };
  const rhAdapterLink = { label: "RH adapter ↗", href: explorerAddress(4663, "0x37F26e3025b3DC50e0EE9f610D386803B42D0685") };
  // Older cached reports (pre-verdict) fall back to the absolute delta.
  const verdict = p.verdict ?? (p.verified ? "EXACT" : "IN_FLIGHT");
  const blocks = `Base #${p.base.number} · RH #${p.robinhood.number}`;
  if (verdict === "UNBACKED") {
    out.push({ id: "parity-unbacked", severity: "critical", points: 40, title: "Robinhood $VIBES supply exceeds Base backing", detail: `Circulating on Robinhood exceeds VIBES locked on Base by ${fmtUnits(p.delta, 18, 4)} VIBES, confirmed on a second pair of fresh reads (${blocks}). The bridge itself can never cause this (it locks at send, releases at receive), so this is unbacked supply.`, link: rhAdapterLink });
  } else if (verdict === "IN_FLIGHT") {
    if (p.pendingPackets === null)
      out.push({ id: "parity-in-flight", severity: "info", points: 0, title: "Base backing exceeds Robinhood circulating · in-flight count unknown", detail: `Base locked exceeds Robinhood circulating by ${fmtUnits(p.delta, 18, 4)} VIBES (${blocks}). The LayerZero nonce reads failed, so whether packets are in flight is UNKNOWN. Either way holders are not exposed (locked ≥ circulating).`, link: baseAdapterLink });
    else
      out.push({ id: "parity-in-flight", severity: "info", points: 0, title: `${p.pendingPackets} LayerZero packet${p.pendingPackets === 1 ? "" : "s"} in flight · Δ expected`, detail: `Base locked exceeds Robinhood circulating by ${fmtUnits(p.delta, 18, 4)} VIBES while packets are sent but not yet delivered (${blocks}). Lock/reserve-return happens at send and release at delivery, so this closes on its own.`, link: baseAdapterLink });
  } else if (verdict === "OVER_BACKED") {
    out.push({ id: "parity-over-backed", severity: "info", points: 0, title: "OFT backing exceeds circulating supply", detail: `${fmtUnits(p.delta, 18, 4)} VIBES more is locked on Base than circulates on Robinhood, with no packet in flight (${blocks}). Over-collateralised: holders are not exposed (e.g. VIBES sent straight to the adapter).`, link: baseAdapterLink });
  } else {
    out.push({ id: "parity-ok", severity: "info", points: 0, title: "OFT 1:1 parity exact", detail: `${fmtUnits(p.lockedOnBase, 18, 2)} VIBES locked on Base = Robinhood circulating supply (Δ 0, ${blocks}).` });
  }

  for (const l of p.bridge?.lanes ?? []) {
    const name = l.direction === "base->robinhood" ? "Base → Robinhood" : "Robinhood → Base";
    const link = l.srcPaused ? (l.srcChainId === 8453 ? baseAdapterLink : rhAdapterLink) : l.dstChainId === 8453 ? baseAdapterLink : rhAdapterLink;
    if (l.srcPaused || l.dstPaused) {
      out.push({ id: `bridge-paused-${l.srcChainId}`, severity: "critical", points: 25, title: `OFT bridge paused · ${name}`, detail: `${l.srcPaused ? "Source adapter paused: send() reverts." : "Destination adapter paused: packets verify but are not delivered until the owner Safe unpauses."} Cross-chain exits and arbitrage on this lane are halted.`, link });
    }
    // null = a peers() read failed (UNKNOWN, surfaced via parity.bridgeDegraded), never a mismatch.
    if (l.peersOk === false) {
      out.push({ id: `bridge-peer-${l.srcChainId}`, severity: "critical", points: 20, title: `OFT peer mismatch · ${name}`, detail: "peers(remoteEid) on one adapter does not point at the other adapter, so messages on this lane cannot be delivered to the expected contract.", link });
    }
    if (l.credit && BigInt(l.credit.limit) > 0n && BigInt(l.credit.headroom) * 4n < BigInt(l.credit.limit)) {
      out.push({ id: `bridge-headroom-${l.srcChainId}`, severity: "warn", points: 8, title: `Bridge credit budget nearly exhausted · ${name}`, detail: `Only ${fmtUnits(l.credit.headroom, 18, 0)} of ${fmtUnits(l.credit.limit, 18, 0)} VIBES can be delivered in the current ${fmtDuration(l.credit.windowSec)} window. Further deliveries queue at the LayerZero endpoint (RateLimitExceeded) until the window decays.`, link });
    }
    if (l.nonces.awaitingExecution.length > 0) {
      out.push({ id: `bridge-stuck-${l.srcChainId}`, severity: "warn", points: 6, title: `${l.nonces.awaitingExecution.length} verified packet${l.nonces.awaitingExecution.length > 1 ? "s" : ""} not delivered · ${name}`, detail: `Nonce${l.nonces.awaitingExecution.length > 1 ? "s" : ""} ${l.nonces.awaitingExecution.map((x) => x.nonce).join(", ")} passed DVN verification but lzReceive has not executed (rate limit, pause or gas). Anyone can retry via EndpointV2.lzReceive once the cause clears.`, link });
    }
  }

  if (p.spreadBps !== null && Math.abs(p.spreadBps) >= 300) {
    const net = p.netEdgeBps !== null ? `net edge ${p.netEdgeBps} bps after pool fees, the live LayerZero fee and gas at ${fmtUnits(p.arbNotionalWei ?? "100000000000000000", 18, 4)} ETH` : `net of ${p.feeDragBps} bps pool fees the edge is ${p.netEdgeBpsBeforeBridge ?? "n/a"} bps (LayerZero fee unavailable)`;
    out.push({ id: "spread-wide", severity: "warn", points: 8, title: `Cross-venue spread ${fmtBps(p.spreadBps)}`, detail: `VIBES is cheaper on ${p.cheaperVenue === "robinhood" ? "Robinhood Chain" : "Base"}; ${net}.` });
  }
  return out;
}

export function walletFindings(w: WalletReport): Finding[] {
  const out: Finding[] = [];
  const unlimited = w.approvals.filter((a) => a.unlimited);
  const fresh = w.approvals.filter((a) => a.discoveredOvernight);
  // Every live approval scores by size (unlimited +10 each, cap 40; bounded +3 each, cap 10), as documented on
  // /how-it-works. "Granted overnight" is a separate recency premium (+15 flat): a fresh unlimited approval is the
  // classic drainer setup, so it must never score LOWER than the same approval granted last week.
  if (unlimited.length) out.push({ id: "approvals-unlimited", severity: unlimited.length >= 3 ? "critical" : "warn", points: Math.min(40, unlimited.length * 10), title: `${unlimited.length} unlimited approval${unlimited.length > 1 ? "s" : ""}`, detail: unlimited.map((a) => `${a.tokenSymbol} → ${a.spenderName}`).join(" · ") });
  const limitedAll = w.approvals.filter((a) => !a.unlimited);
  if (limitedAll.length > 0) out.push({ id: "approvals-limited", severity: "info", points: Math.min(10, limitedAll.length * 3), title: `${limitedAll.length} bounded approval${limitedAll.length > 1 ? "s" : ""}`, detail: "Non-zero but capped allowances — still revocable in the Panic Bunker." });
  if (fresh.length) out.push({ id: "approvals-overnight", severity: "critical", points: 15, title: `${fresh.length} approval${fresh.length > 1 ? "s" : ""} granted overnight`, detail: fresh.map((a) => `${a.tokenSymbol} → ${shortAddr(a.spender)}${a.unlimited ? " (unlimited)" : ""}`).join(" · ") });
  if (w.eip7702Delegate) {
    const known = known7702Delegate(w.eip7702Delegate);
    const link = { label: "Delegate ↗", href: explorerAddress(w.chainId, w.eip7702Delegate) };
    if (known) out.push({ id: "eip7702-known", severity: "info", points: 0, title: `EIP-7702 smart EOA · ${known.label}`, detail: `This EOA delegates execution to ${shortAddr(w.eip7702Delegate)}, a known ${known.vendor} wallet delegator (${known.evidence}).`, link });
    else out.push({ id: "eip7702", severity: "warn", points: 10, title: "Unknown EIP-7702 delegate", detail: `This EOA delegates execution to ${shortAddr(w.eip7702Delegate)}, which is not a known wallet delegator — verify that delegate before signing anything.`, link });
  }
  const unknownUnlimited = unlimited.filter((a) => a.spenderKnown === false);
  if (unknownUnlimited.length) out.push({ id: "approvals-unknown-spender", severity: "warn", points: Math.min(20, unknownUnlimited.length * 10), title: `${unknownUnlimited.length} unlimited approval${unknownUnlimited.length > 1 ? "s" : ""} to unlabeled spender${unknownUnlimited.length > 1 ? "s" : ""}`, detail: `${unknownUnlimited.map((a) => `${a.tokenSymbol} → ${shortAddr(a.spender)}`).join(" · ")} — found in this wallet's Approval logs and not in Kestrel's verified spender list. Verify each contract before trusting it.` });
  const acct = w.account;
  if (acct?.kind === "safe" && acct.safe) out.push({ id: "account-safe", severity: "info", points: 0, title: `Safe ${acct.safe.threshold}-of-${acct.safe.owners.length} multisig`, detail: `Smart-contract wallet${acct.safe.version ? ` (Safe v${acct.safe.version})` : ""}: revocations execute as one Safe transaction once ${acct.safe.threshold} owner${acct.safe.threshold > 1 ? "s" : ""} sign.`, link: { label: "Safe ↗", href: explorerAddress(w.chainId, w.address) } });
  else if (acct && (acct.kind === "coinbase-smart-wallet" || acct.kind === "erc4337" || acct.kind === "smart-wallet")) out.push({ id: "account-smart", severity: "info", points: 0, title: acct.label, detail: `Smart-contract wallet scanned as a wallet${acct.entryPoint ? ` (ERC-4337 via ${shortAddr(acct.entryPoint)})` : ""}: revocations can be batched atomically with EIP-5792.` });
  const c = w.coverage;
  const scope = c
    ? `${c.tokensChecked} tokens × ${c.spendersChecked} spenders (${c.erc20PairsChecked.toLocaleString("en-US")} allowance reads) + ${c.permit2PairsChecked} Permit2 sub-allowances; Approval logs over the last ${c.logLookbackHours}h${c.walletWideLogDiscovery ? " across all tokens" : " for the curated tokens + Permit2"}`
    : `${w.spendersChecked} spenders × tracked tokens, plus Permit2 sub-allowances`;
  if (c?.partial) out.push({ id: "approvals-coverage-partial", severity: "warn", points: 5, title: "Approval scan incomplete", detail: `Some reads failed or the log window was not fully read, so missing approvals are UNKNOWN, not clean. Checked: ${scope}. ${c.notes.slice(0, 2).join(" ")}`.trim() });
  if (!w.approvals.length && !c?.partial) out.push({ id: "approvals-clean", severity: "info", points: 0, title: "No live approvals found", detail: `Checked ${scope}. Approvals to spenders outside this list on tokens never seen in those logs are not covered.` });
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
