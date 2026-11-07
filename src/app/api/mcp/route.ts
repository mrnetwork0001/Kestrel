import { NextResponse } from "next/server";
import { CONTRACTS } from "@/config/contracts";
import { CORS_HEADERS, json, preflight, rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { readEscrow } from "@/lib/engine/escrow";
import { escrowFindings } from "@/lib/engine/findings";
import { guardVerdict } from "@/lib/engine/guard";
import { getBridgeParity } from "@/lib/engine/parity";
import { discoverWethPool, readPool } from "@/lib/engine/pools";
import { simulateExit } from "@/lib/engine/sim";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Max JSON-RPC messages per HTTP request; each message is charged one rate-limit unit. */
const MAX_BATCH = 20;

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const chainProp = { type: "integer", enum: [8453, 4663], default: 8453, description: "8453 = Base Mainnet, 4663 = Robinhood Chain Mainnet" };
const addrProp = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };

const TOOLS = [
  {
    name: "scan_contract",
    title: "Kestrel pre-trade scan",
    description: "Live onchain safety verdict (ALLOW | WARN | BLOCK, 0–100 risk score, reasons) for any wallet, token, pool or Vibestarter escrow on Base or Robinhood Chain. Reads bytecode, EIP-1967 slots, owner posture, pool depth and 8h deltas directly over RPC.",
    inputSchema: { type: "object", properties: { address: { ...addrProp, description: "Target address" }, chainId: chainProp }, required: ["address"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "check_bridge_parity",
    title: "$VIBES OFT parity & spread",
    description: "Verifies the $VIBES LayerZero OFT 1:1 invariant (Base adapter locked == Robinhood circulating) and the live Base Aerodrome vs Robinhood Uniswap v3 price spread net of pool fees.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "simulate_exit",
    title: "Simulate the rug",
    description: "Exact BigInt AMM exit simulation on a live pool (or the token's WETH pool): sell size, LP removal shock and whale dump → WETH out before/after and drawdown.",
    inputSchema: {
      type: "object",
      properties: {
        address: { ...addrProp, description: "Pool address, or a token address (its WETH pool is discovered live)" },
        chainId: chainProp,
        sellBpsOfReserve: { type: "integer", minimum: 1, maximum: 10000, default: 100, description: "Your sell size as bps of the pool's token-side depth" },
        lpPullBps: { type: "integer", minimum: 0, maximum: 9500, default: 0 },
        whaleDumpBpsOfSupply: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
      },
      required: ["address"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "inspect_vibestarter_escrow",
    title: "Vibestarter Backer Shield",
    description: "Live read of a VibesTranchEscrow: campaign state, 7-tranche schedule, 72h challenge-window countdowns, active challenge, LP lock and Origin Capsule. Defaults to the Genesis $VIBES escrow.",
    inputSchema: { type: "object", properties: { address: { ...addrProp, description: "Escrow address (default: Genesis $VIBES escrow)" }, chainId: chainProp }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const chainId = normalizeChainId(args.chainId ?? 8453);
  switch (name) {
    case "scan_contract": {
      const address = parseAddress(args.address);
      if (!address) throw new Error("`address` must be a valid 0x address");
      return cached(`guard:preview:${chainId}:${address.toLowerCase()}`, 30, () => guardVerdict(chainId, address, "preview"));
    }
    case "check_bridge_parity": {
      const p = await cached("parity:lite", 15, () => getBridgeParity({ overnight: false }));
      return { verified: p.verified, lockedOnBaseRaw: p.lockedOnBase, rhCirculatingRaw: p.rhCirculating, deltaRaw: p.delta, spreadBps: p.spreadBps, cheaperVenue: p.cheaperVenue, feeDragBps: p.feeDragBps, netEdgeBps: p.netEdgeBps, baseBlock: p.base.number, robinhoodBlock: p.robinhood.number };
    }
    case "simulate_exit":
    case "simulate_rug_shock": {
      const address = parseAddress(args.address);
      if (!address) throw new Error("`address` must be a valid 0x address");
      let pool = await readPool(chainId, address, { overnight: false }).catch(() => null);
      if (!pool) {
        const found = await discoverWethPool(chainId, address);
        if (found) pool = await readPool(chainId, found, { overnight: false });
      }
      if (!pool) throw new Error("No recognizable pool (or token WETH pool) at that address");
      return { ...simulateExit(pool, { sellBpsOfReserve: Number(args.sellBpsOfReserve ?? 100), lpPullBps: Number(args.lpPullBps ?? 0), whaleDumpBpsOfSupply: Number(args.whaleDumpBpsOfSupply ?? 0) }), blockNumber: pool.block.number };
    }
    case "inspect_vibestarter_escrow": {
      const address = parseAddress(args.address) ?? CONTRACTS.base.vibesGenesisEscrow;
      const e = await readEscrow(chainId, address);
      return { ...e, findings: escrowFindings(e) };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

async function handleOne(msg: RpcReq): Promise<object | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return null; // client JSON-RPC response → 202
    return { jsonrpc: "2.0", id: (msg as { id?: unknown } | null)?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.method?.startsWith("notifications/")) return null;
  try {
    let result: unknown;
    switch (msg.method) {
      case "initialize": {
        const requested = String(msg.params?.protocolVersion ?? "");
        result = {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kestrel-sentinel", title: "Kestrel Overnight Sentinel", version: "0.1.0" },
          instructions: "Kestrel reads Base (8453) and Robinhood Chain (4663) live. Call scan_contract before any swap; BLOCK means do not trade.",
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
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        try {
          const data = await callTool(name, args);
          result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
        } catch (e) {
          if ((e as { rpcCode?: number }).rpcCode) throw e;
          result = { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
        }
        break;
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
    return isNotification ? null : { jsonrpc: "2.0", id, result };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32603, message: errMsg(e) } };
  }
}

/** Streamable HTTP MCP endpoint (JSON responses; no server-initiated SSE stream). */
export async function POST(req: Request) {
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
  const responses = (await Promise.all(messages.map(handleOne))).filter((r): r is object => r !== null);
  if (!responses.length) return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  return json(batch ? responses : responses[0]);
}

export async function GET() {
  return json(
    { name: "kestrel-sentinel", transport: "streamable-http", usage: "POST JSON-RPC 2.0 messages (initialize, tools/list, tools/call) to this URL.", tools: TOOLS.map((t) => t.name) },
    { status: 405, headers: { Allow: "POST, OPTIONS" } }
  );
}

export const OPTIONS = preflight;
