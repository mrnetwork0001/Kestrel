"use client";

import { useEffect, useState } from "react";
import { cx, Panel } from "@/components/ui";

interface Rules {
  lpDropPct: number;
  maxSpreadBps: number;
  watchChallengeWindows: boolean;
  parityDrift: boolean;
}

interface PagerResponse {
  delivered: { channel: string; ok: boolean; status: number | null; error?: string }[];
  triggers: { rule: string; fired: boolean; observed: string }[];
  message: string;
  deepLink: string;
  error?: string;
}

const DEFAULT_RULES: Rules = { lpDropPct: 15, maxSpreadBps: 300, watchChallengeWindows: true, parityDrift: true };
const STORAGE_KEY = "kestrel.pager.v1";

export function PagerTab({ target, chainId }: { target: string; chainId: number }) {
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [sending, setSending] = useState(false);
  const [resp, setResp] = useState<PagerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        setRules({ ...DEFAULT_RULES, ...v.rules });
        setWebhookUrl(v.webhookUrl ?? "");
        setTelegramChatId(v.telegramChatId ?? "");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const save = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rules, webhookUrl, telegramChatId }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const send = async () => {
    setSending(true);
    setErr(null);
    setResp(null);
    try {
      const res = await fetch("/api/pager/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: webhookUrl || undefined, telegramChatId: telegramChatId || undefined, rules, target, chainId }),
      });
      const body = (await res.json()) as PagerResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResp(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <Panel title="Armed thresholds" n="01">
          <div className="space-y-5">
            <label className="block">
              <div className="flex justify-between"><span className="label">Page if LP depth drops more than</span><span className="tnum text-[13px] text-ink">{rules.lpDropPct}%</span></div>
              <input type="range" min={5} max={50} step={1} value={rules.lpDropPct} onChange={(e) => setRules({ ...rules, lpDropPct: Number(e.target.value) })} className="mt-2 w-full" />
            </label>
            <label className="block">
              <div className="flex justify-between"><span className="label">Page if Base ↔ RH spread exceeds</span><span className="tnum text-[13px] text-ink">{(rules.maxSpreadBps / 100).toFixed(1)}%</span></div>
              <input type="range" min={50} max={1500} step={25} value={rules.maxSpreadBps} onChange={(e) => setRules({ ...rules, maxSpreadBps: Number(e.target.value) })} className="mt-2 w-full" />
            </label>
            <label className="flex items-center gap-3 text-[13px] text-ink-2">
              <input type="checkbox" checked={rules.watchChallengeWindows} onChange={(e) => setRules({ ...rules, watchChallengeWindows: e.target.checked })} />
              Page when any Vibestarter 72h challenge window opens
            </label>
            <label className="flex items-center gap-3 text-[13px] text-ink-2">
              <input type="checkbox" checked={rules.parityDrift} onChange={(e) => setRules({ ...rules, parityDrift: e.target.checked })} />
              Page on $VIBES OFT 1:1 parity drift
            </label>
          </div>
        </Panel>
        <Panel title="Delivery" n="02">
          <label className="block">
            <span className="label">Webhook URL (Discord, Slack or custom · https only)</span>
            <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" className="mt-2 w-full rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[12px] text-ink placeholder:text-ink-3 focus:border-phosphor/50 focus:outline-none" />
          </label>
          <label className="mt-4 block">
            <span className="label">Telegram chat ID (requires server bot token)</span>
            <input value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="123456789" className="mt-2 w-full rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[12px] text-ink placeholder:text-ink-3 focus:border-phosphor/50 focus:outline-none" />
          </label>
          <div className="mt-5 flex flex-wrap gap-3">
            <button onClick={send} disabled={sending} className="rounded-[2px] bg-phosphor px-4 py-2 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698] disabled:opacity-40">
              {sending ? "DISPATCHING…" : "SEND LIVE TEST PAGER"}
            </button>
            <button onClick={save} className="rounded-[2px] border border-hair-strong px-4 py-2 mono text-[12px] text-ink hover:border-phosphor/60">
              {saved ? "SAVED ✓" : "SAVE RULES (THIS BROWSER)"}
            </button>
          </div>
          <p className="mt-3 text-[11px] text-ink-3">The test evaluates every rule against live chain state right now and sends the real alert. Rules are stored only in this browser.</p>
          {err && <p className="mt-3 mono text-[12px] text-crit">{err}</p>}
        </Panel>
      </div>

      <Panel title="Live evaluation & message" n="03">
        {!resp ? (
          <p className="text-[13px] text-ink-3">Send a test page to see each rule evaluated against current Base and Robinhood Chain state, and the exact message delivered.</p>
        ) : (
          <div className="space-y-5">
            <ul className="space-y-1.5">
              {resp.triggers.map((t) => (
                <li key={t.rule} className="flex items-center gap-3 mono text-[12px]">
                  <span className={t.fired ? "text-warn" : "text-phosphor"}>{t.fired ? "● FIRED" : "○ CLEAR"}</span>
                  <span className="text-ink-2">{t.rule}</span>
                  <span className="ml-auto text-ink-3">{t.observed}</span>
                </li>
              ))}
            </ul>
            <pre className="whitespace-pre-wrap border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2">{resp.message}</pre>
            <div>
              {resp.delivered.length === 0 && <p className="mono text-[11px] text-ink-3">No delivery channel set — message rendered only.</p>}
              {resp.delivered.map((d) => (
                <p key={d.channel} className={cx("mono text-[11px]", d.ok ? "text-phosphor" : "text-crit")}>
                  {d.channel}: {d.ok ? `delivered (HTTP ${d.status})` : `failed — ${d.error ?? `HTTP ${d.status}`}`}
                </p>
              ))}
            </div>
            <a href={resp.deepLink} className="inline-block mono text-[12px] text-crit hover:underline">Rescue deep link → {resp.deepLink.replace(/^https?:\/\/[^/]+/, "")}</a>
          </div>
        )}
      </Panel>
    </div>
  );
}
