import { randomBytes } from "node:crypto";
import { type Address, getAddress } from "viem";
import { TRACKED_TOKENS } from "@/config/contracts";
import { OWNABLE_ABI, SAFE_MULTISIG_ABI } from "@/lib/abis";
import { parseAddressFromSlot } from "@/lib/bytecode-signatures";
import { parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";
import type { ChainId, ScanResult, ThreatBand } from "@/lib/engine/types";
import { getPublicClientForChain } from "@/lib/rpc";
import { PROXY_SLOT_NAMES, type ProxySlotName, SLOTS, VIBES_BRIDGE, VIBES_SET, WETH } from "./constants";
import { blankState, computeGlobals, evaluateWatch, type RuleObservation } from "./evaluate";
import { type ChainSnapshot, fetchImplCode, type ImplCode, planChains, planFor, probeChain } from "./probes";
import { rulesFromTypes, validateRules } from "./rules";
import type { Desk, Hex, RuleConfig, TokenRef, Watch, WatchState } from "./types";

/**
 * armWatch (spec §6/§13): classify the target once with a live `scanTarget(useLlm:false)`, capture
 * static meta (pool, token, proxy slots, owner Safe, approval token filter, $VIBES bridge lanes),
 * then run the same batched probe pass the tick uses and seed every baseline with a `seedOnly`
 * evaluation, so the first tick compares against real armed values and never alerts on "arming".
 */

export class ArmError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ArmError";
    this.status = status;
  }
}

export interface ArmInput {
  address: string;
  chainId: number;
  label?: string | null;
  /** Partial rule configs (`{type, enabled?, …params}`) or plain rule type strings (MCP). */
  rules?: unknown[] | null;
  /** Extra Base token addresses for approval-log coverage (≤ 10). */
  extraTokens?: string[] | null;
}

export interface ArmResult {
  watch: Watch;
  state: WatchState;
  scan: { score: number; band: ThreatBand; kind: Watch["kind"]; label: string; block: string };
  observations: RuleObservation[];
  baselineErrors: string[];
}

const MAX_APPROVAL_TOKENS = 60;
const tokenRef = (t: { address: string; symbol: string; decimals: number }): TokenRef => ({
  address: getAddress(t.address) as Hex,
  symbol: String(t.symbol).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24),
  decimals: t.decimals,
});

export function sanitizeWatchLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Proxy slots in use, owner() presence and whether the owner is a Safe (one storage batch + one multicall). */
export async function readProxyMeta(chainId: ChainId, target: Address): Promise<{ meta: Watch["meta"]["proxy"]; slotValues: Partial<Record<ProxySlotName, string>>; owner: string | null }> {
  const client = getPublicClientForChain(chainId);
  const vals = await Promise.all(PROXY_SLOT_NAMES.map((n) => client.getStorageAt({ address: target, slot: SLOTS[n] }).catch(() => undefined)));
  const slotValues: Partial<Record<ProxySlotName, string>> = {};
  const slots: ProxySlotName[] = [];
  PROXY_SLOT_NAMES.forEach((n, i) => {
    const a = parseAddressFromSlot(vals[i]);
    if (a) {
      slots.push(n);
      slotValues[n] = a.toLowerCase();
    }
  });
  const [owner] = await client.multicall({ allowFailure: true, contracts: [{ address: target, abi: OWNABLE_ABI, functionName: "owner" }] });
  const ownerAddr = owner.status === "success" ? String(owner.result) : null;
  let safe: Hex | null = null;
  if (ownerAddr && !/^0x0{40}$/i.test(ownerAddr)) {
    const code = await client.getCode({ address: getAddress(ownerAddr) }).catch(() => undefined);
    if (code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) {
      const [thr, owners] = await client.multicall({
        allowFailure: true,
        contracts: [
          { address: getAddress(ownerAddr), abi: SAFE_MULTISIG_ABI, functionName: "getThreshold" },
          { address: getAddress(ownerAddr), abi: SAFE_MULTISIG_ABI, functionName: "getOwners" },
        ],
      });
      if (thr.status === "success" && owners.status === "success") safe = getAddress(ownerAddr) as Hex;
    }
  }
  const hasOwnerFn = owner.status === "success";
  return { meta: slots.length || hasOwnerFn ? { slots, hasOwnerFn, safe } : undefined, slotValues, owner: ownerAddr };
}

/** Static meta from a scan (no extra I/O except the proxy probe for tokens / contracts). */
export async function buildMeta(chainId: ChainId, target: Address, scan: ScanResult, extraTokens: Address[]): Promise<{ meta: Watch["meta"]; slotValues: Partial<Record<ProxySlotName, string>> }> {
  const kind = scan.target.kind;
  const meta: Watch["meta"] = {};
  const weth = WETH[chainId].toLowerCase();
  if (scan.pool && (kind === "pool" || kind === "token")) {
    const p = scan.pool;
    meta.pool = {
      address: getAddress(p.address) as Hex,
      kind: p.kind === "aerodrome-v2" ? "aerodrome-v2" : "uniswap-v3", // Slipstream CL shares v3 slot0/liquidity/Burn semantics
      token0: tokenRef(p.token0),
      token1: tokenRef(p.token1),
      feeBps: p.feeBps,
      wethSide: p.token0.address.toLowerCase() === weth ? 0 : p.token1.address.toLowerCase() === weth ? 1 : null,
    };
  }
  if (scan.token && (kind === "token" || kind === "pool")) meta.token = tokenRef(scan.token);
  let slotValues: Partial<Record<ProxySlotName, string>> = {};
  if (kind === "token" || kind === "contract") {
    const pm = await readProxyMeta(chainId, target);
    if (pm.meta) meta.proxy = pm.meta;
    slotValues = pm.slotValues;
  }
  if (kind === "wallet") {
    meta.isEoa = true; // scanTarget classifies code-less addresses (incl. EIP-7702 delegated EOAs) as wallets
    const fromScan = [...(scan.wallet?.holdings ?? []).map((h) => h.token), ...(scan.wallet?.approvals ?? []).map((a) => a.token)];
    const set = new Map<string, Hex>();
    for (const t of [...TRACKED_TOKENS[chainId], ...extraTokens, ...fromScan]) {
      try {
        set.set(t.toLowerCase(), getAddress(t) as Hex);
      } catch {
        /* skip malformed */
      }
    }
    meta.approvalTokens = [...set.values()].slice(0, MAX_APPROVAL_TOKENS);
  }
  if (VIBES_SET.has(target.toLowerCase())) {
    meta.vibes = true;
    meta.bridge = VIBES_BRIDGE.map((b) => ({ ...b }));
  }
  return { meta, slotValues };
}

function resolveRules(input: unknown[] | null | undefined, kind: Watch["kind"], meta: Watch["meta"]): RuleConfig[] {
  if (input && input.length && input.every((x) => typeof x === "string")) {
    const v = rulesFromTypes(input, kind, meta);
    if (!v.ok) throw new ArmError(v.error, 400);
    return v.rules;
  }
  const v = validateRules(input ?? undefined, kind, meta);
  if (!v.ok) throw new ArmError(v.error, 400);
  return v.rules;
}

export async function armWatch(desk: Pick<Desk, "id">, input: ArmInput): Promise<ArmResult> {
  const address = parseAddress(input.address);
  if (!address) throw new ArmError("address must be a 0x-prefixed 20-byte address", 400);
  const chainId = Number(input.chainId);
  if (chainId !== 8453 && chainId !== 4663) throw new ArmError("chainId must be 8453 (Base) or 4663 (Robinhood Chain)", 400);
  const extra: Address[] = [];
  for (const t of (input.extraTokens ?? []).slice(0, 10)) {
    const a = parseAddress(t);
    if (!a) throw new ArmError("extraTokens entries must be token addresses", 400);
    extra.push(a);
  }

  const scan = await scanTarget(chainId, address, { useLlm: false, extraTokens: extra });
  const kind = scan.target.kind;
  const { meta, slotValues } = await buildMeta(chainId, address, scan, extra);
  const rules = resolveRules(input.rules, kind, meta);
  const now = Date.now();
  const watch: Watch = {
    v: 1,
    id: `w_${randomBytes(8).toString("base64url").slice(0, 10)}`,
    deskId: desk.id,
    chainId,
    target: getAddress(address) as Hex,
    kind,
    label: sanitizeWatchLabel(input.label) || sanitizeWatchLabel(scan.target.label) || `${kind} ${address.slice(0, 6)}…${address.slice(-4)}`,
    enabled: true,
    rules,
    meta,
    createdAt: now,
    updatedAt: now,
  };

  // Baselines from the exact probe pass the tick will run (logs skipped: baselines are state).
  const baselineErrors: string[] = [];
  const plan = planFor(watch, undefined);
  const chains = [...new Set<ChainId>([chainId, ...planChains(plan)])];
  const snaps: Partial<Record<ChainId, ChainSnapshot>> = {};
  await Promise.all(
    chains.map(async (c) => {
      try {
        snaps[c] = await probeChain(c, plan, null, { skipLogs: true });
        baselineErrors.push(...snaps[c]!.errors.map((e) => `${c}: ${e}`));
      } catch (e) {
        baselineErrors.push(`${c}: probe failed (${e instanceof Error ? e.message.slice(0, 120) : "error"})`);
      }
    })
  );

  // Upgrade Tripwire baseline: risky selector set of the logic that runs today.
  const newImplCode: Record<string, ImplCode> = {};
  const logicKey = slotValues.eip1967Beacon ?? slotValues.eip1967Impl ?? slotValues.ozImpl;
  if (logicKey && meta.proxy) {
    try {
      let logic = logicKey;
      if (slotValues.eip1967Beacon) {
        logic = String(
          await getPublicClientForChain(chainId).readContract({
            address: getAddress(slotValues.eip1967Beacon),
            abi: [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const,
            functionName: "implementation",
          })
        ).toLowerCase();
      }
      newImplCode[logicKey] = await fetchImplCode(chainId, logic);
    } catch {
      baselineErrors.push("implementation bytecode unavailable: selector baseline empty");
    }
  }

  const block = snaps[chainId]?.block.number.toString() ?? scan.block.number;
  let state = blankState(watch, now, block);
  let observations: RuleObservation[] = [];
  if (snaps[chainId]) {
    const r = evaluateWatch({ now, snap: snaps, globals: computeGlobals(snaps, null, now), newImplCode, seedOnly: true }, watch, state);
    state = r.next;
    observations = r.observations;
    state.lastCheckedAt = null; // the first real tick is the first "check"
    state.lastCheckedBlock = null;
  } else {
    state.lastError = "baseline probe failed at arm time: the first tick will seed baselines";
  }
  state.armedBlock = block;
  state.scan = { score: scan.score, band: scan.band, at: now, block: scan.block.number };

  return {
    watch,
    state,
    scan: { score: scan.score, band: scan.band, kind, label: scan.target.label, block: scan.block.number },
    observations,
    baselineErrors,
  };
}
