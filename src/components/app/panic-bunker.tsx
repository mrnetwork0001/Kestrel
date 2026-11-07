"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Abi, type Address, BaseError, encodeFunctionData, getAddress, type Hex, keccak256, type PublicClient, toHex } from "viem";
import { useAccount, useCapabilities, useConfig, useConnect, useDisconnect, usePublicClient, useSendCalls, useSwitchChain, useWriteContract } from "wagmi";
import { waitForCallsStatus } from "wagmi/actions";
import { CONTRACTS } from "@/config/contracts";
import { DEMO_RESCUE_WALLET, isDemoWallet } from "@/config/demo";
import { SkeletonRows } from "@/components/editorial";
import { AddrLink, ChainBadge, cx, TxLink } from "@/components/ui";
import { AERODROME_ROUTER_ABI, ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { explorerBlock, fmtUnits, shortAddr } from "@/lib/format";
import type { ApprovalExposure, ScanResult, WalletHolding } from "@/lib/engine/types";
import { approvalKey, type ExtraPair, type LiveExposure, readLiveExposure } from "@/lib/rescue/live-approvals";
import { getJson } from "./use-api";

interface RescueCall {
  id: string;
  label: string;
  kind: "revoke" | "permit2-lockdown" | "unwind-approve" | "unwind-swap";
  /** Unwind calls carry the token they belong to, so a failed approve can skip its swap. */
  unwindToken?: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  data: Hex;
}

type SimStatus = "pending" | "ok" | "fail" | "deferred";
type SimState = { status: SimStatus; message?: string };
type StepState = { status: "waiting" | "signing" | "sent" | "confirmed" | "failed" | "skipped"; hash?: string; message?: string };

/** A simulation run, bound to the exact calldata + account it covered. Signing is only allowed while it still matches. */
interface SimRun {
  fingerprint: Hex;
  account: string;
  at: number;
  bundle: boolean;
  /** Head block when the simulation ran (eth_blockNumber read just before it), for the "Simulated at block #" proof line. */
  block: string | null;
  results: Record<string, SimState>;
}

interface VerifyReport {
  block: string;
  revoked: string[];
  remaining: string[];
  error?: string;
}

const SLIPPAGE_BPS = 300n;
const DEADLINE_SEC = 1200;
const SIM_MAX_AGE_MS = 10 * 60_000;
const ATOMIC_UNSUPPORTED_CODES = new Set([5700, 5710, 5750, 5760, 4200, -32601]);

function decodeErr(e: unknown): string {
  if (e instanceof BaseError) return (e.shortMessage || e.message).split("\n")[0].slice(0, 200);
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

function errCode(e: unknown): number | null {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "number") return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const isUserRejection = (e: unknown) => errCode(e) === 4001 || /user (rejected|denied)/i.test(decodeErr(e));

export function keyOf(a: ApprovalExposure) {
  return approvalKey(a);
}

/** Everything selected, or only the pager's "token:spender" approval when it is still live. */
function initialSelection(approvals: ApprovalExposure[], revokeOnly: string | null): Set<string> {
  const only = revokeOnly?.toLowerCase();
  const pick = only ? approvals.filter((a) => `${a.token}:${a.spender}`.toLowerCase() === only) : [];
  return new Set((pick.length ? pick : approvals).map(keyOf));
}

function fingerprint(calls: RescueCall[], account: string): Hex {
  return keccak256(toHex(JSON.stringify([account.toLowerCase(), 8453, calls.map((c) => [c.to.toLowerCase(), c.data])])));
}

function buildRevokes(approvals: ApprovalExposure[], selected: Set<string>, unwindTokens: Set<string>): RescueCall[] {
  const router = CONTRACTS.base.aerodromeRouter.toLowerCase();
  const calls: RescueCall[] = [];
  // An unwound token's router approval is overwritten by the unwind's exact-amount approve and consumed by the swap.
  const erc20 = approvals.filter((a) => a.kind === "erc20" && selected.has(keyOf(a)) && !(unwindTokens.has(a.token.toLowerCase()) && a.spender.toLowerCase() === router));
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

/** Live router quote → exact-amount approve + slippage-bounded swap, with a fresh deadline. */
async function buildUnwind(client: PublicClient, h: WalletHolding, recipient: string): Promise<{ calls: RescueCall[]; expected: bigint }> {
  const routes = unwindRoute(h.token)!;
  const amountIn = BigInt(h.balance);
  const amounts = await client.readContract({ address: CONTRACTS.base.aerodromeRouter, abi: AERODROME_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, routes] });
  const expected = amounts[amounts.length - 1];
  const minOut = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
  const token = getAddress(h.token);
  const approveArgs = [CONTRACTS.base.aerodromeRouter, amountIn] as const;
  const swapArgs = [amountIn, minOut, routes, getAddress(recipient), deadline] as const;
  return {
    expected,
    calls: [
      { id: `unwind-approve-${token}`, unwindToken: token, label: `Approve Aerodrome router for exactly ${fmtUnits(amountIn, h.decimals, 4)} ${h.symbol}`, kind: "unwind-approve", to: token, abi: ERC20_ABI as unknown as Abi, functionName: "approve", args: approveArgs, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: approveArgs }) },
      { id: `unwind-swap-${token}`, unwindToken: token, label: `Swap ${fmtUnits(amountIn, h.decimals, 2)} ${h.symbol} → ≥ ${fmtUnits(minOut, 6, 2)} USDC`, kind: "unwind-swap", to: CONTRACTS.base.aerodromeRouter, abi: AERODROME_ROUTER_ABI as unknown as Abi, functionName: "swapExactTokensForTokens", args: swapArgs, data: encodeFunctionData({ abi: AERODROME_ROUTER_ABI, functionName: "swapExactTokensForTokens", args: swapArgs }) },
    ],
  };
}

export interface PanicBunkerProps {
  /** Address to preview without a wallet (deep link, or the workspace's scanned wallet). */
  previewAddress?: string | null;
  previewChainId?: number;
  /** Server-read live exposure for `previewAddress` (SSR), used if it is under a minute old. */
  initialLive?: LiveExposure | null;
  /** Tokens the deep link is about (a token target, or a pool's two tokens): highlighted in the bundle. */
  focusTokens?: string[];
  /** "token:spender" from a pager deep link: preselect only that approval. */
  revokeOnly?: string | null;
  /** One-line context shown above the bunker (e.g. why a token deep link has no wallet). */
  context?: string | null;
}

export function PanicBunker({ previewAddress, previewChainId = 8453, initialLive = null, focusTokens = [], revokeOnly = null, context = null }: PanicBunkerProps) {
  const config = useConfig();
  const { address, isConnected, chainId: walletChainId, connector } = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const chainId = 8453 as const; // Panic Bunker executes on Base (USDC unwind + Permit2 are Base-native)
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined;
  const caps = useCapabilities({ query: { enabled: isConnected } });
  const { sendCallsAsync } = useSendCalls();
  const { writeContractAsync } = useWriteContract();

  const preview = previewAddress && previewChainId === 8453 ? getAddress(previewAddress) : null;
  const [choice, setChoice] = useState<"auto" | "demo" | "wallet">("auto");
  useEffect(() => setChoice("auto"), [preview]);
  const subject: string | null =
    choice === "demo" ? DEMO_RESCUE_WALLET.address : choice === "wallet" ? (address ?? null) : preview ?? (isConnected && address ? address : null);
  const subjectIsWallet = !!subject && !!address && subject.toLowerCase() === address.toLowerCase();

  // SSR: when the server already read this subject's allowances, the first paint (and the HTML) carries the bundle.
  const ssrLive = initialLive && subject && initialLive.owner.toLowerCase() === subject.toLowerCase() ? initialLive : null;
  const [live, setLive] = useState<LiveExposure | null>(ssrLive);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(ssrLive?.approvals ?? [], revokeOnly));
  const [unwind, setUnwind] = useState<Set<string>>(new Set());
  const [unwindCalls, setUnwindCalls] = useState<RescueCall[]>([]);
  const [quotes, setQuotes] = useState<Record<string, string>>({});
  const [quoting, setQuoting] = useState(false);
  const [sim, setSim] = useState<SimRun | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [batches, setBatches] = useState<{ id: string; label: string; status: string; tx?: string }[]>([]);
  const [executing, setExecuting] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [separate, setSeparate] = useState(false);
  const [showCalldata, setShowCalldata] = useState(true);

  const extraPairs = useMemo<ExtraPair[]>(
    () =>
      scan?.wallet && scan.target.address.toLowerCase() === subject?.toLowerCase()
        ? scan.wallet.approvals.map((a) => ({ token: a.token, spender: a.spender, spenderName: a.spenderName.replace(/ via Permit2$/, ""), kind: a.kind, discoveredOvernight: a.discoveredOvernight }))
        : [],
    [scan, subject]
  );

  const initSelection = useCallback((approvals: ApprovalExposure[]) => setSelected(initialSelection(approvals, revokeOnly)), [revokeOnly]);

  // Load: live allowance read (uncached RPC) + server scan (threat score, approvals discovered overnight from logs).
  useEffect(() => {
    const fresh = initialLive && subject && initialLive.owner.toLowerCase() === subject.toLowerCase() && Date.now() - Date.parse(initialLive.readAt) < 60_000 ? initialLive : null;
    setLive(fresh);
    setScan(null);
    setSim(null);
    setSteps({});
    setBatches([]);
    setVerify(null);
    setExecErr(null);
    setUnwind(new Set());
    setUnwindCalls([]);
    setQuotes({});
    if (!subject) return;
    let cancelled = false;
    setLiveErr(null);
    if (fresh) initSelection(fresh.approvals);
    if (!publicClient) return;
    setLoading(!fresh);
    const liveP = fresh ? Promise.resolve(fresh) : readLiveExposure(publicClient, subject);
    liveP
      .then((r) => {
        if (cancelled || fresh) return;
        setLive(r);
        initSelection(r.approvals);
      })
      .catch((e) => !cancelled && setLiveErr(`Live allowance read failed: ${decodeErr(e)}`))
      .finally(() => !cancelled && setLoading(false));
    // Server scan (30s KV-cached): threat score + spenders discovered in Approval logs that the known list misses.
    getJson<ScanResult>(`/api/scan?address=${subject}&chainId=8453&mode=wallet`)
      .then(async (s) => {
        if (cancelled || !s) return;
        setScan(s);
        const base = await liveP.catch(() => null);
        const have = new Set((base?.approvals ?? []).map((a) => `${a.token}:${a.spender}`.toLowerCase()));
        const missing = (s.wallet?.approvals ?? []).filter((a) => !have.has(`${a.token}:${a.spender}`.toLowerCase()));
        if (!missing.length || cancelled) return;
        // Spenders found in overnight Approval logs: re-read them live so the bundle covers them too.
        const extra = s.wallet!.approvals.map((a) => ({ token: a.token, spender: a.spender, spenderName: a.spenderName.replace(/ via Permit2$/, ""), discoveredOvernight: a.discoveredOvernight }));
        const r = await readLiveExposure(publicClient, subject, extra);
        if (cancelled) return;
        setLive(r);
        initSelection(r.approvals);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, publicClient]);

  const approvals = live?.approvals ?? [];
  const unwindable: WalletHolding[] = (live?.holdings ?? []).filter((h) => unwindRoute(h.token) && BigInt(h.balance) > 0n);
  const holdingsSig = unwindable.map((h) => `${h.token}:${h.balance}`).join(",");
  const unwindSig = [...unwind].sort().join(",");

  // Preview unwind calls from live router quotes. Rebuilt only when the subject, the selection or a balance changes.
  useEffect(() => {
    if (!publicClient || !subject) return;
    const picked = unwindable.filter((x) => unwind.has(x.token.toLowerCase()));
    if (!picked.length) {
      setUnwindCalls([]);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    (async () => {
      const out: RescueCall[] = [];
      const q: Record<string, string> = {};
      for (const h of picked) {
        try {
          const u = await buildUnwind(publicClient, h, subject);
          out.push(...u.calls);
          q[h.token.toLowerCase()] = u.expected.toString();
        } catch (e) {
          q[h.token.toLowerCase()] = `error: ${decodeErr(e)}`;
        }
      }
      if (!cancelled) {
        setUnwindCalls(out);
        setQuotes(q);
        setQuoting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, subject, unwindSig, holdingsSig]);

  const unwindTokens = useMemo(() => new Set(unwindCalls.map((c) => c.unwindToken!.toLowerCase())), [unwindCalls]);
  const revokeCalls = useMemo(() => buildRevokes(approvals, selected, unwindTokens), [approvals, selected, unwindTokens]);
  // Revokes FIRST: a reverting swap (price moved past slippage) can never take the revokes down with it in sequential mode.
  const calls = useMemo(() => [...revokeCalls, ...unwindCalls], [revokeCalls, unwindCalls]);
  const currentFp = useMemo(() => (address && calls.length ? fingerprint(calls, address) : null), [calls, address]);

  const capsForChain = caps.data?.[chainId] as { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  const atomic = capsForChain?.atomic?.status === "supported" || capsForChain?.atomic?.status === "ready" || capsForChain?.atomicBatch?.supported === true;

  const simBound = !!sim && !!currentFp && sim.fingerprint === currentFp && sim.account.toLowerCase() === address?.toLowerCase() && Date.now() - sim.at < SIM_MAX_AGE_MS;
  const simStale = !!sim && !simBound;
  const hasDeferred = simBound && calls.some((c) => sim!.results[c.id]?.status === "deferred");
  const allSimOk = simBound && calls.every((c) => sim!.results[c.id]?.status === "ok" || (sim!.results[c.id]?.status === "deferred" && c.kind === "unwind-swap"));
  const busy = loading || quoting || simulating || executing;
  const canSign = allSimOk && !busy && subjectIsWallet;
  const useAtomic = atomic && !hasDeferred;

  async function refreshLive(): Promise<LiveExposure | null> {
    if (!publicClient || !subject) return null;
    try {
      const r = await readLiveExposure(publicClient, subject, extraPairs);
      setLive(r);
      return r;
    } catch (e) {
      setLiveErr(`Live allowance read failed: ${decodeErr(e)}`);
      return null;
    }
  }

  async function simulateAll() {
    if (!publicClient || !address || !subjectIsWallet) return;
    setExecErr(null);
    setVerify(null);
    setSteps({});
    setBatches([]);
    setSimulating(true);
    try {
      // 1. Fresh allowance read: allowances already at 0 are dropped instead of re-signed as no-op revokes.
      const fresh = await readLiveExposure(publicClient, address, extraPairs);
      const liveKeys = new Set(fresh.approvals.map(keyOf));
      const sel = new Set([...selected].filter((k) => liveKeys.has(k)));
      // 2. Fresh quotes + deadlines for every unwind.
      const unw: RescueCall[] = [];
      const q: Record<string, string> = {};
      for (const h of fresh.holdings.filter((x) => unwindRoute(x.token) && unwind.has(x.token.toLowerCase()) && BigInt(x.balance) > 0n)) {
        try {
          const u = await buildUnwind(publicClient, h, address);
          unw.push(...u.calls);
          q[h.token.toLowerCase()] = u.expected.toString();
        } catch (e) {
          q[h.token.toLowerCase()] = `error: ${decodeErr(e)}`;
        }
      }
      const all = [...buildRevokes(fresh.approvals, sel, new Set(unw.map((c) => c.unwindToken!.toLowerCase()))), ...unw];
      setLive(fresh);
      setSelected(sel);
      setUnwindCalls(unw);
      setQuotes(q);
      if (!all.length) {
        setSim(null);
        return;
      }
      const simBlock = await publicClient.getBlockNumber().catch(() => null);
      // 3. Simulate. eth_simulateV1 runs the calls in order on one state, exactly like the atomic batch.
      const results: Record<string, SimState> = {};
      let bundle = false;
      try {
        const res = await publicClient.simulateCalls({ account: address, calls: all.map((c) => ({ to: c.to, data: c.data })) });
        res.results.forEach((r, i) => {
          results[all[i].id] = r.status === "success" ? { status: "ok", message: "passed (ordered bundle simulation, eth_simulateV1)" } : { status: "fail", message: r.error ? decodeErr(r.error) : "reverted in bundle simulation" };
        });
        bundle = true;
      } catch {
        // RPC without eth_simulateV1: simulate each call alone. A swap needs its approve onchain first, so it is
        // re-quoted and simulated just before its own signature (sequential mode only).
        for (const c of all) {
          try {
            await publicClient.simulateContract({ account: address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args });
            results[c.id] = { status: "ok", message: "simulation passed" };
          } catch (e) {
            results[c.id] = c.kind === "unwind-swap" ? { status: "deferred", message: "needs its approve onchain first: re-quoted and simulated right before this signature" } : { status: "fail", message: decodeErr(e) };
          }
        }
      }
      setSim({ fingerprint: fingerprint(all, address), account: address, at: Date.now(), bundle, block: simBlock != null ? simBlock.toString() : null, results });
    } catch (e) {
      setExecErr(`Simulation failed: ${decodeErr(e)}`);
      setSim(null);
    } finally {
      setSimulating(false);
    }
  }

  const step = (id: string, s: StepState) => setSteps((prev) => ({ ...prev, [id]: s }));

  /** Simulate this exact call for this account right now, then sign exactly what was simulated. */
  async function signOne(c: RescueCall): Promise<boolean> {
    if (!publicClient || !address) return false;
    step(c.id, { status: "signing" });
    try {
      await publicClient.simulateContract({ account: address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args });
    } catch (e) {
      step(c.id, { status: "failed", message: `pre-sign simulation reverted: ${decodeErr(e)}` });
      return false;
    }
    try {
      const hash = await writeContractAsync({ chainId, account: address as Address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args });
      step(c.id, { status: "sent", hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      step(c.id, { status: receipt.status === "success" ? "confirmed" : "failed", hash, message: receipt.status === "success" ? undefined : "reverted onchain" });
      return receipt.status === "success";
    } catch (e) {
      step(c.id, { status: "failed", message: decodeErr(e) });
      if (isUserRejection(e)) throw e;
      return false;
    }
  }

  async function runSequential(list: RescueCall[]) {
    // Revokes first, each independent: one failure never stops the rest.
    for (const c of list.filter((x) => x.kind === "revoke" || x.kind === "permit2-lockdown")) await signOne(c);
    // Then each unwind: approve → (re-quote, re-simulate) swap. A failed approve skips its swap.
    const tokens = [...new Set(list.filter((x) => x.unwindToken).map((x) => x.unwindToken!))];
    for (const t of tokens) {
      const approve = list.find((x) => x.kind === "unwind-approve" && x.unwindToken === t)!;
      const swap = list.find((x) => x.kind === "unwind-swap" && x.unwindToken === t)!;
      if (!(await signOne(approve))) {
        step(swap.id, { status: "skipped", message: "approve did not confirm" });
        continue;
      }
      const holding = live?.holdings.find((h) => h.token.toLowerCase() === t.toLowerCase());
      let fresh = swap;
      if (holding && publicClient && address) {
        try {
          fresh = (await buildUnwind(publicClient, holding, address)).calls[1];
          fresh = { ...fresh, id: swap.id };
        } catch (e) {
          step(swap.id, { status: "failed", message: `re-quote failed: ${decodeErr(e)}` });
          continue;
        }
      }
      await signOne(fresh);
    }
  }

  async function runBatch(list: RescueCall[], label: string): Promise<"ok" | "failed" | "unsupported"> {
    let id: string;
    try {
      const res = await sendCallsAsync({ chainId, forceAtomic: true, calls: list.map((c) => ({ to: c.to, data: c.data })) });
      id = res.id;
    } catch (e) {
      if (isUserRejection(e)) throw e;
      const code = errCode(e);
      if (code !== null && ATOMIC_UNSUPPORTED_CODES.has(code)) return "unsupported";
      setExecErr(`${label}: ${decodeErr(e)}`);
      return "failed";
    }
    setBatches((b) => [...b, { id, label, status: "pending" }]);
    try {
      const st = await waitForCallsStatus(config, { id, timeout: 180_000 });
      const tx = st.receipts?.[0]?.transactionHash;
      const status = st.status ?? "unknown";
      setBatches((b) => b.map((x) => (x.id === id ? { ...x, status, tx } : x)));
      return status === "success" ? "ok" : "failed";
    } catch (e) {
      setBatches((b) => b.map((x) => (x.id === id ? { ...x, status: `unknown (${decodeErr(e)})` } : x)));
      return "failed";
    }
  }

  async function execute() {
    if (!canSign || !address) return;
    const plan = calls;
    const targeted = revokeCalls.flatMap((c) => (c.kind === "revoke" ? [c.id.replace(/^revoke-/, "")] : approvals.filter((a) => a.kind === "permit2" && selected.has(keyOf(a))).map(keyOf)));
    setExecErr(null);
    setVerify(null);
    setSteps({});
    setBatches([]);
    setExecuting(true);
    try {
      if (walletChainId !== chainId) await switchChainAsync({ chainId });
      const revokes = plan.filter((c) => c.kind === "revoke" || c.kind === "permit2-lockdown");
      const unwinds = plan.filter((c) => c.kind === "unwind-approve" || c.kind === "unwind-swap");
      if (useAtomic) {
        const groups = separate && revokes.length && unwinds.length ? [{ list: revokes, label: "Revoke batch" }, { list: unwinds, label: "Unwind batch" }] : [{ list: plan, label: "Atomic rescue" }];
        for (const g of groups) {
          const r = await runBatch(g.list, g.label);
          if (r === "unsupported") {
            setExecErr("Wallet refused an atomic batch: falling back to guided sequential signing.");
            await runSequential(g.list);
          }
        }
      } else {
        await runSequential(plan);
      }
    } catch (e) {
      setExecErr(isUserRejection(e) ? "Signature request rejected in the wallet: remaining steps cancelled." : decodeErr(e));
    } finally {
      setExecuting(false);
      setSim(null);
      // Post-rescue verification: re-read every allowance live (no server cache) and diff against the plan.
      const after = await refreshLive();
      if (after) {
        const still = new Set(after.approvals.map(keyOf));
        setVerify({ block: after.block, revoked: targeted.filter((k) => !still.has(k)), remaining: targeted.filter((k) => still.has(k)) });
        initSelection(after.approvals);
      } else setVerify({ block: "", revoked: [], remaining: targeted, error: "Could not re-read allowances: press re-read." });
    }
  }

  const doneCount = Object.values(steps).filter((s) => s.status === "confirmed").length;
  const focus = new Set(focusTokens.map((t) => t.toLowerCase()));
  const focusHit = focus.size > 0 && approvals.some((a) => focus.has(a.token.toLowerCase()));
  const labelOf = (k: string) => {
    const a = approvals.find((x) => keyOf(x) === k);
    if (a) return `${a.tokenSymbol} → ${a.spenderName}`;
    const [, t, s] = k.split(":");
    return `${shortAddr(t)} → ${shortAddr(s)}`;
  };
  const demo = isDemoWallet(subject);
  // Nothing picked yet: Steps 2–4 collapse to one ruled paper list and the live preview is the single filled primary.
  const awaitingSubject = !subject && !loading && !live;

  const unlimitedCount = approvals.filter((a) => a.unlimited).length;
  const walletScan = scan?.target.kind === "wallet" && scan.target.address.toLowerCase() === subject?.toLowerCase() ? scan : null;
  const signLabel = executing ? "SIGNING…" : "SIGN RESCUE";
  const signSub = useAtomic
    ? separate && unwindCalls.length && revokeCalls.length
      ? "2 atomic batches · EIP-5792"
      : "1 signature · atomic wallet_sendCalls"
    : `${calls.length} transaction${calls.length === 1 ? "" : "s"} · guided sequential`;

  return (
    <div className="min-w-0 space-y-6">
      {context && <p className="max-w-[80ch] border-l-2 border-warn pl-4 text-[14px] leading-relaxed text-ink-2">{context}</p>}
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 min-[901px]:grid-cols-12">
        {/* ── Procedure: Step 1–4 ── */}
        <div className="min-w-0 space-y-6 min-[901px]:col-span-8">
          <StepPanel n={1} title="Wallet" right={<ChainBadge chainId={8453} />}>
            {isConnected && address ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="mono text-[14px] text-ink">{shortAddr(address, 6)}</p>
                  <p className="mono text-[12px] text-ink-meta">
                    via {connector?.name ?? "wallet"} · chain {walletChainId}
                  </p>
                </div>
                <button onClick={() => disconnect()} className="ink-link mono text-[12px] text-ink-2 hover:text-ink max-[901px]:min-h-[44px]">
                  disconnect
                </button>
              </div>
            ) : (
              <div>
                <p className="max-w-[62ch] text-[14px] leading-relaxed text-ink-2">Connect to rescue your own wallet. Smart Wallets (Coinbase Smart Wallet, Safe, Ambire) batch everything into one atomic signature.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {connectors.map((c) => (
                    <button key={c.uid} onClick={() => connect({ connector: c, chainId })} disabled={connecting} className="press min-h-[40px] rounded-[2px] border border-hair-strong px-3 py-2 mono text-[12px] text-ink transition-colors hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40 max-[901px]:min-h-[44px] max-[601px]:flex-1">
                      {c.name}
                    </button>
                  ))}
                </div>
                {connectError && <p className="mt-2 mono text-[12px] text-crit">{decodeErr(connectError)}</p>}
              </div>
            )}
            {isConnected && (
              <p className="mt-4 border-t border-hair pt-3 mono text-[12px]">
                <span className="text-ink-meta">EIP-5792 wallet_getCapabilities → </span>
                {caps.isLoading ? <span className="text-ink-meta">probing…</span> : atomic ? <span className="text-phosphor">atomic batching SUPPORTED · 1 signature</span> : <span className="text-warn">not supported · guided sequential signing</span>}
              </p>
            )}
            <div className="mt-4 border-t border-hair pt-3">
              {subject ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mono text-[12px]">
                  <span className="text-ink-meta">{subjectIsWallet ? "Rescuing" : "Previewing (read-only)"}</span>
                  <AddrLink chainId={8453} address={subject} n={6} />
                  {demo && <span className="text-base">{DEMO_RESCUE_WALLET.label}</span>}
                  {live?.safe && (
                    <span className="text-ink-2">
                      Safe {live.safe.threshold}-of-{live.safe.owners} (live)
                    </span>
                  )}
                  {live && !live.safe && live.hasCode && <span className="text-ink-2">smart account</span>}
                  {choice !== "auto" && (
                    <button onClick={() => setChoice("auto")} className="ink-link text-ink-2 hover:text-ink max-[901px]:min-h-[44px]">
                      back
                    </button>
                  )}
                  {isConnected && address && !subjectIsWallet && (
                    <button onClick={() => setChoice("wallet")} className="ink-link text-phosphor max-[901px]:min-h-[44px]">
                      rescue my connected wallet instead
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-ink-2">No wallet selected. Connect one, or preview a live public wallet below.</p>
              )}
              {demo && <p className="mt-1.5 max-w-[70ch] text-[12px] leading-relaxed text-ink-meta">Public protocol treasury ({DEMO_RESCUE_WALLET.source}). Kestrel only reads it; only its owners could sign this bundle.</p>}
              {!demo && (
                <button
                  onClick={() => setChoice("demo")}
                  className={cx(
                    "press mt-3 max-[601px]:w-full",
                    awaitingSubject
                      ? "btn-primary min-h-[44px] px-5 mono text-[13px] tracking-[0.06em] max-[601px]:!h-auto max-[601px]:!whitespace-normal max-[601px]:px-3 max-[601px]:py-2.5 max-[601px]:text-center"
                      : "inline-flex min-h-[40px] items-center gap-2 rounded-[2px] border border-base/40 px-3 py-1.5 mono text-[12px] text-base transition-colors hover:bg-base/10 max-[901px]:min-h-[44px] max-[601px]:justify-center"
                  )}
                >
                  Preview a live wallet rescue · no wallet needed
                </button>
              )}
            </div>
          </StepPanel>

          {awaitingSubject ? (
            <PendingSteps />
          ) : (
            <>
              <StepPanel
                n={2}
                title="Approvals to revoke"
                right={
                  live ? (
                    <span className="flex items-center gap-3 whitespace-nowrap mono text-[12px] text-ink-meta">
                      <a href={explorerBlock(8453, live.block)} target="_blank" rel="noreferrer" className="hover:text-ink">
                        block #{BigInt(live.block).toLocaleString("en-US")} <span>↗</span>
                      </a>
                      <button onClick={() => void refreshLive()} disabled={busy} className="ink-link text-ink-2 hover:text-ink disabled:opacity-40 max-[901px]:min-h-[44px]">
                        re-read
                      </button>
                    </span>
                  ) : null
                }
              >
                {!subject && (
                  <p className="text-[14px] text-ink-2">
                    Connect a wallet, open <span className="mono">/rescue?target=0x…</span>, or use the live preview in Step 1.
                  </p>
                )}
                {loading && <SkeletonRows rows={3} caption="Reading allowances & Permit2 live from Base" />}
                {liveErr && <p className="mono text-[13px] text-crit">{liveErr}</p>}
                {live && !loading && approvals.length === 0 && (
                  <p className="font-serif text-[22px] leading-snug text-ink">
                    No open approvals at block #{BigInt(live.block).toLocaleString("en-US")}. <span className="text-phosphor">Nothing to revoke.</span>
                    <span className="mt-1 block font-sans text-[13px] text-ink-meta">{live.pairsChecked} token/spender pairs checked.</span>
                  </p>
                )}
                {focus.size > 0 && live && !focusHit && <p className="mb-2 text-[13px] text-ink-2">No live approvals on the alerted token for this wallet.</p>}
                {approvals.length > 0 && (
                  <ul className="-mx-5 -mt-2 divide-y divide-hair border-b border-hair max-[601px]:-mx-3">
                    {approvals.map((a) => {
                      const on = selected.has(keyOf(a));
                      const hot = focus.has(a.token.toLowerCase());
                      return (
                        <li key={keyOf(a)} className="relative">
                          {hot && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-warn" />}
                          {/* <=600px: row 1 = checkbox · token · amount, row 2 = full spender name (wraps instead of truncating). */}
                          <label className={cx("flex min-h-[48px] cursor-pointer items-center gap-3 px-5 py-2.5 transition-colors hover:bg-white/[0.02] max-[601px]:flex-wrap max-[601px]:gap-y-1 max-[601px]:px-3", !on && "opacity-60")}>
                            <input type="checkbox" className="h-4 w-4 accent-[var(--signal-critical)]" checked={on} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(keyOf(a)); else n.delete(keyOf(a)); return n; })} />
                            <span className="w-16 shrink-0 mono text-[13px] text-ink max-[601px]:w-auto">{a.tokenSymbol}</span>
                            <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2 max-[601px]:order-last max-[601px]:basis-full max-[601px]:whitespace-normal max-[601px]:pl-7 max-[601px]:[overflow-wrap:anywhere]">
                              <span className="text-ink-meta">spender </span>
                              {a.spenderName}
                              {a.kind === "permit2" && <span className="ml-2 mono text-[11px] text-ink-meta">PERMIT2</span>}
                            </span>
                            <span className={cx("tnum text-[13px] max-[601px]:ml-auto", a.unlimited ? "text-crit" : "text-warn")}>{a.unlimited ? "UNLIMITED" : fmtUnits(a.amount, a.tokenDecimals, 2)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </StepPanel>

              <StepPanel n={3} title="Unwind to USDC" right={<span className="whitespace-nowrap mono text-[12px] text-ink-meta">Aerodrome router · {Number(SLIPPAGE_BPS) / 100}% max slippage</span>}>
                {unwindable.length === 0 ? (
                  <p className="text-[14px] text-ink-2">{live ? "No VIBES or WETH balance to unwind. Optional step: revokes alone are a complete rescue." : "Unwindable VIBES / WETH balances appear here after the live read."}</p>
                ) : (
                  <ul className="-mx-5 -mt-2 divide-y divide-hair border-b border-hair max-[601px]:-mx-3">
                    {unwindable.map((h) => {
                      const k = h.token.toLowerCase();
                      const q = quotes[k];
                      return (
                        <li key={k} className="relative">
                          {focus.has(k) && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-warn" />}
                          <label className="flex min-h-[48px] cursor-pointer flex-wrap items-center gap-3 px-5 py-2.5 transition-colors hover:bg-white/[0.02] max-[601px]:gap-y-1 max-[601px]:px-3">
                            <input type="checkbox" className="h-4 w-4" checked={unwind.has(k)} onChange={(e) => setUnwind((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                            <span className="tnum text-[14px] text-ink">
                              {fmtUnits(h.balance, h.decimals, 4)} {h.symbol}
                            </span>
                            <span className={cx("ml-auto mono text-[12px]", q?.startsWith("error") ? "text-crit" : unwind.has(k) && q ? "text-ink" : "text-ink-meta")}>
                              {unwind.has(k) ? (q ? (q.startsWith("error") ? q : `≈ ${fmtUnits(q, 6, 2)} USDC`) : "quoting…") : "live quote on select"}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-ink-meta">Unwinds run after every revoke. Each approve is for the exact swap amount, so the router allowance ends at 0 once the swap fills.</p>
              </StepPanel>

              <StepPanel
                n={4}
                title="Rescue bundle"
                right={
                  <span className="flex items-center gap-3 whitespace-nowrap mono text-[12px] text-ink-meta">
                    <span>
                      {calls.length} call{calls.length === 1 ? "" : "s"}
                    </span>
                    {calls.length > 0 && (
                      <button onClick={() => setShowCalldata((v) => !v)} className="ink-link text-ink-2 hover:text-ink max-[901px]:min-h-[44px]">
                        {showCalldata ? "hide" : "show"} calldata
                      </button>
                    )}
                  </span>
                }
              >
                {calls.length === 0 ? (
                  <p className="text-[14px] text-ink-2">{subject ? (live ? "Select approvals to revoke (Step 2) or positions to unwind (Step 3)." : "Waiting for the live allowance read…") : "Pick a wallet in Step 1 to build its rescue bundle."}</p>
                ) : (
                  <ol className="-mx-5 -mt-2 divide-y divide-hair border-b border-hair max-[601px]:-mx-3">
                    {calls.map((c, i) => {
                      const s = simBound ? sim!.results[c.id] : simulating ? { status: "pending" as const } : undefined;
                      const st = steps[c.id];
                      return (
                        <li key={c.id} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 px-5 py-3.5 max-[601px]:px-3">
                          <span className="pt-0.5 mono text-[12px] text-ink-meta">{String(i + 1).padStart(2, "0")}</span>
                          <div className="min-w-0">
                            <p className="text-[14px] text-ink">{c.label}</p>
                            <p className="mt-0.5 mono text-[12px] text-ink-meta">
                              {c.functionName}() on <AddrLink chainId={8453} address={c.to} className="text-[12px]" />
                            </p>
                            {s && <p className={cx("mt-1 mono text-[12px]", s.status === "ok" ? "text-phosphor" : s.status === "fail" ? "text-crit" : s.status === "deferred" ? "text-warn" : "text-ink-meta")}>sim: {s.status === "pending" ? "running…" : s.message}</p>}
                            {st && (
                              <p className={cx("mt-1 mono text-[12px]", st.status === "confirmed" ? "text-phosphor" : st.status === "failed" ? "text-crit" : "text-warn")}>
                                tx: {st.status}
                                {st.hash && (
                                  <>
                                    {" "}
                                    · <TxLink chainId={8453} hash={st.hash} className="text-[12px]" />
                                  </>
                                )}
                                {st.message && ` · ${st.message}`}
                              </p>
                            )}
                            {/* <=900px: long calldata (Permit2 lockdown, swaps) scrolls inside a bounded well instead of stretching the list. */}
                            {showCalldata && <p className="mt-2 break-all bg-canvas px-2 py-1.5 mono text-[11px] leading-relaxed text-ink-meta max-[901px]:max-h-[76px] max-[901px]:overflow-y-auto max-[901px]:overscroll-contain">{c.data}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {verify && (
                  <div className="mt-4 border-t border-hair pt-3 mono text-[12px]">
                    <p className="text-ink-2">
                      Post-rescue live re-read
                      {verify.block && (
                        <>
                          {" "}
                          at block{" "}
                          <a href={explorerBlock(8453, verify.block)} target="_blank" rel="noreferrer" className="hover:text-ink">
                            #{BigInt(verify.block).toLocaleString("en-US")}
                          </a>
                        </>
                      )}
                      : <span className="text-phosphor">{verify.revoked.length} revoked</span> · <span className={verify.remaining.length ? "text-crit" : "text-ink-meta"}>{verify.remaining.length} still live</span>
                    </p>
                    {verify.remaining.map((k) => (
                      <p key={k} className="text-crit">
                        still live: {labelOf(k)}
                      </p>
                    ))}
                    {verify.error && <p className="text-warn">{verify.error}</p>}
                  </div>
                )}
              </StepPanel>
            </>
          )}
        </div>

        {/* ── Sign rail: exposure + the single crit SIGN RESCUE (sticky at 901px+) ── */}
        <aside className="min-w-0 min-[901px]:sticky min-[901px]:top-4 min-[901px]:col-span-4 min-[901px]:self-start" aria-label="Sign rescue">
          <section className="panel min-w-0 border-crit/30">
            <header className="flex items-center justify-between gap-3 border-b border-hair px-5 py-3 max-[601px]:px-3">
              <p className="t-kicker text-crit">[ LIVE // RESCUE ]</p>
              <ChainBadge chainId={8453} />
            </header>
            <div className="space-y-5 p-5 max-[601px]:p-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                {walletScan ? (
                  <RailFig label="Threat score" value={String(walletScan.score)} tone={walletScan.band === "CRITICAL" ? "crit" : walletScan.band === "ELEVATED" ? "warn" : "phosphor"} sub={walletScan.band} big />
                ) : (
                  <RailFig label="Live approvals" value={live ? String(approvals.length) : "—"} tone={live ? (approvals.length ? "warn" : "phosphor") : undefined} sub={live ? `${live.pairsChecked} pairs checked` : "awaiting read"} big />
                )}
                <RailFig label="Unlimited" value={live ? String(unlimitedCount) : "—"} tone={unlimitedCount ? "crit" : undefined} sub={walletScan ? `${approvals.length} live approvals` : undefined} big />
                <RailFig label="Native ETH" value={live ? fmtUnits(live.nativeBalance, 18, 4) : "—"} />
                <RailFig label="Bundle" value={`${calls.length} call${calls.length === 1 ? "" : "s"}`} sub={`${revokeCalls.length} revoke · ${unwindCalls.length} unwind`} />
              </div>

              <div className="space-y-2 border-t border-hair pt-4">
                {!subjectIsWallet ? (
                  <p className="text-[13px] leading-relaxed text-ink-2">
                    {calls.length > 0 ? (
                      <>
                        Preview mode: Step 4 is the exact calldata Kestrel would submit for {shortAddr(subject, 6)}. {demo ? "Only the Safe's owners could execute it (as one Safe batch)." : "Connect the wallet that owns these approvals to simulate and sign."}
                      </>
                    ) : (
                      "Connect the wallet that owns the approvals to simulate and sign its rescue."
                    )}
                  </p>
                ) : (
                  <>
                    {useAtomic && unwindCalls.length > 0 && revokeCalls.length > 0 && (
                      <label className="flex items-start gap-2 text-[13px] text-ink-2">
                        <input type="checkbox" className="mt-1" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
                        <span>
                          Keep revokes separate from swaps (2 signatures). <span className="text-ink-meta">{separate ? "Revokes land even if a swap reverts." : "One signature, all-or-nothing: if a swap reverts (price moved past slippage), the whole bundle reverts, revokes included."}</span>
                        </span>
                      </label>
                    )}
                    <button onClick={simulateAll} disabled={busy || calls.length === 0} className="press flex min-h-[44px] w-full items-center justify-between gap-3 rounded-[2px] border border-hair-strong px-4 mono text-[12px] tracking-wider text-ink transition-colors hover:border-phosphor/60 hover:text-phosphor disabled:cursor-not-allowed disabled:opacity-40">
                      <span>{simulating ? "SIMULATING…" : "SIMULATE ALL"}</span>
                      <span className="text-ink-meta">simulateCalls</span>
                    </button>
                  </>
                )}
                <button onClick={execute} disabled={!canSign} className={cx("press flex min-h-[48px] w-full flex-col items-center justify-center rounded-[2px] px-4 py-2 transition-colors disabled:cursor-not-allowed", awaitingSubject ? "border border-crit/40 text-crit/70" : "bg-crit text-white hover:bg-[#ff6668] disabled:opacity-30")}>
                  <span className="mono text-[13px] font-semibold tracking-[0.14em]">{signLabel}</span>
                  {subjectIsWallet && calls.length > 0 && <span className="mono text-[11px] text-white/80">{signSub}</span>}
                </button>
                <p className="mono text-[12px] text-ink-meta">
                  {simBound && sim!.block ? (
                    <>
                      Simulated at block{" "}
                      <a href={explorerBlock(8453, sim!.block)} target="_blank" rel="noreferrer" className="text-ink-2 hover:text-ink">
                        #{BigInt(sim!.block).toLocaleString("en-US")} <span className="text-ink-meta">↗</span>
                      </a>
                      {sim!.bundle ? " · ordered bundle (eth_simulateV1)" : " · per-call simulateContract"}
                    </>
                  ) : subjectIsWallet && calls.length > 0 ? (
                    "Not simulated yet. Signing unlocks only after every call passes."
                  ) : (
                    "Every call is simulated before any signature."
                  )}
                </p>
                {simStale && !busy && <p className="mono text-[12px] text-warn">The bundle changed since it was simulated (new quote, selection or account). Simulate again before signing.</p>}
                {simBound && !allSimOk && <p className="mono text-[12px] text-crit">Every call must pass simulation before signing.</p>}
                {hasDeferred && atomic && <p className="mono text-[12px] text-warn">This RPC can&apos;t simulate the swap after its approve in one bundle, so Kestrel signs sequentially and simulates each swap right before it.</p>}
                {!useAtomic && Object.keys(steps).length > 0 && (
                  <p className="mono text-[12px] text-ink-2">
                    {doneCount}/{calls.length} confirmed
                  </p>
                )}
                {batches.map((b) => (
                  <p key={b.id} className="mono text-[12px] text-ink-2">
                    {b.label} {shortAddr(b.id, 6)} · <span className={b.status === "success" ? "text-phosphor" : b.status === "pending" ? "text-ink-meta" : "text-crit"}>{b.status}</span>
                    {b.tx && (
                      <>
                        {" "}
                        · <TxLink chainId={8453} hash={b.tx} className="text-[12px]" />
                      </>
                    )}
                  </p>
                ))}
                {execErr && <p className="mono text-[12px] text-crit">{execErr}</p>}
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const PENDING_STEPS: [number, string, string][] = [
  [2, "Approvals to revoke", "Every live ERC-20 and Permit2 allowance on Base, read at the current block, unlimited ones pre-selected."],
  [3, "Unwind to USDC", "Optional: swap exposed VIBES or WETH to USDC through the Aerodrome router at a live quote."],
  [4, "Rescue bundle", "The exact calldata, simulated call by call, then signed once (EIP-5792) or step by step on an EOA."],
];

/** Steps 2–4 before a wallet is picked: one ruled, numbered paper list instead of three empty instruments. */
function PendingSteps() {
  return (
    <section aria-label="Steps 2 to 4" className="border-t border-hair-strong">
      <ol className="divide-y divide-hair border-b border-hair">
        {PENDING_STEPS.map(([n, title, body]) => (
          <li key={n} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 py-5 max-[601px]:grid-cols-1 max-[601px]:gap-y-1">
            <span className="font-serif text-[20px] leading-tight text-ink-meta">Step {n}</span>
            <span className="min-w-0">
              <span className="block font-serif text-[22px] leading-tight text-ink">{title}</span>
              <span className="mt-1 block max-w-[62ch] text-[14px] leading-relaxed text-ink-2">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[13px] text-ink-2">Pick a wallet in Step 1, or preview a live public wallet, to fill these in.</p>
    </section>
  );
}

/** Procedure instrument: "Step N · Title" as a 24px serif rule header. Numerals are legitimate here (a real sequence). */
function StepPanel({ n, title, right, children }: { n: number; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel min-w-0 max-w-full max-[901px]:overflow-x-clip" aria-label={`Step ${n}: ${title}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hair px-5 py-4 max-[601px]:px-3">
        <h3 className="font-serif text-[24px] leading-tight text-ink max-[601px]:text-[22px]">
          <span className="text-ink-meta">Step {n} ·</span> {title}
        </h3>
        {right}
      </header>
      <div className="p-5 max-[601px]:p-3">{children}</div>
    </section>
  );
}

const RAIL_TONE = { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit" } as const;

function RailFig({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: keyof typeof RAIL_TONE; big?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="t-kicker">{label}</p>
      <p className={cx("mt-1.5 tnum leading-none [overflow-wrap:anywhere]", big ? "text-[40px] max-[601px]:text-[32px]" : "text-[18px]", tone ? RAIL_TONE[tone] : "text-ink")}>{value}</p>
      {sub && <p className="mt-1.5 mono text-[12px] leading-snug text-ink-meta">{sub}</p>}
    </div>
  );
}
