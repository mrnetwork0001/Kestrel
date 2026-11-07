"use client";

import { useState } from "react";
import { cx, Panel } from "@/components/ui";
import type { DeskPublic } from "@/lib/pager/types";
import { Btn, CopyButton, Dot, inputCls, Note, Tag } from "./pager-ui";
import { DESK_KEY_RE, errStatus, errText, usePagerMutations } from "./use-pager";

/**
 * 02 · Your desk. A desk is an anonymous watch-set owned by a random desk key (kst_…) stored only in this
 * browser. No login, no wallet. The key is shown in full once at creation; afterwards it can still be copied.
 */
export function DeskPanel({
  deskKey,
  setKey,
  desk,
  loading,
  error,
  imported,
  mutations,
}: {
  deskKey: string | null;
  setKey: (k: string | null) => void;
  desk: DeskPublic | null;
  loading: boolean;
  error: unknown;
  imported: boolean;
  mutations: ReturnType<typeof usePagerMutations>;
}) {
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importVal, setImportVal] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"forget" | "delete" | null>(null);
  const { createDesk, deleteDesk } = mutations;

  const open = () => {
    createDesk.mutate(undefined, {
      onSuccess: (r) => {
        if (r?.deskKey && DESK_KEY_RE.test(r.deskKey)) {
          setFreshKey(r.deskKey);
          setKey(r.deskKey);
        }
      },
    });
  };

  const doImport = () => {
    const v = importVal.trim();
    if (!DESK_KEY_RE.test(v)) {
      setImportErr("Not a desk key. Expected kst_ followed by 20–64 URL-safe characters.");
      return;
    }
    setImportErr(null);
    setImportVal("");
    setImportOpen(false);
    setKey(v);
  };

  const forget = () => {
    setKey(null);
    setFreshKey(null);
    setConfirm(null);
  };

  const remove = () => {
    deleteDesk.mutate(undefined, { onSuccess: forget });
  };

  const status = errStatus(error);
  const deviceUrl = deskKey && typeof window !== "undefined" ? `${window.location.origin}/app?tab=pager#desk=${deskKey}` : "";

  return (
    <Panel title="Your desk" n="02" right={desk ? <Tag tone={desk.storage === "memory" ? "warn" : "phosphor"}>{desk.storage === "memory" ? "dev memory" : "upstash"}</Tag> : undefined}>
      {!deskKey && (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Open a night desk. No login: a private desk key is stored in this browser. Arm watches on any Base or Robinhood Chain address and Kestrel checks them every tick while you sleep.
          </p>
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" onClick={open} disabled={createDesk.isPending}>
              {createDesk.isPending ? "OPENING…" : "OPEN DESK"}
            </Btn>
            <Btn variant="ghost" onClick={() => setImportOpen((v) => !v)}>
              IMPORT KEY
            </Btn>
          </div>
          {importOpen && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={importVal}
                onChange={(e) => setImportVal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doImport()}
                placeholder="kst_…"
                spellCheck={false}
                autoComplete="off"
                aria-label="Desk key"
                className={inputCls}
              />
              <Btn onClick={doImport}>USE KEY</Btn>
            </div>
          )}
          {importErr && <Note tone="crit">{importErr}</Note>}
          {createDesk.error && <Note tone="crit">Could not open a desk: {errText(createDesk.error)}</Note>}
          <Note>Anyone with the desk key can edit this desk&apos;s alerts. It cannot touch your funds: Kestrel never asks for a private key or a signature to watch.</Note>
        </div>
      )}

      {deskKey && (
        <div className="space-y-4">
          {freshKey === deskKey && (
            <div className="border border-warn/40 bg-warn/[0.04] p-3">
              <p className="label text-warn">Desk key · shown once</p>
              <p className="mt-2 break-all mono text-[12px] text-ink">{freshKey}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton text={freshKey} label="COPY KEY" variant="ghost" size="md" />
                <Btn variant="quiet" onClick={() => setFreshKey(null)}>
                  I SAVED IT
                </Btn>
              </div>
              <Note className="mt-2">This key is the only credential for the desk and is kept in this browser. Save it somewhere safe to manage the desk from another device.</Note>
            </div>
          )}

          {imported && !desk && loading && <Note tone="phosphor">Desk key imported from the link. Loading desk…</Note>}

          {loading && !desk && !imported && <Note>Loading desk…</Note>}

          {error && !desk ? (
            <div className="space-y-2">
              <Note tone="crit">
                {status === 401 || status === 404
                  ? "This desk key is not recognised: the desk was deleted or the storage was reset."
                  : status === 503
                    ? `Pager storage is not configured on this deployment: ${errText(error)}.`
                    : `Could not load the desk: ${errText(error)}`}
              </Note>
              <Btn variant="quiet" size="sm" onClick={forget}>
                FORGET THIS KEY
              </Btn>
            </div>
          ) : null}

          {desk && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Field label="Desk id" value={desk.id.slice(0, 10)} title={desk.id} />
                <Field label="Watches" value={`${desk.watchCount} / ${desk.limits.maxWatches}`} />
                <Field label="Opened" value={new Date(desk.createdAt).toISOString().slice(0, 10)} />
                <Field label="Overnight policy" value={desk.policy.sleepMode === "critical-only" ? "critical only" : "page all"} />
              </dl>
              {desk.storage === "memory" && (
                <Note tone="warn">
                  <Dot tone="warn" className="mr-1.5 align-middle" />
                  Dev memory storage: this desk lives in one server process and is lost on restart. Production uses Upstash Redis.
                </Note>
              )}
              <div className="flex flex-wrap gap-2">
                <CopyButton text={deskKey} label="COPY KEY" />
                <CopyButton text={deviceUrl} label="OPEN ON ANOTHER DEVICE" copiedLabel="LINK COPIED" />
                {confirm === "forget" ? (
                  <>
                    <Btn size="sm" variant="danger" onClick={forget}>
                      CONFIRM FORGET
                    </Btn>
                    <Btn size="sm" variant="quiet" onClick={() => setConfirm(null)}>
                      CANCEL
                    </Btn>
                  </>
                ) : confirm === "delete" ? (
                  <>
                    <Btn size="sm" variant="danger" onClick={remove} disabled={deleteDesk.isPending}>
                      {deleteDesk.isPending ? "DELETING…" : "DELETE DESK + WATCHES"}
                    </Btn>
                    <Btn size="sm" variant="quiet" onClick={() => setConfirm(null)}>
                      CANCEL
                    </Btn>
                  </>
                ) : (
                  <>
                    <Btn size="sm" variant="quiet" onClick={() => setConfirm("forget")}>
                      FORGET
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => setConfirm("delete")}>
                      DELETE
                    </Btn>
                  </>
                )}
              </div>
              {confirm === "forget" && <Note tone="warn">Forget removes the key from this browser only. The desk keeps running; without a saved copy of the key you cannot manage it again.</Note>}
              {confirm === "delete" && <Note tone="crit">Delete stops every watch and erases the desk, its channels and its alert history on the server.</Note>}
              {deleteDesk.error && <Note tone="crit">Delete failed: {errText(deleteDesk.error)}</Note>}
              <Note>The &quot;another device&quot; link carries the key in the #fragment, which browsers never send to a server.</Note>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="label text-[10px]">{label}</dt>
      <dd className={cx("mt-1 truncate tnum text-[13px] text-ink")}>{value}</dd>
    </div>
  );
}
