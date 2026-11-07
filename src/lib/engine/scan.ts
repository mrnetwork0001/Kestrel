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
import { scanWallet } from "./wallet";
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
}

/**
 * Unified live scan: classifies any address on Base or Robinhood Chain (wallet / token / pool /
 * Vibestarter escrow / contract), runs the relevant live readers, scores, and writes the brief.
 */
export async function scanTarget(chainId: ChainId, address: Address, opts: ScanOptions = {}): Promise<ScanResult> {
  const key = `${chainId}:${address.toLowerCase()}:${opts.useLlm === false ? 0 : 1}:${(opts.extraTokens ?? []).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const started = Date.now();
  const client = getPublicClientForChain(chainId);
  const [latest, code] = await Promise.all([client.getBlock({ blockTag: "latest" }), client.getCode({ address }).catch(() => undefined)]);
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

  if (!insp.isContract) {
    kind = "wallet";
    result.wallet = await scanWallet(chainId, address, opts.extraTokens ?? []);
    findings.push(...walletFindings(result.wallet));
    label ||= insp.eip7702Delegate ? "EIP-7702 smart EOA" : "Wallet";
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
      result.xray = await xrayContract(chainId, risky.address as Address).catch(() => null);
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
