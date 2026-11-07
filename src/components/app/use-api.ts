"use client";

import { useQuery } from "@tanstack/react-query";
import type { EscrowReport, Finding, ParityReport, ScanResult } from "@/lib/engine/types";

/** A failed API call. `retryAfterSec` is set when the server says the read is retryable (503 degraded). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec: number | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ body: T; res: Response }> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; retryAfterSec?: number };
    const ra = typeof b.retryAfterSec === "number" ? b.retryAfterSec : Number(res.headers.get("Retry-After")) || null;
    throw new ApiError(b.error || `HTTP ${res.status}`, res.status, res.status === 503 || res.status === 429 ? ra : null);
  }
  return { body: body as T, res };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await fetchJson<T>(url, init)).body;
}

/**
 * Why a scan is incomplete (empty = complete). Client-side mirror of the engine's scanDegradedReasons (pure, types
 * only), so the SSR scan and every refetch are judged the same way the X-Kestrel-Scan-Status header is.
 */
export function scanDegradedReasons(scan: ScanResult): string[] {
  const out: string[] = [];
  const f = scan.findings.find((x) => x.id === "scan-degraded");
  if (f) out.push(f.detail);
  if (scan.flow?.degraded?.length) out.push(`Holder/flow read incomplete: ${scan.flow.degraded.slice(0, 2).join("; ")}`);
  if (scan.pool?.overnight?.degraded) out.push(scan.pool.overnight.degraded);
  if (scan.parity?.bridgeDegraded) out.push(scan.parity.bridgeDegraded);
  if (scan.xray?.degraded) out.push(`Bytecode X-Ray incomplete: ${(scan.xray.degradedReasons ?? []).slice(0, 2).join("; ") || "an RPC read failed"}`);
  if (scan.wallet?.coverage?.partial) out.push("Approval scan incomplete (some reads failed or the log window was not fully read)");
  return out;
}

const HEADER_DEGRADED = new WeakSet<ScanResult>();

/** Reasons the scan is incomplete; a header-only degraded flag yields a generic reason. */
export function scanIncomplete(scan: ScanResult): string[] {
  const r = scanDegradedReasons(scan);
  return r.length || !HEADER_DEGRADED.has(scan) ? r : ["A live read failed during this scan"];
}

/** Live scan. `enabled: false` holds the query (e.g. an unsupported chain in the URL) without showing other data. */
export function useScan(address: string, chainId: number, initial: ScanResult | null, enabled = true) {
  return useQuery({
    queryKey: ["scan", chainId, address.toLowerCase()],
    queryFn: async () => {
      const { body, res } = await fetchJson<ScanResult>(`/api/scan?address=${address}&chainId=${chainId}`);
      // The header is authoritative for this response even when the body carries no named reason.
      if (res.headers.get("X-Kestrel-Scan-Status") === "degraded") HEADER_DEGRADED.add(body);
      return body;
    },
    initialData: initial && initial.target.address.toLowerCase() === address.toLowerCase() && initial.target.chainId === chainId ? initial : undefined,
    staleTime: 30_000,
    enabled,
    // A 4xx (bad address / chain) will not fix itself; one retry for transient RPC failures.
    retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429),
  });
}

/** Shared query options so the masthead and the Briefing tab trigger and read the same AI brief. */
export function briefQuery(address: string, chainId: number) {
  return {
    queryKey: ["brief", chainId, address.toLowerCase()] as const,
    queryFn: () =>
      getJson<{ brief: ScanResult["brief"]; status?: "complete" | "degraded"; llm?: { configured: boolean; dailyCap: number } }>("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      }),
    staleTime: 120_000,
    retry: 0,
  };
}

/** AI brief: user-triggered only (the route is rate-limited to 10/min, 40/h). */
export function useBrief(address: string, chainId: number, enabled: boolean) {
  return useQuery({ ...briefQuery(address, chainId), enabled });
}

export function useParity() {
  return useQuery({ queryKey: ["parity"], queryFn: () => getJson<ParityReport>("/api/parity"), refetchInterval: 30_000 });
}

export function useBackerShield() {
  return useQuery({
    queryKey: ["backer-shield"],
    queryFn: () => getJson<{ escrows: (EscrowReport & { findings: Finding[] })[]; fetchedAt: string }>("/api/backer-shield"),
    refetchInterval: 60_000,
  });
}

export { getJson };
