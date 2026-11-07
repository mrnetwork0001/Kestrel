const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;
const DEV_URL = "http://localhost:3002";

function normalize(raw: string | undefined | null, defaultProto = "https"): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `${defaultProto}://${v}`).origin;
  } catch {
    return null;
  }
}

/**
 * Canonical public origin (no trailing slash), resolved in order:
 * NEXT_PUBLIC_APP_URL (unless it points at localhost) → VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL →
 * the request's own origin (x-forwarded-proto / x-forwarded-host / host) → http://localhost:3002.
 */
export function siteUrl(req?: { headers: Headers; url?: string }): string {
  const env = normalize(process.env.NEXT_PUBLIC_APP_URL);
  if (env && !LOCAL_HOST.test(new URL(env).hostname)) return env;
  const vercel = normalize(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? normalize(process.env.VERCEL_URL);
  if (vercel) return vercel;
  if (req) {
    const h = req.headers;
    const host = h.get("x-forwarded-host")?.split(",")[0] ?? h.get("host");
    const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || (req.url ? new URL(req.url).protocol.replace(":", "") : "https");
    const origin = normalize(host, proto === "http" ? "http" : "https");
    if (origin) return origin;
  }
  return DEV_URL;
}
