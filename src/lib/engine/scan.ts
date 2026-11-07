import { type Address } from "viem";
import { CONTRACTS, KNOWN_LABELS } from "@/config/contracts";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { getPublicClientForChain } from "@/lib/rpc";
import { generateBrief } from "./brief";
import { readTokenMeta } from "./chain-utils";
import { isVibestarterEscrow, readEscrow } from "./escrow";
import { bandFor, escrowFindings, flowFindings, parityFindings, poolFindings, totalScore, walletFindings, xrayFindings } from "./findings";
import { readOvernightFlow } from "./flow";
import { getBridgeParity } from "./parity";
import { discoverWethPool, readPool } from "./pools";
import type { ChainId, Finding, ScanResult, TargetKind } from "./types";
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

const cache = new Map<string, { at: number; result: ScanResult }>();
const CACHE_MS = 30_000;

export interface ScanOptions {
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

/**
 * Unified live scan: classifies any address on Base or Robinhood Chain (wallet / token / pool /
 * Vibestarter escrow / contract), runs the relevant live readers, scores, and writes the brief.
 */
export async function scanTarget(chainId: ChainId, address: Address, opts: ScanOptions = {}): Promise<ScanResult> {
  const mode = opts.mode ?? "auto";
  const key = `${chainId}:${address.toLowerCase()}:${opts.useLlm === false ? 0 : 1}:${mode}:${(opts.extraTokens ?? []).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const started = Date.now();
  const client = getPublicClientForChain(chainId);
  const [latest, code] = await Promise.all([client.getBlock({ blockTag: "latest" }), readCodeStrict(chainId, address)]);
  const insp = inspectRawBytecode(code);
  const block = { chainId, number: latest.number.toString(), timestamp: Number(latest.timestamp) };

  let kind: TargetKind = "contract";
  let label = KNOWN_LABELS[address.toLowerCase()] ?? "";
  const findings: Finding[] = [];
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
  const parityP = wantsParity ? getBridgeParity({ overnight: false }).catch(() => null) : Promise.resolve(null);

  // Smart-contract wallets (Safe, Coinbase Smart Wallet, ERC-4337) are WALLETS: full approval scan, not "contract".
  // Detection errors propagate (fail closed) instead of silently falling through to a contract/all-clear path.
  const account = !insp.isContract ? null : await detectWalletAccount(chainId, address, code ?? null);

  if (!insp.isContract || account || mode === "wallet") {
    kind = "wallet";
    result.wallet = await scanWallet(chainId, address, opts.extraTokens ?? [], { account: !insp.isContract ? undefined : (account ?? { kind: "smart-wallet", label: "Contract (scanned as wallet)" }) });
    findings.push(...walletFindings(result.wallet));
    label ||= result.wallet.account?.label ?? (insp.eip7702Delegate ? "EIP-7702 smart EOA" : "Wallet");
    if (insp.isContract && !account) result.xray = await xrayContract(chainId, address).catch(() => null);
  } else if (await isVibestarterEscrow(chainId, address, await fetchCampaigns())) {
    kind = "escrow";
    result.escrow = await readEscrow(chainId, address, { probeApp: true });
    result.xray = await xrayContract(chainId, address);
    findings.push(...escrowFindings(result.escrow));
    label = result.escrow.title ? `${result.escrow.title} Tranche Escrow` : "Vibestarter Tranche Escrow";
  } else {
    const pool = await readPool(chainId, address).catch(() => null);
    if (pool) {
      kind = "pool";
      result.pool = pool;
      findings.push(...poolFindings(pool));
      const risky = [pool.token0, pool.token1].find((t) => !t.symbol.toUpperCase().includes("WETH")) ?? pool.token1;
      result.token = risky;
      // Flow + top holder for the pool's risky token (enables "Top whale dumps 100%" on pool targets).
      const [xr, flow] = await Promise.all([
        xrayContract(chainId, risky.address as Address).catch(() => null),
        readOvernightFlow(chainId, risky, [address]).catch(() => null),
      ]);
      result.xray = xr;
      result.flow = flow;
      if (flow) findings.push(...flowFindings(flow, risky.symbol, risky.decimals, chainId));
      if (result.xray) findings.push(...xrayFindings(result.xray).map((f) => ({ ...f, title: `${risky.symbol}: ${f.title}` })));
      label ||= `${pool.token0.symbol}/${pool.token1.symbol} ${pool.kind === "uniswap-v3" ? "Uniswap v3" : "Aerodrome"} Pool`;
    } else {
      const token = await readTokenMeta(chainId, address);
      result.xray = await xrayContract(chainId, address);
      findings.push(...xrayFindings(result.xray));
      if (token) {
        kind = "token";
        result.token = token;
        label ||= `${token.name} (${token.symbol})`;
        const poolAddr = await discoverWethPool(chainId, address);
        const [poolSnap, flow] = await Promise.all([
          poolAddr ? readPool(chainId, poolAddr).catch(() => null) : Promise.resolve(null),
          readOvernightFlow(chainId, token, poolAddr ? [poolAddr] : []),
        ]);
        result.pool = poolSnap;
        result.flow = flow;
        if (poolSnap) findings.push(...poolFindings(poolSnap));
        else findings.push({ id: "no-pool", severity: "warn", points: 12, title: "No WETH pool found", detail: chainId === 8453 ? "Aerodrome factory has no volatile WETH pool for this token — exits may be impossible onchain." : "No Uniswap v3 WETH pool at 1%/0.3%/0.05% tiers on Robinhood Chain." });
        findings.push(...flowFindings(flow, token.symbol, token.decimals, chainId));
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

  const score = totalScore(findings);
  const band = bandFor(score);
  const brief = await generateBrief({ ...result, findings, score, band }, { useLlm: opts.useLlm });
  const full: ScanResult = { ...result, findings, score, band, brief, generatedAt: new Date().toISOString(), durationMs: Date.now() - started };
  cache.set(key, { at: Date.now(), result: full });
  return full;
}
