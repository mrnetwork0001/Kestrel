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
 * Cached 30 min on the shared KV (failures 5 min). GITHUB_TOKEN is optional (60 → 5,000 req/h).
 */

export type { GithubVelocity };

const API = "https://api.github.com";
const TTL_OK = 1800;
const TTL_FAIL = 300;
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

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(7_000) });
  if (!res.ok) {
    const rateLimited = (res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429);
    throw new GithubHttpError(res.status, rateLimited);
  }
  return (await res.json()) as T;
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

/** Resolve a login from a numeric GitHub id (used when Vibestarter only exposes the avatar URL). Cached 24 h. */
export async function resolveGithubLogin(id: number): Promise<string | null> {
  const key = `gh:id:${id}`;
  const hit = await kvGetJson<{ login: string | null }>(key).catch(() => null);
  if (hit) return hit.login;
  try {
    const u = await gh<{ login?: string }>(`/user/${id}`);
    const login = u.login && LOGIN_RE.test(u.login) ? u.login : null;
    await kvSetJson(key, { login }, { ex: 86_400 }).catch(() => undefined);
    return login;
  } catch {
    return null;
  }
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
      if (e.status === 404) return { ...base, status: "not-found", note: `GitHub user @${login} not found.` };
      if (e.rateLimited) return { ...base, status: "rate-limited", note: "GitHub API rate limit reached for this server — velocity will refresh automatically (set GITHUB_TOKEN for 5,000 req/h)." };
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

  if (capsuleRepo) {
    try {
      const r = await gh<GhRepo>(`/repos/${capsuleRepo}`);
      base.capsuleRepo = { fullName: r.full_name, status: "ok", pushedAt: r.pushed_at, stars: r.stargazers_count, archived: r.archived };
    } catch (e) {
      base.capsuleRepo = { fullName: capsuleRepo, status: e instanceof GithubHttpError && e.status === 404 ? "not-found" : "error", pushedAt: null, stars: null, archived: null };
    }
  }

  base.note =
    `Public GitHub activity of @${login}: ${base.pushes30d} pushes over ${base.activeDays30d} active days in 30 d` +
    (base.commits30d != null ? `; ${base.commits30d}${base.commitsCapped ? "+" : ""} commits landed in ${top.length} repo${top.length === 1 ? "" : "s"} they pushed to` : "") +
    ". Private-repo work is invisible to the public API.";
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
  await kvSetJson(key, v, { ex: v.status === "ok" || v.status === "not-found" ? TTL_OK : TTL_FAIL }).catch(() => undefined);
  return v;
}
