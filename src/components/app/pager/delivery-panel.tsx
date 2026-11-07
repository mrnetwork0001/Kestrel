"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { cx, Panel } from "@/components/ui";
import type { DeskPublic, WatchView } from "@/lib/pager/types";
import { Btn, CopyButton, Dot, inputCls, Note, Tag } from "./pager-ui";
import { errText, pollTelegramLink, toMs, usePagerMutations, usePagerStatus, type TelegramLinkStart } from "./use-pager";

const POLL_MS = 2_000;
const POLL_MAX_MS = 120_000;

type LinkState =
  | { phase: "idle" }
  | { phase: "waiting"; link: TelegramLinkStart; startedAt: number }
  | { phase: "linked"; username: string | null }
  | { phase: "expired" }
  | { phase: "error"; message: string };

/** 04 · Delivery: Telegram deep-link linking with status polling, webhook URL + signing secret, and a live test page. */
export function DeliveryPanel({
  deskKey,
  desk,
  watches,
  mutations,
  onTest,
  testingId,
}: {
  deskKey: string | null;
  desk: DeskPublic | null;
  watches: WatchView[];
  mutations: ReturnType<typeof usePagerMutations>;
  onTest: (w: WatchView, dispatch: boolean) => void;
  testingId: string | null;
}) {
  const qc = useQueryClient();
  const { linkTelegram, unlinkTelegram, patchDesk } = mutations;
  const [link, setLink] = useState<LinkState>({ phase: "idle" });
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [chatId, setChatId] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = usePagerStatus();
  const tgConfigured = status.data?.telegram ? status.data.telegram.configured : null; // null = unknown
  const tg = desk?.channels.telegram ?? null;
  const wh = desk?.channels.webhook ?? null;
  const hasDesk = !!deskKey && !!desk;

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  // Secret delivered with the desk projection (when the server includes it) or returned once by PATCH.
  const effectiveSecret = secret ?? wh?.secret ?? null;

  const startLink = () => {
    if (!deskKey) return;
    if (pollRef.current) clearTimeout(pollRef.current);
    linkTelegram.mutate(undefined, {
      onSuccess: (r) => {
        if (!r?.url || !/^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}\?start=[A-Za-z0-9_-]{1,64}$/.test(r.url)) {
          setLink({ phase: "error", message: "Server returned an unexpected Telegram link." });
          return;
        }
        const startedAt = Date.now();
        setLink({ phase: "waiting", link: r, startedAt });
        // Best effort; popup blockers may stop this after an await, so the link is also rendered as a button.
        window.open(r.url, "_blank", "noopener,noreferrer");
        const expiresMs = toMs(r.expiresAt);
        const poll = async () => {
          const elapsed = Date.now() - startedAt;
          if (elapsed > POLL_MAX_MS || (expiresMs !== null && Date.now() > expiresMs)) {
            setLink({ phase: "expired" });
            return;
          }
          try {
            const s = await pollTelegramLink(deskKey);
            if (s.status === "linked") {
              setLink({ phase: "linked", username: s.telegram?.username ?? null });
              qc.invalidateQueries({ queryKey: ["pager", "desk"] });
              return;
            }
            if (s.status === "expired") {
              setLink({ phase: "expired" });
              return;
            }
          } catch {
            /* transient: keep polling until the deadline */
          }
          pollRef.current = setTimeout(poll, POLL_MS);
        };
        pollRef.current = setTimeout(poll, POLL_MS);
      },
      onError: (e) => setLink({ phase: "error", message: errText(e) }),
    });
  };

  const cancelLink = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setLink({ phase: "idle" });
  };

  const flash = (m: string) => {
    setSavedMsg(m);
    setTimeout(() => setSavedMsg(null), 2000);
  };

  const saveWebhook = () => {
    const v = webhook.trim();
    patchDesk.mutate(
      { webhookUrl: v || null },
      {
        onSuccess: (r) => {
          setWebhook("");
          if (r?.webhookSecret) setSecret(r.webhookSecret);
          flash(v ? "WEBHOOK SAVED" : "WEBHOOK REMOVED");
        },
      }
    );
  };

  const rotate = () => {
    patchDesk.mutate(
      { rotateWebhookSecret: true },
      {
        onSuccess: (r) => {
          if (r?.webhookSecret) {
            setSecret(r.webhookSecret);
            setShowSecret(true);
          }
          flash("SECRET ROTATED");
        },
      }
    );
  };

  const saveChatId = () => {
    const v = chatId.trim();
    patchDesk.mutate({ telegramChatId: v || null }, { onSuccess: () => { setChatId(""); flash(v ? "CHAT ID SAVED" : "CHAT ID CLEARED"); } });
  };

  const testable = watches.find((w) => w.enabled) ?? watches[0] ?? null;
  const anyChannel = !!(tg?.linked || wh);

  return (
    <Panel title="Delivery" n="04">
      {!hasDesk ? (
        <Note>Open a desk to link Telegram or a webhook. Pages carry a 1-click deep link into the Panic Bunker.</Note>
      ) : (
        <div className="space-y-5">
          {/* Telegram */}
          <section>
            <div className="flex items-center justify-between gap-2">
              <p className="label">Telegram</p>
              {tg?.linked && !tg.disabledReason && <Tag tone="phosphor">linked</Tag>}
              {tg?.disabledReason && <Tag tone="crit">disabled</Tag>}
            </div>
            {tg?.linked ? (
              <div className="mt-2 space-y-2">
                <p className="mono text-[12px] text-ink">
                  <Dot tone={tg.disabledReason ? "crit" : "phosphor"} className="mr-2 align-middle" />
                  Linked · {tg.username ? `@${tg.username}` : "chat"} · {tg.chatType}
                  {tg.verified ? <span className="text-phosphor"> · verified</span> : <span className="text-warn"> · unverified (manual chat ID)</span>}
                </p>
                {tg.disabledReason && <Note tone="crit">Disabled: {tg.disabledReason}</Note>}
                <div className="flex flex-wrap gap-2">
                  <Btn size="sm" variant="quiet" onClick={startLink} disabled={linkTelegram.isPending}>
                    RE-LINK
                  </Btn>
                  <Btn size="sm" variant="danger" onClick={() => unlinkTelegram.mutate(undefined, { onSuccess: () => setLink({ phase: "idle" }) })} disabled={unlinkTelegram.isPending}>
                    {unlinkTelegram.isPending ? "UNLINKING…" : "UNLINK"}
                  </Btn>
                </div>
                {unlinkTelegram.error && <Note tone="crit">Unlink failed: {errText(unlinkTelegram.error)}</Note>}
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {tgConfigured === false && (
                  <Note tone="warn">The Telegram bot is not configured on this deployment (no bot token), so Telegram pages cannot be delivered here. Use a webhook instead.</Note>
                )}
                {link.phase !== "waiting" && (
                  <Btn variant={tgConfigured === false ? "ghost" : "primary"} onClick={startLink} disabled={linkTelegram.isPending || tgConfigured === false} className="w-full sm:w-auto">
                    {linkTelegram.isPending ? "CREATING LINK…" : "LINK TELEGRAM"}
                  </Btn>
                )}
                {link.phase === "waiting" && (
                  <div className="space-y-2 border border-base/30 bg-base/[0.04] p-3">
                    <p className="mono text-[12px] text-ink">
                      <Dot tone="base" live className="mr-2 align-middle" />
                      Waiting for /start in Telegram…
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <a href={link.link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-[2px] border border-base/50 px-3.5 py-2 mono text-[12px] tracking-wider text-base hover:border-base">
                        OPEN TELEGRAM, PRESS START ↗
                      </a>
                      <Btn size="sm" variant="quiet" onClick={cancelLink}>
                        CANCEL
                      </Btn>
                    </div>
                    <Note>
                      Single-use link, valid {link.link.mode === "webhook" ? "for 15 min" : "while this tab polls (2 min)"}. Delivery mode: {link.link.mode}.
                    </Note>
                  </div>
                )}
                {link.phase === "linked" && <Note tone="phosphor">Linked{link.username ? ` · @${link.username}` : ""}. Critical pages ring; warnings arrive silently.</Note>}
                {link.phase === "expired" && <Note tone="warn">Link expired before Telegram confirmed it. Create a new link.</Note>}
                {link.phase === "error" && <Note tone="crit">Telegram linking unavailable: {link.message}</Note>}
                <button type="button" onClick={() => setAdvanced((v) => !v)} className="block mono text-[10.5px] uppercase tracking-wider text-ink-3 hover:text-ink">
                  {advanced ? "− hide advanced" : "+ advanced: manual chat ID"}
                </button>
                {advanced && (
                  <div className="space-y-1.5">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789, -100… or @channel" aria-label="Telegram chat ID" className={inputCls} />
                      <Btn onClick={saveChatId} disabled={patchDesk.isPending} className="shrink-0">
                        SAVE CHAT ID
                      </Btn>
                    </div>
                    <Note>Stored as unverified. The bot can only message chats that have pressed Start on it.</Note>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Webhook */}
          <section className="border-t hairline pt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="label">Webhook</p>
              {wh && <Tag tone={wh.disabledReason ? "crit" : wh.failures > 0 ? "warn" : "phosphor"}>{wh.kind}</Tag>}
            </div>
            {wh && (
              <div className="mt-2 space-y-1">
                <p className="mono text-[12px] text-ink">
                  <Dot tone={wh.disabledReason ? "crit" : wh.failures > 0 ? "warn" : "phosphor"} className="mr-2 align-middle" />
                  {wh.host}
                  <span className="text-ink-3"> · {wh.failures} consecutive failure{wh.failures === 1 ? "" : "s"}</span>
                </p>
                {wh.disabledReason && <Note tone="crit">Disabled: {wh.disabledReason}</Note>}
              </div>
            )}
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder={wh ? "Replace with a new https:// URL…" : "https://discord.com/api/webhooks/…"}
                spellCheck={false}
                autoComplete="off"
                aria-label="Webhook URL"
                className={inputCls}
              />
              <Btn onClick={saveWebhook} disabled={patchDesk.isPending || !webhook.trim()} className="shrink-0">
                SAVE
              </Btn>
            </div>
            <Note className="mt-1.5">Discord, Slack or any https endpoint. Private and internal addresses are refused. Generic endpoints receive HMAC-signed JSON.</Note>
            {wh && (
              <div className="mt-3 flex flex-wrap gap-2">
                {wh.kind === "generic" && (
                  <>
                    {effectiveSecret ? (
                      <>
                        <Btn size="sm" variant="quiet" onClick={() => setShowSecret((v) => !v)}>
                          {showSecret ? "HIDE SECRET" : "REVEAL SECRET"}
                        </Btn>
                        <CopyButton text={effectiveSecret} label="COPY SECRET" />
                      </>
                    ) : null}
                    <Btn size="sm" variant="quiet" onClick={rotate} disabled={patchDesk.isPending}>
                      ROTATE SECRET
                    </Btn>
                  </>
                )}
                <Btn size="sm" variant="danger" onClick={() => patchDesk.mutate({ webhookUrl: null }, { onSuccess: () => flash("WEBHOOK REMOVED") })} disabled={patchDesk.isPending}>
                  REMOVE
                </Btn>
              </div>
            )}
            {showSecret && effectiveSecret && <p className="mt-2 break-all border hairline bg-canvas p-2 mono text-[11px] text-ink-2">{effectiveSecret}</p>}
            {wh?.kind === "generic" && !effectiveSecret && <Note className="mt-1.5">The signing secret is shown only right after saving or rotating. Rotate to see a new one.</Note>}
          </section>

          {patchDesk.error && <Note tone="crit">{errText(patchDesk.error)}</Note>}
          {savedMsg && <Note tone="phosphor">{savedMsg}</Note>}

          {/* Test */}
          <section className="border-t hairline pt-4">
            <Btn
              variant={anyChannel ? "primary" : "ghost"}
              onClick={() => testable && onTest(testable, true)}
              disabled={!testable || testingId !== null}
              className={cx("w-full sm:w-auto")}
            >
              {testingId !== null ? "DISPATCHING…" : "SEND TEST PAGE"}
            </Btn>
            <Note className="mt-1.5">
              {!testable
                ? "Arm a watch first: the test page evaluates a real watch against live chain state."
                : anyChannel
                  ? `Evaluates "${testable.label}" against live state now and sends the real message to your channels.`
                  : "No channel linked yet: the message will be rendered below but not delivered."}
            </Note>
          </section>
        </div>
      )}
    </Panel>
  );
}
