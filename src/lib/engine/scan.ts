import { type Address } from "viem";
import { CONTRACTS, KNOWN_LABELS } from "@/config/contracts";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { cached } from "@/lib/cache";
import { getPublicClientForChain } from "@/lib/rpc";
import { deterministicBrief } from "./brief";
import { errMsg, readTokenMeta } from "./chain-utils";
import { isVibestarterEscrow, readEscrow } from "./escrow";
import { bandFor, escrowFindings, flowFindings, parityFindings, poolFindings, totalScore, walletFindings, xrayFindings } from "./findings";
import { readOvernightFlow } from "./flow";
import { getBridgeParity } from "./parity";
import { discoverBestPool, readPool } from "./pools";
import { known7702Delegate } from "./eip7702";
import { poolSides } from "./sides";
import type { ChainId, Finding, PoolSnapshot, ScanResult, TargetKind } from "./types";
import { fetchCampaigns } from "./vibestarter-api";
import { detectWalletAccount, scanWallet } from "./wallet";
import { xrayContract } from "./xray";

const VIBES_SET = new Set(
  [
    CONTRACTS.base.vibesToken,
    CONTRACTS.robinhood.vibesToken,
    CONTRACTS.base.vibesAerodromePool,
    CONTRACTS.robinhood.vibesUniswapV3Pool,
    CONTRACTS.base.vibesBridgeAdapter,
    CONTRACTS.robinhood.vibesReserveAdapter,
  ].map((a) => a.toLowerCase())
);

/** Per-process memo of COMPLETE scans (bounded: expired entries are deleted, oldest evicted past CACHE_MAX). */
const cache = new Map<string, { at: number; result: ScanResult }>();
const CACHE_MS = 30_000;
const CACHE_MAX = 200;

function cacheGet(key: string): ScanResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function cachePut(key: string, result: ScanResult) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), result });
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  // Map iteration is insertion order → oldest first.
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(k);
  }
}

export interface ScanOptions {
  /**
   * Ignored: scans always carry the deterministic brief. The LLM brief runs only on an explicit
   * POST /api/brief (rate-limited, daily-capped, sanitized) — never inside GET /api/scan, SSR, the guard or the pager.
   */
  useLlm?: boolean;
  extraTokens?: Address[];
  /**
   * "wallet" forces the wallet/approval scan for any address (Panic Bunker subject: Safes, smart wallets, or any
   * contract that holds approvals). Default "auto" classifies first.
   */
  mode?: "auto" | "wallet";
}

/** getCode with one retry. Throws on RPC failure — an unreadable address must never be classified as an all-clear wallet. */
async function readCodeStrict(chainId: ChainId, address: Address) {
  const client = getPublicClientForChain(chainId);
  try {
    return await client.getCode({ address });
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await client.getCode({ address });
    } catch (e) {
      throw new Error(`Could not read bytecode for ${address} on chain ${chainId} (${e instanceof Error ? e.message.slice(0, 80) : "RPC error"}) — refusing to classify; retry shortly.`);
    }
  }
}

/** Id of the finding scanTarget adds when a secondary live read failed (results are partial, not clean). */
export const SCAN_DEGRADED_ID = "scan-degraded";

/**
 * Why a scan is incomplete (empty = complete). Covers secondary reads that failed inside the scan, a degraded
 * bytecode X-Ray and — unless `approvals: false` — a partial wallet approval scan. Degraded scans must never be
 * cached and must never yield a guard ALLOW.
 */
export function scanDegradedReasons(scan: Pick<ScanResult, "findings" | "xray" | "wallet"> & Partial<Pick<ScanResult, "flow" | "pool" | "parity">>, opts: { approvals?: boolean } = {}): string[] {
  const out: string[] = [];
  const f = scan.findings.find((x) => x.id === SCAN_DEGRADED_ID);
  if (f) out.push(f.detail);
  // In-band read failures (holder balances, chain head, overnight pool state/logs): the whale / LP / price
  // findings they feed are UNKNOWN, not absent.
  if (scan.flow?.degraded?.length) out.push(`Holder/flow read incomplete: ${scan.flow.degraded.slice(0, 2).join("; ")}`);
  if (scan.pool?.overnight?.degraded) out.push(scan.pool.overnight.degraded);
  if (scan.parity?.bridgeDegraded) out.push(scan.parity.bridgeDegraded);
  if (scan.xray?.degraded) out.push(`Bytecode X-Ray incomplete: ${(scan.xray.degradedReasons ?? []).slice(0, 2).join("; ") || "an RPC read failed"}`);
  if (opts.approvals !== false && scan.wallet?.coverage?.partial) out.push("Approval scan incomplete (some reads failed or the log window was not fully read)");
  return out;
}

/** Carries a degraded scan out of cached() so it is returned but never stored. */
class UncacheableScan extends Error {
  constructor(readonly result: ScanResult) {
    super("degraded scan — not cached");
  }
}

/** Shared KV key for a scan (same shape across /api/scan, /app and /rescue SSR so they share entries). */
export function scanCacheKey(chainId: ChainId, address: Address, opts: { mode?: "auto" | "wallet"; extraTokens?: Address[] } = {}): string {
  const tokensKey = (opts.extraTokens ?? []).map((t) => t.toLowerCase()).sort().join(",");
  return `scan:${chainId}:${address.toLowerCase()}:0:${tokensKey}${opts.mode === "wallet" ? ":wallet" : ""}`;
}

/**
 * scanTarget behind the shared 30 s KV cache. Degraded scans are returned to the caller but NEVER stored, so a
 * cache hit is always a complete scan. Use this everywhere a scan is cached (API routes and SSR pages).
 */
export async function cachedScan(chainId: ChainId, address: Address, opts: ScanOptions = {}): Promise<{ result: ScanResult; degraded: string[] }> {
  try {
    const result = await cached(scanCacheKey(chainId, address, opts), 30, async () => {
      const r = await scanTarget(chainId, address, opts);
      if (scanDegradedReasons(r).length) throw new UncacheableScan(r);
      return r;
    });
    // Re-check on every return: entries written before this guard existed (or by other writers) may be degraded.
    return { result, degraded: scanDegradedReasons(result) };
  } catch (e) {
    if (e instanceof UncacheableScan) return { result: e.result, degraded: scanDegradedReasons(e.result) };
    throw e;
  }
}

const VIBES_POOL_BY_TOKEN: Record<string, Address> = {
  [`8453:${CONTRACTS.base.vibesToken.toLowerCase()}`]: CONTRACTS.base.vibesAerodromePool,
  [`4663:${CONTRACTS.robinhood.vibesToken.toLowerCase()}`]: CONTRACTS.robinhood.vibesUniswapV3Pool,
};

/** One retry for a throwing live read (transient RPC errors), then propagate. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

function poolLabel(pool: PoolSnapshot): string {
  return `${pool.token0.symbol}/${pool.token1.symbol} ${pool.venue} Pool`;
}

/**
 * Unified live scan: classifies any address on Base or Robinhood Chain (wallet / token / pool /
 * Vibestarter escrow / contract), runs the relevant live readers, scores, and writes the brief.
 */
export async function scanTarget(chainId: ChainId, address: Address, opts: ScanOptions = {}): Promise<ScanResult> {
  const mode = opts.mode ?? "auto";
  const key = `${chainId}:${address.toLowerCase()}:${mode}:${(opts.extraTokens ?? []).map((t) => t.toLowerCase()).sort().join(",")}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const started = Date.now();
  const client = getPublicClientForChain(chainId);
  const [latest, code] = await Promise.all([retryOnce(() => client.getBlock({ blockTag: "latest" })), readCodeStrict(chainId, address)]);
  const insp = inspectRawBytecode(code);
  const block = { chainId, number: latest.number.toString(), timestamp: Number(latest.timestamp) };

  let kind: TargetKind = "contract";
  let label = KNOWN_LABELS[address.toLowerCase()] ?? "";
  const findings: Finding[] = [];
  /** Secondary live reads that failed: the scan still answers, but flags itself incomplete (never "clean"). */
  const degraded: string[] = [];
  const soft = <T,>(what: string, p: Promise<T>): Promise<T | null> =>
    p.catch((e: unknown) => {
      degraded.push(`${what}: ${errMsg(e).slice(0, 100)}`);
      return null;
    });
  const result: Omit<ScanResult, "score" | "band" | "brief" | "generatedAt" | "durationMs" | "findings"> = {
    target: { address, chainId, kind, label },
    block,
    token: null,
    xray: null,
    pool: null,
    flow: null,
    wallet: null,
    escrow: null,
    parity: null,
  };

  const wantsParity = VIBES_SET.has(address.toLowerCase());
  const parityP = wantsParity ? soft("$VIBES bridge parity read failed", getBridgeParity({ overnight: false })) : Promise.resolve(null);

  // Smart-contract wallets (Safe, Coinbase Smart Wallet, ERC-4337) are WALLETS: full approval scan, not "contract".
  // Detection errors propagate (fail closed) instead of silently falling through to a contract/all-clear path.
  const account = !insp.isContract ? null : await retryOnce(() => detectWalletAccount(chainId, address, code ?? null));

  if (!insp.isContract || account || mode === "wallet") {
    kind = "wallet";
    result.wallet = await scanWallet(chainId, address, opts.extraTokens ?? [], { account: !insp.isContract ? undefined : (account ?? { kind: "smart-wallet", label: "Contract (scanned as wallet)" }) });
    findings.push(...walletFindings(result.wallet));
    label ||= result.wallet.account?.label ?? (insp.eip7702Delegate ? "EIP-7702 smart EOA" : "Wallet");
    if (insp.isContract && !account) result.xray = await soft("Bytecode X-Ray failed", xrayContract(chainId, address));
    // Unknown EIP-7702 delegate: X-Ray the delegate's code (known wallet delegators are info-only).
    else if (insp.eip7702Delegate && !known7702Delegate(insp.eip7702Delegate)) result.xray = await soft("EIP-7702 delegate X-Ray failed", xrayContract(chainId, address));
  } else if (await isVibestarterEscrow(chainId, address, await fetchCampaigns())) {
    kind = "escrow";
    result.escrow = await readEscrow(chainId, address, { probeApp: true });
    result.xray = await xrayContract(chainId, address);
    findings.push(...escrowFindings(result.escrow));
    label = result.escrow.title ? `${result.escrow.title} Tranche Escrow` : "Vibestarter Tranche Escrow";
  } else {
    // readPool returns null for "not a pool" and THROWS on RPC failure — a failure must not be read as "not a pool".
    const pool = await retryOnce(() => readPool(chainId, address));
    if (pool) {
      kind = "pool";
      result.pool = pool;
      findings.push(...poolFindings(pool));
      // Risky side by ADDRESS (quote = WETH/USDC/… per chain), never by symbol text.
      const risky = poolSides(pool).risky;
      result.token = risky;
      // Flow + top holder for the pool's risky token (enables "Top whale dumps 100%" on pool targets).
      const [xr, flow] = await Promise.all([
        soft(`${risky.symbol} bytecode X-Ray failed`, xrayContract(chainId, risky.address as Address)),
        soft(`${risky.symbol} holder/flow read failed`, readOvernightFlow(chainId, risky, [address])),
      ]);
      result.xray = xr;
      result.flow = flow;
      if (flow) findings.push(...flowFindings(flow, risky.symbol, risky.decimals, chainId));
      if (result.xray) findings.push(...xrayFindings(result.xray).map((f) => ({ ...f, title: `${risky.symbol}: ${f.title}` })));
      label ||= poolLabel(pool);
    } else {
      // readTokenMeta throws on RPC failure: that is UNKNOWN (degraded), never "not a token → Contract".
      let tokenUnknown = false;
      const token = await retryOnce(() => readTokenMeta(chainId, address)).catch((e: unknown) => {
        tokenUnknown = true;
        degraded.push(`Token metadata read failed (decimals/totalSupply): ${errMsg(e).slice(0, 100)}`);
        return null;
      });
      result.xray = await xrayContract(chainId, address);
      findings.push(...xrayFindings(result.xray));
      if (token) {
        kind = "token";
        result.token = token;
        label ||= `${token.name} (${token.symbol})`;
        // Best exit pool across every scanned venue (deepest WETH pair, else USDC/USDbC/cbBTC; WETH itself → WETH/USDC).
        // Discovery throws on RPC failure: that is UNKNOWN (degraded), not "no pool".
        const canonical = VIBES_POOL_BY_TOKEN[`${chainId}:${address.toLowerCase()}`] ?? null;
        let discoveryFailed = false;
        const poolAddr: Address | null =
          canonical ??
          (await discoverBestPool(chainId, address).then(
            (r) => (r ? (r.best.address as Address) : null),
            (e: unknown) => {
              discoveryFailed = true;
              degraded.push(`Pool discovery failed: ${errMsg(e).slice(0, 100)}`);
              return null;
            }
          ));
        const [poolSnap, flow] = await Promise.all([
          poolAddr ? soft("Exit pool read failed", readPool(chainId, poolAddr)) : Promise.resolve(null),
          soft(`${token.symbol} holder/flow read failed`, readOvernightFlow(chainId, token, poolAddr ? [poolAddr] : [])),
        ]);
        result.pool = poolSnap;
        result.flow = flow;
        if (poolSnap) findings.push(...poolFindings(poolSnap));
        else if (!poolAddr && !discoveryFailed)
          findings.push({
            id: "no-pool", severity: "warn", points: 12, title: "No pool on scanned venues",
            detail: chainId === 8453
              ? "No pool pairs this token with WETH, USDC, USDbC or cbBTC on Aerodrome v2 (volatile/stable), Aerodrome Slipstream CL or Uniswap v3 — exits may be impossible onchain."
              : "No Uniswap v3 pool pairs this token with WETH at any fee tier on Robinhood Chain — exits may be impossible onchain.",
          });
        if (flow) findings.push(...flowFindings(flow, token.symbol, token.decimals, chainId));
      } else if (tokenUnknown) {
        // Could be a token: pool, LP, whale and approval checks did not run. The scan-degraded finding says so.
        label ||= "Unclassified contract (token reads failed)";
      } else {
        label ||= "Contract";
        // Contracts that hold tokens/approvals (bot contracts, custom smart accounts) carry real approval exposure:
        // run the wallet scan too and attach it when it finds any, so the Panic Bunker can revoke them.
        const w = await scanWallet(chainId, address, opts.extraTokens ?? [], { account: { kind: "smart-wallet", label: "Contract account" } }).catch(() => null);
        if (w && (w.approvals.length || w.holdings.length)) {
          result.wallet = w;
          // A contract's own approvals are context, not code risk: summarize at 0 points (the full wallet-mode scan
          // — scanTarget(..., { mode: "wallet" }) — scores them).
          const unl = w.approvals.filter((a) => a.unlimited).length;
          findings.push({ id: "contract-approvals", severity: "info", points: 0, title: `Contract holds ${w.approvals.length} live approval${w.approvals.length === 1 ? "" : "s"}${unl ? ` (${unl} unlimited)` : ""}`, detail: `This contract has granted token allowances${w.holdings.length ? ` and holds ${w.holdings.length} token${w.holdings.length === 1 ? "" : "s"}` : ""}. If it is your account contract, revoke them in the Panic Bunker.` });
        }
      }
    }
  }

  result.parity = await parityP;
  if (result.parity) findings.push(...parityFindings(result.parity));
  result.target = { address, chainId, kind, label };
  if (degraded.length) {
    findings.push({
      id: SCAN_DEGRADED_ID, severity: "warn", points: 5,
      title: "Scan incomplete — some live reads failed",
      detail: `Results for these parts are UNKNOWN, not clean: ${degraded.slice(0, 4).join("; ")}. Re-scan shortly.`,
    });
  }

  const score = totalScore(findings);
  const band = bandFor(score);
  // Deterministic brief only. The LLM brief is opt-in via POST /api/brief.
  const brief = { text: deterministicBrief({ ...result, findings, score, band }), source: "deterministic" as const, model: null };
  const full: ScanResult = { ...result, findings, score, band, brief, generatedAt: new Date().toISOString(), durationMs: Date.now() - started };
  if (!scanDegradedReasons(full).length) cachePut(key, full);
  return full;
}
