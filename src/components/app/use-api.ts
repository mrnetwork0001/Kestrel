"use client";

import { useQuery } from "@tanstack/react-query";
import type { EscrowReport, Finding, ParityReport, ScanResult } from "@/lib/engine/types";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export function useScan(address: string, chainId: number, initial: ScanResult | null) {
  return useQuery({
    queryKey: ["scan", chainId, address.toLowerCase()],
    queryFn: () => getJson<ScanResult>(`/api/scan?address=${address}&chainId=${chainId}&llm=0`),
    initialData: initial && initial.target.address.toLowerCase() === address.toLowerCase() && initial.target.chainId === chainId ? initial : undefined,
    staleTime: 30_000,
  });
}

export function useBrief(address: string, chainId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["brief", chainId, address.toLowerCase()],
    queryFn: () =>
      getJson<{ brief: ScanResult["brief"] }>("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      }),
    enabled,
    staleTime: 120_000,
    retry: 0,
  });
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
