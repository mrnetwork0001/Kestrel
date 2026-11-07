"use client";

/**
 * Night-Shift Pager client hooks: desk-key storage plus react-query wrappers over the /api/pager/* contract
 * (spec section 13). The desk key is a bearer capability kept ONLY in this browser's localStorage and sent as
 * `Authorization: Bearer kst_…`. It is never logged and never put in a URL other than a #fragment.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChainId, Severity } from "@/lib/engine/types";
import type { DeskPublic, DigestPayload, PagerAlert, RuleConfig, SleepPublic, TickSummary, WatchView } from "@/lib/pager/types";

/* ------------------------------------------------------------------ */
/* Types for API responses not covered by src/lib/pager/types.ts      */
/* ------------------------------------------------------------------ */

export interface Delivery {
  channel: string;
  ok: boolean;
  status?: number | null;
  error?: string;
}

export interface DeskResponse {
  desk: DeskPublic;
  watches: WatchView[];
  /** Usually PagerAlert[]; digests may also be pushed into the same list by the wake job. */
  recentAlerts: (PagerAlert | (DigestPayload & { kind?: "digest" }))[];
  /** Newest-first morning digests (returned separately by GET /api/pager/desk). */
  digests?: DigestPayload[];
  sleep: SleepPublic | null;
  cadenceSec: number | null;
  lastTick: TickSummary | null;
}

export interface WatchTestObservation {
  ruleId: string;
  type: string;
  fired: boolean;
  severity: Severity | null;
  observed: string;
  threshold: string;
}

export interface WatchTestResponse {
  evaluatedAt: number | string;
  block: string | null;
  observations: WatchTestObservation[];
  message: { text: string; html?: string };
  delivered: Delivery[];
}

/** Legacy `/api/pager/test` response (zero-desk preview). */
export interface LegacyTestResponse {
  delivered: Delivery[];
  triggers: { rule: string; fired: boolean; observed: string }[];
  message: string;
  deepLink: string;
}

export interface PagerStatusChainWindow { from: string; to: string; count: string }

export interface PagerStatus {
  healthy: boolean;
  cadenceSec: number | null;
  /** Object in the live route ({ kind, inProcess, opportunisticTriggered }); a string in early drafts. */
  scheduler?: string | { kind: string; inProcess?: { active: boolean; intervalSec: number | null; lastRunAt: number | null; lastError: string | null } | null; opportunisticTriggered?: boolean } | null;
  storage?: string | null;
  telegram?: { configured: boolean; mode: "webhook" | "polling" } | null;
  /** Total ticks ever run against this storage. */
  checks?: number;
  lastTick: {
    tickId?: string;
    at: number | string;
    ageSec?: number | null;
    reason?: string;
    durationMs?: number;
    chains?: Partial<Record<"8453" | "4663", { block: string | null; ok?: boolean; error?: string } | null>>;
    watches?: number;
    evaluated?: number;
    alerts?: number;
    hash?: string | null;
    prevHash?: string | null;
  } | null;
  /** Window covered by the stored tick log (up to 50 ticks). */
  window?: { ticks: number; fromAt: number; toAt: number; alerts: number; digests?: number; blocks?: Partial<Record<"8453" | "4663", PagerStatusChainWindow | null>> } | null;
  /** Spec-draft name for the same aggregate. */
  last24h?: { ticks: number; alerts: number; blocks?: Partial<Record<"8453" | "4663", string | number | null>> } | null;
  chain?: { valid: boolean; checked: number; brokenAt: string | number | null; algorithm?: string } | null;
  log?: TickSummary[];
  systemDesk?: { watches: { label: string; chainId: ChainId; kind?: string; status: string; lastCheckedBlock?: string | null; lastAlert: { title: string; at: number; severity?: Severity | string } | string | null }[] } | null;
}

export interface TelegramLinkStart {
  url: string;
  expiresAt: number | string;
  mode: "webhook" | "polling";
}

export interface TelegramLinkStatus {
  status: "linked" | "pending" | "none" | "expired";
  telegram?: { username: string | null; chatType: string };
}

export interface SleepStopResponse {
  digest: DigestPayload | null;
  delivered: Delivery[];
  /** Plain-text rendering of the digest. */
  text?: string | null;
  /** True when the digest was queued for delivery by the next tick. */
  queued?: boolean;
  note?: string;
}

export interface SleepStartResponse {
  sleep: SleepPublic;
  clamped?: boolean;
  snapshotWatches?: number;
  pendingFirstCheck?: number;
}

export class PagerHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PagerHttpError";
  }
}

/* ------------------------------------------------------------------ */
/* Desk key storage                                                    */
/* ------------------------------------------------------------------ */

export const DESK_KEY_STORAGE = "kestrel.desk.v1";
export const DESK_KEY_RE = /^kst_[A-Za-z0-9_-]{20,64}$/;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

function readKey(): string | null {
  try {
    const v = window.localStorage.getItem(DESK_KEY_STORAGE);
    return v && DESK_KEY_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === DESK_KEY_STORAGE) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function storeDeskKey(key: string | null) {
  try {
    if (key) window.localStorage.setItem(DESK_KEY_STORAGE, key);
    else window.localStorage.removeItem(DESK_KEY_STORAGE);
  } catch {
    /* storage disabled: the key lives only for this page view */
  }
  emit();
}

/**
 * The desk key for this browser. Imports `#desk=kst_…` from the URL fragment (the "open on another device" and
 * MCP `manageUrl` flow) into localStorage, then strips the fragment so it does not linger in history.
 */
export function useDeskKey() {
  const key = useSyncExternalStore(subscribe, readKey, () => null);
  const [ready, setReady] = useState(false);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    const m = /(?:^#|&)desk=(kst_[A-Za-z0-9_-]{20,64})(?:&|$)/.exec(window.location.hash);
    if (m) {
      storeDeskKey(m[1]);
      setImported(true);
      const url = window.location.pathname + window.location.search;
      window.history.replaceState(window.history.state, "", url);
    }
    setReady(true);
  }, []);

  const setKey = useCallback((k: string | null) => storeDeskKey(k), []);
  return { key, ready, imported, setKey };
}

/* ------------------------------------------------------------------ */
/* Fetch helper                                                        */
/* ------------------------------------------------------------------ */

export async function pagerFetch<T>(path: string, opts: { method?: string; body?: unknown; key?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
  } catch (e) {
    throw new PagerHttpError(e instanceof Error ? `Network error: ${e.message}` : "Network error", 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new PagerHttpError(msg, res.status);
  }
  return body as T;
}

export function errText(e: unknown): string {
  if (!e) return "";
  return e instanceof Error ? e.message : String(e);
}

export function errStatus(e: unknown): number | null {
  return e instanceof PagerHttpError ? e.status : null;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

const deskQK = (key: string | null) => ["pager", "desk", key] as const;

export function useDesk(key: string | null) {
  return useQuery({
    queryKey: deskQK(key),
    queryFn: () => pagerFetch<DeskResponse>("/api/pager/desk", { key }),
    enabled: !!key,
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: (n, e) => {
      const s = errStatus(e);
      if (s === 401 || s === 403 || s === 404 || s === 503) return false;
      return n < 2;
    },
  });
}

export function usePagerStatus() {
  return useQuery({
    queryKey: ["pager", "status"],
    queryFn: () => pagerFetch<PagerStatus>("/api/pager/status"),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
  });
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface CreateWatchInput {
  address: string;
  chainId: number;
  label?: string;
  rules?: Partial<RuleConfig>[];
  extraTokens?: string[];
}

export interface PatchWatchInput {
  id: string;
  enabled?: boolean;
  label?: string;
  rules?: RuleConfig[];
}

export interface PatchDeskInput {
  label?: string;
  webhookUrl?: string | null;
  telegramChatId?: string | null;
  sleepPolicy?: "critical-only" | "page-all";
  rotateWebhookSecret?: true;
}

export function usePagerMutations(key: string | null) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["pager", "desk"] });

  const createDesk = useMutation({
    mutationFn: (label?: string) => pagerFetch<{ deskKey: string; desk: DeskPublic }>("/api/pager/desk", { method: "POST", body: label ? { label } : {} }),
  });

  const deleteDesk = useMutation({
    mutationFn: () => pagerFetch<void>("/api/pager/desk", { method: "DELETE", key }),
  });

  const patchDesk = useMutation({
    mutationFn: (input: PatchDeskInput) => pagerFetch<{ desk: DeskPublic; webhookSecret?: string }>("/api/pager/desk", { method: "PATCH", key, body: input }),
    onSuccess: invalidate,
  });

  const createWatch = useMutation({
    mutationFn: (input: CreateWatchInput) => pagerFetch<{ watch: WatchView }>("/api/pager/watches", { method: "POST", key, body: input }),
    onSuccess: invalidate,
  });

  const patchWatch = useMutation({
    mutationFn: ({ id, ...rest }: PatchWatchInput) => pagerFetch<{ watch: WatchView }>(`/api/pager/watches/${encodeURIComponent(id)}`, { method: "PATCH", key, body: rest }),
    onSuccess: invalidate,
  });

  const deleteWatch = useMutation({
    mutationFn: (id: string) => pagerFetch<void>(`/api/pager/watches/${encodeURIComponent(id)}`, { method: "DELETE", key }),
    onSuccess: invalidate,
  });

  const testWatch = useMutation({
    mutationFn: ({ id, dispatch }: { id: string; dispatch: boolean }) =>
      pagerFetch<WatchTestResponse>(`/api/pager/watches/${encodeURIComponent(id)}/test`, { method: "POST", key, body: { dispatch } }),
  });

  const linkTelegram = useMutation({
    mutationFn: () => pagerFetch<TelegramLinkStart>("/api/pager/telegram/link", { method: "POST", key }),
  });

  const unlinkTelegram = useMutation({
    mutationFn: () => pagerFetch<void>("/api/pager/telegram/link", { method: "DELETE", key }),
    onSuccess: invalidate,
  });

  const startSleep = useMutation({
    mutationFn: (input: { wakeAt: string; tz?: string; policy?: "critical-only" | "page-all" }) =>
      pagerFetch<SleepStartResponse>("/api/pager/sleep", { method: "POST", key, body: input }),
    onSuccess: invalidate,
  });

  const wake = useMutation({
    mutationFn: ({ digest }: { digest: boolean }) => pagerFetch<SleepStopResponse | undefined>(`/api/pager/sleep${digest ? "?digest=1" : ""}`, { method: "DELETE", key }),
    onSuccess: invalidate,
  });

  return { createDesk, deleteDesk, patchDesk, createWatch, patchWatch, deleteWatch, testWatch, linkTelegram, unlinkTelegram, startSleep, wake };
}

/** One poll of Telegram link status (used by the delivery panel's 2 s polling loop). */
export function pollTelegramLink(key: string) {
  return pagerFetch<TelegramLinkStatus>("/api/pager/telegram/link", { key });
}

/** Zero-desk preview: legacy one-shot evaluation of the current target, render-only (no destination). */
export function legacyPreview(target: string, chainId: number) {
  return pagerFetch<LegacyTestResponse>("/api/pager/test", { method: "POST", body: { target, chainId } });
}

/* ------------------------------------------------------------------ */
/* Small UI utilities                                                  */
/* ------------------------------------------------------------------ */

/** A clock that re-renders every `ms` (null until mounted, so SSR and hydration match). */
export function useNow(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Accepts ms epoch, seconds epoch or ISO; returns ms or null. */
export function toMs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
}

export function ago(atMs: number | null, now: number | null): string {
  if (atMs === null || now === null) return "—";
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Block numbers arrive as decimal strings; group with BigInt (never Number). */
export function fmtBlock(b: string | number | null | undefined): string {
  if (b === null || b === undefined || b === "") return "—";
  try {
    return `#${BigInt(b).toLocaleString("en-US")}`;
  } catch {
    return "—";
  }
}

/** Local HH:MM for an epoch-ms timestamp. */
export function hhmm(ms: number | null): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Only allow http(s) and same-origin relative hrefs from server-provided link lists. */
export function safeHref(href: string): string | null {
  if (typeof href !== "string") return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
