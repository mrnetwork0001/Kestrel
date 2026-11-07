import { kvGetJson, kvSetJson } from "@/lib/kv";
import type { GithubVelocity } from "./types";

/**
 * Founder GitHub live velocity from the public GitHub REST API.
 *
 * Why this shape (verified 2026-11-07): GitHub's public events feed no longer carries commit lists /
 * sizes on PushEvent payloads, and founders often push commits authored under another identity, so
 * author-filtered commit search returns 0 for active builders. Kestrel therefore measures:
 *   - pushes + active days from /users/{login}/events/public (last 7 / 30 days; feed covers ≤ 90 days)
 *   - commits that landed in the (≤ 3) repos the founder pushed to in the last 30 days
 *     (/repos/{repo}/commits?since=…, default branch, capped at 100 per repo)
 *   - the capsule repo's last push (/repos/{owner}/{repo}) when Vibestarter lists one (404 = private/deleted)
 * Cached 30 min on the shared KV (failures 5 min; rate-limited until the quota resets, ≤ 30 min). Failed id → login
 * lookups are negative-cached 30 min, and a process-wide breaker stops calling GitHub once it reports a rate limit,
 * so the shared 60 req/h unauthenticated quota is not burnt on retries. GITHUB_TOKEN is optional (60 → 5,000 req/h).
 */

export type { GithubVelocity };

const API = "https://api.github.com";
const TTL_OK = 1800;
const TTL_FAIL = 300;
/** Resolved id → login mappings are stable: 24 h. */
const TTL_LOGIN = 86_400;
/** Negative cache for failed login lookups (404 / rate-limited), and the cap on the rate-limit breaker. */
const TTL_NEG_LOGIN = 1800;
const DAY = 86_400_000;

class GithubHttpError extends Error {
  constructor(readonly status: number, readonly rateLimited: boolean) {
    super(`GitHub HTTP ${status}${rateLimited ? " (rate limited)" : ""}`);
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// ── process-wide rate-limit breaker: once GitHub says "rate limited", stop spending the shared quota until reset ──
const RL_KEY = "gh:ratelimited-until";
const gRl = globalThis as typeof globalThis & { __kestrelGhRateLimitedUntil?: number };

async function rateLimitedUntil(): Promise<number> {
  const local = gRl.__kestrelGhRateLimitedUntil ?? 0;
  if (local > Date.now()) return local;
  const shared = await kvGetJson<{ until: number }>(RL_KEY).catch(() => null);
  if (shared && shared.until > Date.now()) {
    gRl.__kestrelGhRateLimitedUntil = shared.until;
    return shared.until;
  }
  return 0;
}

function markRateLimited(res: Response) {
  // x-ratelimit-reset (epoch s) for primary limits, retry-after (s) for secondary limits; cap at 30 min.
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
  const retryAfter = Number(res.headers.get("retry-after")) * 1000;
  const now = Date.now();
  const target = reset > now ? reset : retryAfter > 0 ? now + retryAfter : now + 5 * 60_000;
  const until = Math.min(target, now + TTL_NEG_LOGIN * 1000);
  gRl.__kestrelGhRateLimitedUntil = until;
  void kvSetJson(RL_KEY, { until }, { ex: Math.max(1, Math.ceil((until - now) / 1000)) }).catch(() => undefined);
}

async function gh<T>(path: string): Promise<T> {
  if ((await rateLimitedUntil()) > Date.now()) throw new GithubHttpError(429, true);
  const res = await fetch(`${API}${path}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(7_000) });
  if (!res.ok) {
    const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (rateLimited) markRateLimited(res);
    throw new GithubHttpError(res.status, rateLimited);
  }
  return (await res.json()) as T;
}

function rateLimitNote(): string {
  const until = gRl.__kestrelGhRateLimitedUntil ?? 0;
  const mins = until > Date.now() ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : null;
  return `GitHub API rate limit reached for this server${mins ? ` (resets in ~${mins} min)` : ""} — velocity refreshes automatically${process.env.GITHUB_TOKEN?.trim() ? "" : " (set GITHUB_TOKEN for 5,000 req/h)"}.`;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** "https://github.com/owner/repo(.git)" → "owner/repo" (null for non-GitHub URLs). */
export function parseGithubRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo] = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    const full = owner && repo ? `${owner}/${repo}` : null;
    return full && REPO_RE.test(full) ? full : null;
  } catch {
    return null;
  }
}

/** "https://avatars.githubusercontent.com/u/155464950?v=4" → 155464950 */
export function githubIdFromAvatar(url: string | null | undefined): number | null {
  const m = url?.match(/avatars\.githubusercontent\.com\/u\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Outcome of resolving a numeric GitHub id to a login:
 *  - ok:           resolved (cached 24 h)
 *  - missing:      GitHub answered 404 — the account was deleted, suspended or never existed (cached 30 min)
 *  - rate-limited: this server's GitHub quota is exhausted; nothing is known about the account (cached until reset, ≤ 30 min)
 *  - error:        network / 5xx (cached 5 min)
 */
export interface GithubLoginResolution {
  id: number;
  login: string | null;
  state: "ok" | "missing" | "rate-limited" | "error";
  checkedAt: string;
}

/** Resolve a login from a numeric GitHub id with an honest failure state. Failed lookups are negative-cached. */
export async function resolveGithubLoginDetailed(id: number): Promise<GithubLoginResolution> {
  const key = `gh:id:v2:${id}`;
  const hit = await kvGetJson<GithubLoginResolution>(key).catch(() => null);
  if (hit && hit.state) return hit;
  const legacy = await kvGetJson<{ login: string | null }>(`gh:id:${id}`).catch(() => null);
  if (legacy?.login) return { id, login: legacy.login, state: "ok", checkedAt: new Date().toISOString() };
  const checkedAt = new Date().toISOString();
  let out: GithubLoginResolution;
  let ttl: number;
  try {
    const u = await gh<{ login?: string }>(`/user/${id}`);
    const login = u.login && LOGIN_RE.test(u.login) ? u.login : null;
    out = { id, login, state: login ? "ok" : "missing", checkedAt };
    ttl = login ? TTL_LOGIN : TTL_NEG_LOGIN;
  } catch (e) {
    if (e instanceof GithubHttpError && e.rateLimited) {
      out = { id, login: null, state: "rate-limited", checkedAt };
      const until = gRl.__kestrelGhRateLimitedUntil ?? 0;
      ttl = until > Date.now() ? Math.max(30, Math.ceil((until - Date.now()) / 1000)) : TTL_FAIL;
    } else if (e instanceof GithubHttpError && e.status === 404) {
      out = { id, login: null, state: "missing", checkedAt };
      ttl = TTL_NEG_LOGIN;
    } else {
      out = { id, login: null, state: "error", checkedAt };
      ttl = TTL_FAIL;
    }
  }
  await kvSetJson(key, out, { ex: Math.min(ttl, out.state === "ok" ? TTL_LOGIN : TTL_NEG_LOGIN) }).catch(() => undefined);
  return out;
}

/** Resolve a login from a numeric GitHub id (used when Vibestarter only exposes the avatar URL). null = unresolved. */
export async function resolveGithubLogin(id: number): Promise<string | null> {
  return (await resolveGithubLoginDetailed(id)).login;
}

/**
 * A GithubVelocity row for a founder whose login could not be resolved from their avatar id, so the board shows
 * WHY (rate-limited vs account missing) instead of a bare "login not resolved". `login` is "id:<n>" — not a real
 * login — and `profileUrl` is GitHub's public by-id API URL, which names the account.
 */
export function unresolvedGithubVelocity(r: GithubLoginResolution): GithubVelocity | null {
  if (r.state === "ok") return null;
  const status: GithubVelocity["status"] = r.state === "missing" ? "not-found" : r.state;
  const note =
    r.state === "rate-limited"
      ? `Founder GitHub account #${r.id} not resolved: ${rateLimitNote()}`
      : r.state === "missing"
        ? `GitHub account #${r.id} (from the founder's Vibestarter avatar) no longer exists — deleted, renamed away or suspended.`
        : `GitHub API unavailable while resolving founder account #${r.id}; retrying in a few minutes.`;
  return {
    login: `id:${r.id}`,
    status,
    profileUrl: `https://api.github.com/user/${r.id}`,
    pushes7d: null,
    pushes30d: null,
    activeDays30d: null,
    commits7d: null,
    commits30d: null,
    commitsCapped: false,
    reposPushed30d: [],
    lastPushAt: null,
    lastEventAt: null,
    capsuleRepo: null,
    note,
    fetchedAt: r.checkedAt,
    authenticated: Boolean(process.env.GITHUB_TOKEN?.trim()),
  };
}

type GhEvent = { type: string; created_at: string; repo?: { name?: string } };
type GhCommit = { commit?: { author?: { date?: string }; committer?: { date?: string } } };
type GhRepo = { full_name: string; pushed_at: string | null; stargazers_count: number; archived: boolean };

async function compute(login: string, capsuleRepo: string | null): Promise<GithubVelocity> {
  const now = Date.now();
  const fetchedAt = new Date().toISOString();
  const base: GithubVelocity = {
    login,
    status: "ok",
    profileUrl: `https://github.com/${login}`,
    pushes7d: null,
    pushes30d: null,
    activeDays30d: null,
    commits7d: null,
    commits30d: null,
    commitsCapped: false,
    reposPushed30d: [],
    lastPushAt: null,
    lastEventAt: null,
    capsuleRepo: null,
    note: "",
    fetchedAt,
    authenticated: Boolean(process.env.GITHUB_TOKEN?.trim()),
  };

  let events: GhEvent[];
  try {
    events = await gh<GhEvent[]>(`/users/${encodeURIComponent(login)}/events/public?per_page=100`);
  } catch (e) {
    if (e instanceof GithubHttpError) {
      if (e.status === 404) return { ...base, status: "not-found", note: `GitHub user @${login} not found — the account was renamed, deleted or suspended.` };
      if (e.rateLimited) return { ...base, status: "rate-limited", note: rateLimitNote() };
    }
    return { ...base, status: "error", note: `GitHub API unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const within = (iso: string, days: number) => now - Date.parse(iso) <= days * DAY;
  const pushes = events.filter((e) => e.type === "PushEvent");
  const pushes30 = pushes.filter((e) => within(e.created_at, 30));
  base.pushes7d = pushes.filter((e) => within(e.created_at, 7)).length;
  base.pushes30d = pushes30.length;
  base.activeDays30d = new Set(events.filter((e) => within(e.created_at, 30)).map((e) => e.created_at.slice(0, 10))).size;
  base.lastPushAt = pushes[0]?.created_at ?? null;
  base.lastEventAt = events[0]?.created_at ?? null;
  const repoCounts = new Map<string, number>();
  for (const p of pushes30) if (p.repo?.name && REPO_RE.test(p.repo.name)) repoCounts.set(p.repo.name, (repoCounts.get(p.repo.name) ?? 0) + 1);
  base.reposPushed30d = [...repoCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);

  // commits landed in the top repos the founder pushed to (one call per repo, ≤ 3)
  const since = new Date(now - 30 * DAY).toISOString();
  const top = base.reposPushed30d.slice(0, 3);
  if (top.length === 0) {
    base.commits7d = 0;
    base.commits30d = 0;
  } else {
    const lists = await Promise.all(
      top.map((r) => gh<GhCommit[]>(`/repos/${r}/commits?since=${encodeURIComponent(since)}&per_page=100`).catch(() => null))
    );
    const ok = lists.filter((l): l is GhCommit[] => Array.isArray(l));
    if (ok.length) {
      let c7 = 0;
      let c30 = 0;
      for (const l of ok) {
        if (l.length >= 100) base.commitsCapped = true;
        for (const c of l) {
          const d = c.commit?.committer?.date ?? c.commit?.author?.date;
          if (!d) continue;
          c30++;
          if (within(d, 7)) c7++;
        }
      }
      base.commits7d = c7;
      base.commits30d = c30;
    }
  }

  let capsuleNote = "";
  if (capsuleRepo) {
    try {
      const r = await gh<GhRepo>(`/repos/${capsuleRepo}`);
      base.capsuleRepo = { fullName: r.full_name, status: "ok", pushedAt: r.pushed_at, stars: r.stargazers_count, archived: r.archived };
    } catch (e) {
      const missing = e instanceof GithubHttpError && e.status === 404;
      base.capsuleRepo = { fullName: capsuleRepo, status: missing ? "not-found" : "error", pushedAt: null, stars: null, archived: null };
      // GitHub answers 404 for both private and deleted repos — it never reveals which.
      capsuleNote = missing
        ? ` Capsule repo ${capsuleRepo} is private or deleted (GitHub returns 404 for both).`
        : e instanceof GithubHttpError && e.rateLimited
          ? ` Capsule repo ${capsuleRepo} not checked: GitHub rate limit reached.`
          : ` Capsule repo ${capsuleRepo} could not be read (GitHub API error).`;
    }
  }

  const commitsUnread = top.length > 0 && base.commits30d == null;
  base.note =
    `Public GitHub activity of @${login}: ${base.pushes30d} pushes over ${base.activeDays30d} active days in 30 d` +
    (base.commits30d != null ? `; ${base.commits30d}${base.commitsCapped ? "+" : ""} commits landed in ${top.length} repo${top.length === 1 ? "" : "s"} they pushed to` : "") +
    (commitsUnread ? "; commit counts unavailable (GitHub API refused the repo reads)" : "") +
    ". Private-repo work is invisible to the public API." +
    capsuleNote;
  return base;
}

/** Live founder velocity (cached 30 min; failures 5 min). Returns null only for an invalid login. */
export async function readGithubVelocity(login: string, opts: { capsuleRepoUrl?: string | null } = {}): Promise<GithubVelocity | null> {
  if (!LOGIN_RE.test(login)) return null;
  const capsuleRepo = parseGithubRepo(opts.capsuleRepoUrl);
  const key = `gh:velocity:v1:${login.toLowerCase()}:${capsuleRepo?.toLowerCase() ?? "-"}`;
  const hit = await kvGetJson<GithubVelocity>(key).catch(() => null);
  if (hit) return hit;
  const v = await compute(login, capsuleRepo);
  let ttl = v.status === "ok" || v.status === "not-found" ? TTL_OK : TTL_FAIL;
  if (v.status === "rate-limited") {
    // retry right after the quota resets rather than on a fixed 5 min clock
    const until = gRl.__kestrelGhRateLimitedUntil ?? 0;
    ttl = until > Date.now() ? Math.min(TTL_NEG_LOGIN, Math.max(30, Math.ceil((until - Date.now()) / 1000))) : TTL_FAIL;
  }
  await kvSetJson(key, v, { ex: ttl }).catch(() => undefined);
  return v;
}
