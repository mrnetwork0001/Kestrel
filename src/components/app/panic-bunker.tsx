"use client";

import { useEffect, useMemo, useState } from "react";
import { type Abi, type Address, BaseError, encodeFunctionData, getAddress, type Hex } from "viem";
import { useAccount, useCapabilities, useConnect, useDisconnect, usePublicClient, useSendCalls, useSwitchChain, useWaitForCallsStatus, useWriteContract } from "wagmi";
import { CONTRACTS } from "@/config/contracts";
import { AddrLink, ChainBadge, cx, Panel, Stat, TxLink } from "@/components/ui";
import { AERODROME_ROUTER_ABI, ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { fmtUnits, shortAddr } from "@/lib/format";
import type { ApprovalExposure, ScanResult, WalletHolding } from "@/lib/engine/types";
import { getJson } from "./use-api";

interface RescueCall {
  id: string;
  label: string;
  kind: "revoke" | "permit2-lockdown" | "unwind-approve" | "unwind-swap";
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  data: Hex;
}

type SimState = { status: "idle" | "ok" | "fail" | "pending"; message?: string };
type StepState = { status: "waiting" | "signing" | "sent" | "confirmed" | "failed"; hash?: string; message?: string };

const SLIPPAGE_BPS = 300n;

function decodeErr(e: unknown): string {
  if (e instanceof BaseError) return (e.shortMessage || e.message).split("\n")[0].slice(0, 200);
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

function buildRevokes(approvals: ApprovalExposure[], selected: Set<string>): RescueCall[] {
  const calls: RescueCall[] = [];
  const erc20 = approvals.filter((a) => a.kind === "erc20" && selected.has(keyOf(a)));
  for (const a of erc20) {
    const args = [getAddress(a.spender), 0n] as const;
    calls.push({ id: `revoke-${keyOf(a)}`, label: `Revoke ${a.tokenSymbol} → ${a.spenderName}`, kind: "revoke", to: getAddress(a.token), abi: ERC20_ABI as unknown as Abi, functionName: "approve", args, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args }) });
  }
  const p2 = approvals.filter((a) => a.kind === "permit2" && selected.has(keyOf(a)));
  if (p2.length) {
    const pairs = p2.map((a) => ({ token: getAddress(a.token), spender: getAddress(a.spender) }));
    calls.push({ id: "permit2-lockdown", label: `Permit2 lockdown · ${p2.length} sub-allowance${p2.length > 1 ? "s" : ""}`, kind: "permit2-lockdown", to: CONTRACTS.base.permit2, abi: PERMIT2_ABI as unknown as Abi, functionName: "lockdown", args: [pairs], data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "lockdown", args: [pairs] }) });
  }
  return calls;
}

export function keyOf(a: ApprovalExposure) {
  return `${a.kind}:${a.token.toLowerCase()}:${a.spender.toLowerCase()}`;
}

/** Tokens Kestrel can unwind to USDC on Base through the Aerodrome router (route verified live via getAmountsOut). */
function unwindRoute(token: string) {
  const f = CONTRACTS.base.aerodromeFactory;
  const t = token.toLowerCase();
  if (t === CONTRACTS.base.vibesToken.toLowerCase())
    return [
      { from: CONTRACTS.base.vibesToken, to: CONTRACTS.base.weth, stable: false, factory: f },
      { from: CONTRACTS.base.weth, to: CONTRACTS.base.usdc, stable: false, factory: f },
    ];
  if (t === CONTRACTS.base.weth.toLowerCase()) return [{ from: CONTRACTS.base.weth, to: CONTRACTS.base.usdc, stable: false, factory: f }];
  return null;
}

export function PanicBunker({ previewAddress, previewChainId = 8453 }: { previewAddress?: string | null; previewChainId?: number }) {
  const { address, isConnected, chainId: walletChainId, connector } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const chainId = 8453 as const; // Panic Bunker executes on Base (USDC unwind + Permit2 are Base-native)
  const publicClient = usePublicClient({ chainId });
  const caps = useCapabilities({ query: { enabled: isConnected } });
  const { sendCallsAsync } = useSendCalls();
  const { writeContractAsync } = useWriteContract();

  const subject = isConnected && address ? address : previewAddress && previewChainId === 8453 ? previewAddress : null;
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unwind, setUnwind] = useState<Set<string>>(new Set());
  const [unwindCalls, setUnwindCalls] = useState<RescueCall[]>([]);
  const [quotes, setQuotes] = useState<Record<string, string>>({});
  const [sims, setSims] = useState<Record<string, SimState>>({});
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [batchId, setBatchId] = useState<string | null>(null);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [showCalldata, setShowCalldata] = useState(!isConnected);
  const batchStatus = useWaitForCallsStatus({ id: batchId ?? undefined, query: { enabled: !!batchId } });

  useEffect(() => {
    if (!subject) return;
    let cancelled = false;
    setScanning(true);
    setScanErr(null);
    getJson<ScanResult>(`/api/scan?address=${subject}&chainId=8453&llm=0`)
      .then((r) => {
        if (cancelled) return;
        setScan(r);
        setSelected(new Set((r.wallet?.approvals ?? []).map(keyOf)));
        setSims({});
        setSteps({});
        setBatchId(null);
      })
      .catch((e) => !cancelled && setScanErr(e.message))
      .finally(() => !cancelled && setScanning(false));
    return () => {
      cancelled = true;
    };
  }, [subject]);

  const approvals = scan?.wallet?.approvals ?? [];
  const unwindable: WalletHolding[] = (scan?.wallet?.holdings ?? []).filter((h) => unwindRoute(h.token) && BigInt(h.balance) > 0n);

  // Build unwind calls with live router quotes
  useEffect(() => {
    if (!publicClient || !subject) return;
    let cancelled = false;
    (async () => {
      const out: RescueCall[] = [];
      const q: Record<string, string> = {};
      for (const h of unwindable.filter((x) => unwind.has(x.token.toLowerCase()))) {
        const routes = unwindRoute(h.token)!;
        const amountIn = BigInt(h.balance);
        try {
          const amounts = await publicClient.readContract({ address: CONTRACTS.base.aerodromeRouter, abi: AERODROME_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, routes] });
          const expected = amounts[amounts.length - 1];
          const minOut = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
          q[h.token.toLowerCase()] = expected.toString();
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
          const approveArgs = [CONTRACTS.base.aerodromeRouter, amountIn] as const;
          const swapArgs = [amountIn, minOut, routes, getAddress(subject), deadline] as const;
          out.push({ id: `unwind-approve-${h.token}`, label: `Approve Aerodrome router for ${h.symbol}`, kind: "unwind-approve", to: getAddress(h.token), abi: ERC20_ABI as unknown as Abi, functionName: "approve", args: approveArgs, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: approveArgs }) });
          out.push({ id: `unwind-swap-${h.token}`, label: `Swap ${fmtUnits(amountIn, h.decimals, 2)} ${h.symbol} → ≥ ${fmtUnits(minOut, 6, 2)} USDC`, kind: "unwind-swap", to: CONTRACTS.base.aerodromeRouter, abi: AERODROME_ROUTER_ABI as unknown as Abi, functionName: "swapExactTokensForTokens", args: swapArgs, data: encodeFunctionData({ abi: AERODROME_ROUTER_ABI, functionName: "swapExactTokensForTokens", args: swapArgs }) });
        } catch (e) {
          q[h.token.toLowerCase()] = `error: ${decodeErr(e)}`;
        }
      }
      if (!cancelled) {
        setUnwindCalls(out);
        setQuotes(q);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, subject, unwind, scan]);

  // Unwind (approve + swap) goes FIRST so revokes never cancel the fresh router approval.
  const calls = useMemo(() => [...unwindCalls, ...buildRevokes(approvals, selected).filter((c) => !(c.kind === "revoke" && unwindCalls.some((u) => u.kind === "unwind-approve" && u.to.toLowerCase() === c.to.toLowerCase() && c.args[0] === CONTRACTS.base.aerodromeRouter)))], [unwindCalls, approvals, selected]);

  const capsForChain = caps.data?.[chainId] as { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  const atomic = capsForChain?.atomic?.status === "supported" || capsForChain?.atomic?.status === "ready" || capsForChain?.atomicBatch?.supported === true;
  const allSimOk = calls.length > 0 && calls.every((c) => sims[c.id]?.status === "ok");

  async function simulateAll() {
    if (!publicClient || !address) return;
    setExecErr(null);
    const next: Record<string, SimState> = {};
    for (const c of calls) next[c.id] = { status: "pending" };
    setSims({ ...next });
    for (const c of calls) {
      try {
        await publicClient.simulateContract({ account: address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args });
        next[c.id] = { status: "ok", message: "simulation passed" };
      } catch (e) {
        next[c.id] = { status: "fail", message: decodeErr(e) };
      }
    }
    // Swaps depend on the preceding approve inside the same bundle: verify sequentially with eth_simulateV1.
    const swapsNeedingSeq = calls.filter((c) => c.kind === "unwind-swap" && next[c.id].status === "fail");
    if (swapsNeedingSeq.length) {
      try {
        const res = await publicClient.simulateCalls({ account: address, calls: calls.map((c) => ({ to: c.to, data: c.data })) });
        res.results.forEach((r, i) => {
          const c = calls[i];
          if (c.kind === "unwind-swap") next[c.id] = r.status === "success" ? { status: "ok", message: "passed in sequential bundle simulation (after approve)" } : { status: "fail", message: r.error ? decodeErr(r.error) : "reverted in bundle simulation" };
        });
      } catch (e) {
        for (const c of swapsNeedingSeq) next[c.id] = { status: "fail", message: `standalone sim reverted (needs approve first); sequential sim unavailable: ${decodeErr(e)}` };
      }
    }
    setSims({ ...next });
  }

  async function execute() {
    if (!address || !allSimOk) return;
    setExecErr(null);
    try {
      if (walletChainId !== chainId) await switchChainAsync({ chainId });
      if (atomic) {
        const res = await sendCallsAsync({ chainId, calls: calls.map((c) => ({ to: c.to, data: c.data })) });
        setBatchId(res.id);
        return;
      }
      for (const c of calls) {
        setSteps((s) => ({ ...s, [c.id]: { status: "signing" } }));
        try {
          const hash = await writeContractAsync({ chainId, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args });
          setSteps((s) => ({ ...s, [c.id]: { status: "sent", hash } }));
          const receipt = await publicClient!.waitForTransactionReceipt({ hash });
          setSteps((s) => ({ ...s, [c.id]: { status: receipt.status === "success" ? "confirmed" : "failed", hash } }));
          if (receipt.status !== "success") throw new Error(`${c.label} reverted onchain`);
        } catch (e) {
          setSteps((s) => ({ ...s, [c.id]: { status: "failed", message: decodeErr(e) } }));
          throw e;
        }
      }
    } catch (e) {
      setExecErr(decodeErr(e));
    }
  }

  const doneCount = Object.values(steps).filter((s) => s.status === "confirmed").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="space-y-6">
        <Panel title="Wallet" n="01" right={<ChainBadge chainId={8453} />}>
          {isConnected && address ? (
            <div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="mono text-[13px] text-ink">{shortAddr(address, 6)}</p>
                  <p className="mono text-[11px] text-ink-3">via {connector?.name ?? "wallet"} · chain {walletChainId}</p>
                </div>
                <button onClick={() => disconnect()} className="mono text-[11px] text-ink-3 hover:text-ink">disconnect</button>
              </div>
              <div className="mt-4 border-t hairline pt-3 mono text-[11px]">
                <span className="text-ink-3">EIP-5792 wallet_getCapabilities → </span>
                {caps.isLoading ? <span className="text-ink-3">probing…</span> : atomic ? <span className="text-phosphor">atomic batching SUPPORTED · 1 signature</span> : <span className="text-warn">not supported · guided sequential signing</span>}
              </div>
            </div>
          ) : (
            <div>
              <p className="text-[13px] text-ink-2">Connect to rescue your own wallet. Smart Wallets (Coinbase Smart Wallet, Safe, Ambire) batch everything into one atomic signature.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {connectors.map((c) => (
                  <button key={c.uid} onClick={() => connect({ connector: c, chainId })} disabled={connecting} className="rounded-[2px] border border-hair-strong px-3 py-2 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40">
                    {c.name}
                  </button>
                ))}
              </div>
              {connectError && <p className="mt-2 mono text-[11px] text-crit">{decodeErr(connectError)}</p>}
              {previewAddress && <p className="mt-4 mono text-[11px] text-ink-3">Previewing rescue for {shortAddr(previewAddress, 6)} (read-only, no wallet needed).</p>}
            </div>
          )}
        </Panel>

        <Panel title="Risky approvals" n="02" right={scan?.wallet ? <span className="mono text-[10px] text-ink-3">{scan.wallet.spendersChecked} spenders checked</span> : null}>
          {!subject && <p className="text-[13px] text-ink-3">Connect a wallet or open <span className="mono">/rescue?target=0x…</span> to preview a rescue bundle.</p>}
          {scanning && <p className="mono text-[12px] text-ink-3 cursor-blink">Scanning allowances & Permit2</p>}
          {scanErr && <p className="mono text-[12px] text-crit">{scanErr}</p>}
          {scan && !scanning && approvals.length === 0 && <p className="text-[13px] text-phosphor">No live approvals to known spenders. Nothing to revoke.</p>}
          {approvals.length > 0 && (
            <ul className="space-y-1.5">
              {approvals.map((a) => (
                <li key={keyOf(a)}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-[2px] border hairline px-3 py-2 hover:border-hair-strong">
                    <input type="checkbox" checked={selected.has(keyOf(a))} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(keyOf(a)); else n.delete(keyOf(a)); return n; })} />
                    <span className="mono text-[12px] text-ink">{a.tokenSymbol}</span>
                    <span className="flex-1 truncate text-[12px] text-ink-2">→ {a.spenderName}</span>
                    <span className={cx("tnum text-[11px]", a.unlimited ? "text-crit" : "text-warn")}>{a.unlimited ? "UNLIMITED" : fmtUnits(a.amount, a.tokenDecimals, 2)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {unwindable.length > 0 && (
          <Panel title="Emergency unwind → USDC" n="03" right={<span className="mono text-[10px] text-ink-3">Aerodrome router · {Number(SLIPPAGE_BPS) / 100}% max slippage</span>}>
            <ul className="space-y-1.5">
              {unwindable.map((h) => {
                const k = h.token.toLowerCase();
                const q = quotes[k];
                return (
                  <li key={k}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-[2px] border hairline px-3 py-2 hover:border-hair-strong">
                      <input type="checkbox" checked={unwind.has(k)} onChange={(e) => setUnwind((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                      <span className="mono text-[12px] text-ink">{fmtUnits(h.balance, h.decimals, 4)} {h.symbol}</span>
                      <span className="ml-auto mono text-[11px] text-ink-3">{q ? (q.startsWith("error") ? q : `≈ ${fmtUnits(q, 6, 2)} USDC`) : unwind.has(k) ? "quoting…" : "live quote on select"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </div>

      <div className="space-y-6">
        <Panel title={`Rescue bundle · ${calls.length} call${calls.length === 1 ? "" : "s"}`} n="04" right={<button onClick={() => setShowCalldata((v) => !v)} className="mono text-[10px] text-ink-3 hover:text-ink">{showCalldata ? "hide" : "show"} calldata</button>}>
          {calls.length === 0 ? (
            <p className="text-[13px] text-ink-3">Select approvals to revoke or positions to unwind.</p>
          ) : (
            <ol className="space-y-2">
              {calls.map((c, i) => {
                const sim = sims[c.id];
                const step = steps[c.id];
                return (
                  <li key={c.id} className="border hairline p-3">
                    <div className="flex items-start gap-3">
                      <span className="mono text-[11px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink">{c.label}</p>
                        <p className="mono text-[11px] text-ink-3">
                          {c.functionName}() on <AddrLink chainId={8453} address={c.to} />
                        </p>
                        {sim && sim.status !== "idle" && <p className={cx("mt-1 mono text-[11px]", sim.status === "ok" ? "text-phosphor" : sim.status === "fail" ? "text-crit" : "text-ink-3")}>sim: {sim.status === "pending" ? "running…" : sim.message}</p>}
                        {step && <p className={cx("mt-1 mono text-[11px]", step.status === "confirmed" ? "text-phosphor" : step.status === "failed" ? "text-crit" : "text-warn")}>tx: {step.status}{step.hash && <> · <TxLink chainId={8453} hash={step.hash} /></>}{step.message && ` · ${step.message}`}</p>}
                        {showCalldata && <p className="mt-2 break-all mono text-[10px] leading-relaxed text-ink-3">{c.data}</p>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {calls.length > 0 && (
            <div className="mt-5 space-y-3 border-t hairline pt-4">
              {!isConnected ? (
                <p className="text-[12px] text-ink-3">Preview mode: this is the exact calldata Kestrel would submit. Connect the wallet that owns these approvals to simulate and sign.</p>
              ) : subject?.toLowerCase() !== address?.toLowerCase() ? null : (
                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={simulateAll} className="rounded-[2px] border border-hair-strong px-4 py-2 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor">1 · SIMULATE ALL</button>
                  <button onClick={execute} disabled={!allSimOk} className="rounded-[2px] bg-crit px-4 py-2 mono text-[12px] font-semibold text-white hover:bg-[#ff6668] disabled:cursor-not-allowed disabled:opacity-30">
                    2 · {atomic ? "SIGN ATOMIC RESCUE (1 SIGNATURE)" : `SIGN ${calls.length} TXS SEQUENTIALLY`}
                  </button>
                  {!allSimOk && Object.keys(sims).length > 0 && <span className="mono text-[11px] text-crit">Every call must pass simulation before signing.</span>}
                </div>
              )}
              {!atomic && Object.keys(steps).length > 0 && <p className="mono text-[11px] text-ink-2">{doneCount}/{calls.length} confirmed</p>}
              {batchId && (
                <p className="mono text-[11px] text-ink-2">
                  Atomic bundle {shortAddr(batchId, 6)} · {batchStatus.data ? batchStatus.data.status : "pending…"}
                  {batchStatus.data?.receipts?.[0]?.transactionHash && <> · <TxLink chainId={8453} hash={batchStatus.data.receipts[0].transactionHash} /></>}
                </p>
              )}
              {execErr && <p className="mono text-[11px] text-crit">{execErr}</p>}
            </div>
          )}
        </Panel>
        {scan?.wallet && (
          <Panel title="Exposure summary" n="05">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Threat score" value={scan.score} tone={scan.band === "CRITICAL" ? "crit" : scan.band === "ELEVATED" ? "warn" : "phosphor"} sub={scan.band} />
              <Stat label="Unlimited" value={approvals.filter((a) => a.unlimited).length} tone={approvals.some((a) => a.unlimited) ? "crit" : undefined} />
              <Stat label="Native ETH" value={fmtUnits(scan.wallet.nativeBalance, 18, 4)} />
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
