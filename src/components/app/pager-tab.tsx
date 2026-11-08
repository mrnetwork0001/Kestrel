"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { WatchView } from "@/lib/pager/types";
import { DeliveryPanel } from "./pager/delivery-panel";
import { DeskPanel } from "./pager/desk-panel";
import { EvaluationPanel, type Evaluation } from "./pager/evaluation-panel";
import { NightShiftLog } from "./pager/night-shift-log";
import { RecentPages } from "./pager/recent-pages";
import { SleepPanel } from "./pager/sleep-panel";
import { errText, legacyPreview, useDesk, useDeskKey, usePagerMutations } from "./pager/use-pager";
import { WatchList } from "./pager/watch-list";

/**
 * Night-Shift Pager tab: a thin composition of the pager panels (spec section 15).
 * The desk key lives in this browser only; every panel reads the same react-query desk cache.
 */
export function PagerTab({ target, chainId }: { target: string; chainId: number }) {
  const qc = useQueryClient();
  const { key, setKey, imported } = useDeskKey();
  const deskQ = useDesk(key);
  const mutations = usePagerMutations(key);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evalPending, setEvalPending] = useState(false);
  const [evalErr, setEvalErr] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const data = key ? (deskQ.data ?? null) : null;
  const desk = data?.desk ?? null;
  const watches = data?.watches ?? [];
  const hasDesk = !!desk;

  // A different (or no) desk: drop results that belonged to the previous one.
  useEffect(() => {
    setEvaluation(null);
    setEvalErr(null);
  }, [key]);

  const reveal = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("pager-eval")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const runTest = async (w: WatchView, dispatch: boolean) => {
    setTestingId(w.id);
    setEvalPending(true);
    setEvalErr(null);
    reveal();
    try {
      const r = await mutations.testWatch.mutateAsync({ id: w.id, dispatch });
      setEvaluation({ kind: "watch", watchLabel: w.label, chainId: w.chainId, dispatch, data: r });
      if (dispatch) qc.invalidateQueries({ queryKey: ["pager", "desk"] });
    } catch (e) {
      setEvalErr(`Test failed: ${errText(e)}`);
    } finally {
      setEvalPending(false);
      setTestingId(null);
    }
  };

  const preview = async () => {
    setEvalPending(true);
    setEvalErr(null);
    reveal();
    try {
      const r = await legacyPreview(target, chainId);
      setEvaluation({ kind: "legacy", target, chainId, data: r });
    } catch (e) {
      setEvalErr(`Preview failed: ${errText(e)}`);
    } finally {
      setEvalPending(false);
    }
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-8 min-[901px]:grid-cols-12">
      {/* Left 7: the instruments (desk, watches, delivery, sleep, live test pager). */}
      <div className="min-w-0 space-y-6 min-[901px]:col-span-7">
        <DeskPanel deskKey={key} setKey={setKey} desk={desk} loading={deskQ.isLoading} error={key ? deskQ.error : null} imported={imported} mutations={mutations} />
        {/* Watches, delivery and sleep only exist once a desk does; before that the desk panel lists what they will do. */}
        {hasDesk && (
          <>
          <WatchList
            hasDesk={hasDesk}
            watches={watches}
            maxWatches={desk?.limits.maxWatches ?? null}
            target={target}
            chainId={chainId}
            mutations={mutations}
            onTest={runTest}
            testingId={testingId}
          />
          <DeliveryPanel deskKey={key} desk={desk} watches={watches} mutations={mutations} onTest={runTest} testingId={testingId} />
          <SleepPanel desk={desk} sleep={data?.sleep ?? null} watchCount={watches.length} mutations={mutations} />
          </>
        )}
        <div id="pager-eval" className="min-w-0 scroll-mt-[calc(var(--topbar-h)+16px)]">
          <EvaluationPanel evaluation={evaluation} pending={evalPending} error={evalErr} hasDesk={hasDesk} target={target} chainId={chainId} onPreview={preview} />
        </div>
      </div>
      {/* Right 5: the ruled logs (public proof-of-watch, this desk's recent pages). */}
      <div className="min-w-0 space-y-10 min-[901px]:col-span-5">
        <NightShiftLog />
        <RecentPages hasDesk={hasDesk} items={[...(data?.digests ?? []), ...(data?.recentAlerts ?? [])]} />
      </div>
    </div>
  );
}
