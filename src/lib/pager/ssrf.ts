/**
 * Outbound-request SSRF guard for user-supplied webhook URLs (Night-Shift Pager) and any other
 * server-side fetch of an externally supplied URL.
 *
 * Hardening (audit `pager-ssrf-gaps`):
 *  - https only (http opt-in for read-only probes), no embedded credentials, port 443 only by default.
 *  - Hostnames are vetted before DNS: localhost / *.local / *.internal / *.home.arpa / single-label names are refused.
 *  - Every resolved address must be public unicast. IPv4: RFC 6890 special-purpose ranges incl. 0/8, 100.64/10,
 *    192.0.0/24, TEST-NETs, 198.18/15, 224/4, 240/4. IPv6: only global unicast 2000::/3 minus Teredo, 6to4,
 *    documentation and NAT64; IPv4-mapped / IPv4-compatible forms (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d)
 *    are unwrapped and re-checked as IPv4. Decimal / octal / hex IPv4 hosts are normalized by the WHATWG URL
 *    parser (https://2130706433 → 127.0.0.1) and parsed defensively here as well.
 *  - DNS-rebinding / TOCTOU: `safeRequest` connects to the exact IP that was vetted (custom `lookup` on
 *    node:https, SNI + certificate verification still use the hostname), so a second resolution can never
 *    swap in a private address between check and connect.
 *  - Redirects are never followed (a 3xx is returned as a failure), total time and response size are capped.
 */
import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";

export class SsrfError extends Error {
  /** True for conditions that may clear on their own (DNS lookup failure), as opposed to policy violations. */
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.name = "SsrfError";
    this.transient = transient;
  }
}

/* ------------------------------------------------------------------ IP parsing */

/** Parses an IPv4 literal in dotted-quad, or the legacy inet_aton forms (decimal, octal, hex, 1–4 parts). */
export function parseIPv4(input: string): number[] | null {
  const s = input.trim();
  if (!s || !/^[0-9a-fx.]+$/i.test(s)) return null;
  const parts = s.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton: the last part fills the remaining bytes
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const remaining = 4 - nums.length;
  if (last >= 256 ** remaining) return null;
  const tail: number[] = [];
  let v = last;
  for (let i = 0; i < remaining; i++) {
    tail.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return [...nums, ...tail];
}

/** Parses an IPv6 literal (with optional brackets, zone id and embedded dotted IPv4 tail) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    // embedded dotted IPv4 tail (::ffff:1.2.3.4) → two hex groups
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(tail) ? tail.split(".").map(Number) : null;
    if (!v4 || v4.some((n) => n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const tailGroups: number[] = [];
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = toGroups(dbl[0]);
  const rest = dbl.length === 2 ? toGroups(dbl[1]) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tailGroups.length;
  if (dbl.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array(8 - known).fill(0), ...rest, ...tailGroups];
  }
  if (known !== 8) return null;
  return [...head, ...tailGroups];
}

const inV4 = (ip: number[], net: number[], bits: number): boolean => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
};

/** IPv4 special-purpose ranges that must never be reached from the server (RFC 6890 + multicast/reserved). */
const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], // link-local incl. cloud metadata 169.254.169.254
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + 255.255.255.255 broadcast
];

function isBlockedV4(b: number[]): boolean {
  return V4_BLOCKED.some(([net, bits]) => inV4(b, net, bits));
}

function isBlockedV6(g: number[]): boolean {
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible, incl. :: and ::1) → judge as IPv4
  if (first5Zero && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isBlockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // ::ffff:0:a.b.c.d (SIIT) → judge as IPv4 too
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) {
    return isBlockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // Allow-list: only global unicast 2000::/3 …
  if ((g[0] & 0xe000) !== 0x2000) return true; // blocks ::/8 rest, 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8
  // … minus special ranges inside it
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF (Teredo 2001::/32, ORCHID, benchmarking)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 (embeds arbitrary IPv4)
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

/** True when `ip` (IPv4 or IPv6 literal, any accepted notation) is NOT a public unicast address. Unparseable → true. */
export function isPrivateIp(ip: string): boolean {
  const v6 = parseIPv6(ip);
  if (v6) return isBlockedV6(v6);
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedV4(v4);
  return true;
}

const ipLiteral = (host: string): { address: string; family: 4 | 6 } | null => {
  const v6 = parseIPv6(host);
  if (v6) return { address: v6.map((x) => x.toString(16)).join(":"), family: 6 };
  const v4 = parseIPv4(host);
  if (v4 && /^[0-9a-fx.]+$/i.test(host) && /\d/.test(host)) return { address: v4.join("."), family: 4 };
  return null;
};

/* ------------------------------------------------------------------ URL vetting */

export interface SafeUrlOptions {
  /** Allow plain http:// (read-only probes only). Webhooks are always https. */
  allowHttp?: boolean;
  /** Allowed ports. Defaults to [443] (plus [80] when allowHttp). */
  ports?: readonly number[];
}

export interface ResolvedTarget {
  url: URL;
  hostname: string;
  port: number;
  address: string;
  family: 4 | 6;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp", ".localdomain"];

/** Synchronous URL-shape checks (no DNS). Throws SsrfError. */
export function assertSafeUrlShape(raw: string, opts: SafeUrlOptions = {}): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new SsrfError("Webhook URL is required");
  if (raw.length > 2048) throw new SsrfError("Webhook URL is too long (max 2048 chars)");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SsrfError("Webhook URL is not a valid URL");
  }
  const httpOk = opts.allowHttp && u.protocol === "http:";
  if (u.protocol !== "https:" && !httpOk) throw new SsrfError("Webhook must use https://");
  if (u.username || u.password) throw new SsrfError("Webhook URL must not embed credentials");
  const ports = opts.ports ?? (opts.allowHttp ? [443, 80] : [443]);
  const port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
  if (!ports.includes(port)) throw new SsrfError(`Webhook port ${port} not allowed (only ${ports.join(", ")})`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new SsrfError("Webhook host is missing");
  const lit = ipLiteral(host);
  if (lit) {
    if (isPrivateIp(lit.address)) throw new SsrfError("Webhook resolves to a private or reserved address");
    return u;
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new SsrfError("Webhook host not allowed");
  if (!host.includes(".")) throw new SsrfError("Webhook host must be a public domain name");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new SsrfError("Webhook host contains invalid characters");
  return u;
}

/** Full check: URL shape + DNS resolution; every resolved address must be public. Returns the vetted IP to pin. */
export async function resolveSafeUrl(raw: string | URL, opts: SafeUrlOptions = {}): Promise<ResolvedTarget> {
  const u = assertSafeUrlShape(typeof raw === "string" ? raw : raw.toString(), opts);
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  const port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
  const lit = ipLiteral(hostname);
  if (lit) return { url: u, hostname, port, address: lit.address, family: lit.family };
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`Webhook host ${hostname} does not resolve`, true);
  }
  if (!addrs.length) throw new SsrfError(`Webhook host ${hostname} does not resolve`, true);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new SsrfError("Webhook resolves to a private or reserved address");
  const pick = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { url: u, hostname, port, address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

/**
 * Back-compat helper (was private in /api/pager/test): validates the URL and its DNS answers.
 * Prefer `safeRequest`, which re-validates and pins the IP on every send.
 */
export async function assertSafeWebhook(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  return (await resolveSafeUrl(raw, opts)).url;
}

/* ------------------------------------------------------------------ pinned request */

export interface SafeRequestInit {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Total time budget in ms (connect + TLS + response). Default 8000. */
  timeoutMs?: number;
  /** Max response bytes read (the rest is discarded and the socket destroyed). Default 64 KiB. */
  maxBytes?: number;
  allowHttp?: boolean;
  ports?: readonly number[];
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  headers: IncomingHttpHeaders;
  /** Response text truncated to maxBytes. */
  text: string;
  truncated: boolean;
  /** Vetted IP the request was pinned to. */
  address: string;
  durationMs: number;
}

/**
 * Sends one HTTP(S) request to a user-supplied URL with the SSRF guard re-run right now and the TCP connection
 * pinned to the vetted IP (no DNS-rebinding window). Never follows redirects. Throws SsrfError for policy
 * violations and Error for transport failures/timeouts.
 */
export async function safeRequest(raw: string | URL, init: SafeRequestInit = {}): Promise<SafeResponse> {
  const started = Date.now();
  const timeoutMs = Math.max(500, Math.min(init.timeoutMs ?? 8_000, 30_000));
  const maxBytes = Math.max(1_024, Math.min(init.maxBytes ?? 65_536, 1_048_576));
  const target = await resolveSafeUrl(raw, { allowHttp: init.allowHttp, ports: init.ports });
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) throw new Error("Webhook timed out (DNS)");

  const pinned: LookupFunction = (_host, options, cb) => {
    const done = cb as unknown as (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
    if ((options as { all?: boolean })?.all) done(null, [{ address: target.address, family: target.family }]);
    else done(null, target.address, target.family);
  };

  const isHttps = target.url.protocol === "https:";
  const body = init.body ?? "";
  const headers: Record<string, string> = { "User-Agent": "Kestrel-Pager/1.0", Accept: "application/json, text/plain;q=0.9, */*;q=0.1", ...init.headers };
  if (init.method === "POST" || body) headers["Content-Length"] = String(Buffer.byteLength(body));

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: init.method ?? (body ? "POST" : "GET"),
        headers,
        lookup: pinned,
        ...(isHttps ? { servername: target.hostname } : {}),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (c.length > room) {
            chunks.push(c.subarray(0, room));
            size = maxBytes;
            truncated = true;
            res.destroy();
            done();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        const done = () =>
          finish(() =>
            resolve({
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString("utf8"),
              truncated,
              address: target.address,
              durationMs: Date.now() - started,
            })
          );
        res.on("end", done);
        res.on("close", done);
        res.on("error", (e) => finish(() => reject(e)));
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`Webhook timed out after ${timeoutMs} ms`));
    }, remaining);
    req.on("error", (e) => finish(() => reject(e)));
    if (body) req.write(body);
    req.end();
  });
}
