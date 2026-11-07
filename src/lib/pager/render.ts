/**
 * Per-channel rendering for Night-Shift Pager messages.
 *
 * Every untrusted string (token names/symbols, campaign titles, labels, challenge reasons, alert lines) is
 * escaped for the destination: Telegram HTML entities, Discord markdown (+ allowed_mentions: none so a token
 * named "@everyone" cannot ping), Slack mrkdwn control characters (<!channel>, <url|text>). Only our own app
 * and explorer URLs are ever placed in hrefs / buttons. Numbers arrive pre-formatted in `PagerAlert.lines`
 * (fmtUnits / fmtBps on BigInt); nothing here converts uint256 values.
 */
import { chainName } from "@/lib/format";
import type { ChainId, Severity } from "@/lib/engine/types";
import type { Desk, DigestPayload, PagerAlert } from "@/lib/pager/types";
import { absUrl, buttonUrl, pagerHref, type LinkRef } from "@/lib/pager/links";

export type PagerEvent = "alert" | "digest" | "test" | "resolved" | "notice";

export interface Button {
  text: string;
  url: string;
}

export interface GenericPayload {
  text: string;
  content: string;
  kestrel: {
    v: 1;
    event: PagerEvent;
    deskId: string | null;
    severity: Severity;
    title: string;
    alerts: PagerAlert[];
    digest: DigestPayload | null;
    data?: Record<string, unknown>;
  };
}

export interface Rendered {
  event: PagerEvent;
  severity: Severity;
  /** Telegram disable_notification: everything except CRITICAL arrives silently. */
  silent: boolean;
  headline: string;
  /** Plain text (≤ ~3,500 chars) — used for logs, the UI preview and generic receivers. */
  plain: string;
  /** Telegram HTML (parse_mode: "HTML"), built from escaped pieces, never sliced after escaping. */
  html: string;
  /** Telegram inline keyboard rows; only public https URLs (empty in local dev). */
  buttons: Button[][];
  discord: Record<string, unknown>;
  slack: Record<string, unknown>;
  generic: GenericPayload;
}

/* ------------------------------------------------------------------ escaping */

/** Telegram HTML text escaping (the only three entities Telegram requires). */
export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Attribute-safe escaping for href values. */
export const escAttr = (s: string) => escHtml(s).replace(/"/g, "&quot;");
/** Discord markdown escaping: blocks masked links [x](y), headings, lists, code, spoilers, mentions-by-markup. */
export const escMd = (s: string) => s.replace(/[\\*_~`|>\[\]()#\-<@:]/g, (c) => `\\${c}`);
/** Slack mrkdwn escaping: blocks <!channel>, <@U…>, <url|text> injection. */
export const escSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Strips control chars / bidi overrides from untrusted plain text and bounds its length. */
export function clean(s: unknown, max = 500): string {
  const str = typeof s === "string" ? s : s === null || s === undefined ? "" : String(s);
  // eslint-disable-next-line no-control-regex
  const out = str.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/* ------------------------------------------------------------------ helpers */

const SEV_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };
const SEV_LABEL: Record<Severity, string> = { info: "INFO", warn: "WARNING", critical: "CRITICAL" };
const SEV_COLOR: Record<Severity, number> = { critical: 0xff4d4f, warn: 0xffb020, info: 0x91d982 };

export function maxSeverity(list: { severity: Severity }[]): Severity {
  return list.reduce<Severity>((m, a) => (SEV_RANK[a.severity] > SEV_RANK[m] ? a.severity : m), "info");
}

const fmtBlock = (b: string | null | undefined) => {
  if (!b || !/^\d+$/.test(b)) return "—";
  return BigInt(b).toLocaleString("en-US");
};

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

function localTime(ms: number, tz: string | null): string {
  if (!tz) return hhmm(ms);
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz, hour12: false }).format(new Date(ms));
  } catch {
    return hhmm(ms);
  }
}

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** A link rendered three ways: plain text, Telegram HTML, and a button candidate. */
function linkPieces(l: LinkRef): { text: string; html: string; md: string; slack: string; button: Button | null } {
  const label = clean(l.label, 60);
  const abs = absUrl(l.href);
  const btn = buttonUrl(l.href);
  return {
    text: `${label}: ${abs}`,
    html: btn ? `<a href="${escAttr(btn)}">${escHtml(label)} ↗</a>` : `${escHtml(label)}: ${escHtml(abs)}`,
    md: btn ? `[${escMd(label)}](${btn})` : `${escMd(label)}: ${abs}`,
    slack: btn ? `<${btn}|${escSlack(label).replace(/\|/g, "/")}>` : `${escSlack(label)}: ${escSlack(abs)}`,
    button: btn ? { text: label.slice(0, 40), url: btn } : null,
  };
}

function buttonRows(links: LinkRef[], max = 4): Button[][] {
  const btns: Button[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const b = linkPieces(l).button;
    if (b && !seen.has(b.url)) {
      seen.add(b.url);
      btns.push(b);
    }
    if (btns.length >= max) break;
  }
  const rows: Button[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return rows;
}

/** Truncates to `max` chars at a line boundary, appending a pointer to the app. */
function budget(lines: string[], max: number, more: (dropped: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length + 1;
    if (used + len > max) {
      out.push(more(lines.length - i));
      break;
    }
    out.push(lines[i]);
    used += len;
  }
  return out;
}

interface Block {
  severity: Severity;
  title: string;
  lines: string[];
  footer: string | null;
  links: LinkRef[];
  timestamp: number | null;
}

const PLAIN_BUDGET = 3_500;

/** Shared body assembly for all channels from neutral blocks. */
function assemble(opts: {
  event: PagerEvent;
  severity: Severity;
  headline: string;
  intro: string[];
  blocks: Block[];
  outro: string[];
  buttons: LinkRef[];
  deskId: string | null;
  title: string;
  alerts: PagerAlert[];
  digest: DigestPayload | null;
  data?: Record<string, unknown>;
}): Rendered {
  const { event, severity, headline } = opts;
  const moreLink = absUrl(pagerHref());

  // ---- plain text
  const plainLines: string[] = [headline, ...opts.intro.map((l) => clean(l, 600))];
  for (const b of opts.blocks) {
    plainLines.push("", clean(b.title, 200), ...b.lines.map((l) => `  ${clean(l, 400)}`));
    if (b.footer) plainLines.push(`  ${b.footer}`);
    for (const l of b.links) plainLines.push(`  ↳ ${linkPieces(l).text}`);
  }
  if (opts.outro.length) plainLines.push("", ...opts.outro.map((l) => clean(l, 900)));
  const plain = budget(plainLines, PLAIN_BUDGET, (n) => `… +${n} more lines in the app: ${moreLink}`).join("\n");

  // ---- Telegram HTML (escape each piece; truncate on plain-length budget, never slice HTML)
  const htmlParts: { plainLen: number; html: string }[] = [];
  const push = (plainText: string, html: string) => htmlParts.push({ plainLen: plainText.length + 1, html });
  push(headline, `<b>${escHtml(headline)}</b>`);
  for (const l of opts.intro) push(clean(l, 600), escHtml(clean(l, 600)));
  for (const b of opts.blocks) {
    const t = clean(b.title, 200);
    push(t, `\n<b>${escHtml(t)}</b>`);
    for (const l of b.lines) push(clean(l, 400), escHtml(clean(l, 400)));
    if (b.footer) push(b.footer, `<i>${escHtml(b.footer)}</i>`);
    const ls = b.links.map(linkPieces);
    if (ls.length) push(ls.map((x) => x.text).join(" · "), ls.map((x) => x.html).join(" · "));
  }
  if (opts.outro.length) for (const l of opts.outro) push(clean(l, 900), `\n${escHtml(clean(l, 900))}`);
  const htmlOut: string[] = [];
  let used = 0;
  for (let i = 0; i < htmlParts.length; i++) {
    if (used + htmlParts[i].plainLen > PLAIN_BUDGET) {
      htmlOut.push(`<i>… +${htmlParts.length - i} more lines in the app: ${escHtml(moreLink)}</i>`);
      break;
    }
    htmlOut.push(htmlParts[i].html);
    used += htmlParts[i].plainLen;
  }
  const html = htmlOut.join("\n");
  const buttons = buttonRows(opts.buttons);

  // ---- Discord (≤ 10 embeds, ≤ 6,000 chars total across embeds; we stay well under)
  const discordButtons = buttons.flat().slice(0, 5);
  const embeds = opts.blocks.slice(0, 4).map((b) => {
    const links = b.links.map((l) => linkPieces(l).md);
    const desc = [...b.lines.map((l) => escMd(clean(l, 400))), ...(links.length ? [links.join(" · ")] : [])].join("\n");
    return {
      title: escMd(clean(b.title, 200)).slice(0, 256),
      description: desc.length > 1_100 ? `${desc.slice(0, 1_090)}…` : desc,
      color: SEV_COLOR[b.severity],
      ...(b.footer ? { footer: { text: clean(b.footer, 200) } } : {}),
      ...(b.timestamp ? { timestamp: new Date(b.timestamp).toISOString() } : {}),
    };
  });
  const extra = opts.blocks.length - embeds.length;
  const introMd = opts.intro.map((l) => escMd(clean(l, 600))).join("\n");
  const outroMd = opts.outro.map((l) => escMd(clean(l, 900))).join("\n");
  const discordContent = [`**${escMd(headline)}**`, introMd, extra > 0 ? `+${extra} more in the app: ${moreLink}` : "", outroMd].filter(Boolean).join("\n");
  const discord: Record<string, unknown> = {
    username: "Kestrel Night-Shift Pager",
    content: discordContent.length > 1_900 ? `${discordContent.slice(0, 1_890)}…` : discordContent,
    embeds,
    allowed_mentions: { parse: [] },
    ...(discordButtons.length
      ? { components: [{ type: 1, components: discordButtons.map((b) => ({ type: 2, style: 5, label: b.text.slice(0, 80), url: b.url })) }] }
      : {}),
  };

  // ---- Slack Block Kit
  const sections = opts.blocks.slice(0, 10).map((b) => {
    const links = b.links.map((l) => linkPieces(l).slack);
    const txt = [`*${escSlack(clean(b.title, 200))}*`, ...b.lines.map((l) => escSlack(clean(l, 400))), ...(b.footer ? [`_${escSlack(b.footer)}_`] : []), ...(links.length ? [links.join(" · ")] : [])].join("\n");
    return { type: "section", text: { type: "mrkdwn", text: txt.length > 2_900 ? `${txt.slice(0, 2_890)}…` : txt } };
  });
  const introSlack = opts.intro.map((l) => escSlack(clean(l, 600))).join("\n");
  const outroSlack = opts.outro.map((l) => escSlack(clean(l, 900))).join("\n");
  const slackButtons = buttons.flat().slice(0, 5);
  const slack: Record<string, unknown> = {
    text: escSlack(headline),
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline.slice(0, 150), emoji: false } },
      ...(introSlack ? [{ type: "section", text: { type: "mrkdwn", text: introSlack.slice(0, 2_900) } }] : []),
      ...sections,
      ...(outroSlack ? [{ type: "context", elements: [{ type: "mrkdwn", text: outroSlack.slice(0, 2_900) }] }] : []),
      ...(slackButtons.length
        ? [{ type: "actions", elements: slackButtons.map((b, i) => ({ type: "button", action_id: `kestrel_link_${i}`, text: { type: "plain_text", text: b.text.slice(0, 75) }, url: b.url })) }]
        : []),
    ].slice(0, 50),
  };

  const generic: GenericPayload = {
    text: plain,
    content: plain.length > 2_000 ? `${plain.slice(0, 1_990)}…` : plain,
    kestrel: { v: 1, event, deskId: opts.deskId, severity, title: clean(opts.title, 200), alerts: opts.alerts, digest: opts.digest, ...(opts.data ? { data: opts.data } : {}) },
  };

  return { event, severity, silent: severity !== "critical", headline, plain, html, buttons, discord, slack, generic };
}

/* ------------------------------------------------------------------ public renderers */

/**
 * Renders one message for a desk carrying this tick's alerts (one message per desk per tick).
 * `wokeYou` prefixes CRITICAL pages sent during Sleep Mode.
 */
export function renderAlerts(desk: Pick<Desk, "id"> | null, alerts: PagerAlert[], opts: { wokeYou?: boolean; labels?: Record<string, string> } = {}): Rendered {
  const sorted = [...alerts].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.at - b.at);
  const severity = maxSeverity(sorted);
  const allResolved = sorted.length > 0 && sorted.every((a) => !!a.resolves);
  const event: PagerEvent = allResolved ? "resolved" : "alert";
  const count = sorted.length;
  const headline = `>_ KESTREL · ${allResolved ? "RESOLVED" : SEV_LABEL[severity]}${count > 1 ? ` · ${count} alerts` : ""}`;
  const intro = opts.wokeYou && severity === "critical" ? ["Woke you because:"] : [];
  const blocks: Block[] = sorted.map((a) => {
    const label = opts.labels?.[a.watchId];
    return {
      severity: a.severity,
      title: `${a.resolves ? "RESOLVED: " : ""}${a.title}`,
      lines: [...(label ? [`Watch: ${label}`] : []), ...a.lines],
      footer: `${chainName(a.chainId)} · block #${fmtBlock(a.block)} · ${hhmm(a.at)}`,
      links: [...a.actions.slice(0, 2), ...a.evidence.slice(0, 2)],
      timestamp: a.at,
    };
  });
  const first = sorted[0];
  return assemble({
    event,
    severity,
    headline,
    intro,
    blocks,
    outro: [],
    buttons: first ? [...first.actions, ...first.evidence] : [],
    deskId: desk?.id ?? null,
    title: first ? first.title : "No alerts",
    alerts: sorted,
    digest: null,
  });
}

const BRIEF_SOURCE: Record<DigestPayload["brief"]["source"], string> = { deterministic: "deterministic", "0g-compute": "0G Compute", anthropic: "Anthropic" };

/** "While You Slept" digest. "All quiet" still renders a full message: silence must never look like a dead sentinel. */
export function renderDigest(desk: Pick<Desk, "id"> | null, d: DigestPayload): Rendered {
  const severity = maxSeverity(d.perWatch);
  const tzLabel = d.tz ? ` (${clean(d.tz, 40)})` : "";
  const headline = `>_ WHILE YOU SLEPT · ${localTime(d.startedAt, d.tz)} → ${localTime(d.endedAt, d.tz)}${tzLabel} · ${span(d.endedAt - d.startedAt)}`;
  const chainParts = ([8453, 4663] as ChainId[])
    .map((cid) => [cid, d.blocks[cid]] as const)
    .filter((e): e is readonly [ChainId, { from: string; to: string; count: string }] => !!e[1])
    .map(([cid, b]) => `${fmtBlock(b.count)} ${chainName(cid)} blocks (#${fmtBlock(b.from)} → #${fmtBlock(b.to)})`);
  const intro = [
    `Kestrel ran ${d.checks.toLocaleString("en-US")} checks${chainParts.length ? ` across ${chainParts.join(" and ")}` : ""}.`,
    `${d.pagedCount} critical page${d.pagedCount === 1 ? "" : "s"} sent · ${d.deferredCount} warning${d.deferredCount === 1 ? "" : "s"} held for this digest.`,
  ];
  const blocks: Block[] = d.perWatch.map((w) => ({
    severity: w.severity,
    title: `${w.severity === "info" ? "○" : "●"} ${clean(w.label, 80)} (${chainName(w.chainId)})`,
    lines: w.lines,
    footer: null,
    links: w.actions.slice(0, 2),
    timestamp: null,
  }));
  if (!blocks.length) blocks.push({ severity: "info", title: "○ No watches on this desk", lines: ["Add a watch in the Night-Shift Pager tab."], footer: null, links: [], timestamp: null });
  const brief = clean(d.brief.text, 900);
  const outro = brief ? [`Desk brief (${BRIEF_SOURCE[d.brief.source] ?? "deterministic"}${d.brief.model ? ` · ${clean(d.brief.model, 60)}` : ""}): ${brief}`] : [];
  const primary = d.perWatch.flatMap((w) => w.actions).slice(0, 2);
  return assemble({
    event: "digest",
    severity,
    headline,
    intro,
    blocks,
    outro,
    buttons: [...primary, { label: "Open Kestrel", href: pagerHref() }],
    deskId: desk?.id ?? null,
    title: "While You Slept",
    alerts: [],
    digest: d,
  });
}

/**
 * Free-form notice (test pages, "Sentinel degraded" ops alerts, Telegram link confirmations).
 * `lines` are plain text; `links` are app-relative or explorer URLs built by us.
 */
export function renderNotice(opts: {
  event?: PagerEvent;
  severity?: Severity;
  headline: string;
  title?: string;
  lines: string[];
  links?: LinkRef[];
  deskId?: string | null;
  data?: Record<string, unknown>;
}): Rendered {
  const severity = opts.severity ?? "info";
  const blocks: Block[] = opts.title ? [{ severity, title: opts.title, lines: opts.lines, footer: null, links: opts.links ?? [], timestamp: Date.now() }] : [];
  const intro = opts.title ? [] : opts.lines;
  const linksBlock = !opts.title && opts.links?.length ? [{ severity, title: "Links", lines: [], footer: null, links: opts.links, timestamp: null }] : [];
  return assemble({
    event: opts.event ?? "notice",
    severity,
    headline: clean(opts.headline, 150),
    intro,
    blocks: [...blocks, ...linksBlock],
    outro: [],
    buttons: opts.links ?? [],
    deskId: opts.deskId ?? null,
    title: opts.title ?? opts.headline,
    alerts: [],
    digest: null,
    data: opts.data,
  });
}
