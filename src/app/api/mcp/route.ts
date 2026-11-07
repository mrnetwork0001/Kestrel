import { after, NextResponse } from "next/server";
import { type Address, getAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { clientIp, CORS_HEADERS, json, preflight, rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg, parseAddress } from "@/lib/engine/chain-utils";
import { readEscrow } from "@/lib/engine/escrow";
import { escrowFindings } from "@/lib/engine/findings";
import { cachedGuardVerdict, type GuardIntent } from "@/lib/engine/guard";
import { getBridgeParity } from "@/lib/engine/parity";
import { discoverWethPool, readPool } from "@/lib/engine/pools";
import { simulateExit, toIntInRange } from "@/lib/engine/sim";
import type { ChainId } from "@/lib/engine/types";
import { ArmError, type ArmResult, armWatch } from "@/lib/pager/arm";
import { ipHash, requireDeskByKey, storageGuard } from "@/lib/pager/auth";
import { deskIdFromKey, isDeskKey } from "@/lib/pager/desk-key";
import { hit, type LimitBucket, limit, maxDesksPerIpDay, maxWatchesPerDesk, maxWatchesTotal, watchCapFor } from "@/lib/pager/limits";
import { RULE_CATALOGUE, RULE_TYPES } from "@/lib/pager/rules";
import {
  StoreError,
  addWatch,
  countWatchesTotal,
  createDesk,
  deleteWatch,
  getDesk,
  getWatches,
  listWatchViews,
  newWatchId,
  sanitizeLabel,
  toDeskPublic,
  toWatchView,
} from "@/lib/pager/store";
import type { Desk, Hex, Watch, WatchState } from "@/lib/pager/types";
import { siteUrl } from "@/lib/site";
import { buildChallengeBase, DRY_RUN_OUTCOMES, type DryRunOutcome, readChallengeCopilot, runChallengeDryRun } from "@/lib/vibestarter/challenge";
import { getEcosystemBoard, readEcosystemRowByKey } from "@/lib/vibestarter/ecosystem";
import { vibestarterPulse } from "@/lib/vibestarter/pulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Max JSON-RPC messages per HTTP request; each message is charged one rate-limit unit. */
const MAX_BATCH = 20;
/** Per-tool wall clock (the function itself is capped at 60 s). */
const TOOL_TIMEOUT_MS = 55_000;

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const chainProp = { type: "integer", enum: [8453, 4663], default: 8453, description: "8453 = Base Mainnet, 4663 = Robinhood Chain Mainnet" };
const addrProp = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const deskKeyProp = {
  type: "string",
  pattern: "^kst_[A-Za-z0-9_-]{20,64}$",
  description: "Desk key (kst_…) returned once by create_watch or POST /api/pager/desk. It is a bearer credential for alert settings only; it can never move funds.",
};
const RULE_LIST = RULE_TYPES.map((t) => `${t} (${RULE_CATALOGUE[t].label})`).join("; ");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const TOOLS = [
  {
    name: "scan_contract",
    title: "Kestrel pre-trade security gate",
    description:
      "Free-tier pre-trade verdict for any Base (8453) or Robinhood Chain (4663) address: ALLOW | WARN | BLOCK, 0-100 risk score, threat band, top reasons, simulated 1% exit slippage and pool depth. Everything is read live over RPC (bytecode dispatcher selectors, EIP-1967/ZeppelinOS/beacon proxy slots, owner posture, pool reserves, 8h log deltas). Fails closed: status 'degraded' (never ALLOW) when an RPC read fails. intent=trade (default) BLOCKs addresses with no contract code (a token or pool must have code); intent=counterparty treats a wallet as a normal recipient. Same engine as GET /api/v1/guard?mode=preview; the paid x402 tier (mode=full) is HTTP only.",
    inputSchema: {
      type: "object",
      properties: {
        address: { ...addrProp, description: "Token, pool, wallet, contract or Vibestarter escrow address" },
        chainId: chainProp,
        intent: { type: "string", enum: ["trade", "counterparty"], default: "trade", description: "trade: you are about to swap/approve this token or pool. counterparty: you are about to send to this address." },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "check_bridge_parity",
    title: "$VIBES OFT parity, bridge lanes & spread",
    description:
      "Live dual-chain check of the $VIBES LayerZero OFT. verdict: EXACT (Base adapter locked == Robinhood totalSupply - reserve adapter balance), IN_FLIGHT (difference explained by packets still crossing), OVER_BACKED, or UNBACKED (Robinhood supply exceeds locked collateral, confirmed by a second read). Also returns both bridge lanes (live LayerZero quoteSend fee, inbound credit budget limit/headroom/window, pause flags, DVN set, config match, undelivered packets), adapter governance (owner Safe, pauser, delegate), and the Base Aerodrome vs Robinhood Uniswap v3 VIBES/WETH spread: spreadBps, netEdgeBpsBeforeBridge (after pool fees) and netEdgeBps (after pool fees, LayerZero fee and gas; null when the fee could not be read). uint256 values are decimal strings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "simulate_exit",
    title: "Simulate the rug (exact AMM exit)",
    description:
      "Exact BigInt exit simulation on a live pool: Aerodrome v2 constant-product (getReserves + live factory fee) or concentrated liquidity (Uniswap v3 / Aerodrome Slipstream slot0.sqrtPriceX96 + liquidity, active range). Pass a pool, or a token (its deepest WETH pool is discovered live). Applies optional LP-removal and whale-dump shocks before your sell and returns amount out before/after, price impact and drawdown in bps, plus the block read.",
    inputSchema: {
      type: "object",
      properties: {
        address: { ...addrProp, description: "Pool address, or a token address (its WETH pool is discovered live)" },
        chainId: chainProp,
        sellBpsOfReserve: { type: "integer", minimum: 1, maximum: 10000, default: 100, description: "Your sell size in bps of the pool's token-side reserve (100 = 1%)" },
        lpPullBps: { type: "integer", minimum: 0, maximum: 9500, default: 0, description: "Liquidity removed before your sell, in bps (5000 = half the LP pulled)" },
        whaleDumpBpsOfSupply: { type: "integer", minimum: 0, maximum: 10000, default: 0, description: "Whale sell before yours, in bps of token total supply" },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "inspect_vibestarter_escrow",
    title: "Vibestarter Backer Shield (escrow read)",
    description:
      "Live read of one VibesTranchEscrow: campaign state, the 10% kickstart + six 15% monthly tranche schedule, 72h challenge-window countdowns (escrow's own clock), active challenge, Proof-of-Lock (permanent LP lock), Refund Radar, Origin Capsule, founder app HTTP health and GitHub velocity, plus scored findings. With no address on Base it reads the Genesis $VIBES escrow (0x0e9bf34baed84a80d7647dafe4db52169147c911).",
    inputSchema: {
      type: "object",
      properties: { address: { ...addrProp, description: "Escrow address (default on Base: Genesis $VIBES escrow; required on Robinhood Chain)" }, chainId: chainProp },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "challenge_copilot",
    title: "Backer Challenge Co-pilot",
    description:
      "Everything a backer needs before the 72h challenge window on a Vibestarter escrow closes: escrow version (v1/v2), phase (NOT_FUNDED, AWAITING_UNLOCK, AWAITING_REQUEST, WINDOW_OPEN, CHALLENGE_PENDING, AWAITING_CLAIM, COMPLETED, FROZEN, REFUNDING, FAILED), next-tranche countdowns, exact bond and 20% slash at risk, trust surface (adjudicator, platform Safe, signer, time oracle), unofficial vote tally when a challenge is pending, and a refund-if-upheld estimate computed by the contract's own upholdChallenge() inside eth_simulateV1. With `wallet`, adds that wallet's balance, allowance, contribution, credential/nonce, cooldown, vote and a readiness checklist in the contract's exact revert order. Read-only: never signs or sends.",
    inputSchema: {
      type: "object",
      properties: {
        escrow: { ...addrProp, description: "VibesTranchEscrow address" },
        chainId: chainProp,
        wallet: { ...addrProp, description: "Optional backer wallet to check eligibility and readiness for" },
      },
      required: ["escrow"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "challenge_dry_run",
    title: "Challenge Dry-Run (eth_simulateV1)",
    description:
      "Runs the REAL deployed escrow bytecode through eth_simulateV1 with synthetic actors and at most five listed storage-slot overrides (each verified against its getter before and inside the simulation). Scenarios: raise (approve, raise, support, oppose, duplicate vote reverts), reject (20% of the bond burned to 0xdead), uphold (escrow ends Frozen with refund snapshot), expire (no-op at half window, full bond back after). Escrows that are not Funded run only the raise attempt and show the contract's real revert. Nothing is broadcast.",
    inputSchema: {
      type: "object",
      properties: {
        escrow: { ...addrProp, description: "VibesTranchEscrow address" },
        chainId: chainProp,
        outcomes: { type: "array", items: { type: "string", enum: DRY_RUN_OUTCOMES }, uniqueItems: true, description: "Scenarios to run (default: all four)" },
      },
      required: ["escrow"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "ecosystem_health",
    title: "Vibestarter Ecosystem Health Board",
    description:
      "Every Vibestarter launch on Base and Robinhood Chain in one board: token X-Ray score, Proof-of-Lock share, pool depth (real WETH held), escrow state and next window countdown, Refund Radar, founder app HTTP health, founder GitHub velocity and Origin Capsule status, with attention-ranked warning signals and BigInt totals. Served from a 120 s stale-while-revalidate cache (see cache.ageSec / cache.stale). Filter by chainId, or pass escrow for one row. Unreadable values are reported as 'unavailable' with a reason, never guessed.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "integer", enum: [8453, 4663], description: "Only launches on this chain (default: both)" },
        escrow: { ...addrProp, description: "Return only the launch with this escrow (chainId defaults to 8453)" },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "vibestarter_pulse",
    title: "Vibestarter Pulse (MCP-to-MCP)",
    description:
      "Platform-wide Vibestarter figures fetched by Kestrel from Vibestarter's own MCP server (https://app.vibestarter.xyz/mcp: get_platform_stats + list_raises, with provenance), falling back to the REST /api/stats. Vibestarter's 'liquidity locked' figure is reconciled against the on-chain sum of VibesLPLockerV2.getAllLockedPositions() on Base (matches / delta in wei). Includes the next unlock and the raise list. source='unavailable' with errors when neither source answers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "create_watch",
    title: "Arm a Night-Shift Pager watch",
    description:
      `Arms a 24/7 Night-Shift Pager watch on a wallet, token, pool, contract or Vibestarter escrow. The target is classified and every baseline is seeded from live mainnet state (takes 3-20 s), so the first check never alerts on arming. Without deskKey a new anonymous desk is opened and its deskKey is returned ONCE: store it (it is the only credential; alert settings only, never funds). manageUrl opens the desk in the Kestrel UI to link Telegram or a webhook and start Sleep Mode. rules: omit for the defaults of the target kind, or pass rule type strings to enable exactly those. Rule types: ${RULE_LIST}.`,
    inputSchema: {
      type: "object",
      properties: {
        address: { ...addrProp, description: "Target to watch" },
        chainId: chainProp,
        deskKey: { ...deskKeyProp, description: `${deskKeyProp.description} Omit to open a new desk.` },
        label: { type: "string", maxLength: 80, description: "Watch label (plain text)" },
        deskLabel: { type: "string", maxLength: 60, description: "Label for a newly opened desk" },
        rules: {
          type: "array",
          maxItems: 32,
          items: {
            anyOf: [
              { type: "string", enum: RULE_TYPES },
              { type: "object", properties: { type: { type: "string", enum: RULE_TYPES }, enabled: { type: "boolean" } }, required: ["type"], additionalProperties: true, description: "Partial rule config: {type, enabled?, ...threshold params}" },
            ],
          },
          description: "Rule type strings (enable exactly these) or partial rule configs merged over the defaults",
        },
        extraTokens: { type: "array", maxItems: 10, items: addrProp, description: "Extra Base token addresses for wallet approval-log coverage" },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_watches",
    title: "List Night-Shift Pager watches",
    description: "Lists the watches on a desk with live status (ok / pending / alerting / errored), last checked block, last alert, armed rules and display metrics, plus the desk's delivery channels (no secrets) and watch limit.",
    inputSchema: { type: "object", properties: { deskKey: deskKeyProp }, required: ["deskKey"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_watch",
    title: "Delete a Night-Shift Pager watch",
    description: "Removes one watch (and its stored state) from a desk. Other desks' watches are never visible or deletable. Returns deleted:true; a watch that is not on this desk is an error.",
    inputSchema: {
      type: "object",
      properties: { deskKey: deskKeyProp, watchId: { type: "string", pattern: "^w_[A-Za-z0-9_-]{6,20}$", description: "Watch id (w_…) from create_watch or list_watches" } },
      required: ["deskKey", "watchId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

type RpcReq = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
interface Ctx {
  req: Request;
}

/** Input / authorization / rate-limit problem: reported as a tool result with isError so the model can self-correct. */
class ToolError extends Error {
  constructor(
    message: string,
    readonly info: { status?: number; retryAfterSec?: number } = {}
  ) {
    super(message);
  }
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { rpcCode: code });

function chainArg(v: unknown, dflt: ChainId = 8453): ChainId {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "string" && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : v;
  if (n === 8453 || n === 4663) return n;
  throw new ToolError("chainId must be 8453 (Base Mainnet) or 4663 (Robinhood Chain Mainnet)", { status: 400 });
}

function addrArg(v: unknown, name: string): Address {
  const a = parseAddress(v);
  if (!a) throw new ToolError(`\`${name}\` must be a 0x-prefixed 20-byte address`, { status: 400 });
  return a;
}

function optAddrArg(v: unknown, name: string): Address | null {
  return v === undefined || v === null || v === "" ? null : addrArg(v, name);
}

/** Turns a pager helper's ready-made error Response (401/404/429/503) into a ToolError. */
async function toolErrorFrom(res: Response): Promise<ToolError> {
  const body = (await res.json().catch(() => null)) as { error?: string; retryAfterSec?: number } | null;
  const retryAfterSec = typeof body?.retryAfterSec === "number" ? body.retryAfterSec : undefined;
  return new ToolError(`${body?.error ?? `HTTP ${res.status}`}${retryAfterSec ? ` (retry after ${retryAfterSec} s)` : ""}`, { status: res.status, retryAfterSec });
}

async function applyLimit(bucket: LimitBucket, subject: string): Promise<void> {
  const r = await limit(bucket, subject);
  if (r) throw await toolErrorFrom(r);
}

/** Desk from a key passed as a tool argument. The key is never logged or echoed in errors. */
async function deskFromKey(key: unknown): Promise<Desk> {
  if (typeof key !== "string" || !key.trim()) throw new ToolError("deskKey is required (the kst_… key returned by create_watch or POST /api/pager/desk)", { status: 401 });
  const guard = storageGuard();
  if (guard) throw await toolErrorFrom(guard);
  const r = await requireDeskByKey(key.trim());
  if (r instanceof Response) throw await toolErrorFrom(r);
  return r;
}

async function toolLimit(ctx: Ctx, tool: string, perMin: number): Promise<void> {
  if (await rateLimited(ctx.req, perMin, { route: `mcp:${tool}` })) throw new ToolError(`Rate limit: max ${perMin} ${tool} calls per minute`, { status: 429, retryAfterSec: 60 });
}

/** Batched messages run with this concurrency (never 20 cold scans / arms at once inside one 60 s invocation). */
const BATCH_CONCURRENCY = 3;

async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** create_watch is serialized per desk (or per network for desk-less calls): pre-checks then see finished arms. */
const watchChains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = watchChains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  watchChains.set(key, tail);
  void tail.then(() => {
    if (watchChains.get(key) === tail) watchChains.delete(key);
  });
  return run;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s; retry shortly`)), ms)))]).finally(() => clearTimeout(t));
}

async function createWatchTool(ctx: Ctx, args: Record<string, unknown>) {
  const address = getAddress(addrArg(args.address, "address")) as Hex;
  const chainId = chainArg(args.chainId);
  if (args.label !== undefined && args.label !== null && typeof args.label !== "string") throw new ToolError("label must be a string", { status: 400 });
  const label = typeof args.label === "string" ? sanitizeLabel(args.label) || undefined : undefined;
  let rules: unknown[] | undefined;
  if (args.rules !== undefined && args.rules !== null) {
    if (!Array.isArray(args.rules) || args.rules.length > 32) throw new ToolError("rules must be an array of at most 32 rule types or rule configs", { status: 400 });
    rules = args.rules;
  }
  let extraTokens: Hex[] | undefined;
  if (args.extraTokens !== undefined && args.extraTokens !== null) {
    if (!Array.isArray(args.extraTokens) || args.extraTokens.length > 10) throw new ToolError("extraTokens must be an array of at most 10 token addresses", { status: 400 });
    extraTokens = [...new Map(args.extraTokens.map((t) => addrArg(t, "extraTokens[]")).map((a) => [a.toLowerCase(), getAddress(a) as Hex])).values()];
  }

  // ---- desk + cheap pre-checks before the expensive live arm ----
  const hasKey = args.deskKey !== undefined && args.deskKey !== null && args.deskKey !== "";
  let desk: Desk | null = null;
  let ip: string | null = null;
  if (hasKey) {
    desk = await deskFromKey(args.deskKey);
    await applyLimit("watchCreate", desk.id);
    const max = maxWatchesPerDesk();
    if (desk.watchIds.length >= max && !desk.system) throw new ToolError(`Desk is full (max ${max} watches). Delete one first.`, { status: 429 });
    const existing = await getWatches(desk.watchIds);
    if (existing.some((w) => w.chainId === chainId && w.target.toLowerCase() === address.toLowerCase())) {
      throw new ToolError("This desk already watches that target on that chain", { status: 409 });
    }
  } else {
    const guard = storageGuard();
    if (guard) throw await toolErrorFrom(guard);
    ip = ipHash(ctx.req);
    await applyLimit("deskCreate", ip);
    await applyLimit("deskCreateGlobal", "all");
    const daily = await hit("deskDay", ip, { limit: maxDesksPerIpDay(), windowSec: 86_400 });
    if (daily.limited) throw new ToolError("Too many desks opened from this network today", { status: 429, retryAfterSec: daily.retryAfterSec });
  }
  if ((await countWatchesTotal()) >= watchCapFor(desk)) throw new ToolError(watchCapFor(desk) < maxWatchesTotal() ? "Night shift at capacity for desks without a linked channel. Link Telegram or a webhook first, then retry." : "Night shift at capacity, try again later", { status: 503 });

  // ---- arm from live chain state (the desk is only created once arming succeeded) ----
  let armed: ArmResult;
  try {
    armed = await armWatch({ id: desk?.id ?? "pending" }, { address, chainId, label, rules, extraTokens });
  } catch (e) {
    const msg = errMsg(e).replace(/\s+/g, " ").slice(0, 200);
    if (e instanceof ArmError && e.status >= 400 && e.status < 500) throw new ToolError(msg, { status: e.status });
    throw new Error(`Could not arm the watch: live chain read failed (${msg})`);
  }

  let deskKey: string;
  let opened = false;
  if (desk) deskKey = (args.deskKey as string).trim();
  else {
    const label = typeof args.deskLabel === "string" ? sanitizeLabel(args.deskLabel, 60) || null : null;
    const created = await createDesk(label ?? "MCP desk", ip ?? undefined);
    desk = created.desk;
    deskKey = created.deskKey;
    opened = true;
  }

  const now = Date.now();
  const watch: Watch = {
    ...armed.watch,
    v: 1,
    id: /^w_[A-Za-z0-9_-]{6,20}$/.test(armed.watch.id ?? "") ? armed.watch.id : newWatchId(),
    deskId: desk.id,
    chainId,
    label: sanitizeLabel(label ?? armed.watch.label) || `${armed.watch.kind} ${address.slice(0, 6)}…${address.slice(-4)}`,
    createdAt: armed.watch.createdAt || now,
    updatedAt: now,
  };
  const state: WatchState = { ...armed.state, watchId: watch.id };
  try {
    await addWatch(watch, state, { maxTotal: watchCapFor(desk) });
  } catch (e) {
    if (e instanceof StoreError) throw new ToolError(e.message, { status: e.status });
    throw e;
  }
  const fresh = (await getDesk(desk.id).catch(() => null)) ?? desk;
  return {
    watch: toWatchView(watch, state, now),
    scan: armed.scan,
    observations: armed.observations,
    baselineErrors: armed.baselineErrors,
    desk: toDeskPublic(fresh),
    ...(opened
      ? { deskKey, notice: "Store this desk key now: it is shown once and is the only credential for this desk. Anyone holding it can edit this desk's alerts; it can never touch funds." }
      : {}),
    manageUrl: `${siteUrl(ctx.req)}/app?tab=pager#desk=${deskKey}`,
    nextSteps: "Open manageUrl to link Telegram or a webhook (alerts are only delivered to a linked channel) and to start Sleep Mode for a morning digest.",
  };
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "scan_contract": {
      const address = addrArg(args.address, "address");
      const chainId = chainArg(args.chainId);
      if (args.intent !== undefined && args.intent !== null && args.intent !== "trade" && args.intent !== "counterparty") {
        throw new ToolError('intent must be "trade" or "counterparty"', { status: 400 });
      }
      const intent: GuardIntent = args.intent === "counterparty" ? "counterparty" : "trade";
      // Same budget as GET /api/v1/guard preview (60/min per network, shared bucket).
      if (await rateLimited(ctx.req, 60, { route: "/api/v1/guard" })) throw new ToolError("Rate limit: max 60 scan_contract / guard preview calls per minute", { status: 429, retryAfterSec: 60 });
      // Same 30 s cache as GET /api/v1/guard; degraded verdicts are returned but never cached.
      return cachedGuardVerdict(chainId, address, "preview", { intent });
    }
    case "check_bridge_parity": {
      const p = await cached("parity:lite", 15, () => getBridgeParity({ overnight: false }));
      return {
        verdict: p.verdict,
        verified: p.verified,
        lockedOnBaseRaw: p.lockedOnBase,
        rhTotalSupplyRaw: p.rhTotalSupply,
        rhReserveRaw: p.rhReserve,
        rhCirculatingRaw: p.rhCirculating,
        deltaRaw: p.delta,
        deltaSignedRaw: p.deltaSigned,
        pendingPackets: p.pendingPackets,
        spreadBps: p.spreadBps,
        cheaperVenue: p.cheaperVenue,
        feeDragBps: p.feeDragBps,
        netEdgeBpsBeforeBridge: p.netEdgeBpsBeforeBridge,
        bridgeFeeBps: p.bridgeFeeBps,
        gasBps: p.gasBps,
        netEdgeBps: p.netEdgeBps,
        arbNotionalWei: p.arbNotionalWei,
        lanes:
          p.bridge?.lanes.map((l) => ({
            direction: l.direction,
            srcChainId: l.srcChainId,
            dstChainId: l.dstChainId,
            peersOk: l.peersOk,
            nativeFeeWei: l.nativeFeeWei,
            creditLimitRaw: l.credit?.limit ?? null,
            creditHeadroomRaw: l.credit?.headroom ?? null,
            creditInFlightRaw: l.credit?.inFlight ?? null,
            windowSec: l.credit?.windowSec ?? null,
            srcPaused: l.srcPaused,
            dstPaused: l.dstPaused,
            configMatches: l.configMatches,
            confirmations: l.confirmations,
            requiredDvns: l.requiredDvns.map((d) => d.name ?? d.address),
            unverified: l.nonces.unverified,
            awaitingExecution: l.nonces.awaitingExecution.length,
          })) ?? null,
        governance: p.bridge?.governance ?? null,
        arb: p.arb,
        ethUsd: p.ethUsd,
        baseBlock: p.base.number,
        robinhoodBlock: p.robinhood.number,
        fetchedAt: p.fetchedAt,
      };
    }
    case "simulate_exit":
    case "simulate_rug_shock": {
      const address = addrArg(args.address, "address");
      const chainId = chainArg(args.chainId);
      let pool = await readPool(chainId, address, { overnight: false });
      if (!pool) {
        const found = await discoverWethPool(chainId, address);
        if (found) pool = await readPool(chainId, found, { overnight: false });
      }
      if (!pool) throw new ToolError("No recognizable pool at that address, and no WETH pool found for it as a token (Aerodrome v2 / Slipstream / Uniswap v3)", { status: 404 });
      return {
        ...simulateExit(pool, {
          sellBpsOfReserve: toIntInRange(args.sellBpsOfReserve, 1, 10_000, 100),
          lpPullBps: toIntInRange(args.lpPullBps, 0, 9_500, 0),
          whaleDumpBpsOfSupply: toIntInRange(args.whaleDumpBpsOfSupply, 0, 10_000, 0),
        }),
        pool: pool.address,
        venue: pool.venue ?? pool.kind,
        chainId,
        blockNumber: pool.block.number,
      };
    }
    case "inspect_vibestarter_escrow": {
      const chainId = chainArg(args.chainId);
      const address = optAddrArg(args.address, "address") ?? (chainId === 8453 ? CONTRACTS.base.vibesGenesisEscrow : null);
      if (!address) throw new ToolError("address is required on Robinhood Chain (the Genesis default is a Base escrow)", { status: 400 });
      const e = await readEscrow(chainId, address);
      return { ...e, findings: escrowFindings(e) };
    }
    case "challenge_copilot": {
      const escrow = addrArg(args.escrow, "escrow");
      const chainId = chainArg(args.chainId);
      const wallet = optAddrArg(args.wallet, "wallet");
      const base = await cached(`challenge:base:v1:${chainId}:${escrow.toLowerCase()}`, 15, () => buildChallengeBase(chainId, escrow));
      return readChallengeCopilot(chainId, escrow, { wallet, base });
    }
    case "challenge_dry_run": {
      const escrow = addrArg(args.escrow, "escrow");
      const chainId = chainArg(args.chainId);
      if (args.outcomes !== undefined && args.outcomes !== null && (!Array.isArray(args.outcomes) || args.outcomes.some((o) => !DRY_RUN_OUTCOMES.includes(o as DryRunOutcome)))) {
        throw new ToolError(`outcomes must be an array of ${DRY_RUN_OUTCOMES.join(" | ")}`, { status: 400 });
      }
      await toolLimit(ctx, "challenge_dry_run", 10);
      const requested = Array.isArray(args.outcomes) ? DRY_RUN_OUTCOMES.filter((o) => (args.outcomes as unknown[]).includes(o)) : DRY_RUN_OUTCOMES;
      const outcomes = requested.length ? requested : DRY_RUN_OUTCOMES;
      return cached(`challenge:dryrun:v1:${chainId}:${escrow.toLowerCase()}:${outcomes.join(",")}`, 30, () => runChallengeDryRun(chainId, escrow, outcomes));
    }
    case "ecosystem_health": {
      const escrow = optAddrArg(args.escrow, "escrow");
      if (escrow) {
        const chainId = chainArg(args.chainId);
        const row = await readEcosystemRowByKey(chainId, escrow);
        if (!row) throw new ToolError(`No Vibestarter launch with escrow ${escrow} on chain ${chainId}`, { status: 404 });
        return { row };
      }
      const filter = args.chainId === undefined || args.chainId === null || args.chainId === "" ? null : chainArg(args.chainId);
      const board = await getEcosystemBoard({ onBackgroundRefresh: (p) => after(p) });
      return filter ? { ...board, rows: board.rows.filter((r) => r.chainId === filter), filter: { chainId: filter } } : board;
    }
    case "vibestarter_pulse":
      return vibestarterPulse();
    case "create_watch": {
      const k = typeof args.deskKey === "string" && isDeskKey(args.deskKey.trim()) ? `desk:${deskIdFromKey(args.deskKey.trim())}` : `net:${clientIp(ctx.req)}`;
      return serialized(k, () => createWatchTool(ctx, args));
    }
    case "list_watches": {
      const desk = await deskFromKey(args.deskKey);
      await applyLimit("watchList", desk.id);
      return { desk: toDeskPublic(desk), watches: await listWatchViews(desk), limits: { maxWatches: maxWatchesPerDesk() } };
    }
    case "delete_watch": {
      const desk = await deskFromKey(args.deskKey);
      const id = typeof args.watchId === "string" ? args.watchId.trim() : "";
      if (!/^w_[A-Za-z0-9_-]{6,20}$/.test(id)) throw new ToolError("watchId must be a watch id (w_…)", { status: 400 });
      await applyLimit("watchDelete", desk.id);
      if (!(await deleteWatch(desk.id, id))) throw new ToolError("Watch not found on this desk", { status: 404 });
      return { deleted: true, watchId: id };
    }
    default:
      throw rpcError(-32602, `Unknown tool: ${name}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function handleOne(ctx: Ctx, msg: RpcReq): Promise<object | null> {
  if (!isObj(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: each JSON-RPC message must be an object" } };
  const idOk = msg.id === undefined || msg.id === null || typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
  const id = idOk ? ((msg.id as string | number | null | undefined) ?? null) : null;
  if (typeof msg.method !== "string") {
    if ("result" in msg || "error" in msg) return null; // client JSON-RPC response → 202
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } };
  }
  if (msg.jsonrpc !== "2.0" || !idOk) return { jsonrpc: "2.0", id, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0" and id a string, number or null' } };
  const isNotification = msg.id === undefined;
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.params !== undefined && !isObj(msg.params)) {
    return isNotification ? null : { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: params must be an object" } };
  }
  const params = (msg.params ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (msg.method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        result = {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kestrel-sentinel", title: "Kestrel Overnight Sentinel", version: "0.2.0" },
          instructions:
            "Kestrel reads Base (8453) and Robinhood Chain (4663) mainnet live; nothing is mocked. Before any swap or approval call scan_contract (BLOCK = do not trade; status 'degraded' = retry). check_bridge_parity verifies the $VIBES OFT 1:1 reserve and bridge lanes; simulate_exit stress-tests a pool exit; inspect_vibestarter_escrow, challenge_copilot, challenge_dry_run and ecosystem_health cover Vibestarter escrows; vibestarter_pulse composes Vibestarter's own MCP. create_watch / list_watches / delete_watch manage 24/7 Night-Shift Pager watches (keep the deskKey private). uint256 values are decimal strings.",
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        if (typeof params.name !== "string" || !params.name) throw rpcError(-32602, "Invalid params: `name` (tool name) is required");
        if (params.arguments !== undefined && params.arguments !== null && !isObj(params.arguments)) throw rpcError(-32602, "Invalid params: `arguments` must be an object");
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const data = await withTimeout(callTool(ctx, name, args), TOOL_TIMEOUT_MS, name);
          result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
        } catch (e) {
          if ((e as { rpcCode?: number }).rpcCode) throw e;
          const info = e instanceof ToolError ? e.info : {};
          result = {
            content: [{ type: "text", text: `Error: ${errMsg(e)}` }],
            structuredContent: { error: errMsg(e), ...info },
            isError: true,
          };
        }
        break;
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
    return isNotification ? null : { jsonrpc: "2.0", id, result };
  } catch (e) {
    return isNotification ? null : { jsonrpc: "2.0", id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32603, message: errMsg(e) } };
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

function originOf(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).origin;
  } catch {
    return null;
  }
}

/**
 * MCP Streamable HTTP §Security: validate Origin to stop DNS-rebinding / cross-site browser calls.
 * No Origin (Claude Code, SDKs, curl, server-side agents) → allowed. A browser Origin must be this site's canonical
 * origin (NEXT_PUBLIC_APP_URL / Vercel URLs) — never the request's own Host, which a rebinding attacker controls.
 * Outside production, localhost origins are also allowed (MCP Inspector, local UI).
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const allowed = new Set<string>([siteUrl()]);
  for (const v of [process.env.NEXT_PUBLIC_APP_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]) {
    const x = originOf(v);
    if (x) allowed.add(x);
  }
  if (allowed.has(o.origin)) return true;
  return process.env.NODE_ENV !== "production" && LOCAL_HOST.test(o.hostname);
}

/** Streamable HTTP MCP endpoint (JSON responses; no server-initiated SSE stream). */
export async function POST(req: Request) {
  if (!originAllowed(req)) {
    return json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: Origin not allowed for this MCP server" } }, { status: 403 });
  }
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED_VERSIONS.includes(pv.trim())) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version ${pv.slice(0, 20)}; supported: ${SUPPORTED_VERSIONS.join(", ")}` } }, { status: 400 });
  }
  let payload: unknown;
  let parsed = true;
  try {
    payload = await req.json();
  } catch {
    parsed = false;
  }
  const batch = Array.isArray(payload);
  const messages = (parsed ? (batch ? payload : [payload]) : []) as RpcReq[];
  // One unit per JSON-RPC message (oversized batches are charged the cap, then rejected).
  if (await rateLimited(req, 60, { cost: Math.min(Math.max(messages.length, 1), MAX_BATCH) })) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Rate limited" } }, { status: 429 });
  }
  if (!parsed) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  if (batch && (messages.length === 0 || messages.length > MAX_BATCH)) {
    const message = messages.length ? `Invalid Request: batch of ${messages.length} exceeds the max of ${MAX_BATCH} messages` : "Invalid Request: empty batch";
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status: 400 });
  }
  const ctx: Ctx = { req };
  const responses = (await mapPool(messages, BATCH_CONCURRENCY, (m) => handleOne(ctx, m))).filter((r): r is object => r !== null);
  if (!responses.length) return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  return json(batch ? responses : responses[0]);
}

export async function GET() {
  return json(
    {
      name: "kestrel-sentinel",
      transport: "streamable-http",
      usage: "POST JSON-RPC 2.0 messages (initialize, tools/list, tools/call) to this URL. Stateless: no session id, JSON responses, no server-initiated SSE stream.",
      tools: TOOLS.map((t) => t.name),
    },
    { status: 405, headers: { Allow: "POST, OPTIONS" } }
  );
}

export const OPTIONS = preflight;
