import { cached } from "@/lib/cache";

/**
 * Server-side client for Vibestarter's public MCP server (https://app.vibestarter.xyz/mcp).
 *
 * Wire facts (verified live 2026-11-07, research spec §2):
 * - Streamable HTTP, stateless: no Mcp-Session-Id is ever returned (we still echo one if it appears).
 * - `Accept` MUST list both application/json and text/event-stream, otherwise HTTP 406.
 * - Responses are SSE (`event: message` / `data: {...}`), one frame per JSON-RPC response; JSON is also
 *   accepted in case the server ever switches. Frames are matched by JSON-RPC id.
 * - Tool results arrive as `content[0].text` holding a JSON string (lists / stats / detail) or plain text
 *   (`how_it_works`, not-found). Bad args → `isError: true`.
 * - Tools: list_raises, get_raise, search_raises, get_platform_stats, how_it_works.
 */

export const VIBESTARTER_MCP_URL = process.env.VIBESTARTER_MCP_URL || "https://app.vibestarter.xyz/mcp";
const UA = "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)";
const PREFERRED_PROTOCOL = "2025-06-18";
const CLIENT_INFO = { name: "kestrel-sentinel", title: "Kestrel Overnight Sentinel", version: "0.1.0" };

export interface McpProvenance {
  server: string;
  tool: string;
  protocolVersion: string | null;
  latencyMs: number;
  fetchedAt: string;
}

export interface McpToolResult<T> {
  data: T | null;
  text: string;
  isError: boolean;
  provenance: McpProvenance;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "McpError";
  }
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const g = globalThis as typeof globalThis & {
  __kestrelVsMcp?: { session: { id: string | null; protocolVersion: string } | null; initPromise: Promise<void> | null; seq: number };
};
const state = (g.__kestrelVsMcp ??= { session: null, initPromise: null, seq: 0 });

/** Parses `event: message\ndata: {...}\n\n` frames (multi-line data joined with \n per the SSE spec). */
export function parseSse(body: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      /* keep-alive / partial frame */
    }
  }
  return out;
}

async function post(body: unknown, timeoutMs: number): Promise<{ res: Response; messages: JsonRpcResponse[] }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": UA,
  };
  if (state.session?.protocolVersion) headers["MCP-Protocol-Version"] = state.session.protocolVersion;
  if (state.session?.id) headers["Mcp-Session-Id"] = state.session.id;
  const res = await fetch(VIBESTARTER_MCP_URL, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const sid = res.headers.get("mcp-session-id");
  if (sid && state.session) state.session.id = sid;
  if (res.status === 202) return { res, messages: [] };
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  let messages: JsonRpcResponse[] = [];
  if (ct.includes("text/event-stream")) messages = parseSse(text);
  else if (text) {
    try {
      messages = ([] as JsonRpcResponse[]).concat(JSON.parse(text));
    } catch {
      messages = [];
    }
  }
  return { res, messages };
}

async function ensureInitialized(): Promise<void> {
  if (state.session) return;
  state.initPromise ??= (async () => {
    const id = ++state.seq;
    const { res, messages } = await post(
      { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PREFERRED_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } },
      6_000
    );
    if (!res.ok) throw new McpError(`initialize HTTP ${res.status}`, undefined, res.status);
    const msg = messages.find((m) => m.id === id);
    if (!msg || msg.error || !msg.result) throw new McpError(msg?.error?.message ?? "initialize: empty response", msg?.error?.code);
    const r = msg.result as { protocolVersion?: string };
    state.session = { id: res.headers.get("mcp-session-id"), protocolVersion: r.protocolVersion ?? PREFERRED_PROTOCOL };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, 4_000).catch(() => undefined);
  })().finally(() => {
    state.initPromise = null;
  });
  await state.initPromise;
}

async function rpc<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  await ensureInitialized();
  const id = ++state.seq;
  let { res, messages } = await post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
  if ((res.status === 400 || res.status === 404) && state.session?.id) {
    // stale session — only possible if the server ever turns stateful
    state.session = null;
    await ensureInitialized();
    ({ res, messages } = await post({ jsonrpc: "2.0", id, method, params }, timeoutMs));
  }
  if (!res.ok) throw new McpError(`${method} HTTP ${res.status}`, undefined, res.status);
  const msg = messages.find((m) => m.id === id);
  if (!msg) throw new McpError(`${method}: no JSON-RPC response for id ${id}`);
  if (msg.error) throw new McpError(msg.error.message, msg.error.code);
  return msg.result as T;
}

type ToolCallResult<T> = { content?: { type: string; text?: string }[]; structuredContent?: T; isError?: boolean };

/** Uncached tools/call. Text content is JSON-parsed when possible (how_it_works / not-found are plain text). */
export async function callVibestarterTool<T = unknown>(tool: string, args: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<McpToolResult<T>> {
  const started = Date.now();
  let r: ToolCallResult<T>;
  try {
    r = await rpc<ToolCallResult<T>>("tools/call", { name: tool, arguments: args }, timeoutMs);
  } catch (e) {
    // one retry on network-level failure (idempotent reads)
    if (e instanceof McpError && e.httpStatus && e.httpStatus < 500) throw e;
    state.session = null;
    r = await rpc<ToolCallResult<T>>("tools/call", { name: tool, arguments: args }, timeoutMs);
  }
  const text = (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  let data: T | null = r.structuredContent ?? null;
  if (data === null && !r.isError) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return {
    data,
    text,
    isError: Boolean(r.isError),
    provenance: { server: VIBESTARTER_MCP_URL, tool, protocolVersion: state.session?.protocolVersion ?? null, latencyMs: Date.now() - started, fetchedAt: new Date().toISOString() },
  };
}

export interface McpHandshake {
  server: string;
  protocolVersion: string | null;
  serverInfo: { name?: string; version?: string } | null;
  initMs: number;
  listMs: number;
  tools: { name: string; description: string | null }[];
  statsMs: number | null;
  statsAsOf: string | null;
  fetchedAt: string;
}

/** Live handshake transcript (initialize → tools/list → tools/call get_platform_stats) for /agents. Never cached. */
export async function mcpHandshakeTranscript(): Promise<McpHandshake> {
  const t0 = Date.now();
  const initId = ++state.seq;
  const prevSession = state.session;
  state.session = null;
  const { res, messages } = await post(
    { jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: PREFERRED_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } },
    6_000
  );
  const initMsg = messages.find((m) => m.id === initId);
  if (!res.ok || !initMsg?.result) {
    state.session = prevSession;
    throw new McpError(`initialize failed (HTTP ${res.status})`, initMsg?.error?.code, res.status);
  }
  const init = initMsg.result as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
  state.session = { id: res.headers.get("mcp-session-id"), protocolVersion: init.protocolVersion ?? PREFERRED_PROTOCOL };
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, 4_000).catch(() => undefined);
  const initMs = Date.now() - t0;
  const t1 = Date.now();
  const tools = await rpc<{ tools: { name: string; description?: string }[] }>("tools/list", {}, 6_000);
  const listMs = Date.now() - t1;
  const stats = await callVibestarterTool<VsPlatformStats>("get_platform_stats").catch(() => null);
  return {
    server: VIBESTARTER_MCP_URL,
    protocolVersion: state.session?.protocolVersion ?? null,
    serverInfo: init.serverInfo ?? null,
    initMs,
    listMs,
    tools: (tools.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? null })),
    statsMs: stats?.provenance.latencyMs ?? null,
    statsAsOf: stats?.data?.figures?.asOf ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// ---- typed wrappers (shared KV cache, keyed by tool + args; errors are never cached) ----

export type VsStatus = "ACTIVE" | "FUNDED" | "COMPLETED" | "FAILED";

export interface VsRaiseSummary {
  slug: string;
  title: string;
  tagline: string | null;
  status: string;
  fundingModel: string;
  goalWei: string;
  totalRaisedWei: string;
  contributorCount: number;
  deadline: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
}

export interface VsRaiseDetail extends VsRaiseSummary {
  description: string;
  raiseType: string;
  softCapWei: string | null;
}

export interface VsNextUnlock {
  at: string;
  campaignId: string;
  title: string;
  ticker: string;
  txHash: string;
  orderIndex: number;
  chainId: number;
  amountWei: string;
}

export interface VsFigures {
  raised: { wei: string; backed24hWei: string };
  backers: { count: number; firstTime24h: number };
  live: { count: number; closingIn24h: number; nextOpensAt: string | null };
  inEscrow: { wei: string; raises: number; nextUnlock: VsNextUnlock | null };
  released: { wei: string; count: number };
  liquidity: { wei: string; raises: number };
  funded: number;
  medianFundedWei: string;
  listed: number;
}

export interface VsPlatformStats {
  totalRaised: string;
  totalDisbursed: string;
  totalInEscrow: string;
  totalBackers: number;
  fundedCount: number;
  liquidityLocked: string;
  releasesPaid: number;
  tokensLaunched: number;
  campaignCount: number;
  figures: VsFigures & { asOf: string; byChain: Record<string, Partial<VsFigures>> };
}

function ensureOk<T>(r: McpToolResult<T>): McpToolResult<T> {
  if (r.isError) throw new McpError(`Vibestarter MCP ${r.provenance.tool}: ${r.text.slice(0, 200)}`);
  return r;
}

export function getPlatformStatsViaMcp(): Promise<McpToolResult<VsPlatformStats>> {
  return cached("vs-mcp:get_platform_stats:v1", 60, async () => ensureOk(await callVibestarterTool<VsPlatformStats>("get_platform_stats")));
}

export function listRaisesViaMcp(status?: VsStatus): Promise<McpToolResult<VsRaiseSummary[]>> {
  return cached(`vs-mcp:list_raises:v1:${status ?? "all"}`, 60, async () =>
    ensureOk(await callVibestarterTool<VsRaiseSummary[]>("list_raises", status ? { limit: 100, status } : { limit: 100 }))
  );
}

export function searchRaisesViaMcp(query: string): Promise<McpToolResult<VsRaiseSummary[]>> {
  const q = query.trim().slice(0, 100);
  return cached(`vs-mcp:search_raises:v1:${q.toLowerCase()}`, 120, async () => ensureOk(await callVibestarterTool<VsRaiseSummary[]>("search_raises", { query: q, limit: 20 })));
}

/** `idOrSlug` = launch tx hash or "vibes". Not-found resolves with data=null (plain-text answer). */
export function getRaiseViaMcp(idOrSlug: string): Promise<McpToolResult<VsRaiseDetail>> {
  return cached(`vs-mcp:get_raise:v1:${idOrSlug.toLowerCase()}`, 300, async () => ensureOk(await callVibestarterTool<VsRaiseDetail>("get_raise", { idOrSlug })));
}

export function howItWorksViaMcp(): Promise<McpToolResult<null>> {
  return cached("vs-mcp:how_it_works:v1", 86_400, async () => ensureOk(await callVibestarterTool<null>("how_it_works")));
}
